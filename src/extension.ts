import * as vscode from 'vscode';
import { IndexManager } from './indexer/IndexManager.js';
import { FastSearchViewProvider } from './webview/FastSearchPanel.js';

let indexManager: IndexManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  indexManager = new IndexManager(context);

  const provider = new FastSearchViewProvider(context.extensionUri, indexManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FastSearchViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Ctrl+Shift+F focuses the sidebar search view
  context.subscriptions.push(
    vscode.commands.registerCommand('fastsearch.focus', () => {
      vscode.commands.executeCommand('fastsearch.searchView.focus');
    })
  );

  // Begin indexing in background
  indexManager.initialize();
}

export function deactivate(): void {
  indexManager?.dispose();
}
