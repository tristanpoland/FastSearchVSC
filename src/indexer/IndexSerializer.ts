import * as vscode from 'vscode';
import { DirHashEntry, FileEntry, Posting, SerializedIndex } from '../types.js';
import { InvertedIndex } from './InvertedIndex.js';

const INDEX_VERSION = 1;

export class IndexSerializer {
  constructor(private storageUri: vscode.Uri) {}

  async save(index: InvertedIndex, dirHashes: Map<string, DirHashEntry>, workspaceRoot: string): Promise<void> {
    // Ensure storage directory exists
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
    } catch {
      // May already exist
    }

    const termsObj: Record<string, Posting[]> = {};
    for (const [term, postings] of index.getTerms()) {
      termsObj[term] = postings;
    }

    const data: SerializedIndex = {
      version: INDEX_VERSION,
      workspaceRoot,
      createdAt: Date.now(),
      files: Array.from(index.getFiles().values()),
      dirHashes: Array.from(dirHashes.values()),
      terms: termsObj,
    };

    const metaUri = vscode.Uri.joinPath(this.storageUri, 'index-meta.json');
    const metaContent = JSON.stringify({
      version: data.version,
      workspaceRoot: data.workspaceRoot,
      createdAt: data.createdAt,
      files: data.files,
      dirHashes: data.dirHashes,
    });
    await vscode.workspace.fs.writeFile(metaUri, Buffer.from(metaContent, 'utf-8'));

    const termsUri = vscode.Uri.joinPath(this.storageUri, 'index-terms.json');
    const termsContent = JSON.stringify(data.terms);
    await vscode.workspace.fs.writeFile(termsUri, Buffer.from(termsContent, 'utf-8'));
  }

  async load(workspaceRoot: string): Promise<{
    files: FileEntry[];
    dirHashes: DirHashEntry[];
    terms: Map<string, Posting[]>;
  } | null> {
    try {
      const metaUri = vscode.Uri.joinPath(this.storageUri, 'index-meta.json');
      const metaRaw = await vscode.workspace.fs.readFile(metaUri);
      const meta = JSON.parse(Buffer.from(metaRaw).toString('utf-8'));

      if (meta.version !== INDEX_VERSION) {
        return null;
      }
      if (meta.workspaceRoot !== workspaceRoot) {
        return null;
      }

      const termsUri = vscode.Uri.joinPath(this.storageUri, 'index-terms.json');
      const termsRaw = await vscode.workspace.fs.readFile(termsUri);
      const termsObj: Record<string, Posting[]> = JSON.parse(Buffer.from(termsRaw).toString('utf-8'));

      const terms = new Map<string, Posting[]>();
      for (const [key, value] of Object.entries(termsObj)) {
        terms.set(key, value);
      }

      return {
        files: meta.files as FileEntry[],
        dirHashes: meta.dirHashes as DirHashEntry[],
        terms,
      };
    } catch {
      return null;
    }
  }
}
