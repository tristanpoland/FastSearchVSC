import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry, IndexStatus, SearchRequest, SearchResult, SearchResultCallback, DirChildStat, DirHashEntry } from '../types.js';
import { FileWalker } from './FileWalker.js';
import { HashManager } from './HashManager.js';
import { InvertedIndex } from './InvertedIndex.js';
import { IndexSerializer } from './IndexSerializer.js';
import { SearchEngine } from '../search/SearchEngine.js';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala', '.r': 'r',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.svg': 'xml', '.md': 'markdown', '.mdx': 'markdown',
  '.sql': 'sql', '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript',
  '.ps1': 'powershell', '.bat': 'bat', '.cmd': 'bat',
  '.lua': 'lua', '.dart': 'dart', '.vue': 'vue', '.svelte': 'svelte',
  '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf',
  '.dockerfile': 'dockerfile', '.makefile': 'makefile',
  '.gitignore': 'ignore', '.env': 'dotenv', '.ini': 'ini', '.cfg': 'ini',
  '.txt': 'plaintext', '.log': 'log', '.csv': 'csv',
};

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (LANGUAGE_MAP[ext]) {
    return LANGUAGE_MAP[ext];
  }
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  if (basename === 'cmakelists.txt') return 'cmake';
  return 'plaintext';
}

