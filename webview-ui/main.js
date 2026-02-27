(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ──
  let currentMode = 'natural';
  let currentResults = { files: [], totalMatches: 0, truncated: false, elapsed: 0 };
  let currentFileId = null;
  let currentSearchQuery = '';
  let selectedFileIndex = -1;
  let sortOrder = 'matches'; // 'matches' | 'recent' | 'alpha'
  let recentFiles = {};      // relativePath -> timestamp (last viewed)
  let currentSearchId = 0;   // tracks which search we're receiving results for
  let isSearching = false;

  // ── DOM Elements ──
  const searchInput = document.getElementById('search-input');
  const modeToggle = document.getElementById('mode-toggle');
  const modeLabel = document.getElementById('mode-label');
  const reindexBtn = document.getElementById('reindex-btn');
  const fileListPanel = document.getElementById('file-list');
  const statusText = document.getElementById('status-text');

  // ── Language Icons (SVG-based) ──
  const LANG_ICONS = {
    typescript: { color: '#3178c6', letter: 'TS' },
    typescriptreact: { color: '#3178c6', letter: 'TX' },
    javascript: { color: '#f7df1e', letter: 'JS' },
    javascriptreact: { color: '#f7df1e', letter: 'JX' },
    python: { color: '#3776ab', letter: 'PY' },
    java: { color: '#ed8b00', letter: 'JV' },
    c: { color: '#555555', letter: 'C' },
    cpp: { color: '#00599c', letter: 'C+' },
    csharp: { color: '#239120', letter: 'C#' },
    go: { color: '#00add8', letter: 'GO' },
    rust: { color: '#dea584', letter: 'RS' },
    ruby: { color: '#cc342d', letter: 'RB' },
    php: { color: '#777bb4', letter: 'PH' },
    swift: { color: '#fa7343', letter: 'SW' },
    kotlin: { color: '#7f52ff', letter: 'KT' },
    html: { color: '#e34f26', letter: 'HT' },
    css: { color: '#1572b6', letter: 'CS' },
    scss: { color: '#c6538c', letter: 'SC' },
    json: { color: '#292929', letter: '{}' },
    yaml: { color: '#cb171e', letter: 'YM' },
    markdown: { color: '#083fa1', letter: 'MD' },
    sql: { color: '#e38c00', letter: 'SQ' },
    shellscript: { color: '#89e051', letter: 'SH' },
    vue: { color: '#42b883', letter: 'VU' },
    svelte: { color: '#ff3e00', letter: 'SV' },
    dart: { color: '#0175c2', letter: 'DA' },
    xml: { color: '#0060ac', letter: 'XM' },
    plaintext: { color: '#6a737d', letter: 'TX' },
  };

  function getLangIcon(language) {
    const info = LANG_ICONS[language] || { color: '#6a737d', letter: '?' };
    return `<span class="lang-icon" style="background:${info.color}">${info.letter}</span>`;
  }

  // ── Search ──
  let debounceTimer = null;

  function doSearch() {
    const query = searchInput.value.trim();
    if (query.length > 0) {
      currentSearchQuery = query;
      currentSearchId++;
      isSearching = true;
      // Clear previous results and show searching state
      currentResults = { files: [], totalMatches: 0, truncated: false, elapsed: 0 };
      selectedFileIndex = -1;
      fileListPanel.innerHTML = '';
      ensureSummaryRow();
      vscode.postMessage({ type: 'search', payload: { query, mode: currentMode } });
    } else {
      currentResults = { files: [], totalMatches: 0, truncated: false, elapsed: 0 };
      isSearching = false;
      showFilePlaceholder();
    }
  }

  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 200);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateFileList(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateFileList(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceTimer) clearTimeout(debounceTimer);
      doSearch();
    } else if (e.key === 'Escape') {
      searchInput.blur();
    }
  });

  modeToggle.addEventListener('click', () => {
    currentMode = currentMode === 'natural' ? 'regex' : 'natural';
    modeLabel.textContent = currentMode === 'natural' ? 'Natural' : 'Regex';
    modeToggle.classList.toggle('regex-mode', currentMode === 'regex');
    if (searchInput.value.trim().length > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      doSearch();
    }
  });

  reindexBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'requestReindex' });
  });

  document.getElementById('clear-index-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearIndex' });
  });

  // ── File list navigation ──
  function navigateFileList(delta) {
    if (currentResults.files.length === 0) return;
    const newIndex = Math.max(0, Math.min(currentResults.files.length - 1, selectedFileIndex + delta));
    selectFile(newIndex);
  }

  function highlightSelectedFile() {
    const items = fileListPanel.querySelectorAll('.file-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === selectedFileIndex);
    });
    const selected = items[selectedFileIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Sort logic ──
  function sortFiles(files) {
    const sorted = [...files];
    switch (sortOrder) {
      case 'matches':
        sorted.sort((a, b) => b.matchCount - a.matchCount);
        break;
      case 'recent':
        sorted.sort((a, b) => {
          const ta = recentFiles[a.relativePath] || 0;
          const tb = recentFiles[b.relativePath] || 0;
          if (tb !== ta) return tb - ta;
          return b.matchCount - a.matchCount;
        });
        break;
      case 'alpha':
        sorted.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        break;
    }
    return sorted;
  }

  function trackRecentFile(relativePath) {
    recentFiles[relativePath] = Date.now();
    saveState();
  }

  // ── Summary row (sticky header) ──
  function ensureSummaryRow() {
    let summaryRow = fileListPanel.querySelector('.file-list-summary');
    if (!summaryRow) {
      summaryRow = document.createElement('div');
      summaryRow.className = 'file-list-summary';

      const summaryText = document.createElement('span');
      summaryText.id = 'summary-text';
      summaryRow.appendChild(summaryText);

      const sortSelect = document.createElement('select');
      sortSelect.className = 'sort-select';
      sortSelect.title = 'Sort order';
      sortSelect.innerHTML = `
        <option value="matches"${sortOrder === 'matches' ? ' selected' : ''}>Most matches</option>
        <option value="recent"${sortOrder === 'recent' ? ' selected' : ''}>Recent first</option>
        <option value="alpha"${sortOrder === 'alpha' ? ' selected' : ''}>A → Z</option>
      `;
      sortSelect.addEventListener('change', () => {
        sortOrder = sortSelect.value;
        saveState();
        rerenderFileList();
      });
      summaryRow.appendChild(sortSelect);

      fileListPanel.insertBefore(summaryRow, fileListPanel.firstChild);
    }
    updateSummaryText();
  }

  function updateSummaryText() {
    const el = document.getElementById('summary-text');
    if (!el) return;
    if (isSearching) {
      el.textContent = `Searching... ${currentResults.totalMatches} match${currentResults.totalMatches !== 1 ? 'es' : ''} in ${currentResults.files.length} file${currentResults.files.length !== 1 ? 's' : ''}`;
    } else if (currentResults.files.length === 0 && currentSearchQuery) {
      el.textContent = 'No results found';
    } else {
      let text = `${currentResults.totalMatches} match${currentResults.totalMatches !== 1 ? 'es' : ''} in ${currentResults.files.length} file${currentResults.files.length !== 1 ? 's' : ''}`;
      if (currentResults.elapsed > 0) {
        text += ` (${currentResults.elapsed.toFixed(1)}ms)`;
      }
      if (currentResults.truncated) {
        text += ' (truncated)';
      }
      el.textContent = text;
    }
  }

  // ── Append a single file result ──
  function appendFileItem(file) {
    const index = currentResults.files.indexOf(file);
    if (index === -1) return;

    const item = createFileItem(file, index);
    fileListPanel.appendChild(item);

    // Auto-select first result
    if (index === 0) {
      selectFile(0);
    }
  }

  function createFileItem(file, index) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.index = String(index);
    item.dataset.fileId = String(file.fileId);

    const parts = file.relativePath.replace(/\\/g, '/').split('/');
    const fileName = parts.pop() || '';
    const dirName = parts.join('/');

    item.innerHTML = `
      <div class="file-info">
        ${getLangIcon(file.language)}
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="file-dir" title="${escapeHtml(file.relativePath)}">${dirName ? escapeHtml(dirName) + '/' : ''}</span>
      </div>
      <div class="file-actions">
        <span class="match-badge">${file.matchCount}</span>
        <button class="open-editor-btn" title="Open in full editor">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 1H2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-1 12H3V3h10v10zM5 5h6v1H5V5zm0 3h6v1H5V8zm0 3h4v1H5v-1z"/>
          </svg>
        </button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.open-editor-btn')) return;
      selectFileByFileId(file.fileId);
    });

    const openBtn = item.querySelector('.open-editor-btn');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      trackRecentFile(file.relativePath);
      vscode.postMessage({ type: 'openInEditor', payload: { fileId: file.fileId } });
    });

    return item;
  }

  // ── Full re-render (used when sort order changes) ──
  function rerenderFileList() {
    currentResults.files = sortFiles(currentResults.files);
    selectedFileIndex = -1;

    // Remove all file items, keep summary
    const items = fileListPanel.querySelectorAll('.file-item');
    items.forEach(el => el.remove());

    for (let i = 0; i < currentResults.files.length; i++) {
      const item = createFileItem(currentResults.files[i], i);
      fileListPanel.appendChild(item);
    }

    updateSummaryText();

    if (currentResults.files.length > 0) {
      selectFile(0);
    }
  }

  function selectFile(index) {
    if (index < 0 || index >= currentResults.files.length) return;
    selectedFileIndex = index;
    highlightSelectedFile();
    const file = currentResults.files[index];
    currentFileId = file.fileId;
    trackRecentFile(file.relativePath);
    vscode.postMessage({ type: 'openFile', payload: { fileId: file.fileId } });
  }

  function selectFileByFileId(fileId) {
    const index = currentResults.files.findIndex(f => f.fileId === fileId);
    if (index !== -1) {
      selectFile(index);
    }
  }

  // ── Placeholders ──
  function showFilePlaceholder() {
    fileListPanel.innerHTML = `
      <div class="placeholder-message">
        <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
          <path d="M15.25 13.68l-3.46-3.46a6.02 6.02 0 0 0 1.27-3.72 6 6 0 1 0-6 6 6.02 6.02 0 0 0 3.72-1.27l3.46 3.46a1.11 1.11 0 1 0 1.57-1.57l-.56.56zM2.06 6.5a4.44 4.44 0 1 1 4.44 4.44A4.45 4.45 0 0 1 2.06 6.5z"/>
        </svg>
        <p>Type to search across your project</p>
      </div>`;
  }

  // ── Utility ──
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Message handling ──
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'searchResultBatch': {
        const { searchId, file, totalMatches, fileCount } = message.payload;
        // Ignore results from stale searches
        if (searchId !== currentSearchId) break;

        currentResults.files.push(file);
        currentResults.totalMatches = totalMatches;
        updateSummaryText();
        appendFileItem(file);
        break;
      }
      case 'searchComplete': {
        const { searchId, totalMatches, fileCount, truncated, elapsed } = message.payload;
        if (searchId !== currentSearchId) break;

        isSearching = false;
        currentResults.totalMatches = totalMatches;
        currentResults.truncated = truncated;
        currentResults.elapsed = elapsed;
        updateSummaryText();

        // Apply sort now that all results are in
        if (sortOrder !== 'matches' || currentResults.files.length > 0) {
          rerenderFileList();
        }
        break;
      }
      case 'searchResults':
        // Legacy full-result message (fallback)
        isSearching = false;
        currentResults = message.payload;
        rerenderFileList();
        break;
      case 'indexStatus': {
        const status = message.payload;
        const clearBtn = document.getElementById('clear-index-btn');
        if (status.status === 'building') {
          statusText.textContent = `Indexing... (${status.fileCount} files)`;
          statusText.className = 'status-building';
          if (clearBtn) clearBtn.style.display = 'none';
        } else if (status.status === 'updating') {
          statusText.textContent = `Updating... (${status.fileCount} files)`;
          statusText.className = 'status-updating';
          if (clearBtn) clearBtn.style.display = 'none';
        } else {
          const terms = status.termCount ? `, ${(status.termCount / 1000).toFixed(1)}k terms` : '';
          statusText.textContent = `${status.fileCount} files${terms}`;
          statusText.className = 'status-ready';
          if (clearBtn) clearBtn.style.display = status.fileCount > 0 ? 'flex' : 'none';
        }
        break;
      }
      case 'error':
        isSearching = false;
        statusText.textContent = `Error: ${message.payload.message}`;
        statusText.className = 'status-error';
        break;
    }
  });

  // ── State persistence ──
  function saveState() {
    vscode.setState({
      query: searchInput.value,
      mode: currentMode,
      sortOrder: sortOrder,
      recentFiles: recentFiles,
    });
  }

  // ── Init ──
  const previousState = vscode.getState();
  if (previousState) {
    if (previousState.query) {
      searchInput.value = previousState.query;
      currentSearchQuery = previousState.query;
    }
    if (previousState.mode) {
      currentMode = previousState.mode;
      modeLabel.textContent = currentMode === 'natural' ? 'Natural' : 'Regex';
      modeToggle.classList.toggle('regex-mode', currentMode === 'regex');
    }
    if (previousState.sortOrder) {
      sortOrder = previousState.sortOrder;
    }
    if (previousState.recentFiles) {
      recentFiles = previousState.recentFiles;
    }
  }

  searchInput.addEventListener('input', () => {
    saveState();
  });

  vscode.postMessage({ type: 'ready' });
  searchInput.focus();
})();
