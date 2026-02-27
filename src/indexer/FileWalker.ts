import * as vscode from 'vscode';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

export interface WalkEntry {
  uri: vscode.Uri;
  relativePath: string;
  isDirectory: boolean;
}

const ALWAYS_IGNORE = [
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  '.vscode-test',
  '.vscode/fastsearch',
  'dist',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.nyc_output',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.flv', '.wmv', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.sqlite', '.db',
  '.min.js', '.min.css',
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export class FileWalker {
  private ignoreFilter: Ignore;
  private workspaceRoot: vscode.Uri;

  constructor(workspaceRoot: vscode.Uri) {
    this.workspaceRoot = workspaceRoot;
    this.ignoreFilter = ignore();
    this.ignoreFilter.add(ALWAYS_IGNORE);
  }

  async initialize(): Promise<void> {
    // Load .gitignore from workspace root
    const gitignorePath = vscode.Uri.joinPath(this.workspaceRoot, '.gitignore');
    try {
      const content = await vscode.workspace.fs.readFile(gitignorePath);
      const text = Buffer.from(content).toString('utf-8');
      this.ignoreFilter.add(text);
    } catch {
      // No .gitignore, that's fine
    }

    // Also respect VS Code's files.exclude
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') || {};
    for (const [pattern, enabled] of Object.entries(filesExclude)) {
      if (enabled) {
        this.ignoreFilter.add(pattern);
      }
    }
  }

  async *walk(dir?: vscode.Uri): AsyncGenerator<WalkEntry> {
    const currentDir = dir || this.workspaceRoot;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(currentDir);
    } catch {
      return;
    }

    for (const [name, fileType] of entries) {
      const childUri = vscode.Uri.joinPath(currentDir, name);
      const relativePath = path.posix.relative(
        this.workspaceRoot.fsPath.replace(/\\/g, '/'),
        childUri.fsPath.replace(/\\/g, '/')
      );

      if (this.isIgnored(relativePath, fileType === vscode.FileType.Directory)) {
        continue;
      }

      if (fileType === vscode.FileType.Directory) {
        yield { uri: childUri, relativePath, isDirectory: true };
        yield* this.walk(childUri);
      } else if (fileType === vscode.FileType.File) {
        if (!this.isBinaryFile(name)) {
          yield { uri: childUri, relativePath, isDirectory: false };
        }
      }
    }
  }

  isIgnored(relativePath: string, isDir: boolean): boolean {
    const testPath = isDir ? relativePath + '/' : relativePath;
    try {
      return this.ignoreFilter.ignores(testPath);
    } catch {
      return false;
    }
  }

  isBinaryFile(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return true;
    }
    // Check for combined extensions like .min.js
    if (name.endsWith('.min.js') || name.endsWith('.min.css')) {
      return true;
    }
    return false;
  }

  getMaxFileSize(): number {
    return MAX_FILE_SIZE;
  }
}
