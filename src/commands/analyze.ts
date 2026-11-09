import chalk from 'chalk';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { formatSize, exists } from '../utils/index.js';
import { execSync } from 'child_process';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface DiskEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
}

interface AnalyzeCommandOptions {
  path: string;
  top: number;
  json?: boolean;
}

// ═══════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════

function getDirSize(dirPath: string): number {
  try {
    const output = execSync(`du -sk "${dirPath}" 2>/dev/null | cut -f1`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseInt(output, 10) * 1024;
  } catch {
    return 0;
  }
}

function getDiskUsage(): { total: number; used: number; available: number } {
  try {
    const output = execSync("df -k / | tail -1 | awk '{print $2, $3, $4}'", {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const [total, used, available] = output.split(' ').map(n => parseInt(n, 10) * 1024);
    return { total, used, available };
  } catch {
    return { total: 0, used: 0, available: 0 };
  }
}

/**
 * Render a bar chart for a percentage
 */
function renderBar(percentage: number, width = 22): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  if (percentage > 60) return chalk.red(bar);
  if (percentage > 40) return chalk.yellow(bar);
  return chalk.green(bar);
}

/**
 * Scan direct children of a directory
 */
async function scanDirectory(dirPath: string): Promise<DiskEntry[]> {
  const entries: DiskEntry[] = [];

  try {
    const items = await readdir(dirPath);

    for (const item of items) {
      if (item.startsWith('.')) continue; // skip hidden by default

      const fullPath = join(dirPath, item);

      try {
        const stats = await stat(fullPath);
        const size = stats.isDirectory() ? getDirSize(fullPath) : stats.size;

        entries.push({
          name: item,
          path: fullPath,
          size,
          isDirectory: stats.isDirectory(),
        });
      } catch {
        continue; // skip inaccessible files
      }
    }
  } catch {
    // can't read directory
  }

  return entries.sort((a, b) => b.size - a.size);
}

/**
 * Find top N largest files recursively
 */
function findLargestFiles(dirPath: string, count: number): Array<{ path: string; size: number }> {
  try {
    const output = execSync(
      `find "${dirPath}" -type f -maxdepth 4 -exec du -k {} + 2>/dev/null | sort -rn | head -${count}`,
      {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const [sizeStr, ...pathParts] = line.trim().split('\t');
      return {
        size: parseInt(sizeStr, 10) * 1024,
        path: pathParts.join('\t'),
      };
    }).filter(f => f.path && f.size > 0);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════

export async function analyzeCommand(options: AnalyzeCommandOptions): Promise<void> {
  const targetPath = options.path.replace('~', homedir());

  if (!(await exists(targetPath))) {
    console.log(chalk.red(`\n❌ Path not found: ${targetPath}\n`));
    return;
  }

  console.log(chalk.cyan('\n📊 Analyzing disk usage...\n'));

  const ora = (await import('ora')).default;
  const spinner = ora('Scanning directory...').start();

  // Get disk overview
  const disk = getDiskUsage();
  const entries = await scanDirectory(targetPath);
  const totalScanned = entries.reduce((s, e) => s + e.size, 0);

  spinner.text = 'Finding largest files...';
  const largestFiles = findLargestFiles(targetPath, 10);

  spinner.succeed('Analysis complete\n');

  // JSON output
  if (options.json) {
    console.log(JSON.stringify({
      path: targetPath,
      disk,
      entries: entries.slice(0, options.top).map(e => ({
        name: e.name,
        path: e.path,
        size: e.size,
        isDirectory: e.isDirectory,
      })),
      totalScanned,
      largestFiles,
    }, null, 2));
    return;
  }

  // ─── Disk Overview ─────────────────────────────

  const usedPercent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;

  console.log(chalk.bold('💿 Disk Overview'));
  console.log(chalk.dim('━'.repeat(60)));
  console.log(`  Total:     ${formatSize(disk.total)}`);
  console.log(`  Used:      ${formatSize(disk.used)} (${usedPercent}%)`);
  console.log(`  Available: ${chalk.green(formatSize(disk.available))}`);
  console.log(`  ${renderBar(usedPercent, 40)} ${usedPercent}%`);

  // ─── Directory Breakdown ───────────────────────

  console.log(chalk.bold(`\n📂 Directory Breakdown: ${targetPath.replace(homedir(), '~')}`));
  console.log(chalk.dim('━'.repeat(60)));

  const top = entries.slice(0, options.top);
  const maxSize = top[0]?.size ?? 1;

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const percent = totalScanned > 0 ? (entry.size / totalScanned) * 100 : 0;
    const barWidth = Math.max(1, Math.round((entry.size / maxSize) * 20));
    const bar = '█'.repeat(barWidth);

    const icon = entry.isDirectory ? '📁' : '📄';
    const idx = chalk.dim(`${(i + 1).toString().padStart(2)}.`);
    const coloredBar = percent > 30 ? chalk.red(bar) : percent > 15 ? chalk.yellow(bar) : chalk.green(bar);

    console.log(
      `${idx} ${coloredBar.padEnd(30)} ${percent.toFixed(1).padStart(5)}%  ${icon} ${entry.name.padEnd(25)} ${chalk.yellow(formatSize(entry.size))}`
    );
  }

  // ─── Largest Files ─────────────────────────────

  if (largestFiles.length > 0) {
    console.log(chalk.bold('\n📏 Top 10 Largest Files'));
    console.log(chalk.dim('━'.repeat(60)));

    for (let i = 0; i < largestFiles.length; i++) {
      const file = largestFiles[i];
      const displayPath = file.path.replace(homedir(), '~');
      const truncated = displayPath.length > 55 ? '...' + displayPath.slice(-52) : displayPath;
      console.log(
        `  ${chalk.dim((i + 1).toString().padStart(2) + '.')} ${truncated.padEnd(56)} ${chalk.yellow(formatSize(file.size))}`
      );
    }
  }

  console.log();
}
