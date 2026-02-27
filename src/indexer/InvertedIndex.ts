import { FileEntry, Posting } from '../types.js';

interface TokenInfo {
  token: string;
  position: number;
  lineNumber: number;
}

export class InvertedIndex {
  private terms: Map<string, Posting[]> = new Map();
  private files: Map<number, FileEntry> = new Map();
  private rawContents: Map<number, string> = new Map();
  private nextFileId: number = 0;

  addFile(entry: Omit<FileEntry, 'fileId'>, content: string): number {
    const fileId = this.nextFileId++;
    const fileEntry: FileEntry = { ...entry, fileId };
    this.files.set(fileId, fileEntry);
    this.rawContents.set(fileId, content);

    for (const { token, position, lineNumber } of this.tokenize(content)) {
      let postings = this.terms.get(token);
      if (!postings) {
        postings = [];
        this.terms.set(token, postings);
      }
      let posting = postings.find(p => p.fileId === fileId);
      if (!posting) {
        posting = { fileId, positions: [], lineNumbers: [] };
        postings.push(posting);
      }
      posting.positions.push(position);
      posting.lineNumbers.push(lineNumber);
    }

    return fileId;
  }

  removeFile(fileId: number): void {
    this.files.delete(fileId);
    this.rawContents.delete(fileId);
    for (const [term, postings] of this.terms) {
      const idx = postings.findIndex(p => p.fileId === fileId);
      if (idx !== -1) {
        postings.splice(idx, 1);
        if (postings.length === 0) {
          this.terms.delete(term);
        }
      }
    }
  }

  lookupTerm(term: string): Posting[] {
    return this.terms.get(term.toLowerCase()) || [];
  }

  getFile(fileId: number): FileEntry | undefined {
    return this.files.get(fileId);
  }

  getFiles(): Map<number, FileEntry> {
    return this.files;
  }

  getRawContent(fileId: number): string | undefined {
    return this.rawContents.get(fileId);
  }

  setRawContent(fileId: number, content: string): void {
    this.rawContents.set(fileId, content);
  }

  hasRawContent(fileId: number): boolean {
    return this.rawContents.has(fileId);
  }

  getRawContents(): Map<number, string> {
    return this.rawContents;
  }

  getTerms(): Map<string, Posting[]> {
    return this.terms;
  }

  getFileCount(): number {
    return this.files.size;
  }

  findFileByPath(relativePath: string): FileEntry | undefined {
    for (const file of this.files.values()) {
      if (file.relativePath === relativePath) {
        return file;
      }
    }
    return undefined;
  }

  setNextFileId(id: number): void {
    this.nextFileId = id;
  }

  restoreFile(entry: FileEntry, content: string): void {
    this.files.set(entry.fileId, entry);
    this.rawContents.set(entry.fileId, content);
  }

  restoreTerms(terms: Map<string, Posting[]>): void {
    this.terms = terms;
  }

  clear(): void {
    this.terms.clear();
    this.files.clear();
    this.rawContents.clear();
    this.nextFileId = 0;
  }

  private *tokenize(content: string): Generator<TokenInfo> {
    let lineNumber = 1;
    let lineStart = 0;
    // Match sequences of word characters
    const wordRegex = /[a-zA-Z0-9_]+/g;
    let match: RegExpExecArray | null;

    // Track line numbers
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        lineStarts.push(i + 1);
      }
    }

    while ((match = wordRegex.exec(content)) !== null) {
      const position = match.index;
      // Binary search for line number
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= position) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      lineNumber = lo + 1;

      const word = match[0];

      // Yield the full token lowercased
      yield { token: word.toLowerCase(), position, lineNumber };

      // Split camelCase: getUserName -> get, User, Name
      const camelParts = word.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
      if (camelParts.length > 1) {
        let offset = 0;
        for (const part of camelParts) {
          const partLower = part.toLowerCase();
          if (partLower !== word.toLowerCase()) {
            yield { token: partLower, position: position + offset, lineNumber };
          }
          offset += part.length;
        }
      }

      // Split snake_case: user_name -> user, name
      if (word.includes('_')) {
        const snakeParts = word.split('_');
        if (snakeParts.length > 1) {
          let offset = 0;
          for (const part of snakeParts) {
            if (part.length > 0) {
              const partLower = part.toLowerCase();
              if (partLower !== word.toLowerCase()) {
                yield { token: partLower, position: position + offset, lineNumber };
              }
            }
            offset += part.length + 1; // +1 for underscore
          }
        }
      }
    }
  }
}
