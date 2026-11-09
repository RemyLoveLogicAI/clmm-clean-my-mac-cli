import { rename, symlink, lstat, rm, readlink } from 'fs/promises';
import { exists } from './index.js';

export interface RelocateAndLinkResult {
  success: boolean;
  error?: string;
  sourcePath: string;
  targetPath: string;
  backupPath?: string;
}

/**
 * Atomically replaces sourceInternal with a symbolic link pointing to destExternal.
 * If any step fails, rolls back to original internal folder.
 */
export async function createAtomicSymlink(
  sourceInternal: string,
  destExternal: string
): Promise<RelocateAndLinkResult> {
  const backupPath = `${sourceInternal}.bak.${Date.now()}`;

  try {
    // 1. Move original directory to temporary backup
    await rename(sourceInternal, backupPath);

    // 2. Create symbolic link in place of sourceInternal pointing to destExternal
    await symlink(destExternal, sourceInternal);

    // 3. Verify symbolic link
    const stats = await lstat(sourceInternal);
    if (!stats.isSymbolicLink()) {
      throw new Error(`Item at ${sourceInternal} is not a symbolic link`);
    }

    const resolvedTarget = await readlink(sourceInternal);
    if (resolvedTarget !== destExternal) {
      throw new Error(`Symlink points to ${resolvedTarget} instead of expected ${destExternal}`);
    }

    // 4. Success: remove backup
    await rm(backupPath, { recursive: true, force: true });

    return {
      success: true,
      sourcePath: sourceInternal,
      targetPath: destExternal,
    };
  } catch (err: unknown) {
    // Rollback if backup exists
    if (await exists(backupPath)) {
      try {
        if (await exists(sourceInternal)) {
          await rm(sourceInternal, { force: true });
        }
        await rename(backupPath, sourceInternal);
      } catch {
        return {
          success: false,
          error: `Symlink failed: ${(err as Error)?.message}. CRITICAL ROLLBACK FAILURE: original saved at ${backupPath}`,
          sourcePath: sourceInternal,
          targetPath: destExternal,
          backupPath,
        };
      }
    }

    return {
      success: false,
      error: (err as Error)?.message || 'Failed to create atomic symlink',
      sourcePath: sourceInternal,
      targetPath: destExternal,
    };
  }
}
