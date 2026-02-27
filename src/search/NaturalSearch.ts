import { FileSearchResult, NaturalQueryNode, SearchMatch, FileEntry, ContentReader, SearchResultCallback } from '../types.js';
import { InvertedIndex } from '../indexer/InvertedIndex.js';

export class NaturalSearch {
  constructor(
    private index: InvertedIndex,
    private readContent: ContentReader
  ) {}

  async execute(
    ast: NaturalQueryNode,
    maxResults: number,
    onResult?: SearchResultCallback
  ): Promise<FileSearchResult[]> {
    const fileIds = await this.evaluateNode(ast);
    const results: FileSearchResult[] = [];
    let totalMatches = 0;

    for (const fileId of fileIds) {
      if (totalMatches >= maxResults) break;

      const file = this.index.getFile(fileId);
      if (!file) continue;

      const content = await this.readContent(fileId);
      if (!content) continue;

      const matches = this.findMatchesInFile(file, content, ast, maxResults - totalMatches);
      if (matches.length > 0) {
        const fileResult: FileSearchResult = {
          fileId,
          relativePath: file.relativePath,
          language: file.language,
          matchCount: matches.length,
          matches,
        };
        results.push(fileResult);
        totalMatches += matches.length;

        if (onResult) {
          const shouldContinue = onResult(fileResult, totalMatches);
          if (!shouldContinue) break;
        }
      }
    }

    return results;
  }

  private async evaluateNode(node: NaturalQueryNode): Promise<Set<number>> {
    switch (node.type) {
      case 'term': {
        if (!node.value) return new Set();
        if (/[^a-zA-Z0-9_]/.test(node.value)) {
          return await this.literalSearch(node.value);
        }
        const postings = this.index.lookupTerm(node.value);
        return new Set(postings.map(p => p.fileId));
      }
      case 'phrase': {
        return await this.evaluatePhrase(node.value);
      }
      case 'and': {
        const evaluated = await Promise.all(
          node.children.map(async c => {
            if (c.type === 'not') {
              return { exclude: true, set: await this.evaluateNode(c.child) };
            }
            return { exclude: false, set: await this.evaluateNode(c) };
          })
        );

        const includeSets = evaluated.filter(s => !s.exclude);
        const excludeSets = evaluated.filter(s => s.exclude);

        if (includeSets.length === 0) return new Set();

        let result = new Set(includeSets[0].set);
        for (let i = 1; i < includeSets.length; i++) {
          result = this.intersect(result, includeSets[i].set);
        }

        for (const ex of excludeSets) {
          for (const id of ex.set) {
            result.delete(id);
          }
        }

        return result;
      }
      case 'or': {
        const [left, right] = await Promise.all([
          this.evaluateNode(node.left),
          this.evaluateNode(node.right),
        ]);
        return this.union(left, right);
      }
      case 'not': {
        const allFiles = this.index.getFiles();
        const excluded = await this.evaluateNode(node.child);
        const result = new Set<number>();
        for (const fileId of allFiles.keys()) {
          if (!excluded.has(fileId)) {
            result.add(fileId);
          }
        }
        return result;
      }
      case 'fileFilter': {
        return this.filterByFileName(node.pattern);
      }
    }
  }

  private async evaluatePhrase(phrase: string): Promise<Set<number>> {
    const tokens = phrase.toLowerCase().match(/[a-zA-Z0-9_]+/g) || [];
    if (tokens.length === 0) return new Set();

    const postingsPerToken = tokens.map(t => this.index.lookupTerm(t));
    const fileSets = postingsPerToken.map(ps => new Set(ps.map(p => p.fileId)));
    let candidateFiles = fileSets[0];
    for (let i = 1; i < fileSets.length; i++) {
      candidateFiles = this.intersect(candidateFiles, fileSets[i]);
    }

    const result = new Set<number>();
    const phraseLC = phrase.toLowerCase();
    for (const fileId of candidateFiles) {
      const content = await this.readContent(fileId);
      if (content && content.toLowerCase().includes(phraseLC)) {
        result.add(fileId);
      }
    }

    return result;
  }

  private async literalSearch(term: string): Promise<Set<number>> {
    const tokens = term.toLowerCase().match(/[a-zA-Z0-9_]+/g) || [];
    let candidateFiles: Set<number>;

    if (tokens.length > 0) {
      const fileSets = tokens.map(t => new Set(this.index.lookupTerm(t).map(p => p.fileId)));
      candidateFiles = fileSets[0];
      for (let i = 1; i < fileSets.length; i++) {
        candidateFiles = this.intersect(candidateFiles, fileSets[i]);
      }
    } else {
      candidateFiles = new Set(this.index.getFiles().keys());
    }

    const result = new Set<number>();
    const termLC = term.toLowerCase();
    for (const fileId of candidateFiles) {
      const content = await this.readContent(fileId);
      if (content && content.toLowerCase().includes(termLC)) {
        result.add(fileId);
      }
    }
    return result;
  }

  private filterByFileName(pattern: string): Set<number> {
    const result = new Set<number>();
    const files = this.index.getFiles();

    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    let regex: RegExp;
    try {
      regex = new RegExp(regexStr, 'i');
    } catch {
      return result;
    }

    for (const [fileId, file] of files) {
      if (regex.test(file.relativePath)) {
        result.add(fileId);
      }
    }

    return result;
  }

  private findMatchesInFile(
    file: FileEntry,
    content: string,
    ast: NaturalQueryNode,
    limit: number
  ): SearchMatch[] {
    const searchTerms = this.extractTerms(ast);
    if (searchTerms.length === 0) return [];

    const escapedTerms = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = escapedTerms.join('|');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gim');
    } catch {
      return [];
    }

    const lineStarts = this.computeLineStarts(content);
    const matches: SearchMatch[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null && matches.length < limit) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }

      const { lineNumber, column } = this.offsetToLineCol(lineStarts, match.index);
      const lineContent = this.getLine(content, lineStarts, lineNumber);

      matches.push({
        fileId: file.fileId,
        relativePath: file.relativePath,
        language: file.language,
        lineNumber,
        column,
        lineContent,
        matchStart: column,
        matchEnd: column + match[0].length,
      });
    }

    return matches;
  }

  private extractTerms(node: NaturalQueryNode): string[] {
    switch (node.type) {
      case 'term': return node.value ? [node.value] : [];
      case 'phrase': return [node.value];
      case 'not': return [];
      case 'or': return [...this.extractTerms(node.left), ...this.extractTerms(node.right)];
      case 'and': return node.children.flatMap(c => this.extractTerms(c));
      case 'fileFilter': return [];
    }
  }

  private intersect(a: Set<number>, b: Set<number>): Set<number> {
    const result = new Set<number>();
    for (const id of a) {
      if (b.has(id)) result.add(id);
    }
    return result;
  }

  private union(a: Set<number>, b: Set<number>): Set<number> {
    const result = new Set(a);
    for (const id of b) result.add(id);
    return result;
  }

  private computeLineStarts(content: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  private offsetToLineCol(lineStarts: number[], offset: number): { lineNumber: number; column: number } {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { lineNumber: lo + 1, column: offset - lineStarts[lo] };
  }

  private getLine(content: string, lineStarts: number[], lineNumber: number): string {
    const idx = lineNumber - 1;
    const start = lineStarts[idx];
    const end = idx + 1 < lineStarts.length ? lineStarts[idx + 1] - 1 : content.length;
    return content.substring(start, end);
  }
}
