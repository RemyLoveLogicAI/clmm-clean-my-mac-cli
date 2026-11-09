import { execSync } from 'child_process';
import { homedir } from 'os';

/**
 * Retrieves the last accessed/used date of a file or directory using Spotlight metadata (mdls),
 * falling back to BSD stat access time.
 */
export function getLastUsedDate(filePath: string): Date | null {
  const resolved = filePath.replace(/^~/, homedir());

  // 1. Try Spotlight metadata (kMDItemLastUsedDate)
  try {
    const output = execSync(`mdls -name kMDItemLastUsedDate -raw "${resolved}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (output && output !== '(null)' && output !== '') {
      const date = new Date(output);
      if (!isNaN(date.getTime())) return date;
    }
  } catch {
    // Spotlight unavailable or path not indexed
  }

  // 2. Try BSD stat access time (atime)
  try {
    const output = execSync(`stat -f "%Sa" -t "%Y-%m-%dT%H:%M:%S" "${resolved}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (output) {
      const date = new Date(output);
      if (!isNaN(date.getTime())) return date;
    }
  } catch {
    // Fall back to mtime via node stat
  }

  return null;
}

/**
 * Searches for stale files using Spotlight mdfind within a specific directory.
 */
export function findStaleFilesSpotlight(
  searchDir: string,
  daysStale: number,
  minSizeBytes: number
): string[] {
  const resolved = searchDir.replace(/^~/, homedir());
  try {
    const days = Math.max(1, Math.floor(daysStale));
    const query = `-onlyin "${resolved}" 'kMDItemFSSize >= ${minSizeBytes} && kMDItemLastUsedDate < $time.now(-${days}d)'`;
    const output = execSync(`mdfind ${query} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Tiering classification for files and directories based on recency.
 */
export type StorageTier = 'active' | 'warm' | 'cold' | 'frozen';

export function classifyRecency(lastUsed: Date | null, coldDays = 90): StorageTier {
  if (!lastUsed) return 'cold';

  const now = Date.now();
  const diffDays = Math.floor((now - lastUsed.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 30) return 'active';
  if (diffDays <= coldDays) return 'warm';
  if (diffDays <= 180) return 'cold';
  return 'frozen';
}
