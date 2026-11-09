import chalk from 'chalk';
import confirm from '@inquirer/confirm';
import { execSync } from 'child_process';
import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { exists, formatSize } from '../utils/index.js';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface OptimizeResult {
  name: string;
  status: 'done' | 'skipped' | 'failed';
  detail: string;
}

interface OptimizeCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

// ═══════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════

function run(cmd: string, timeout = 10000): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, output };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, output: err.stderr?.toString?.() || err.message || '' };
  }
}

function runSudo(cmd: string, timeout = 15000): { ok: boolean; output: string } {
  return run(`sudo ${cmd}`, timeout);
}

// ═══════════════════════════════════════════════════
// Optimization Tasks
// ═══════════════════════════════════════════════════

async function optDNSFlush(dryRun: boolean): Promise<OptimizeResult> {
  if (dryRun) {
    return { name: 'DNS Cache Flush', status: 'done', detail: 'Would flush DNS cache' };
  }

  run('dscacheutil -flushcache');
  run('sudo killall -HUP mDNSResponder 2>/dev/null');

  return { name: 'DNS Cache Flush', status: 'done', detail: 'DNS cache flushed' };
}

async function optMemoryPurge(dryRun: boolean): Promise<OptimizeResult> {
  if (dryRun) {
    return { name: 'Memory Purge', status: 'done', detail: 'Would purge inactive memory' };
  }

  const result = runSudo('purge');
  if (result.ok) {
    return { name: 'Memory Purge', status: 'done', detail: 'Inactive memory purged' };
  }
  return { name: 'Memory Purge', status: 'failed', detail: 'Need sudo access' };
}

async function optFontCacheRebuild(dryRun: boolean): Promise<OptimizeResult> {
  if (dryRun) {
    return { name: 'Font Cache Rebuild', status: 'done', detail: 'Would rebuild font caches' };
  }

  run('atsutil databases -remove 2>/dev/null');
  run('atsutil server -shutdown 2>/dev/null');
  run('atsutil server -ping 2>/dev/null');

  return { name: 'Font Cache Rebuild', status: 'done', detail: 'Font database rebuilt' };
}

async function optLaunchServicesRebuild(dryRun: boolean): Promise<OptimizeResult> {
  if (dryRun) {
    return { name: 'Launch Services', status: 'done', detail: 'Would rebuild Launch Services database' };
  }

  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  const result = run(`${lsregister} -kill -r -domain local -domain system -domain user 2>/dev/null`, 30000);

  return {
    name: 'Launch Services',
    status: result.ok ? 'done' : 'failed',
    detail: result.ok ? 'Launch Services database rebuilt (Open-With menus refreshed)' : 'Failed to rebuild',
  };
}

async function optQuarantineCleanup(dryRun: boolean): Promise<OptimizeResult> {
  const home = homedir();
  const downloadsDir = join(home, 'Downloads');

  if (!(await exists(downloadsDir))) {
    return { name: 'Quarantine Cleanup', status: 'skipped', detail: 'Downloads folder not found' };
  }

  // Count files with quarantine xattr
  const countResult = run(`find "${downloadsDir}" -maxdepth 2 -xattrname com.apple.quarantine 2>/dev/null | wc -l`);
  const count = parseInt(countResult.output, 10) || 0;

  if (count === 0) {
    return { name: 'Quarantine Cleanup', status: 'skipped', detail: 'No quarantine flags found' };
  }

  if (dryRun) {
    return { name: 'Quarantine Cleanup', status: 'done', detail: `Would remove quarantine from ${count} files` };
  }

  run(`find "${downloadsDir}" -maxdepth 2 -xattrname com.apple.quarantine -exec xattr -d com.apple.quarantine {} \\; 2>/dev/null`, 30000);

  return { name: 'Quarantine Cleanup', status: 'done', detail: `Removed quarantine from ${count} files` };
}

