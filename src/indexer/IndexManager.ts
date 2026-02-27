import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry, IndexStatus, SearchRequest, SearchResult, DirHashEntry } from '../types.js';
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

export class IndexManager implements vscode.Disposable {
  private index: InvertedIndex;
  private hashManager: HashManager;
  private serializer: IndexSerializer;
  private searchEngine: SearchEngine | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private statusEmitter = new vscode.EventEmitter<IndexStatus>();
  public onStatusChange = this.statusEmitter.event;
  private currentStatus: IndexStatus = { status: 'building', progress: 0, fileCount: 0 };
  private workspaceRoot: vscode.Uri | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.index = new InvertedIndex();
    this.hashManager = new HashManager();

    // Store index inside .vscode/fastsearch in the workspace root.
    // .vscode is conventionally gitignored and is the standard place
    // for project-local IDE data.
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
    const rootPath = this.workspaceRoot.fsPath;

    // Try loading persisted index
    const loaded = await this.serializer.load(rootPath);
    if (loaded) {
      // Restore from disk
      this.index.clear();
      let maxId = 0;
      for (const file of loaded.files) {
        if (file.fileId >= maxId) maxId = file.fileId + 1;
      }
      this.index.setNextFileId(maxId);
      this.index.restoreTerms(loaded.terms);

      // Re-read file contents for raw content map and restore file entries
      for (const file of loaded.files) {
        try {
          const uri = vscode.Uri.file(file.absolutePath);
          const contentBytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(contentBytes).toString('utf-8');
          this.index.restoreFile(file, content);
        } catch {
          // File may have been deleted since last index
        }
      }

      this.hashManager.restore(loaded.dirHashes);
      this.searchEngine = new SearchEngine(this.index);
      this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });

      // Incremental re-index in background
      this.incrementalReindex();
    } else {
      await this.fullBuild();
    }

    this.startFileWatcher();
  }

  async fullBuild(): Promise<void> {
    if (!this.workspaceRoot) return;

    this.index.clear();
    this.hashManager.clear();
    this.setStatus({ status: 'building', progress: 0, fileCount: 0 });

    const walker = new FileWalker(this.workspaceRoot);
    await walker.initialize();

    // Collect directory structure for hash computation
    const dirFiles: Map<string, string[]> = new Map();
    const dirSubdirs: Map<string, string[]> = new Map();
    let count = 0;

    for await (const entry of walker.walk()) {
      if (entry.isDirectory) {
        continue;
      }

      try {
        const contentBytes = await vscode.workspace.fs.readFile(entry.uri);
        if (contentBytes.byteLength > walker.getMaxFileSize()) {
          continue;
        }

        const content = Buffer.from(contentBytes).toString('utf-8');
        const contentHash = this.hashManager.computeFileHash(contentBytes);
        const language = detectLanguage(entry.relativePath);

        this.index.addFile({
          relativePath: entry.relativePath,
          absolutePath: entry.uri.fsPath,
          language,
          size: contentBytes.byteLength,
          lastModified: Date.now(),
          contentHash,
          lineCount: countLines(content),
        }, content);

        // Track directory structure
        const dirPath = path.posix.dirname(entry.relativePath);
        if (!dirFiles.has(dirPath)) {
          dirFiles.set(dirPath, []);
        }
        dirFiles.get(dirPath)!.push(contentHash);

        count++;
        if (count % 50 === 0) {
          this.setStatus({ status: 'building', progress: -1, fileCount: count });
          // Yield control to avoid blocking
          await new Promise(r => setTimeout(r, 0));
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Build directory hashes bottom-up
    this.buildDirHashes(dirFiles);

    // Create search engine
    this.searchEngine = new SearchEngine(this.index);

    // Persist
    await this.serializer.save(this.index, this.hashManager.getAllDirHashes(), this.workspaceRoot.fsPath);
    this.setStatus({ status: 'ready', progress: 100, fileCount: count });
  }

  private async incrementalReindex(): Promise<void> {
    if (!this.workspaceRoot) return;

    this.setStatus({ status: 'updating', progress: 0, fileCount: this.index.getFileCount() });

    const walker = new FileWalker(this.workspaceRoot);
    await walker.initialize();

    let changed = false;
    const seenPaths = new Set<string>();

    for await (const entry of walker.walk()) {
      if (entry.isDirectory) continue;

      seenPaths.add(entry.relativePath);
      const existing = this.index.findFileByPath(entry.relativePath);

      try {
        const contentBytes = await vscode.workspace.fs.readFile(entry.uri);
        if (contentBytes.byteLength > walker.getMaxFileSize()) continue;

        const newHash = this.hashManager.computeFileHash(contentBytes);

        if (existing && existing.contentHash === newHash) {
          continue; // File unchanged
        }

        // File is new or changed
        if (existing) {
          this.index.removeFile(existing.fileId);
        }

        const content = Buffer.from(contentBytes).toString('utf-8');
        const language = detectLanguage(entry.relativePath);

        this.index.addFile({
          relativePath: entry.relativePath,
          absolutePath: entry.uri.fsPath,
          language,
          size: contentBytes.byteLength,
          lastModified: Date.now(),
          contentHash: newHash,
          lineCount: countLines(content),
        }, content);

        changed = true;
      } catch {
        // Skip
      }
    }

    // Remove files that no longer exist
    for (const file of Array.from(this.index.getFiles().values())) {
      if (!seenPaths.has(file.relativePath)) {
        this.index.removeFile(file.fileId);
        changed = true;
      }
    }

    if (changed) {
      this.searchEngine = new SearchEngine(this.index);
      await this.serializer.save(this.index, this.hashManager.getAllDirHashes(), this.workspaceRoot.fsPath);
    }

    this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });
  }

  private buildDirHashes(dirFiles: Map<string, string[]>): void {
    for (const [dirPath, fileHashes] of dirFiles) {
      const hash = this.hashManager.computeDirHash(fileHashes, []);
      this.hashManager.setDirHash({
        relativePath: dirPath,
        hash,
        childFiles: fileHashes,
        childDirs: [],
      });
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
      this.searchEngine = new SearchEngine(this.index);
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
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      if (contentBytes.byteLength > 1024 * 1024) return;

      const newHash = this.hashManager.computeFileHash(contentBytes);
      const existing = this.index.findFileByPath(relativePath);

      if (existing && existing.contentHash === newHash) return;

      if (existing) {
        this.index.removeFile(existing.fileId);
      }

      const content = Buffer.from(contentBytes).toString('utf-8');
      const language = detectLanguage(relativePath);

      this.index.addFile({
        relativePath,
        absolutePath: uri.fsPath,
        language,
        size: contentBytes.byteLength,
        lastModified: Date.now(),
        contentHash: newHash,
        lineCount: countLines(content),
      }, content);

      this.searchEngine = new SearchEngine(this.index);
      this.setStatus({ status: 'ready', progress: 100, fileCount: this.index.getFileCount() });
    } catch {
      // File might be binary or unreadable
    }
  }

  search(request: SearchRequest): SearchResult {
    if (!this.searchEngine) {
      return { files: [], totalMatches: 0, truncated: false, elapsed: 0 };
    }
    return this.searchEngine.search(request);
  }

  getFileContent(fileId: number): string | undefined {
    return this.index.getRawContent(fileId);
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
