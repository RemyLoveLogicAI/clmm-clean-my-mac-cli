import chalk from 'chalk';
import checkbox from '@inquirer/checkbox';
import confirm from '@inquirer/confirm';
import { readdir, stat, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { formatSize, exists } from '../utils/index.js';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface AppDetail {
  name: string;
  path: string;
  bundleId: string | null;
  version: string | null;
  size: number;
  lastUsed: Date | null;
  status: 'active' | 'stale' | 'unused';
  relatedPaths: string[];
  relatedSize: number;
}

interface AppsCommandOptions {
  cleanup?: boolean;
  sort?: string;
  staleDays?: number;
  json?: boolean;
}

// ═══════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════

const APP_DIRS = ['/Applications', join(homedir(), 'Applications')];

const RELATED_DIRS = [
  'Library/Application Support',
  'Library/Caches',
  'Library/Preferences',
  'Library/Logs',
  'Library/Saved Application State',
  'Library/WebKit',
  'Library/HTTPStorages',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Cookies',
];

// ═══════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════

/**
 * Read bundle identifier and version from Info.plist
 */
async function readInfoPlist(appPath: string): Promise<{ bundleId: string | null; version: string | null }> {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist');
    const content = await readFile(plistPath, 'utf-8');

    const bundleIdMatch = content.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    const versionMatch = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);

    return {
      bundleId: bundleIdMatch?.[1]?.trim() || null,
      version: versionMatch?.[1]?.trim() || null,
    };
  } catch {
    return { bundleId: null, version: null };
  }
}

/**
 * Get the last used date of an application using Spotlight metadata.
 * Falls back to filesystem access time.
 */
function getLastUsedDate(appPath: string): Date | null {
  try {
    // Method 1: Spotlight metadata (most accurate)
    const output = execSync(`mdls -name kMDItemLastUsedDate -raw "${appPath}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (output && output !== '(null)' && output !== '') {
      const date = new Date(output);
      if (!isNaN(date.getTime())) return date;
    }
  } catch {
    // silently fall through
  }

  try {
    // Method 2: File access time
    const output = execSync(`stat -f "%Sa" -t "%Y-%m-%dT%H:%M:%S" "${appPath}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (output) {
      const date = new Date(output);
      if (!isNaN(date.getTime())) return date;
    }
  } catch {
    // silently fall through
  }

  return null;
}

/**
 * Calculate directory size recursively using du (fast, native)
 */
