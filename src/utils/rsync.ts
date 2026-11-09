import { execSync, spawn } from 'child_process';
import { lstat } from 'fs/promises';
import { join, basename } from 'path';
import { exists, getDirectorySize } from './index.js';

export interface VolumeInfo {
  total: number;
  available: number;
  mountPoint: string;
}

/**
 * Gets capacity and free space information for the filesystem hosting targetPath.
 */
export function getVolumeInfo(targetPath: string): VolumeInfo {
  try {
    const output = execSync(`df -k "${targetPath}" 2>/dev/null | tail -1`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const parts = output.split(/\s+/);
    if (parts.length >= 6) {
      const total = parseInt(parts[1], 10) * 1024;
      const available = parseInt(parts[3], 10) * 1024;
      // In macOS df -k, mount point is column 9 (or last column)
      const mountPoint = parts.slice(8).join(' ') || parts[5];
      return { total, available, mountPoint };
    }
  } catch {
    // fallback
  }

  return { total: 0, available: 0, mountPoint: targetPath };
}

export interface RsyncOptions {
  dryRun?: boolean;
  verifyChecksum?: boolean;
  onProgress?: (output: string) => void;
}

export interface RsyncResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Executes rsync with metadata and integrity preservation flags.
 */
export async function executeRsync(
  sourcePath: string,
  destinationDir: string,
  options: RsyncOptions = {}
): Promise<RsyncResult> {
  const { dryRun = false, verifyChecksum = true, onProgress } = options;

  const args = ['-aHvhP', '--stats'];
  if (verifyChecksum) {
    args.push('--checksum');
  }
  if (dryRun) {
    args.push('--dry-run');
  }

  args.push(sourcePath, destinationDir);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('rsync', args);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onProgress?.(text);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        error: code === 0 ? undefined : stderr || `rsync exited with code ${code}`,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        error: err.message,
      });
    });
  });
}

/**
 * Post-transfer integrity check comparing file sizes and existence.
 */
export async function verifyIntegrity(
  sourcePath: string,
  destinationDir: string
): Promise<{ ok: boolean; sourceBytes: number; destBytes: number; reason?: string }> {
  try {
    const itemBasename = basename(sourcePath);
    const destItemPath = join(destinationDir, itemBasename);

    if (!(await exists(destItemPath))) {
      return { ok: false, sourceBytes: 0, destBytes: 0, reason: `Target missing at ${destItemPath}` };
    }

    const srcStat = await lstat(sourcePath);
    const dstStat = await lstat(destItemPath);

    let srcSize = 0;
    let dstSize = 0;

    if (srcStat.isDirectory()) {
      srcSize = await getDirectorySize(sourcePath);
      dstSize = await getDirectorySize(destItemPath);
    } else {
      srcSize = srcStat.size;
      dstSize = dstStat.size;
    }

    if (srcSize !== dstSize) {
      return {
        ok: false,
        sourceBytes: srcSize,
        destBytes: dstSize,
        reason: `Size mismatch: source ${srcSize} bytes vs destination ${dstSize} bytes`,
      };
    }

    return { ok: true, sourceBytes: srcSize, destBytes: dstSize };
  } catch (err: unknown) {
    return { ok: false, sourceBytes: 0, destBytes: 0, reason: (err as Error)?.message || 'Verification error' };
  }
}
