import * as vscode from 'vscode';
import { IndexManager } from './indexer/IndexManager.js';
import { FastSearchPanel } from './webview/FastSearchPanel.js';

let indexManager: IndexManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  indexManager = new IndexManager(context);

  // Register the open command
  context.subscriptions.push(
    vscode.commands.registerCommand('fastsearch.open', () => {
      FastSearchPanel.createOrShow(context.extensionUri, indexManager!);
    })
  );

  // Register serializer for webview restoration across reloads
  FastSearchPanel.registerSerializer(context, indexManager);

  // Begin indexing in background
  indexManager.initialize();
}

export function deactivate(): void {
  indexManager?.dispose();
}
