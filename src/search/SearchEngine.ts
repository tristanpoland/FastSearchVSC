import { SearchRequest, SearchResult, ContentReader, SearchResultCallback } from '../types.js';
import { InvertedIndex } from '../indexer/InvertedIndex.js';
import { RegexSearch } from './RegexSearch.js';
import { NaturalQueryParser } from './NaturalQueryParser.js';
import { NaturalSearch } from './NaturalSearch.js';

export class SearchEngine {
  private regexSearch: RegexSearch;
  private naturalSearch: NaturalSearch;

  constructor(index: InvertedIndex, readContent: ContentReader) {
    this.regexSearch = new RegexSearch(index.getFiles(), readContent);
    this.naturalSearch = new NaturalSearch(index, readContent);
  }

  async search(request: SearchRequest, onResult?: SearchResultCallback): Promise<SearchResult> {
    const maxResults = request.maxResults ?? 1000;
    const start = performance.now();

    let files;
    if (request.mode === 'regex') {
      files = await this.regexSearch.execute(request.query, maxResults, onResult);
    } else {
      const ast = NaturalQueryParser.parse(request.query);
      files = await this.naturalSearch.execute(ast, maxResults, onResult);
    }

    const elapsed = performance.now() - start;
    const totalMatches = files.reduce((sum, f) => sum + f.matchCount, 0);

    return {
      files,
      totalMatches,
      truncated: totalMatches >= maxResults,
      elapsed,
    };
  }
}