function getDirSize(dirPath: string): number {
  try {
    const output = execSync(`du -sk "${dirPath}" 2>/dev/null | cut -f1`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseInt(output, 10) * 1024; // Convert KB to bytes
  } catch {
    return 0;
  }
}

/**
 * Find related files for an app by bundle ID and app name
 */
async function findRelatedPaths(appName: string, bundleId: string | null): Promise<string[]> {
  const home = homedir();
  const found: string[] = [];
  const searchTerms = [
    appName,
    appName.toLowerCase(),
    appName.replace(/\s+/g, ''),
    appName.replace(/\s+/g, '.'),
  ];
  if (bundleId) searchTerms.push(bundleId);

  for (const relDir of RELATED_DIRS) {
    const fullDir = join(home, relDir);
    if (!(await exists(fullDir))) continue;

    try {
      const entries = await readdir(fullDir);
      for (const entry of entries) {
        const entryLower = entry.toLowerCase();
        const matches = searchTerms.some(term =>
          entryLower.includes(term.toLowerCase())
        );
        if (matches) {
          const fullPath = join(fullDir, entry);
          if (!found.includes(fullPath)) {
            found.push(fullPath);
          }
        }
      }
    } catch {
      // skip directories we can't read
    }
  }

  return found;
}

/**
 * Classify app usage status
 */
function classifyApp(lastUsed: Date | null, staleDays: number): 'active' | 'stale' | 'unused' {
  if (!lastUsed) return 'unused';

  const now = new Date();
  const diffDays = Math.floor((now.getTime() - lastUsed.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 30) return 'active';
  if (diffDays <= staleDays) return 'stale';
  return 'unused';
}

/**
 * Format relative time
 */
function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Never opened';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

/**
 * Status icon and color
 */
function formatStatus(status: 'active' | 'stale' | 'unused'): string {
  switch (status) {
    case 'active': return chalk.green('✅ Active');
    case 'stale': return chalk.yellow('⚠️  Stale');
    case 'unused': return chalk.red('🔴 Unused');
  }
}

// ═══════════════════════════════════════════════════
// Main Scan
// ═══════════════════════════════════════════════════

async function scanApps(staleDays: number, onProgress?: (current: number, total: number, name: string) => void): Promise<AppDetail[]> {
  const apps: AppDetail[] = [];
  
  // First collect all app paths
  const appPaths: { name: string; path: string }[] = [];
  for (const appDir of APP_DIRS) {
    if (!(await exists(appDir))) continue;
    try {
      const entries = await readdir(appDir);
      for (const entry of entries) {
        if (!entry.endsWith('.app')) continue;
        appPaths.push({
          name: basename(entry, '.app'),
          path: join(appDir, entry),
        });
      }
    } catch {
      continue;
    }
  }

  const total = appPaths.length;

  for (let i = 0; i < appPaths.length; i++) {
    const { name, path } = appPaths[i];
    onProgress?.(i + 1, total, name);

    try {
      const stats = await stat(path);
      if (!stats.isDirectory()) continue;

      const { bundleId, version } = await readInfoPlist(path);
      const lastUsed = getLastUsedDate(path);
      const size = getDirSize(path);
      const status = classifyApp(lastUsed, staleDays);
      const relatedPaths = await findRelatedPaths(name, bundleId);

      let relatedSize = 0;
      for (const rp of relatedPaths) {
        relatedSize += getDirSize(rp);
      }

      apps.push({
        name,
        path,
        bundleId,
        version,
        size,
        lastUsed,
        status,
        relatedPaths,
        relatedSize,
      });
    } catch {
      continue;
    }
  }

  return apps;
}

// ═══════════════════════════════════════════════════
// Sort
// ═══════════════════════════════════════════════════

function sortApps(apps: AppDetail[], sortBy: string): AppDetail[] {
  return [...apps].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'last-used': {
        const aTime = a.lastUsed?.getTime() ?? 0;
        const bTime = b.lastUsed?.getTime() ?? 0;
        return aTime - bTime; // oldest first
      }
      case 'size':
      default:
        return (b.size + b.relatedSize) - (a.size + a.relatedSize); // largest first
    }
  });
}

// ═══════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════

