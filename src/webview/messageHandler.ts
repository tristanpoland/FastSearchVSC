import * as vscode from 'vscode';
import { WebviewMessage } from '../types.js';
import { IndexManager } from '../indexer/IndexManager.js';

export function handleWebviewMessage(
  message: WebviewMessage,
  indexManager: IndexManager,
  webview: vscode.Webview
): void {
  switch (message.type) {
    case 'search': {
      try {
        const result = indexManager.search(message.payload);
        webview.postMessage({ type: 'searchResults', payload: result });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'error', payload: { message: errorMessage } });
      }
      break;
    }
    case 'requestFileContent': {
      const content = indexManager.getFileContent(message.payload.fileId);
      const file = indexManager.getFileEntry(message.payload.fileId);
      if (content && file) {
        webview.postMessage({
          type: 'fileContent',
          payload: {
            fileId: file.fileId,
            content,
            language: file.language,
            relativePath: file.relativePath,
          },
        });
      }
      break;
    }
    case 'requestReindex': {
      indexManager.fullBuild();
      break;
    }
    case 'ready': {
      webview.postMessage({
        type: 'indexStatus',
        payload: indexManager.getCurrentStatus(),
      });
      break;
    }
  }
}
