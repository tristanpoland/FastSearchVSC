import { SearchRequest, SearchResult } from '../types.js';
import { InvertedIndex } from '../indexer/InvertedIndex.js';
import { RegexSearch } from './RegexSearch.js';
import { NaturalQueryParser } from './NaturalQueryParser.js';
import { NaturalSearch } from './NaturalSearch.js';

export class SearchEngine {
  private regexSearch: RegexSearch;
  private naturalSearch: NaturalSearch;

  constructor(private index: InvertedIndex) {
    this.regexSearch = new RegexSearch(index.getRawContents(), index.getFiles());
    this.naturalSearch = new NaturalSearch(index);
  }

  search(request: SearchRequest): SearchResult {
    const maxResults = request.maxResults ?? 1000;
    const start = performance.now();

    let files;
    if (request.mode === 'regex') {
      files = this.regexSearch.execute(request.query, maxResults);
    } else {
      const ast = NaturalQueryParser.parse(request.query);
      files = this.naturalSearch.execute(ast, maxResults);
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
