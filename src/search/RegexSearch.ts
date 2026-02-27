import { FileEntry, FileSearchResult, SearchMatch, ContentReader, SearchResultCallback } from '../types.js';

export class RegexSearch {
  constructor(
    private files: Map<number, FileEntry>,
    private readContent: ContentReader
  ) {}

  async execute(
    pattern: string,
    maxResults: number,
    onResult?: SearchResultCallback
  ): Promise<FileSearchResult[]> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gm');
    } catch {
      return [];
    }

    const results: FileSearchResult[] = [];
    let totalMatches = 0;

    for (const [fileId, file] of this.files) {
      if (totalMatches >= maxResults) break;

      const content = await this.readContent(fileId);
      if (!content) continue;

      const lineStarts = this.computeLineStarts(content);
      const matches: SearchMatch[] = [];

      regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null && totalMatches < maxResults) {
        if (match[0].length === 0) {
          regex.lastIndex++;
          continue;
        }

        const { lineNumber, column } = this.offsetToLineCol(lineStarts, match.index);
        const lineContent = this.getLine(content, lineStarts, lineNumber);

        matches.push({
          fileId,
          relativePath: file.relativePath,
          language: file.language,
          lineNumber,
          column,
          lineContent,
          matchStart: column,
          matchEnd: column + match[0].length,
        });
        totalMatches++;
      }

      if (matches.length > 0) {
        const fileResult: FileSearchResult = {
          fileId,
          relativePath: file.relativePath,
          language: file.language,
          matchCount: matches.length,
          matches,
        };
        results.push(fileResult);

        if (onResult) {
          const shouldContinue = onResult(fileResult, totalMatches);
          if (!shouldContinue) break;
        }
      }
    }

    return results;
  }

  private computeLineStarts(content: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        starts.push(i + 1);
      }
    }
    return starts;
  }

  private offsetToLineCol(lineStarts: number[], offset: number): { lineNumber: number; column: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return {
      lineNumber: lo + 1,
      column: offset - lineStarts[lo],
    };
  }

  private getLine(content: string, lineStarts: number[], lineNumber: number): string {
    const idx = lineNumber - 1;
    const start = lineStarts[idx];
    const end = idx + 1 < lineStarts.length ? lineStarts[idx + 1] - 1 : content.length;
    return content.substring(start, end);
  }
}
