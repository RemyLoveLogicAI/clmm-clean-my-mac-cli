import chalk from 'chalk';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { formatSize } from '../utils/index.js';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'critical';
  value: string;
  detail?: string;
}

// HealthReport type reserved for future JSON export

// ═══════════════════════════════════════════════════
// Helper: Run command safely
// ═══════════════════════════════════════════════════

function run(cmd: string, timeout = 5000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════
// Individual Health Checks
// ═══════════════════════════════════════════════════

function checkDiskSpace(): HealthCheck {
  const output = run("df -k / | tail -1 | awk '{print $4}'");
  const freeKB = parseInt(output, 10);
  const freeGB = freeKB / 1024 / 1024;

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (freeGB < 20) status = 'critical';
  else if (freeGB < 50) status = 'warn';

  return {
    name: 'Disk Space',
    status,
    value: `${freeGB.toFixed(1)} GB free`,
    detail: status === 'critical' ? 'Critical — back up and free space immediately' : undefined,
  };
}

function checkMemoryUsage(): HealthCheck {
  const memTotal = parseInt(run('sysctl -n hw.memsize'), 10);
  if (!memTotal || memTotal <= 0) {
    return { name: 'Memory', status: 'ok', value: 'Unable to determine' };
  }

  const vmOutput = run('vm_stat');
  const pageSize = parseInt(vmOutput.match(/page size of (\d+)/)?.[1] ?? '4096', 10);
  const freePages = parseInt(vmOutput.match(/Pages free:\s+(\d+)/)?.[1] ?? '0', 10);
  const inactivePages = parseInt(vmOutput.match(/Pages inactive:\s+(\d+)/)?.[1] ?? '0', 10);
  const specPages = parseInt(vmOutput.match(/Pages speculative:\s+(\d+)/)?.[1] ?? '0', 10);

  const totalPages = Math.floor(memTotal / pageSize);
  const freeTotal = freePages + inactivePages + specPages;
  const usedPercent = Math.min(100, Math.max(0, Math.round(((totalPages - freeTotal) / totalPages) * 100)));

  const totalGB = (memTotal / 1024 / 1024 / 1024).toFixed(0);
  const usedGB = ((memTotal * usedPercent / 100) / 1024 / 1024 / 1024).toFixed(1);

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (usedPercent > 90) status = 'critical';
  else if (usedPercent > 80) status = 'warn';

  return {
    name: 'Memory',
    status,
    value: `${usedPercent}% used (${usedGB} / ${totalGB} GB)`,
  };
}

function checkSwapUsage(): HealthCheck {
  const output = run('sysctl vm.swapusage');
  // Match formats like: used = 9120.94M  or  used = 2.50G
  const usedMatch = output.match(/used\s*=\s*([\d.]+)([MG])/i);

  if (!usedMatch) {
    return { name: 'Swap', status: 'ok', value: '0 MB' };
  }

  let valueMB = parseFloat(usedMatch[1]);
  const unit = usedMatch[2].toUpperCase();

  // Normalize to MB for comparison
  if (unit === 'G') valueMB *= 1024;

  // Display in appropriate unit
  let displayVal: string;
  if (valueMB >= 1024) {
    displayVal = `${(valueMB / 1024).toFixed(1)} GB`;
  } else {
    displayVal = `${Math.round(valueMB)} MB`;
  }

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (valueMB > 4096) status = 'critical';    // > 4 GB
  else if (valueMB > 2048) status = 'warn';    // > 2 GB

  return {
    name: 'Swap',
    status,
    value: displayVal,
    detail: status !== 'ok' ? 'High swap usage indicates memory pressure' : undefined,
  };
}

function checkLoginItems(): HealthCheck {
  // Try osascript to get login items count
  const output = run(
    'osascript -e \'tell application "System Events" to get the name of every login item\' 2>/dev/null',
    8000,
  );

  let count = 0;
  let items: string[] = [];
  if (output && output !== '') {
    items = output.split(', ').filter(Boolean);
    count = items.length;
  }

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (count > 15) status = 'warn';

  const preview = items.slice(0, 3).join(', ');
  const more = count > 3 ? ` +${count - 3} more` : '';

  return {
    name: 'Login Items',
    status,
    value: `${count} apps`,
    detail: count > 0 ? `${preview}${more}` : undefined,
  };
}

function checkDiskSMART(): HealthCheck {
  const output = run("diskutil info disk0 | awk -F: '/SMART Status/ {gsub(/^[ \\t]+/, \"\", $2); print $2}'");

  if (!output) {
    return { name: 'Disk Health', status: 'ok', value: 'N/A' };
  }

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (output === 'Failing') status = 'critical';
  else if (output !== 'Verified') status = 'warn';

  return {
    name: 'Disk Health',
    status,
    value: `SMART ${output}`,
    detail: status === 'critical' ? 'BACK UP IMMEDIATELY — disk is failing!' : undefined,
  };
}

function checkCacheSize(): HealthCheck {
  const home = homedir();
  let totalKB = 0;

  for (const dir of [`${home}/Library/Caches`, `${home}/Library/Logs`]) {
    const output = run(`du -sk "${dir}" 2>/dev/null | cut -f1`, 30000);
    const kb = parseInt(output, 10);
    if (!isNaN(kb)) totalKB += kb;
  }

  const totalBytes = totalKB * 1024;
  const totalGB = totalKB / 1024 / 1024;

  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (totalGB > 10) status = 'warn';
  else if (totalGB > 5) status = 'warn';

  return {
    name: 'Cache Size',
    status,
    value: `${formatSize(totalBytes)} cleanable`,
    detail: status !== 'ok' ? 'Run `clmm` to clean caches' : undefined,
  };
}

function checkSIP(): HealthCheck {
  const output = run('csrutil status 2>/dev/null');
  const enabled = output.includes('enabled');
  return {
    name: 'SIP',
    status: enabled ? 'ok' : 'warn',
    value: enabled ? 'Enabled' : 'Disabled',
    detail: !enabled ? 'System Integrity Protection is disabled — security risk' : undefined,
  };
}

function checkFileVault(): HealthCheck {
  const output = run('fdesetup status 2>/dev/null');
  const on = output.includes('On');
  return {
    name: 'FileVault',
    status: on ? 'ok' : 'warn',
    value: on ? 'On' : 'Off',
    detail: !on ? 'Disk is not encrypted — enable FileVault in System Preferences' : undefined,
  };
}

function checkGatekeeper(): HealthCheck {
  const output = run('spctl --status 2>/dev/null');
  const enabled = output.includes('enabled');
  return {
    name: 'Gatekeeper',
    status: enabled ? 'ok' : 'warn',
    value: enabled ? 'Active' : 'Disabled',
  };
}

function checkMacOSUpdates(): HealthCheck {
  const output = run('softwareupdate -l 2>&1', 10000);
  const hasUpdates = output.includes('*') || output.toLowerCase().includes('available');
  const noUpdates = output.includes('No new software available');

  return {
    name: 'macOS Updates',
    status: noUpdates ? 'ok' : hasUpdates ? 'warn' : 'ok',
    value: noUpdates ? 'Up to date' : hasUpdates ? 'Updates available' : 'Up to date',
    detail: hasUpdates ? 'Run `softwareupdate -i -a` to install' : undefined,
  };
}

// ═══════════════════════════════════════════════════
// Health Score Calculation
// ═══════════════════════════════════════════════════

function calculateHealthScore(checks: HealthCheck[]): { score: number; message: string } {
  let score = 100;

  for (const check of checks) {
    if (check.status === 'critical') {
      score -= 15;
    } else if (check.status === 'warn') {
      score -= 5;
    }
  }

  score = Math.max(0, Math.min(100, score));

  let message: string;
  if (score >= 90) message = 'Excellent';
  else if (score >= 75) message = 'Good';
  else if (score >= 50) message = 'Fair — some issues need attention';
  else message = 'Poor — critical issues detected';

  return { score, message };
}

// ═══════════════════════════════════════════════════
// Status Icons
// ═══════════════════════════════════════════════════

function statusIcon(status: 'ok' | 'warn' | 'critical'): string {
  switch (status) {
    case 'ok': return chalk.green('✅');
    case 'warn': return chalk.yellow('⚠️ ');
    case 'critical': return chalk.red('❌');
  }
}

function scoreColor(score: number): (text: string) => string {
  if (score >= 90) return chalk.green;
  if (score >= 75) return chalk.yellow;
  return chalk.red;
}

function renderScoreBar(score: number): string {
  const total = 20;
  const filled = Math.round((score / 100) * total);
  const empty = total - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return scoreColor(score)(bar);
}

// ═══════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════

export async function checkCommand(options: { json?: boolean }): Promise<void> {
  console.log(chalk.cyan('\n🩺 Running System Health Check...\n'));

  const ora = (await import('ora')).default;
  const spinner = ora('Checking system health...').start();

  const checks: HealthCheck[] = [];

  const runners: Array<{ name: string; fn: () => HealthCheck }> = [
    { name: 'Disk Space', fn: checkDiskSpace },
    { name: 'Memory', fn: checkMemoryUsage },
    { name: 'Swap', fn: checkSwapUsage },
    { name: 'Login Items', fn: checkLoginItems },
    { name: 'Disk SMART', fn: checkDiskSMART },
    { name: 'Cache Size', fn: checkCacheSize },
    { name: 'SIP', fn: checkSIP },
    { name: 'FileVault', fn: checkFileVault },
    { name: 'Gatekeeper', fn: checkGatekeeper },
    { name: 'macOS Updates', fn: checkMacOSUpdates },
  ];

  for (const runner of runners) {
    spinner.text = `Checking ${runner.name}...`;
    checks.push(runner.fn());
  }

  const { score, message } = calculateHealthScore(checks);

  spinner.succeed('Health check complete\n');

  // JSON output
  if (options.json) {
    console.log(JSON.stringify({
      checks: checks.map(c => ({
        name: c.name,
        status: c.status,
        value: c.value,
        detail: c.detail,
      })),
      score,
      message,
    }, null, 2));
    return;
  }

  // ─── Render Report ─────────────────────────────

  console.log(chalk.bold('🩺 System Health Report'));
  console.log(chalk.dim('━'.repeat(55)));

  for (const check of checks) {
    const icon = statusIcon(check.status);
    const name = check.name.padEnd(16);
    const value = check.value;

    console.log(`  ${icon} ${chalk.bold(name)} ${value}`);

    if (check.detail) {
      console.log(`${' '.repeat(7)}${chalk.dim(check.detail)}`);
    }
  }

  // ─── Score ─────────────────────────────────────

  const issues = checks.filter(c => c.status !== 'ok');
  const color = scoreColor(score);

  console.log(chalk.dim('\n━'.repeat(55)));
  console.log(`\n  ${renderScoreBar(score)}  ${color(`${score}/100`)} — ${color(message)}`);

  if (issues.length > 0) {
    console.log(chalk.dim(`\n  💡 ${issues.length} issue(s) detected. Run ${chalk.cyan('clmm optimize')} to auto-fix.`));
  } else {
    console.log(chalk.green('\n  ✨ Your Mac is in great shape!'));
  }

  console.log();
}
