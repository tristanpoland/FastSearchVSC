import * as crypto from 'crypto';
import { DirChildStat, DirHashEntry } from '../types.js';

export class HashManager {
  private dirHashes: Map<string, DirHashEntry> = new Map();

  computeFileHash(content: Uint8Array): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Compute a directory hash from stat metadata of direct children.
   * This hash captures: which files/dirs exist, their sizes, and mtimes.
   * A change anywhere in the subtree (via childDirHashes) bubbles up.
   */
  computeDirStatHash(fileStats: DirChildStat[], childDirHashes: { name: string; hash: string }[]): string {
    const parts: string[] = [];
    const sortedFiles = [...fileStats].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of sortedFiles) {
      parts.push(`F|${f.name}|${f.mtime}|${f.size}`);
    }
    const sortedDirs = [...childDirHashes].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of sortedDirs) {
      parts.push(`D|${d.name}|${d.hash}`);
    }
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  setDirHash(entry: DirHashEntry): void {
    this.dirHashes.set(entry.relativePath, entry);
  }

  getDirHash(relativePath: string): DirHashEntry | undefined {
    return this.dirHashes.get(relativePath);
  }

  getAllDirHashes(): Map<string, DirHashEntry> {
    return this.dirHashes;
  }

  restore(entries: DirHashEntry[]): void {
    this.dirHashes.clear();
    for (const entry of entries) {
      this.dirHashes.set(entry.relativePath, entry);
    }
  }

  clear(): void {
    this.dirHashes.clear();
  }
}