export async function appsCommand(options: AppsCommandOptions): Promise<void> {
  const staleDays = options.staleDays ?? 90;

  console.log(chalk.cyan('\n🔍 Scanning installed applications...\n'));

  const ora = (await import('ora')).default;
  const spinner = ora('Analyzing apps...').start();

  const apps = await scanApps(staleDays, (current, total, name) => {
    spinner.text = `Analyzing ${current}/${total}: ${name}`;
  });

  spinner.succeed(`Found ${apps.length} applications\n`);

  // JSON output mode
  if (options.json) {
    const output = apps.map(a => ({
      name: a.name,
      bundleId: a.bundleId,
      version: a.version,
      size: a.size,
      relatedSize: a.relatedSize,
      totalSize: a.size + a.relatedSize,
      lastUsed: a.lastUsed?.toISOString() ?? null,
      status: a.status,
      relatedFiles: a.relatedPaths.length,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const sorted = sortApps(apps, options.sort || 'size');

  // Classify
  const active = sorted.filter(a => a.status === 'active');
  const stale = sorted.filter(a => a.status === 'stale');
  const unused = sorted.filter(a => a.status === 'unused');

  const activeSize = active.reduce((s, a) => s + a.size + a.relatedSize, 0);
  const staleSize = stale.reduce((s, a) => s + a.size + a.relatedSize, 0);
  const unusedSize = unused.reduce((s, a) => s + a.size + a.relatedSize, 0);

  // ─── Print Table ───────────────────────────────

  console.log(chalk.bold(`📱 Installed Applications (${apps.length} apps)`));
  console.log(chalk.dim('━'.repeat(90)));
  console.log(
    chalk.dim(' #  ') +
    'App Name'.padEnd(32) +
    'Size'.padStart(10) +
    '   ' +
    'Last Used'.padEnd(18) +
    'Status'
  );
  console.log(chalk.dim('──  ' + '─'.repeat(32) + '─'.repeat(10) + '   ' + '─'.repeat(18) + '─'.repeat(12)));

  for (let i = 0; i < sorted.length; i++) {
    const app = sorted[i];
    const totalSize = app.size + app.relatedSize;
    const idx = chalk.dim(`${(i + 1).toString().padStart(2)}  `);
    const name = app.name.substring(0, 30).padEnd(32);
    const size = formatSize(totalSize).padStart(10);
    const lastUsed = formatRelativeTime(app.lastUsed).padEnd(18);
    const status = formatStatus(app.status);

    console.log(`${idx}${name}${chalk.yellow(size)}   ${chalk.dim(lastUsed)}${status}`);
  }

  // ─── Summary ───────────────────────────────────

  console.log(chalk.dim('\n━'.repeat(90)));
  console.log(chalk.bold('\n📊 Summary:'));
  console.log(`  ${chalk.green('✅ Active')} (< 30 days):      ${active.length} apps  |  ${chalk.green(formatSize(activeSize))}`);
  console.log(`  ${chalk.yellow('⚠️  Stale')} (30-${staleDays} days):   ${stale.length} apps  |  ${chalk.yellow(formatSize(staleSize))}`);
  console.log(`  ${chalk.red('🔴 Unused')} (> ${staleDays} days):    ${unused.length} apps  |  ${chalk.red(formatSize(unusedSize))}`);

  if (unused.length > 0 || stale.length > 0) {
    console.log(
      chalk.cyan(`\n💡 ${unused.length + stale.length} apps might be removable (${formatSize(unusedSize + staleSize)})`)
    );
    console.log(chalk.dim(`   Run ${chalk.cyan('clmm apps --cleanup')} to review and uninstall`));
  }

  // ─── Cleanup Mode ──────────────────────────────

  if (options.cleanup) {
    const removable = sorted.filter(a => a.status === 'unused' || a.status === 'stale');

    if (removable.length === 0) {
      console.log(chalk.green('\n✨ All apps are actively used! Nothing to clean up.\n'));
      return;
    }

    console.log(chalk.bold('\n\n🧹 App Cleanup Recommendations'));
    console.log(chalk.dim('━'.repeat(60)));

    const choices = removable.map(app => {
      const totalSize = app.size + app.relatedSize;
      const statusIcon = app.status === 'unused' ? '🔴' : '⚠️';
      return {
        name: `${statusIcon} ${app.name.padEnd(28)} ${chalk.yellow(formatSize(totalSize).padStart(10))}  ${chalk.dim(formatRelativeTime(app.lastUsed))}`,
        value: app.name,
        checked: app.status === 'unused',
      };
    });

    const selected = await checkbox<string>({
      message: 'Select apps to uninstall:',
      choices,
      pageSize: 20,
    });

    if (selected.length === 0) {
      console.log(chalk.yellow('\nNo apps selected.\n'));
      return;
    }

    const toRemove = removable.filter(a => selected.includes(a.name));
    const totalToFree = toRemove.reduce((s, a) => s + a.size + a.relatedSize, 0);

    console.log(chalk.bold(`\n${selected.length} apps selected — ${chalk.green(formatSize(totalToFree))} will be freed`));
    console.log();

    for (const app of toRemove) {
      console.log(`  ${chalk.red('✗')} ${app.name} (${formatSize(app.size + app.relatedSize)})`);
      if (app.relatedPaths.length > 0) {
        console.log(chalk.dim(`      └─ +${app.relatedPaths.length} related files (${formatSize(app.relatedSize)})`));
      }
    }

    console.log();
    const proceed = await confirm({
      message: `Proceed with uninstalling ${selected.length} apps?`,
      default: false,
    });

    if (!proceed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    // Execute uninstall
    const { execSync: exec } = await import('child_process');
    let freed = 0;
    let errors = 0;

    for (const app of toRemove) {
      try {
        process.stdout.write(`  Removing ${app.name}...`);
        exec(`rm -rf "${app.path}"`, { stdio: 'pipe' });
        freed += app.size;

        for (const rp of app.relatedPaths) {
          try {
            exec(`rm -rf "${rp}"`, { stdio: 'pipe' });
            freed += getDirSize(rp);
          } catch {
            // skip
          }
        }

        console.log(chalk.green(' ✓'));
      } catch {
        console.log(chalk.red(' ✗ (permission denied)'));
        errors++;
      }
    }

    console.log(chalk.bold.green(`\n✨ Done! Freed ${formatSize(freed)}`));
    if (errors > 0) {
      console.log(chalk.yellow(`   ${errors} apps could not be removed (try with sudo)`));
    }
    console.log();
  }

  console.log();
}
