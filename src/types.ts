export interface Posting {
  fileId: number;
  positions: number[];
  lineNumbers: number[];
}

export interface FileEntry {
  fileId: number;
  relativePath: string;
  absolutePath: string;
  language: string;
  size: number;
  lastModified: number;
  contentHash: string;
  lineCount: number;
}

export interface DirChildStat {
  name: string;
  mtime: number;
  size: number;
}

export interface DirHashEntry {
  relativePath: string;
  hash: string;
  childFileStats: DirChildStat[];
  childDirNames: string[];
}

export type SearchMode = 'regex' | 'natural';

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  maxResults?: number;
}

export interface SearchMatch {
  fileId: number;
  relativePath: string;
  language: string;
  lineNumber: number;
  column: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResult {
  files: FileSearchResult[];
  totalMatches: number;
  truncated: boolean;
  elapsed: number;
}

export interface FileSearchResult {
  fileId: number;
  relativePath: string;
  language: string;
  matchCount: number;
  matches: SearchMatch[];
}

export type NaturalQueryNode =
  | { type: 'term'; value: string }
  | { type: 'phrase'; value: string }
  | { type: 'not'; child: NaturalQueryNode }
  | { type: 'or'; left: NaturalQueryNode; right: NaturalQueryNode }
  | { type: 'and'; children: NaturalQueryNode[] }
  | { type: 'fileFilter'; pattern: string };

export interface IndexStatus {
  status: 'building' | 'ready' | 'updating';
  progress: number;
  fileCount: number;
}

export type ContentReader = (fileId: number) => Promise<string | undefined>;

export type ExtensionMessage =
  | { type: 'searchResults'; payload: SearchResult }
  | { type: 'fileContent'; payload: { fileId: number; content: string; language: string; relativePath: string } }
  | { type: 'indexStatus'; payload: IndexStatus }
  | { type: 'error'; payload: { message: string } };

export type WebviewMessage =
  | { type: 'search'; payload: SearchRequest }
  | { type: 'requestFileContent'; payload: { fileId: number } }
  | { type: 'requestReindex' }
  | { type: 'ready' };

export interface SerializedIndex {
  version: number;
  workspaceRoot: string;
  createdAt: number;
  files: FileEntry[];
  dirHashes: DirHashEntry[];
  terms: Record<string, Posting[]>;
}
