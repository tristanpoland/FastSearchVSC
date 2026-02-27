import { NaturalQueryNode } from '../types.js';

interface Token {
  type: 'WORD' | 'PHRASE' | 'OR' | 'MINUS' | 'FILE_FILTER';
  value: string;
}

export class NaturalQueryParser {
  private pos: number = 0;
  private tokens: Token[] = [];

  static parse(query: string): NaturalQueryNode {
    const parser = new NaturalQueryParser();
    parser.tokens = parser.tokenize(query);
    if (parser.tokens.length === 0) {
      return { type: 'term', value: '' };
    }
    return parser.parseOrExpr();
  }

  private tokenize(query: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < query.length) {
      // Skip whitespace
      if (/\s/.test(query[i])) {
        i++;
        continue;
      }

      // Quoted phrase
      if (query[i] === '"') {
        i++;
        let phrase = '';
        while (i < query.length && query[i] !== '"') {
          phrase += query[i];
          i++;
        }
        if (i < query.length) i++; // skip closing quote
        if (phrase.length > 0) {
          tokens.push({ type: 'PHRASE', value: phrase });
        }
        continue;
      }

      // Minus (negation)
      if (query[i] === '-' && i + 1 < query.length && !/\s/.test(query[i + 1])) {
        tokens.push({ type: 'MINUS', value: '-' });
        i++;
        continue;
      }

      // Word (including file: prefix)
      let word = '';
      while (i < query.length && !/\s/.test(query[i]) && query[i] !== '"') {
        word += query[i];
        i++;
      }

      if (word.length > 0) {
        if (word === 'OR') {
          tokens.push({ type: 'OR', value: 'OR' });
        } else if (word.startsWith('file:')) {
          tokens.push({ type: 'FILE_FILTER', value: word.substring(5) });
        } else {
          tokens.push({ type: 'WORD', value: word });
        }
      }
    }

    return tokens;
  }

  private parseOrExpr(): NaturalQueryNode {
    let left = this.parseAndExpr();
    while (this.match('OR')) {
      const right = this.parseAndExpr();
      left = { type: 'or', left, right };
    }
    return left;
  }

  private parseAndExpr(): NaturalQueryNode {
    const children: NaturalQueryNode[] = [];
    while (this.hasMore() && !this.peek('OR')) {
      children.push(this.parseUnaryExpr());
    }
    if (children.length === 0) {
      return { type: 'term', value: '' };
    }
    return children.length === 1 ? children[0] : { type: 'and', children };
  }

  private parseUnaryExpr(): NaturalQueryNode {
    if (this.match('MINUS')) {
      return { type: 'not', child: this.parseUnaryExpr() };
    }
    if (this.peekType() === 'PHRASE') {
      return { type: 'phrase', value: this.consume().value };
    }
    if (this.peekType() === 'FILE_FILTER') {
      return { type: 'fileFilter', pattern: this.consume().value };
    }
    return { type: 'term', value: this.consume().value.toLowerCase() };
  }

  private match(type: string): boolean {
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  private peek(type: string): boolean {
    return this.pos < this.tokens.length && this.tokens[this.pos].type === type;
  }

  private peekType(): string | undefined {
    return this.pos < this.tokens.length ? this.tokens[this.pos].type : undefined;
  }

  private hasMore(): boolean {
    return this.pos < this.tokens.length;
  }

  private consume(): Token {
    if (this.pos >= this.tokens.length) {
      return { type: 'WORD', value: '' };
    }
    return this.tokens[this.pos++];
  }
}
