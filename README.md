# FastSearch

Lightning-fast indexed full-text search for VS Code. Builds an in-memory inverted index of your workspace and returns results as you type — no waiting for grep to crawl your files every time.

## Features

- **Instant results** — searches an in-memory inverted index, not the filesystem. Results stream in per-file as they're found.
- **Natural query syntax** — Google-style operators out of the box:
  - `"exact phrase"` — match exact sequences
  - `-exclude` — exclude files containing a term
  - `term1 OR term2` — match either term
  - `term1 term2` — implicit AND, match both
  - `file:*.ts` — filter by file glob
- **Regex mode** — toggle to raw regex search when you need it
- **Incremental indexing** — uses directory-level stat hashing to detect changes. Only re-indexes what actually changed. File watcher picks up live edits automatically.
- **Persistent index** — saves to disk in `.vscode/fastsearch/` so startup is near-instant on repeat opens.
- **Editor integration** — clicking a result opens the file with all matches highlighted in the editor, with scrollbar indicators showing match positions at a glance.
- **Keyboard-driven** — Up/Down to move between files, Left/Right to jump between matches within a file, Enter to search, Escape to blur.
- **Theme-aware** — uses VS Code's CSS variables so it looks native in any theme.
- **Full result button** — if the result set is truncated (default cap of 1k matches), a red "Show all" button appears in the summary row. Click it to rerun the search without the cap.

## Usage

1. Click the FastSearch icon in the activity bar, or press `Ctrl+Shift+F` (`Cmd+Shift+F` on Mac).
2. Type your query. Results appear as you type.
3. Use Up/Down arrows to navigate the file list.
4. Use Left/Right arrows to jump between matches in the open file.
5. Click the editor icon on a result to pin it in a non-preview tab.

### Query Examples

| Query | What it does |
|---|---|
| `useState` | Files containing "useState" |
| `"use strict"` | Exact phrase match |
| `useState -test` | Files with "useState" but not "test" |
| `error OR warning` | Files with either term |
| `handler file:*.ts` | Only TypeScript files containing "handler" |

### Status Bar

The bottom bar shows the index state: file count, term count, and indexing progress. The trash icon clears the index and forces a full rebuild.

## How It Works

1. **FileWalker** recursively traverses the workspace, respecting `.gitignore` rules. Skips `.git`, `node_modules`, binary files, and files over 1 MB.
2. **HashManager** computes stat-based directory hashes (child names + mtimes + sizes). On re-index, unchanged directories are skipped entirely.
3. **InvertedIndex** tokenizes file contents (splitting on non-word characters and camelCase boundaries) into a `Map<term, Posting[]>` with position and line-number data.
4. **IndexSerializer** persists the index as two JSON files (`index-meta.json` + `index-terms.json`) in `.vscode/fastsearch/`.
5. **SearchEngine** dispatches to either `NaturalSearch` (AST-based query evaluation against the inverted index) or `RegexSearch` (pattern applied over raw file contents).

## Development

```bash
npm install
npm run compile    # one-shot build
npm run watch      # rebuild on change
npm run typecheck  # type-check without emitting
```

Press F5 in VS Code to launch the Extension Development Host.

## License

MIT
