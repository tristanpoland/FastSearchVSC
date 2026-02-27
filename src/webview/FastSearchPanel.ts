import * as vscode from 'vscode';
import { WebviewMessage, SearchResult, FileSearchResult } from '../types.js';
import { IndexManager } from '../indexer/IndexManager.js';
import { handleWebviewMessage } from './messageHandler.js';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

const matchHighlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  border: '1px solid',
  borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const matchLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findRangeHighlightBackground'),
  isWholeLine: true,
});

export class FastSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'fastsearch.searchView';

  private view: vscode.WebviewView | undefined;
  private lastSearchResult: SearchResult | undefined;
  private previewEditor: vscode.TextEditor | undefined;
  private currentSearchId = 0;

  constructor(
    private extensionUri: vscode.Uri,
    private indexManager: IndexManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'webview-ui'),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'openFile':
          await this.openFilePreview(message.payload.fileId);
          break;
        case 'openInEditor':
          await this.openFileInEditor(message.payload.fileId);
          break;
        case 'search': {
          const searchId = ++this.currentSearchId;
          try {
            const start = performance.now();
            let fileCount = 0;
            let totalMatches = 0;

            const result = await this.indexManager.search(
              message.payload,
              (file: FileSearchResult, matchesSoFar: number) => {
                // Abort if a newer search has started
                if (searchId !== this.currentSearchId) return false;

                fileCount++;
                totalMatches = matchesSoFar;

                webviewView.webview.postMessage({
                  type: 'searchResultBatch',
                  payload: { searchId, file, totalMatches: matchesSoFar, fileCount },
                });

                return true;
              }
            );

            // Only send completion if this search wasn't superseded
            if (searchId === this.currentSearchId) {
              this.lastSearchResult = result;
              const elapsed = performance.now() - start;
              webviewView.webview.postMessage({
                type: 'searchComplete',
                payload: {
                  searchId,
                  totalMatches: result.totalMatches,
                  fileCount: result.files.length,
                  truncated: result.truncated,
                  elapsed,
                },
              });
            }
          } catch (err: unknown) {
            if (searchId === this.currentSearchId) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              webviewView.webview.postMessage({ type: 'error', payload: { message: errorMessage } });
            }
          }
          break;
        }
        default:
          await handleWebviewMessage(message, this.indexManager, webviewView.webview);
          break;
      }
    });

    this.indexManager.onStatusChange(status => {
      webviewView.webview.postMessage({ type: 'indexStatus', payload: status });
    });

    // Push current status immediately so webview doesn't stay on "Initializing..."
    webviewView.webview.postMessage({
      type: 'indexStatus',
      payload: this.indexManager.getCurrentStatus(),
    });
  }

  private async openFilePreview(fileId: number): Promise<void> {
    const file = this.indexManager.getFileEntry(fileId);
    if (!file) return;

    const uri = vscode.Uri.file(file.absolutePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
        preserveFocus: true,
      });
      this.previewEditor = editor;
      this.applyMatchDecorations(editor, fileId);
    } catch {
      // File may have been deleted
    }
  }

  private async openFileInEditor(fileId: number): Promise<void> {
    const file = this.indexManager.getFileEntry(fileId);
    if (!file) return;

    const uri = vscode.Uri.file(file.absolutePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
      this.previewEditor = editor;
      this.applyMatchDecorations(editor, fileId);
    } catch {
      // File may have been deleted
    }
  }

  private applyMatchDecorations(editor: vscode.TextEditor, fileId: number): void {
    if (!this.lastSearchResult) return;

    const fileResult = this.lastSearchResult.files.find(f => f.fileId === fileId);
    if (!fileResult || fileResult.matches.length === 0) {
      editor.setDecorations(matchHighlightDecoration, []);
      editor.setDecorations(matchLineDecoration, []);
      return;
    }

    const matchRanges: vscode.DecorationOptions[] = [];
    const lineRanges: vscode.DecorationOptions[] = [];
    const seenLines = new Set<number>();

    for (const match of fileResult.matches) {
      const line = match.lineNumber - 1;
      const startCol = match.matchStart;
      const endCol = match.matchEnd;

      matchRanges.push({
        range: new vscode.Range(line, startCol, line, endCol),
      });

      if (!seenLines.has(line)) {
        seenLines.add(line);
        lineRanges.push({
          range: new vscode.Range(line, 0, line, 0),
        });
      }
    }

    editor.setDecorations(matchHighlightDecoration, matchRanges);
    editor.setDecorations(matchLineDecoration, lineRanges);

    // Scroll to first match
    if (fileResult.matches.length > 0) {
      const firstMatch = fileResult.matches[0];
      const pos = new vscode.Position(firstMatch.lineNumber - 1, firstMatch.matchStart);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'styles.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};
             script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet" />
  <title>FastSearch</title>
</head>
<body>
  <div id="app">
    <div class="search-header">
      <div class="search-bar">
        <div class="search-input-wrapper">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M15.25 13.68l-3.46-3.46a6.02 6.02 0 0 0 1.27-3.72 6 6 0 1 0-6 6 6.02 6.02 0 0 0 3.72-1.27l3.46 3.46a1.11 1.11 0 1 0 1.57-1.57l-.56.56zM2.06 6.5a4.44 4.44 0 1 1 4.44 4.44A4.45 4.45 0 0 1 2.06 6.5z"/>
          </svg>
          <input type="text" id="search-input" class="search-input" placeholder="Search... (quotes, -, OR, file:)" autofocus />
        </div>
        <button id="mode-toggle" class="mode-toggle" title="Toggle search mode (Natural / Regex)">
          <span id="mode-label">Natural</span>
        </button>
        <button id="reindex-btn" class="reindex-btn" title="Rebuild index">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.45 2.55A7 7 0 0 0 1.07 7H0l2.5 3L5 7H3.07a5 5 0 0 1 9.36-1.57l1.02-1.02zM13.5 6l-2.5 3h1.93a5 5 0 0 1-9.36 1.57l-1.02 1.02A7 7 0 0 0 14.93 9H16l-2.5-3z"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="file-list-container">
      <div class="file-list-panel" id="file-list">
        <div class="placeholder-message">
          <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
            <path d="M15.25 13.68l-3.46-3.46a6.02 6.02 0 0 0 1.27-3.72 6 6 0 1 0-6 6 6.02 6.02 0 0 0 3.72-1.27l3.46 3.46a1.11 1.11 0 1 0 1.57-1.57l-.56.56zM2.06 6.5a4.44 4.44 0 1 1 4.44 4.44A4.45 4.45 0 0 1 2.06 6.5z"/>
          </svg>
          <p>Type to search across your project</p>
        </div>
      </div>
    </div>
    <div class="status-bar" id="status-bar">
      <span id="status-text">Initializing...</span>
      <button id="clear-index-btn" class="clear-index-btn" title="Clear index" style="display:none;">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM5 4v9h6V4H5zm2-1V2H7v1h2z"/>
        </svg>
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
