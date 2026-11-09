import chalk from 'chalk';
import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import {
  formatSize,
  parseSize,
  exists,
  getDirectorySize,
  getLastUsedDate,
  classifyRecency,
  findStaleFilesSpotlight,
  type StorageTier,
} from '../utils/index.js';

export interface TierItem {
  name: string;
  path: string;
  size: number;
  lastUsed: Date | null;
  tier: StorageTier;
  isDirectory: boolean;
}

export interface TierCommandOptions {
  path?: string;
  days?: number;
  minSize?: string;
  top?: number;
  json?: boolean;
}

function formatTierBadge(tier: StorageTier): string {
  switch (tier) {
    case 'active':
      return chalk.green('🟢 Active');
    case 'warm':
      return chalk.yellow('🟡 Warm  ');
    case 'cold':
      return chalk.red('🔴 Cold  ');
    case 'frozen':
      return chalk.cyan('❄️  Frozen');
  }
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Never / Unknown';
  const now = Date.now();
  const diffDays = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export async function tierCommand(options: TierCommandOptions = {}): Promise<void> {
  const targetDir = (options.path || homedir()).replace(/^~/, homedir());
  const coldDays = options.days ?? 90;
  const minSizeBytes = options.minSize ? parseSize(options.minSize) : 50 * 1024 * 1024; // default 50MB
  const topLimit = options.top ?? 20;

  if (!(await exists(targetDir))) {
    console.log(chalk.red(`\n❌ Target path does not exist: ${targetDir}\n`));
    return;
  }

  console.log(chalk.cyan(`\n🔍 Analyzing storage tiers for: ${targetDir.replace(homedir(), '~')}`));
  console.log(chalk.dim(`   Threshold: >${coldDays} days stale | Min size: ${formatSize(minSizeBytes)}\n`));

  const ora = (await import('ora')).default;
  const spinner = ora('Scanning storage metadata...').start();

  const collected: Map<string, TierItem> = new Map();

  // 1. Spotlight Fast Query
  try {
    const spotlightMatches = findStaleFilesSpotlight(targetDir, coldDays, minSizeBytes);
    for (const match of spotlightMatches) {
      if (collected.size >= topLimit * 4) break;
      try {
        const s = await stat(match);
        const lastUsed = getLastUsedDate(match) || s.atime || s.mtime;
        const tier = classifyRecency(lastUsed, coldDays);
        collected.set(match, {
          name: basename(match),
          path: match,
          size: s.size,
          lastUsed,
          tier,
          isDirectory: false,
        });
      } catch {
        // Skip inaccessible file
      }
    }
  } catch {
    // Spotlight fallback
  }

  // 2. Targeted Directory Crawl
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden
      const fullPath = join(targetDir, entry.name);
      if (collected.has(fullPath)) continue;

      try {
        const s = await stat(fullPath);
        const isDir = s.isDirectory();
        const size = isDir ? await getDirectorySize(fullPath) : s.size;

        if (size >= minSizeBytes) {
          const lastUsed = getLastUsedDate(fullPath) || s.atime || s.mtime;
          const tier = classifyRecency(lastUsed, coldDays);
          collected.set(fullPath, {
            name: entry.name,
            path: fullPath,
            size,
            lastUsed,
            tier,
            isDirectory: isDir,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Folder read issue
  }

  spinner.succeed(`Found ${collected.size} items matching size threshold\n`);

  const items = Array.from(collected.values()).sort((a, b) => b.size - a.size);

  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log(chalk.green('✨ No stale files or heavy directories found above threshold!\n'));
    return;
  }

  // Print Table
  console.log(chalk.bold(`📦 Storage Tier Breakdown (Top ${Math.min(items.length, topLimit)})`));
  console.log(chalk.dim('━'.repeat(95)));
  console.log(
    chalk.dim(' #  ') +
      'Name'.padEnd(34) +
      'Size'.padStart(10) +
      '   ' +
      'Last Used'.padEnd(14) +
      '   ' +
      'Tier'.padEnd(12) +
      'Path'
  );
  console.log(chalk.dim('─'.repeat(95)));

  const displayList = items.slice(0, topLimit);

  for (let i = 0; i < displayList.length; i++) {
    const item = displayList[i];
    const idx = chalk.dim(`${(i + 1).toString().padStart(2)}  `);
    const icon = item.isDirectory ? '📁 ' : '📄 ';
    const displayName = (icon + item.name).substring(0, 32).padEnd(34);
    const sizeStr = formatSize(item.size).padStart(10);
    const lastUsedStr = formatRelativeTime(item.lastUsed).padEnd(14);
    const badge = formatTierBadge(item.tier).padEnd(12);
    const shortPath = item.path.replace(homedir(), '~');
    const truncatedPath = shortPath.length > 30 ? '...' + shortPath.slice(-27) : shortPath;

    console.log(`${idx}${displayName}${chalk.yellow(sizeStr)}   ${chalk.dim(lastUsedStr)}   ${badge} ${chalk.dim(truncatedPath)}`);
  }

  // Summary
  const coldItems = items.filter((i) => i.tier === 'cold' || i.tier === 'frozen');
  const coldBytes = coldItems.reduce((acc, i) => acc + i.size, 0);

  console.log(chalk.dim('\n━'.repeat(95)));
  console.log(chalk.bold('\n📊 Summary:'));
  console.log(`  ${chalk.green('🟢 Active')} (< 30d):      ${items.filter((i) => i.tier === 'active').length} items`);
  console.log(`  ${chalk.yellow('🟡 Warm')} (30-${coldDays}d):   ${items.filter((i) => i.tier === 'warm').length} items`);
  console.log(`  ${chalk.red('🔴 Cold')} (90-180d):    ${items.filter((i) => i.tier === 'cold').length} items`);
  console.log(`  ${chalk.cyan('❄️  Frozen')} (> 180d):    ${items.filter((i) => i.tier === 'frozen').length} items`);

  if (coldBytes > 0) {
    console.log(
      chalk.bold.yellow(`\n💡 Total offloadable cold data: ${formatSize(coldBytes)} across ${coldItems.length} items`)
    );
    console.log(
      chalk.dim(`   Run ${chalk.cyan('managemymac offload <path> --destination "/Volumes/ExternalSSD"')} to safely migrate.`)
    );
  }
  console.log();
}
