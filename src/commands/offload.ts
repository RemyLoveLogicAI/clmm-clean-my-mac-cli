import chalk from 'chalk';
import confirm from '@inquirer/confirm';
import { lstat, rename, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import {
  formatSize,
  exists,
  getDirectorySize,
  getVolumeInfo,
  executeRsync,
  verifyIntegrity,
  createAtomicSymlink,
  validatePathSafety,
  removeItem,
} from '../utils/index.js';

export interface OffloadCommandOptions {
  destination?: string;
  dryRun?: boolean;
  yes?: boolean;
  delete?: boolean;
  trash?: boolean;
  link?: boolean;
  verify?: boolean;
  json?: boolean;
}

export interface OffloadResult {
  source: string;
  destination: string;
  size: number;
  transferred: boolean;
  verified: boolean;
  linked: boolean;
  deleted: boolean;
  error?: string;
}

export async function offloadCommand(
  sources: string[],
  options: OffloadCommandOptions
): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const shouldVerify = options.verify ?? true;
  const rawDest = options.destination;

  if (!rawDest) {
    console.log(chalk.red('\n❌ Error: Destination path is required. Use --destination <path>\n'));
    console.log(chalk.dim('   Example: managemymac offload ~/Downloads/LargeData --destination "/Volumes/SAMSUNG SSD/Archive"\n'));
    return;
  }

  const destination = rawDest.replace(/^~/, homedir());

  console.log(chalk.cyan(`\n🚀 Intelligent Storage Offload ${dryRun ? chalk.yellow('[DRY RUN]') : ''}`));
  console.log(chalk.dim(`   Destination: ${destination}`));

  // Check destination directory
  if (!dryRun && !(await exists(destination))) {
    try {
      await mkdir(destination, { recursive: true });
    } catch (err: unknown) {
      console.log(chalk.red(`\n❌ Failed to create destination directory: ${(err as Error)?.message}\n`));
      return;
    }
  }

  // Pre-flight: Check destination capacity
  const volInfo = getVolumeInfo(destination);
  if (volInfo.available > 0) {
    console.log(chalk.dim(`   Target Volume: ${volInfo.mountPoint} (${formatSize(volInfo.available)} available)\n`));
  }

  const results: OffloadResult[] = [];
  const ora = (await import('ora')).default;

  for (const rawSource of sources) {
    const source = rawSource.replace(/^~/, homedir());

    if (!(await exists(source))) {
      console.log(chalk.red(`\n❌ Source path not found: ${source}`));
      results.push({
        source,
        destination,
        size: 0,
        transferred: false,
        verified: false,
        linked: false,
        deleted: false,
        error: 'Source not found',
      });
      continue;
    }

    // Safety validation
    const safetyCheck = validatePathSafety(source);
    if (safetyCheck) {
      console.log(chalk.red(`\n❌ Safety violation: ${safetyCheck}`));
      results.push({
        source,
        destination,
        size: 0,
        transferred: false,
        verified: false,
        linked: false,
        deleted: false,
        error: safetyCheck,
      });
      continue;
    }

    const sStat = await lstat(source);
    const size = sStat.isDirectory() ? await getDirectorySize(source) : sStat.size;

    console.log(chalk.bold(`\n📦 Source: ${source.replace(homedir(), '~')} (${formatSize(size)})`));

    // Capacity verification
    if (volInfo.available > 0 && volInfo.available < size * 1.05) {
      console.log(chalk.red(`❌ Insufficient space on target volume (${formatSize(volInfo.available)} < ${formatSize(size)})`));
      results.push({
        source,
        destination,
        size,
        transferred: false,
        verified: false,
        linked: false,
        deleted: false,
        error: 'Insufficient space on destination volume',
      });
      continue;
    }

    if (!options.yes && !dryRun) {
      const ok = await confirm({
        message: `Offload "${basename(source)}" (${formatSize(size)}) to "${destination}"?`,
        default: true,
      });
      if (!ok) {
        console.log(chalk.yellow('Skipped.'));
        continue;
      }
    }

    const spinner = ora('Transferring via rsync with checksum integrity...').start();

    // 1. Transfer
    const rsyncRes = await executeRsync(source, destination, {
      dryRun,
      verifyChecksum: shouldVerify,
      onProgress: (line) => {
        const match = line.match(/(\d+%\s+[\d.]+[KMG]?B\/s)/);
        if (match) {
          spinner.text = `Transferring: ${match[1]}`;
        }
      },
    });

    if (!rsyncRes.success) {
      spinner.fail(`Transfer failed: ${rsyncRes.error}`);
      results.push({
        source,
        destination,
        size,
        transferred: false,
        verified: false,
        linked: false,
        deleted: false,
        error: rsyncRes.error,
      });
      continue;
    }

    spinner.succeed('Transfer complete');

    // 2. Verification
    let isVerified = !shouldVerify || dryRun;
    if (shouldVerify && !dryRun) {
      const verifySpinner = ora('Verifying payload integrity...').start();
      const integrity = await verifyIntegrity(source, destination);
      if (!integrity.ok) {
        verifySpinner.fail(`Verification failed: ${integrity.reason}`);
        results.push({
          source,
          destination,
          size,
          transferred: true,
          verified: false,
          linked: false,
          deleted: false,
          error: integrity.reason,
        });
        continue;
      }
      verifySpinner.succeed(`Integrity verified (${formatSize(integrity.destBytes)})`);
      isVerified = true;
    }

    const destItemPath = join(destination, basename(source));
    let isLinked = false;
    let isDeleted = false;

    // 3. Optional Symlink
    if (options.link && !dryRun) {
      const linkSpinner = ora('Creating atomic symlink...').start();
      const linkRes = await createAtomicSymlink(source, destItemPath);
      if (linkRes.success) {
        linkSpinner.succeed(`Created symlink: ${source} -> ${destItemPath}`);
        isLinked = true;
      } else {
        linkSpinner.fail(`Symlink failed: ${linkRes.error}`);
      }
    } else if (options.delete && !dryRun) {
      // 4. Safe Deletion / Trashing of internal original
      const deleteSpinner = ora(options.trash ? 'Moving internal original to Trash...' : 'Purging internal original...').start();
      if (options.trash) {
        try {
          const trashTarget = join(homedir(), '.Trash', `${basename(source)}.${Date.now()}`);
          await rename(source, trashTarget);
          deleteSpinner.succeed(`Moved original to Trash (${trashTarget})`);
          isDeleted = true;
        } catch (tErr: unknown) {
          deleteSpinner.fail(`Failed to move to Trash: ${(tErr as Error)?.message}`);
        }
      } else {
        const removed = await removeItem(source);
        if (removed) {
          deleteSpinner.succeed(`Purged internal copy (${formatSize(size)} freed)`);
          isDeleted = true;
        } else {
          deleteSpinner.fail('Failed to purge internal copy');
        }
      }
    }

    results.push({
      source,
      destination,
      size,
      transferred: true,
      verified: isVerified,
      linked: isLinked,
      deleted: isDeleted,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Summary
  console.log(chalk.bold('\n📊 Offload Summary:'));
  console.log(chalk.dim('━'.repeat(60)));
  const successful = results.filter((r) => r.transferred && r.verified);
  const totalOffloaded = successful.reduce((acc, r) => acc + r.size, 0);

  console.log(`  ${chalk.green('✓ Successful:')} ${successful.length} of ${sources.length} items`);
  console.log(`  ${chalk.yellow('💾 Data Offloaded:')} ${formatSize(totalOffloaded)}`);

  if (dryRun) {
    console.log(chalk.yellow('\n  [DRY RUN] No files were copied or deleted. Run without --dry-run to execute.'));
  }
  console.log();
}
