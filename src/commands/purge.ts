import chalk from 'chalk';
import checkbox from '@inquirer/checkbox';
import confirm from '@inquirer/confirm';
import { readdir } from 'fs/promises';
import { statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { formatSize, exists } from '../utils/index.js';

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface BuildArtifact {
  projectName: string;
  projectPath: string;
  artifactType: string;
  artifactPath: string;
  size: number;
  lastModified: Date | null;
}

interface PurgeCommandOptions {
  scanPath?: string;
  dryRun?: boolean;
  json?: boolean;
  olderThan?: number;  // days — only show artifacts older than N days
  auto?: boolean;      // auto-delete all matching items (skip interactive)
}

// ═══════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════

const ARTIFACT_PATTERNS: Array<{ name: string; dirName: string; language: string }> = [
  // JavaScript/Node
  { name: 'node_modules', dirName: 'node_modules', language: 'Node.js' },
  { name: 'bower_components', dirName: 'bower_components', language: 'Bower' },
  { name: '.yarn', dirName: '.yarn', language: 'Yarn' },
  { name: '.pnpm-store', dirName: '.pnpm-store', language: 'pnpm' },

  // Python
  { name: '.venv', dirName: '.venv', language: 'Python venv' },
  { name: 'venv', dirName: 'venv', language: 'Python venv' },
  { name: '__pycache__', dirName: '__pycache__', language: 'Python' },
  { name: '.pytest_cache', dirName: '.pytest_cache', language: 'Python' },
  { name: '.mypy_cache', dirName: '.mypy_cache', language: 'Python' },
  { name: '.ruff_cache', dirName: '.ruff_cache', language: 'Python' },
  { name: '.tox', dirName: '.tox', language: 'Python' },
  { name: '.eggs', dirName: '.eggs', language: 'Python' },
  { name: 'htmlcov', dirName: 'htmlcov', language: 'Python' },
  { name: '.ipynb_checkpoints', dirName: '.ipynb_checkpoints', language: 'Jupyter' },

  // Ruby
  { name: 'vendor', dirName: 'vendor', language: 'Ruby' },
  { name: '.bundle', dirName: '.bundle', language: 'Ruby' },

  // Rust / Java / Gradle
  { name: 'target', dirName: 'target', language: 'Rust/Java' },
  { name: '.gradle', dirName: '.gradle', language: 'Gradle' },
  { name: 'out', dirName: 'out', language: 'Java' },

  // Build outputs (General)
  { name: 'build', dirName: 'build', language: 'Build output' },
  { name: 'dist', dirName: 'dist', language: 'Build output' },
  { name: '.build', dirName: '.build', language: 'Swift' },

  // Frontend frameworks
  { name: '.next', dirName: '.next', language: 'Next.js' },
  { name: '.nuxt', dirName: '.nuxt', language: 'Nuxt.js' },
  { name: '.output', dirName: '.output', language: 'Nuxt 3' },
  { name: '.angular', dirName: '.angular', language: 'Angular' },
  { name: '.svelte-kit', dirName: '.svelte-kit', language: 'SvelteKit' },
  { name: '.astro', dirName: '.astro', language: 'Astro' },
  { name: '.docusaurus', dirName: '.docusaurus', language: 'Docusaurus' },
  { name: '.parcel-cache', dirName: '.parcel-cache', language: 'Parcel' },
  { name: '.turbo', dirName: '.turbo', language: 'Turborepo' },
  { name: '.vite', dirName: '.vite', language: 'Vite' },
  { name: '.nx', dirName: '.nx', language: 'Nx' },

  // Coverage
  { name: 'coverage', dirName: 'coverage', language: 'Coverage' },
  { name: '.coverage', dirName: '.coverage', language: 'Coverage' },
  { name: '.nyc_output', dirName: '.nyc_output', language: 'NYC' },

  // Apple / Mobile
  { name: 'DerivedData', dirName: 'DerivedData', language: 'Xcode' },
  { name: 'Pods', dirName: 'Pods', language: 'CocoaPods' },
  { name: 'Carthage', dirName: 'Carthage', language: 'Carthage' },
  { name: '.dart_tool', dirName: '.dart_tool', language: 'Dart' },

  // Infrastructure
  { name: '.terraform', dirName: '.terraform', language: 'Terraform' },
];

const DEFAULT_SCAN_PATHS = [
  join(homedir(), 'Documents', 'Code'),
  join(homedir(), 'Projects'),
  join(homedir(), 'Developer'),
  join(homedir(), 'Code'),
  join(homedir(), 'dev'),
  join(homedir(), 'GitHub'),
  join(homedir(), 'workspace'),
];

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

function getDirModTime(dirPath: string): Date | null {
  try {
    const stats = statSync(dirPath);
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Recursively scan for build artifact directories
 */
async function scanForArtifacts(
  rootPath: string,
  maxDepth = 4,
  onProgress?: (found: number, scanning: string) => void,
  currentDepth = 0,
): Promise<BuildArtifact[]> {
  if (currentDepth > maxDepth) return [];

  const artifacts: BuildArtifact[] = [];

  try {
    const entries = await readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && !ARTIFACT_PATTERNS.some(p => p.dirName === entry.name)) continue;

      const fullPath = join(rootPath, entry.name);

      // Check if this dir itself is a known artifact
      const matchedPattern = ARTIFACT_PATTERNS.find(p => p.dirName === entry.name);

      if (matchedPattern) {
        const size = getDirSize(fullPath);
        if (size > 1024 * 1024) { // Only report >1MB
          const projectPath = rootPath;
          const projectName = basename(rootPath);

          onProgress?.(artifacts.length + 1, projectName);

          artifacts.push({
            projectName,
            projectPath,
            artifactType: matchedPattern.name,
            artifactPath: fullPath,
            size,
            lastModified: getDirModTime(fullPath),
          });
        }
        // Don't recurse into artifact dirs
        continue;
      }

      // Recurse into subdirectories
      const subArtifacts = await scanForArtifacts(fullPath, maxDepth, onProgress, currentDepth + 1);
      artifacts.push(...subArtifacts);
    }
  } catch {
    // skip inaccessible directories
  }

  return artifacts;
}

/**
 * Scan for Docker volume data directories (inspired by clean-stack)
 * Parses docker-compose.yml to find bind-mounted volume paths
 */
async function scanDockerVolumes(
  rootPath: string,
  maxDepth = 4,
): Promise<BuildArtifact[]> {
  const artifacts: BuildArtifact[] = [];

  try {
    // Find docker-compose files
    const output = execSync(
      `find "${rootPath}" -maxdepth ${maxDepth} \\( -name "docker-compose.yml" -o -name "docker-compose.yaml" -o -name "compose.yml" -o -name "compose.yaml" \\) -type f 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!output) return artifacts;

    const composeFiles = output.split('\n').filter(Boolean);

    for (const composeFile of composeFiles) {
      const projectDir = join(composeFile, '..');
      const projectName = basename(projectDir);

      // Look for common Docker data directories relative to compose file
      const dockerDataDirs = ['data', 'volumes', 'docker-data', 'db-data', 'mysql-data', 'postgres-data', 'redis-data', 'mongo-data'];

      for (const dirName of dockerDataDirs) {
        const volumePath = join(projectDir, dirName);
        if (await exists(volumePath)) {
          const size = getDirSize(volumePath);
          if (size > 10 * 1024 * 1024) { // Only report >10MB Docker volumes
            artifacts.push({
              projectName,
              projectPath: projectDir,
              artifactType: `docker:${dirName}`,
              artifactPath: volumePath,
              size,
              lastModified: getDirModTime(volumePath),
            });
          }
        }
      }
    }
  } catch {
    // skip if find fails
  }

  return artifacts;
}

/**
 * Remove nested/duplicate artifact paths (from clean-stack)
 */
function deduplicateArtifacts(artifacts: BuildArtifact[]): BuildArtifact[] {
  const sorted = [...artifacts].sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
  const result: BuildArtifact[] = [];

  for (const art of sorted) {
    const isNested = result.some(existing =>
      art.artifactPath.startsWith(existing.artifactPath + '/'),
    );
    if (!isNested) {
      result.push(art);
    }
  }

  return result;
}

/**
 * Format relative time for last modified
 */
function formatAge(date: Date | null): string {
  if (!date) return 'Unknown';
  const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return chalk.green('Today');
  if (diffDays < 7) return chalk.green(`${diffDays}d ago`);
  if (diffDays < 30) return chalk.yellow(`${Math.floor(diffDays / 7)}w ago`);
  if (diffDays < 365) return chalk.red(`${Math.floor(diffDays / 30)}mo ago`);
  return chalk.red(`${Math.floor(diffDays / 365)}y ago`);
}

// ═══════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════

export async function purgeCommand(options: PurgeCommandOptions): Promise<void> {
  console.log(chalk.cyan('\n🗃️  Scanning for build artifacts...\n'));

  const ora = (await import('ora')).default;
  const spinner = ora('Searching project directories...').start();

  // Determine scan paths
  let scanPaths: string[] = [];
  if (options.scanPath) {
    const resolved = options.scanPath.replace('~', homedir());
    if (await exists(resolved)) {
      scanPaths = [resolved];
    } else {
      spinner.fail(`Path not found: ${resolved}`);
      return;
    }
  } else {
    for (const p of DEFAULT_SCAN_PATHS) {
      if (await exists(p)) {
        scanPaths.push(p);
      }
    }
  }

  if (scanPaths.length === 0) {
    spinner.fail('No project directories found. Use --path to specify one.');
    return;
  }

  spinner.text = `Scanning ${scanPaths.length} directories...`;

  // Scan all paths for build artifacts
  let allArtifacts: BuildArtifact[] = [];
  for (const scanPath of scanPaths) {
    const artifacts = await scanForArtifacts(scanPath, 4, (found, name) => {
      spinner.text = `Found ${found + allArtifacts.length} artifacts... (scanning: ${name})`;
    });
    allArtifacts.push(...artifacts);
  }

  // Scan for Docker volumes (inspired by clean-stack)
  spinner.text = 'Scanning Docker volumes...';
  for (const scanPath of scanPaths) {
    const dockerArtifacts = await scanDockerVolumes(scanPath, 4);
    allArtifacts.push(...dockerArtifacts);
  }

  // Deduplicate nested paths (from clean-stack)
  allArtifacts = deduplicateArtifacts(allArtifacts);

  // Sort by size descending
  allArtifacts.sort((a, b) => b.size - a.size);

  // Filter by age if --older-than specified
  const olderThanDays = options.olderThan;
  if (olderThanDays && olderThanDays > 0) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const before = allArtifacts.length;
    allArtifacts = allArtifacts.filter(a =>
      a.lastModified && a.lastModified.getTime() < cutoff,
    );
    const filtered = before - allArtifacts.length;
    if (filtered > 0) {
      console.log(chalk.dim(`  Filtered out ${filtered} artifacts newer than ${olderThanDays} days\n`));
    }
  }

  if (allArtifacts.length === 0) {
    spinner.succeed(olderThanDays
      ? `No artifacts older than ${olderThanDays} days found.`
      : 'No build artifacts found.');
    return;
  }

  const totalSize = allArtifacts.reduce((s, a) => s + a.size, 0);
  spinner.succeed(`Found ${allArtifacts.length} artifacts (${formatSize(totalSize)})\n`);

  // JSON output
  if (options.json) {
    console.log(JSON.stringify(allArtifacts.map(a => ({
      project: a.projectName,
      type: a.artifactType,
      path: a.artifactPath,
      size: a.size,
      lastModified: a.lastModified?.toISOString() ?? null,
    })), null, 2));
    return;
  }

  // ─── Print Table ──────────────────────────────

  console.log(chalk.bold('🗃️  Build Artifacts'));
  console.log(chalk.dim('━'.repeat(80)));
  console.log(
    `${'Project'.padEnd(28)} ${'Type'.padEnd(16)} ${'Size'.padStart(10)}   ${'Modified'.padEnd(10)}`
  );
  console.log(chalk.dim('─'.repeat(28) + ' ' + '─'.repeat(16) + ' ' + '─'.repeat(10) + '   ' + '─'.repeat(10)));

  for (const art of allArtifacts) {
    const project = art.projectName.substring(0, 26).padEnd(28);
    const type = art.artifactType.padEnd(16);
    const size = formatSize(art.size).padStart(10);
    const age = formatAge(art.lastModified);

    console.log(`${project} ${chalk.dim(type)} ${chalk.yellow(size)}   ${age}`);
  }

  console.log(chalk.dim('\n' + '━'.repeat(80)));
  console.log(chalk.bold(`Total: ${formatSize(totalSize)} in ${allArtifacts.length} artifacts\n`));

  if (options.dryRun) {
    console.log(chalk.cyan('[DRY RUN] No files were deleted.\n'));
    return;
  }

  // ─── Auto mode: delete all without interactive picker ───

  if (options.auto) {
    console.log(chalk.bold(`\n🎯 Auto mode: ${allArtifacts.length} artifacts — ${chalk.green(formatSize(totalSize))} will be freed`));

    const proceed = await confirm({
      message: `Permanently delete all ${allArtifacts.length} artifact directories?`,
      default: false,
    });

    if (!proceed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    let freed = 0;
    let errors = 0;
    for (const art of allArtifacts) {
      try {
        process.stdout.write(`  Removing ${art.projectName}/${art.artifactType}...`);
        execSync(`rm -rf "${art.artifactPath}"`, { stdio: 'pipe' });
        freed += art.size;
        console.log(chalk.green(' ✓'));
      } catch {
        console.log(chalk.red(' ✗'));
        errors++;
      }
    }

    console.log(chalk.bold.green(`\n✨ Done! Freed ${formatSize(freed)}`));
    if (errors > 0) console.log(chalk.yellow(`   ${errors} artifacts could not be removed`));
    console.log();
    return;
  }

  // ─── Interactive Selection ─────────────────────

  const autoCheckDays = olderThanDays ?? 7;
  const choices = allArtifacts.map(art => {
    const isOld = art.lastModified && (Date.now() - art.lastModified.getTime()) > autoCheckDays * 24 * 60 * 60 * 1000;
    return {
      name: `${art.projectName.padEnd(25)} ${art.artifactType.padEnd(14)} ${chalk.yellow(formatSize(art.size).padStart(10))}  ${formatAge(art.lastModified)}`,
      value: art.artifactPath,
      checked: isOld ?? false,
    };
  });

  const selected = await checkbox<string>({
    message: 'Select artifacts to delete:',
    choices,
    pageSize: 20,
  });

  if (selected.length === 0) {
    console.log(chalk.yellow('\nNo artifacts selected.\n'));
    return;
  }

  const selectedArtifacts = allArtifacts.filter(a => selected.includes(a.artifactPath));
  const selectedSize = selectedArtifacts.reduce((s, a) => s + a.size, 0);

  console.log(chalk.bold(`\n${selected.length} artifacts selected — ${chalk.green(formatSize(selectedSize))} will be freed`));

  const proceed = await confirm({
    message: `Permanently delete ${selected.length} artifact directories?`,
    default: false,
  });

  if (!proceed) {
    console.log(chalk.yellow('\nCancelled.\n'));
    return;
  }

  // Execute deletion
  let freed = 0;
  let errors = 0;

  for (const art of selectedArtifacts) {
    try {
      process.stdout.write(`  Removing ${art.projectName}/${art.artifactType}...`);
      execSync(`rm -rf "${art.artifactPath}"`, { stdio: 'pipe' });
      freed += art.size;
      console.log(chalk.green(' ✓'));
    } catch {
      console.log(chalk.red(' ✗'));
      errors++;
    }
  }

  console.log(chalk.bold.green(`\n✨ Done! Freed ${formatSize(freed)}`));
  if (errors > 0) {
    console.log(chalk.yellow(`   ${errors} artifacts could not be removed`));
  }
  console.log();
}
