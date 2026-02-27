(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ──
  let currentMode = 'natural';
  let currentResults = null;
  let currentFileId = null;
  let currentSearchQuery = '';
  let selectedFileIndex = -1;
  let sortOrder = 'matches'; // 'matches' | 'recent' | 'alpha'
  let recentFiles = {};      // relativePath -> timestamp (last viewed)

  // ── DOM Elements ──
  const searchInput = document.getElementById('search-input');
  const modeToggle = document.getElementById('mode-toggle');
  const modeLabel = document.getElementById('mode-label');
  const reindexBtn = document.getElementById('reindex-btn');
  const fileListPanel = document.getElementById('file-list');
  const codePreviewPanel = document.getElementById('code-preview');
  const statusText = document.getElementById('status-text');
  const divider = document.getElementById('divider');

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

  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const query = searchInput.value.trim();
      if (query.length > 0) {
        currentSearchQuery = query;
        vscode.postMessage({ type: 'search', payload: { query, mode: currentMode } });
      } else {
        currentResults = null;
        showFilePlaceholder();
        showPreviewPlaceholder();
      }
    }, 200);
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
      // Immediate search
      if (debounceTimer) clearTimeout(debounceTimer);
      const query = searchInput.value.trim();
      if (query.length > 0) {
        currentSearchQuery = query;
        vscode.postMessage({ type: 'search', payload: { query, mode: currentMode } });
      }
    } else if (e.key === 'Escape') {
      searchInput.blur();
    }
  });

  modeToggle.addEventListener('click', () => {
    currentMode = currentMode === 'natural' ? 'regex' : 'natural';
    modeLabel.textContent = currentMode === 'natural' ? 'Natural' : 'Regex';
    modeToggle.classList.toggle('regex-mode', currentMode === 'regex');
    // Re-search with new mode
    const query = searchInput.value.trim();
    if (query.length > 0) {
      vscode.postMessage({ type: 'search', payload: { query, mode: currentMode } });
    }
  });

  reindexBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'requestReindex' });
  });

  // ── File list navigation ──
  function navigateFileList(delta) {
    if (!currentResults || currentResults.files.length === 0) return;
    const newIndex = Math.max(0, Math.min(currentResults.files.length - 1, selectedFileIndex + delta));
    selectFile(newIndex);
  }

  function highlightSelectedFile() {
    const items = fileListPanel.querySelectorAll('.file-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === selectedFileIndex);
    });
    // Scroll selected into view
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
          return b.matchCount - a.matchCount; // fallback
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

  // ── Render file list ──
  function renderFileList(results) {
    currentResults = results;
    currentResults.files = sortFiles(results.files);
    selectedFileIndex = -1;
    fileListPanel.innerHTML = '';

    if (results.files.length === 0) {
      fileListPanel.innerHTML = `
        <div class="no-results">
          <p>No results found</p>
        </div>`;
      showPreviewPlaceholder();
      return;
    }

    // Summary row with sort dropdown
    const summaryRow = document.createElement('div');
    summaryRow.className = 'file-list-summary';

    const summaryText = document.createElement('span');
    summaryText.textContent = `${results.totalMatches} match${results.totalMatches !== 1 ? 'es' : ''} in ${results.files.length} file${results.files.length !== 1 ? 's' : ''} (${results.elapsed.toFixed(1)}ms)`;
    if (results.truncated) {
      summaryText.textContent += ' (truncated)';
    }
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
      if (currentResults) {
        renderFileList(currentResults);
      }
    });
    summaryRow.appendChild(sortSelect);

    fileListPanel.appendChild(summaryRow);

    // File items
    for (let i = 0; i < currentResults.files.length; i++) {
      const file = currentResults.files[i];
      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.index = String(i);

      const parts = file.relativePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop() || '';
      const dirName = parts.join('/');

      item.innerHTML = `
        ${getLangIcon(file.language)}
        <span class="file-name">${escapeHtml(fileName)}</span>
        <span class="file-dir" title="${escapeHtml(file.relativePath)}">${dirName ? escapeHtml(dirName) + '/' : ''}</span>
        <span class="match-badge">${file.matchCount}</span>
      `;

      item.addEventListener('click', () => {
        selectFile(i);
      });

      fileListPanel.appendChild(item);
    }

    // Auto-select first file
    selectFile(0);
  }

  function selectFile(index) {
    if (!currentResults || index < 0 || index >= currentResults.files.length) return;
    selectedFileIndex = index;
    highlightSelectedFile();
    const file = currentResults.files[index];
    currentFileId = file.fileId;
    trackRecentFile(file.relativePath);
    vscode.postMessage({ type: 'requestFileContent', payload: { fileId: file.fileId } });
  }

  // ── Render code preview ──
  function renderCodePreview(fileData, searchResults) {
    codePreviewPanel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'preview-header';
    header.textContent = fileData.relativePath;
    codePreviewPanel.appendChild(header);

    const codeContainer = document.createElement('div');
    codeContainer.className = 'code-container';

    const lines = fileData.content.split('\n');

    // Find match lines for this file
    let matchLines = new Map(); // lineNumber -> [{start, end}]
    if (searchResults && searchResults.files) {
      const fileResult = searchResults.files.find(f => f.fileId === fileData.fileId);
      if (fileResult) {
        for (const match of fileResult.matches) {
          if (!matchLines.has(match.lineNumber)) {
            matchLines.set(match.lineNumber, []);
          }
          matchLines.get(match.lineNumber).push({
            start: match.matchStart,
            end: match.matchEnd,
          });
        }
      }
    }

    let firstMatchElement = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const lineEl = document.createElement('div');
      const isMatch = matchLines.has(lineNum);
      lineEl.className = 'code-line' + (isMatch ? ' match-line' : '');

      const lineNumEl = document.createElement('span');
      lineNumEl.className = 'line-number';
      lineNumEl.textContent = String(lineNum);
      lineEl.appendChild(lineNumEl);

      const lineContentEl = document.createElement('span');
      lineContentEl.className = 'line-content';

      if (isMatch) {
        // Highlight matches within the line
        const highlights = matchLines.get(lineNum);
        lineContentEl.innerHTML = highlightMatches(lines[i], highlights);
        if (!firstMatchElement) {
          firstMatchElement = lineEl;
        }
      } else {
        lineContentEl.textContent = lines[i];
      }

      lineEl.appendChild(lineContentEl);
      codeContainer.appendChild(lineEl);
    }

    codePreviewPanel.appendChild(codeContainer);

    // Scroll to first match
    if (firstMatchElement) {
      setTimeout(() => {
        firstMatchElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }
  }

  function highlightMatches(lineText, highlights) {
    if (!highlights || highlights.length === 0) return escapeHtml(lineText);

    // Sort highlights by start position
    highlights.sort((a, b) => a.start - b.start);

    let result = '';
    let lastEnd = 0;

    for (const h of highlights) {
      const start = Math.max(h.start, lastEnd);
      const end = Math.min(h.end, lineText.length);
      if (start >= end) continue;

      // Text before highlight
      if (start > lastEnd) {
        result += escapeHtml(lineText.substring(lastEnd, start));
      }

      // Highlighted text
      result += '<mark class="search-match">' + escapeHtml(lineText.substring(start, end)) + '</mark>';
      lastEnd = end;
    }

    // Remaining text
    if (lastEnd < lineText.length) {
      result += escapeHtml(lineText.substring(lastEnd));
    }

    return result;
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

  function showPreviewPlaceholder() {
    codePreviewPanel.innerHTML = `
      <div class="placeholder-message">
        <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
          <path d="M14 1H2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-1 12H3V3h10v10z"/>
        </svg>
        <p>Select a file to preview</p>
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

  // ── Divider drag-to-resize ──
  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = fileListPanel.parentElement.getBoundingClientRect();
    const newWidth = Math.max(150, Math.min(e.clientX - containerRect.left, containerRect.width - 150));
    fileListPanel.style.width = newWidth + 'px';
    fileListPanel.style.flexShrink = '0';
    fileListPanel.style.flexGrow = '0';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // ── Message handling ──
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'searchResults':
        renderFileList(message.payload);
        break;
      case 'fileContent':
        renderCodePreview(message.payload, currentResults);
        break;
      case 'indexStatus': {
        const status = message.payload;
        if (status.status === 'building') {
          statusText.textContent = `Indexing... (${status.fileCount} files)`;
          statusText.className = 'status-building';
        } else if (status.status === 'updating') {
          statusText.textContent = `Updating index... (${status.fileCount} files)`;
          statusText.className = 'status-updating';
        } else {
          statusText.textContent = `Index ready (${status.fileCount} files)`;
          statusText.className = 'status-ready';
        }
        break;
      }
      case 'error':
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
  // Restore state
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

  // Save state on input change
  searchInput.addEventListener('input', () => {
    saveState();
  });

  // Notify extension we're ready
  vscode.postMessage({ type: 'ready' });

  // Focus search input
  searchInput.focus();
})();