async function optBrokenPlistCleanup(dryRun: boolean): Promise<OptimizeResult> {
  const prefsDir = join(homedir(), 'Library', 'Preferences');
  if (!(await exists(prefsDir))) {
    return { name: 'Broken Preferences', status: 'skipped', detail: 'Preferences directory not found' };
  }

  let brokenCount = 0;
  try {
    const entries = await readdir(prefsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.plist')) continue;
      // Skip Apple system plists
      if (entry.startsWith('com.apple.') || entry.startsWith('.GlobalPreferences')) continue;

      const fullPath = join(prefsDir, entry);
      const checkResult = run(`plutil -lint "${fullPath}" 2>/dev/null`);

      if (!checkResult.ok || !checkResult.output.includes('OK')) {
        brokenCount++;
        if (!dryRun) {
          try { await rm(fullPath, { force: true }); } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }

  if (brokenCount === 0) {
    return { name: 'Broken Preferences', status: 'skipped', detail: 'All preferences valid' };
  }

  return {
    name: 'Broken Preferences',
    status: 'done',
    detail: dryRun
      ? `Would remove ${brokenCount} broken preference file(s)`
      : `Removed ${brokenCount} broken preference file(s)`,
  };
}

async function optOrphanedLaunchAgents(dryRun: boolean): Promise<OptimizeResult> {
  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  if (!(await exists(agentsDir))) {
    return { name: 'Launch Agents', status: 'skipped', detail: 'No LaunchAgents directory' };
  }

  let orphanedCount = 0;
  try {
    const entries = await readdir(agentsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.plist')) continue;
      if (entry.startsWith('com.apple.')) continue;

      const fullPath = join(agentsDir, entry);
      let binary = '';

      // Read plist to find Program or ProgramArguments
      const readResult = run(`/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "${fullPath}" 2>/dev/null`);
      if (readResult.ok && readResult.output) {
        binary = readResult.output;
      } else {
        const readResult2 = run(`/usr/libexec/PlistBuddy -c "Print :Program" "${fullPath}" 2>/dev/null`);
        if (readResult2.ok && readResult2.output) {
          binary = readResult2.output;
        }
      }

      // Check if the binary exists
      if (binary && !(await exists(binary))) {
        orphanedCount++;
        if (!dryRun) {
          run(`launchctl unload "${fullPath}" 2>/dev/null`);
          try { await rm(fullPath, { force: true }); } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }

  if (orphanedCount === 0) {
    return { name: 'Launch Agents', status: 'skipped', detail: 'All Launch Agents healthy' };
  }

  return {
    name: 'Launch Agents',
    status: 'done',
    detail: dryRun
      ? `Would remove ${orphanedCount} orphaned Launch Agent(s)`
      : `Cleaned ${orphanedCount} orphaned Launch Agent(s)`,
  };
}

async function optPeriodicMaintenance(dryRun: boolean): Promise<OptimizeResult> {
  // Check if periodic maintenance has been run recently
  const dailyLog = '/var/log/daily.out';
  if (await exists(dailyLog)) {
    const statResult = run(`stat -f %m "${dailyLog}"`);
    const lastMod = parseInt(statResult.output, 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    const ageDays = Math.floor((now - lastMod) / 86400);

    if (ageDays < 7) {
      return { name: 'Periodic Maintenance', status: 'skipped', detail: `Already current (${ageDays}d ago)` };
    }
  }

  if (dryRun) {
    return { name: 'Periodic Maintenance', status: 'done', detail: 'Would run daily/weekly/monthly maintenance' };
  }

  const result = runSudo('periodic daily weekly monthly', 30000);
  return {
    name: 'Periodic Maintenance',
    status: result.ok ? 'done' : 'failed',
    detail: result.ok ? 'Triggered daily/weekly/monthly scripts' : 'Need sudo access',
  };
}

async function optSavedStateCleanup(dryRun: boolean): Promise<OptimizeResult> {
  const savedStateDir = join(homedir(), 'Library', 'Saved Application State');
  if (!(await exists(savedStateDir))) {
    return { name: 'Saved State', status: 'skipped', detail: 'No saved state directory' };
  }

  let totalSize = 0;
  let count = 0;

  try {
    const entries = await readdir(savedStateDir);
    for (const entry of entries) {
      if (entry.startsWith('com.apple.')) continue; // keep system app states

      const fullPath = join(savedStateDir, entry);
      try {
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          const sizeOutput = run(`du -sk "${fullPath}" 2>/dev/null | cut -f1`);
          const kb = parseInt(sizeOutput.output, 10) || 0;
          totalSize += kb * 1024;
          count++;

          if (!dryRun) {
            await rm(fullPath, { recursive: true, force: true });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (count === 0) {
    return { name: 'Saved State', status: 'skipped', detail: 'No old saved states' };
  }

  return {
    name: 'Saved State',
    status: 'done',
    detail: dryRun
      ? `Would remove ${count} saved state(s) (${formatSize(totalSize)})`
      : `Removed ${count} saved state(s) (${formatSize(totalSize)})`,
  };
}

async function optDockRefresh(dryRun: boolean): Promise<OptimizeResult> {
  if (dryRun) {
    return { name: 'Dock Refresh', status: 'done', detail: 'Would refresh Dock' };
  }

  // Clean Dock cache databases
  const dockSupport = join(homedir(), 'Library', 'Application Support', 'Dock');
  if (await exists(dockSupport)) {
    try {
      const entries = await readdir(dockSupport);
      for (const entry of entries) {
        if (entry.endsWith('.db')) {
          try { await rm(join(dockSupport, entry), { force: true }); } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  run('killall Dock 2>/dev/null');

  return { name: 'Dock Refresh', status: 'done', detail: 'Dock cache cleared and restarted' };
}

async function optSpotlightCheck(dryRun: boolean): Promise<OptimizeResult> {
  const mdutilOutput = run('mdutil -s / 2>/dev/null');

  if (mdutilOutput.output.toLowerCase().includes('indexing disabled')) {
    return { name: 'Spotlight', status: 'skipped', detail: 'Indexing is disabled' };
  }

  // Quick benchmark Spotlight
  const start = Date.now();
  run("mdfind \"kMDItemFSName == 'Applications'\" 2>/dev/null", 5000);
  const duration = Date.now() - start;

  if (duration < 3000) {
    return { name: 'Spotlight', status: 'skipped', detail: `Index OK (${(duration / 1000).toFixed(1)}s response)` };
  }

  if (dryRun) {
    return { name: 'Spotlight', status: 'done', detail: 'Would rebuild Spotlight index (slow search detected)' };
  }

  const result = runSudo('mdutil -E / 2>/dev/null', 15000);
  return {
    name: 'Spotlight',
    status: result.ok ? 'done' : 'failed',
    detail: result.ok ? 'Index rebuild started (will complete in background, 1-2 hours)' : 'Need sudo access',
  };
}

// ═══════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════

export async function optimizeCommand(options: OptimizeCommandOptions): Promise<void> {
  const dryRun = options.dryRun ?? false;

  console.log(chalk.cyan(`\n⚡ System Optimization ${dryRun ? chalk.yellow('[DRY RUN]') : ''}\n`));

  if (!options.yes && !dryRun) {
    const proceed = await confirm({
      message: 'This will optimize your system (some tasks need sudo). Proceed?',
      default: true,
    });
    if (!proceed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }
  }

  const ora = (await import('ora')).default;
  const spinner = ora('Optimizing...').start();

  const tasks: Array<{ name: string; fn: (dryRun: boolean) => Promise<OptimizeResult> }> = [
    { name: 'DNS Cache', fn: optDNSFlush },
    { name: 'Memory', fn: optMemoryPurge },
    { name: 'Font Cache', fn: optFontCacheRebuild },
    { name: 'Launch Services', fn: optLaunchServicesRebuild },
    { name: 'Quarantine', fn: optQuarantineCleanup },
    { name: 'Preferences', fn: optBrokenPlistCleanup },
    { name: 'Launch Agents', fn: optOrphanedLaunchAgents },
    { name: 'Saved State', fn: optSavedStateCleanup },
    { name: 'Dock', fn: optDockRefresh },
    { name: 'Spotlight', fn: optSpotlightCheck },
    { name: 'Periodic Maintenance', fn: optPeriodicMaintenance },
  ];

  const results: OptimizeResult[] = [];

  for (const task of tasks) {
    spinner.text = `Optimizing ${task.name}...`;
    const result = await task.fn(dryRun);
    results.push(result);
  }

  spinner.succeed('Optimization complete\n');

  // JSON output
  if (options.json) {
    console.log(JSON.stringify({ dryRun, results }, null, 2));
    return;
  }

  // ─── Render Results ────────────────────────────

  console.log(chalk.bold('⚡ Optimization Results'));
  console.log(chalk.dim('━'.repeat(60)));

  for (const result of results) {
    let icon: string;
    switch (result.status) {
      case 'done': icon = chalk.green('✅'); break;
      case 'skipped': icon = chalk.dim('⏭️ '); break;
      case 'failed': icon = chalk.red('❌'); break;
    }

    const name = result.name.padEnd(22);
    console.log(`  ${icon} ${chalk.bold(name)} ${chalk.dim(result.detail)}`);
  }

  // ─── Summary ───────────────────────────────────

  const done = results.filter(r => r.status === 'done').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed = results.filter(r => r.status === 'failed').length;

  console.log(chalk.dim('\n━'.repeat(60)));
  console.log(
    `\n  📊 ${chalk.green(`${done} completed`)}` +
    (skipped > 0 ? ` · ${chalk.dim(`${skipped} skipped`)}` : '') +
    (failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : '')
  );

  if (dryRun) {
    console.log(chalk.yellow('\n  [DRY RUN] No changes were made. Remove --dry-run to execute.'));
  }

  console.log();
}
