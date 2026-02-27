import * as vscode from 'vscode';
import { WebviewMessage } from '../types.js';
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

export class FastSearchPanel {
  public static currentPanel: FastSearchPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, indexManager: IndexManager): void {
    const column = vscode.ViewColumn.One;

    if (FastSearchPanel.currentPanel) {
      FastSearchPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fastSearchPanel',
      'FastSearch',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'webview-ui'),
        ],
      }
    );

    FastSearchPanel.currentPanel = new FastSearchPanel(panel, extensionUri, indexManager);
  }

  static registerSerializer(context: vscode.ExtensionContext, indexManager: IndexManager): void {
    vscode.window.registerWebviewPanelSerializer('fastSearchPanel', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
        FastSearchPanel.currentPanel = new FastSearchPanel(
          panel,
          context.extensionUri,
          indexManager
        );
      },
    });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    private indexManager: IndexManager
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtmlForWebview();
    this.panel.iconPath = new vscode.ThemeIcon('search');

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        handleWebviewMessage(message, this.indexManager, this.panel.webview);
      },
      null,
      this.disposables
    );

    this.disposables.push(
      this.indexManager.onStatusChange(status => {
        this.panel.webview.postMessage({ type: 'indexStatus', payload: status });
      })
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;
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
          <input type="text" id="search-input" class="search-input" placeholder="Search files... (use quotes for exact, - to exclude, OR for union)" autofocus />
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
    <div class="content-panels">
      <div class="file-list-panel" id="file-list">
        <div class="placeholder-message">
          <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
            <path d="M15.25 13.68l-3.46-3.46a6.02 6.02 0 0 0 1.27-3.72 6 6 0 1 0-6 6 6.02 6.02 0 0 0 3.72-1.27l3.46 3.46a1.11 1.11 0 1 0 1.57-1.57l-.56.56zM2.06 6.5a4.44 4.44 0 1 1 4.44 4.44A4.45 4.45 0 0 1 2.06 6.5z"/>
          </svg>
          <p>Type to search across your project</p>
        </div>
      </div>
      <div class="divider" id="divider"></div>
      <div class="code-preview-panel" id="code-preview">
        <div class="placeholder-message">
          <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
            <path d="M14 1H2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-1 12H3V3h10v10z"/>
          </svg>
          <p>Select a file to preview</p>
        </div>
      </div>
    </div>
    <div class="status-bar" id="status-bar">
      <span id="status-text">Initializing...</span>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    FastSearchPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