function countLines(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export class IndexManager implements vscode.Disposable {
  private index: InvertedIndex;
  private hashManager: HashManager;
  private serializer: IndexSerializer;
  private searchEngine: SearchEngine | undefined;
  private walker: FileWalker | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private statusEmitter = new vscode.EventEmitter<IndexStatus>();
  public onStatusChange = this.statusEmitter.event;
  private currentStatus: IndexStatus = { status: 'building', progress: 0, fileCount: 0 };
  private workspaceRoot: vscode.Uri | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.index = new InvertedIndex();
    this.hashManager = new HashManager();

    const folders = vscode.workspace.workspaceFolders;
    const storageUri = folders && folders.length > 0
      ? vscode.Uri.joinPath(folders[0].uri, '.vscode', 'fastsearch')
      : vscode.Uri.joinPath(context.globalStorageUri, 'fallback');
    this.serializer = new IndexSerializer(storageUri);
  }

  async initialize(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    this.workspaceRoot = folders[0].uri;

    this.walker = new FileWalker(this.workspaceRoot);
    await this.walker.initialize();

    // Try loading persisted index
    const loaded = await this.serializer.load(this.workspaceRoot.fsPath);
    if (loaded) {
      // Restore from disk — terms + file metadata only (NO file content reads)
      this.index.clear();
      let maxId = 0;
      for (const file of loaded.files) {
        if (file.fileId >= maxId) maxId = file.fileId + 1;
        // Restore just the file entry, not the raw content
        this.index.restoreFile(file, '');
      }
      this.index.setNextFileId(maxId);
      this.index.restoreTerms(loaded.terms);
      this.hashManager.restore(loaded.dirHashes);

      this.rebuildSearchEngine();
      this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });

      // Smart reindex in background — only touches changed dirs
      this.smartReindex();
    } else {
      await this.fullBuild();
    }

    this.startFileWatcher();
  }

  async fullBuild(): Promise<void> {
    if (!this.workspaceRoot || !this.walker) return;

    this.index.clear();
    this.hashManager.clear();
    this.setStatus({ status: 'building', progress: 0, fileCount: 0 });

    let count = 0;

    // Walk all files, index them, collect stat info per directory
    const dirFileStats: Map<string, DirChildStat[]> = new Map();

    for await (const entry of this.walker.walk()) {
      if (entry.isDirectory) continue;

      try {
        const stat = await vscode.workspace.fs.stat(entry.uri);
        if (stat.size > MAX_FILE_SIZE) continue;

        const contentBytes = await vscode.workspace.fs.readFile(entry.uri);
        const content = Buffer.from(contentBytes).toString('utf-8');
        const contentHash = this.hashManager.computeFileHash(contentBytes);
        const language = detectLanguage(entry.relativePath);

        this.index.addFile({
          relativePath: entry.relativePath,
          absolutePath: entry.uri.fsPath,
          language,
          size: stat.size,
          lastModified: stat.mtime,
          contentHash,
          lineCount: countLines(content),
        }, content);

        // Collect stat for dir hash computation
        const dirPath = path.posix.dirname(entry.relativePath);
        const fileName = path.posix.basename(entry.relativePath);
        if (!dirFileStats.has(dirPath)) {
          dirFileStats.set(dirPath, []);
        }
        dirFileStats.get(dirPath)!.push({ name: fileName, mtime: stat.mtime, size: stat.size });

        count++;
        if (count % 50 === 0) {
          this.setStatus({ status: 'building', progress: -1, fileCount: count });
          await new Promise(r => setTimeout(r, 0));
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Build dir hashes bottom-up from stat info
    await this.computeAllDirHashes(this.workspaceRoot, '.');

    this.rebuildSearchEngine();

    await this.serializer.save(this.index, this.hashManager.getAllDirHashes(), this.workspaceRoot.fsPath);
    this.setStatus({ status: 'ready', progress: 100, fileCount: count });
  }

  /**
   * Smart top-down reindex using directory stat hashes.
   *
   * For each directory:
   * 1. Stat direct children (cheap — no file content reads)
   * 2. Use STORED subdir hashes optimistically to compute this dir's hash
   * 3. If hash matches stored → entire subtree unchanged, skip it
   * 4. If hash differs → recurse into subdirs, then compare individual files
   * 5. Only read+reindex files whose mtime/size actually changed
   */
  private async smartReindex(): Promise<void> {
    if (!this.workspaceRoot || !this.walker) return;

    this.setStatus({ status: 'updating', progress: 0, fileCount: this.index.getFileCount() });

    let changed = false;
    const visitedFiles = new Set<string>();

    const processDir = async (dirUri: vscode.Uri, dirRelPath: string): Promise<string> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
      } catch {
        return '';
      }

      const fileStats: DirChildStat[] = [];
      const subdirs: { name: string; uri: vscode.Uri; relPath: string }[] = [];

      // Classify and stat children
      for (const [name, fileType] of entries) {
        const childUri = vscode.Uri.joinPath(dirUri, name);
        const childRelPath = dirRelPath === '.' ? name : dirRelPath + '/' + name;

        if (fileType === vscode.FileType.Directory) {
          if (this.walker!.isIgnored(childRelPath, true)) continue;
          subdirs.push({ name, uri: childUri, relPath: childRelPath });
        } else if (fileType === vscode.FileType.File) {
          if (this.walker!.isIgnored(childRelPath, false)) continue;
          if (this.walker!.isBinaryFile(name)) continue;
          try {
            const stat = await vscode.workspace.fs.stat(childUri);
            if (stat.size <= MAX_FILE_SIZE) {
              fileStats.push({ name, mtime: stat.mtime, size: stat.size });
            }
          } catch { /* skip */ }
        }
      }

      // --- Optimistic check ---
      // Use STORED subdir hashes to compute this dir's hash without recursing
      const storedSubdirHashes = subdirs.map(d => ({
        name: d.name,
        hash: this.hashManager.getDirHash(d.relPath)?.hash ?? '',
      }));
      const optimisticHash = this.hashManager.computeDirStatHash(fileStats, storedSubdirHashes);
      const storedEntry = this.hashManager.getDirHash(dirRelPath);

      if (storedEntry && storedEntry.hash === optimisticHash) {
        // Subtree completely unchanged — skip everything
        // Just record that all files in this subtree were seen (not deleted)
        this.markSubtreeVisited(dirRelPath, visitedFiles);
        return optimisticHash;
      }

      // --- Something changed — recurse into subdirs ---
      const actualSubdirHashes: { name: string; hash: string }[] = [];
      for (const subdir of subdirs) {
        const subHash = await processDir(subdir.uri, subdir.relPath);
        actualSubdirHashes.push({ name: subdir.name, hash: subHash });
      }

      // Recompute hash with actual subdir hashes
      const actualHash = this.hashManager.computeDirStatHash(fileStats, actualSubdirHashes);

      // --- Compare individual files in this directory ---
      const storedFileStats = storedEntry?.childFileStats ?? [];
      const storedStatMap = new Map(storedFileStats.map(s => [s.name, s]));

      for (const fileStat of fileStats) {
        const childRelPath = dirRelPath === '.' ? fileStat.name : dirRelPath + '/' + fileStat.name;
        visitedFiles.add(childRelPath);

        const existing = this.index.findFileByPath(childRelPath);
        const storedStat = storedStatMap.get(fileStat.name);

        // If file existed before with same mtime+size, it hasn't changed
        if (existing && storedStat &&
            storedStat.mtime === fileStat.mtime &&
            storedStat.size === fileStat.size) {
          continue;
        }

        // File is new or changed — read and reindex
        try {
          const childUri = vscode.Uri.joinPath(dirUri, fileStat.name);
          const contentBytes = await vscode.workspace.fs.readFile(childUri);
          const content = Buffer.from(contentBytes).toString('utf-8');
          const contentHash = this.hashManager.computeFileHash(contentBytes);

          // Double-check: content might be same despite mtime change (e.g. git checkout)
          if (existing && existing.contentHash === contentHash) {
            // Update mtime in the entry but don't reindex
            existing.lastModified = fileStat.mtime;
            this.index.setRawContent(existing.fileId, content);
            continue;
          }

          if (existing) {
            this.index.removeFile(existing.fileId);
          }

          const language = detectLanguage(childRelPath);
          this.index.addFile({
            relativePath: childRelPath,
            absolutePath: vscode.Uri.joinPath(dirUri, fileStat.name).fsPath,
            language,
            size: fileStat.size,
            lastModified: fileStat.mtime,
            contentHash,
            lineCount: countLines(content),
          }, content);

          changed = true;
        } catch { /* skip */ }
      }

      // Update stored hash for this dir
      this.hashManager.setDirHash({
        relativePath: dirRelPath,
        hash: actualHash,
        childFileStats: fileStats,
        childDirNames: subdirs.map(d => d.name),
      });

      return actualHash;
    };

    await processDir(this.workspaceRoot, '.');

    // Remove files that no longer exist on disk
    for (const file of Array.from(this.index.getFiles().values())) {
      if (!visitedFiles.has(file.relativePath)) {
        this.index.removeFile(file.fileId);
        changed = true;
      }
    }

    if (changed) {
      this.rebuildSearchEngine();
      await this.serializer.save(this.index, this.hashManager.getAllDirHashes(), this.workspaceRoot!.fsPath);
    }

    this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });
  }

  /**
   * Mark all indexed files within a subtree as "visited" so they aren't
   * treated as deleted during cleanup.
   */
  private markSubtreeVisited(dirRelPath: string, visitedFiles: Set<string>): void {
    const prefix = dirRelPath === '.' ? '' : dirRelPath + '/';
    for (const file of this.index.getFiles().values()) {
      if (prefix === '' || file.relativePath.startsWith(prefix)) {
        visitedFiles.add(file.relativePath);
      }
    }
  }

  /**
   * Recursively compute stat-based dir hashes for the full tree.
   * Used after fullBuild to populate hashManager.
   */
  private async computeAllDirHashes(dirUri: vscode.Uri, dirRelPath: string): Promise<string> {
    if (!this.walker) return '';

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return '';
    }

    const fileStats: DirChildStat[] = [];
    const childDirHashes: { name: string; hash: string }[] = [];
    const childDirNames: string[] = [];

    for (const [name, fileType] of entries) {
      const childUri = vscode.Uri.joinPath(dirUri, name);
      const childRelPath = dirRelPath === '.' ? name : dirRelPath + '/' + name;

      if (fileType === vscode.FileType.Directory) {
        if (this.walker.isIgnored(childRelPath, true)) continue;
        const subHash = await this.computeAllDirHashes(childUri, childRelPath);
        childDirHashes.push({ name, hash: subHash });
        childDirNames.push(name);
      } else if (fileType === vscode.FileType.File) {
        if (this.walker.isIgnored(childRelPath, false)) continue;
        if (this.walker.isBinaryFile(name)) continue;
        try {
          const stat = await vscode.workspace.fs.stat(childUri);
          if (stat.size <= MAX_FILE_SIZE) {
            fileStats.push({ name, mtime: stat.mtime, size: stat.size });
          }
        } catch { /* skip */ }
      }
    }

    const hash = this.hashManager.computeDirStatHash(fileStats, childDirHashes);
    this.hashManager.setDirHash({
      relativePath: dirRelPath,
      hash,
      childFileStats: fileStats,
      childDirNames,
    });

    return hash;
  }

  private rebuildSearchEngine(): void {
    const reader = (fileId: number) => this.readContent(fileId);
    this.searchEngine = new SearchEngine(this.index, reader);
  }

  /**
   * Read file content — from cache if available, otherwise from disk.
   * Caches the result in the index for subsequent reads.
   */
  async readContent(fileId: number): Promise<string | undefined> {
    // Check cache
    const cached = this.index.getRawContent(fileId);
    if (cached !== undefined && cached !== '') return cached;

    // Read from disk
    const file = this.index.getFile(fileId);
    if (!file) return undefined;

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file.absolutePath));
      const content = Buffer.from(bytes).toString('utf-8');
      this.index.setRawContent(fileId, content);
      return content;
    } catch {
      return undefined;
    }
  }

  private startFileWatcher(): void {
    if (!this.workspaceRoot) return;

    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.fileWatcher.onDidChange(uri => this.handleFileChange(uri));
    this.fileWatcher.onDidCreate(uri => this.handleFileChange(uri));
    this.fileWatcher.onDidDelete(uri => this.handleFileDelete(uri));
  }

  private handleFileChange(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(key, setTimeout(async () => {
      this.debounceTimers.delete(key);
      await this.updateSingleFile(uri);
    }, 300));
  }

  private handleFileDelete(uri: vscode.Uri): void {
    if (!this.workspaceRoot) return;
    const relativePath = path.posix.relative(
      this.workspaceRoot.fsPath.replace(/\\/g, '/'),
      uri.fsPath.replace(/\\/g, '/')
    );
    const existing = this.index.findFileByPath(relativePath);
    if (existing) {
      this.index.removeFile(existing.fileId);
      this.rebuildSearchEngine();
      this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });
    }
  }

  private async updateSingleFile(uri: vscode.Uri): Promise<void> {
    if (!this.workspaceRoot) return;

    const relativePath = path.posix.relative(
      this.workspaceRoot.fsPath.replace(/\\/g, '/'),
      uri.fsPath.replace(/\\/g, '/')
    );

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_SIZE) return;

      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const newHash = this.hashManager.computeFileHash(contentBytes);
      const existing = this.index.findFileByPath(relativePath);

      if (existing && existing.contentHash === newHash) {
        existing.lastModified = stat.mtime;
        return;
      }

      if (existing) {
        this.index.removeFile(existing.fileId);
      }

      const content = Buffer.from(contentBytes).toString('utf-8');
      const language = detectLanguage(relativePath);

      this.index.addFile({
        relativePath,
        absolutePath: uri.fsPath,
        language,
        size: stat.size,
        lastModified: stat.mtime,
        contentHash: newHash,
        lineCount: countLines(content),
      }, content);

      this.rebuildSearchEngine();
      this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });
    } catch {
      // File might be binary or unreadable
    }
  }

  async search(request: SearchRequest, onResult?: SearchResultCallback): Promise<SearchResult> {
    if (!this.searchEngine) {
      return { files: [], totalMatches: 0, truncated: false, elapsed: 0 };
    }
    return this.searchEngine.search(request, onResult);
  }

  async getFileContent(fileId: number): Promise<string | undefined> {
    return this.readContent(fileId);
  }

  getFileEntry(fileId: number): FileEntry | undefined {
    return this.index.getFile(fileId);
  }

  getCurrentStatus(): IndexStatus {
    return this.currentStatus;
  }

  private setStatus(status: IndexStatus): void {
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.statusEmitter.dispose();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
  }
}
