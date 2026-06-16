// State Management
const state = {
  currentWorkspace: null,
  collections: [],            // List of summaries: [{ id, name, requestCount }]
  loadedCollections: {},      // Detailed collection cache: { [id]: collectionObj }
  activeCollectionId: null,   // Currently active collection ID
  activeRequestId: null,      // Currently active request ID
  activeRequest: null,        // Pointer to active request object
  environments: [],           // List of environment objects
  activeEnvId: 'none',        // Active environment ID
  activeEnv: null,            // Pointer to active environment object
  history: [],                // History list
  isSyncingParams: false,     // Flag to prevent infinite sync loops
  expandedNodes: new Set(),   // Tree nodes expanded states (collection-id, folder-id)
  lastResponseText: '',
  lastResponseIsBinary: false,
  lastResponseContentType: '',
  
  // Tabs system state
  tabs: [],                   // Open tabs list [{ id, type, name, request, collectionId }]
  activeTabId: null           // Active tab ID
};

// Map to track self-initiated file writes to ignore them in watch events (prevents feedback loops)
const selfWrittenFiles = new Map();

const originalSaveCollection = window.teamapi.collections.save;
window.teamapi.collections.save = async function(col) {
  selfWrittenFiles.set(`collections/${col.id}.json`, Date.now());
  return await originalSaveCollection(col);
};

const originalSaveEnvironment = window.teamapi.environments.save;
window.teamapi.environments.save = async function(env) {
  selfWrittenFiles.set(`environments/${env.id}.json`, Date.now());
  return await originalSaveEnvironment(env);
};

// Helper: variable interpolator
function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();
    return vars.hasOwnProperty(trimmedKey) ? vars[trimmedKey] : match;
  });
}

// Helper: parse cURL command to request properties
function parseCurlCommand(curlString) {
  const tokens = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < curlString.length; i++) {
    const char = curlString[i];
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === ' ' && !inDoubleQuote && !inSingleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else if (char === '\\' && i + 1 < curlString.length && (curlString[i+1] === '\n' || curlString[i+1] === '\r')) {
      if (curlString[i+1] === '\r') i++;
      i++;
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);

  const cleanTokens = tokens.map(t => {
    let s = t.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    else if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
    return s;
  });

  let method = 'GET';
  let url = '';
  const headers = [];
  let body = '';
  let auth = { type: 'none' };

  for (let i = 1; i < cleanTokens.length; i++) {
    const token = cleanTokens[i];
    if (token === '-X' || token === '--request') {
      method = cleanTokens[++i].toUpperCase();
    } else if (token === '-H' || token === '--header') {
      const headerVal = cleanTokens[++i];
      const colonIndex = headerVal.indexOf(':');
      if (colonIndex !== -1) {
        const key = headerVal.substring(0, colonIndex).trim();
        const value = headerVal.substring(colonIndex + 1).trim();
        headers.push({ key, value, enabled: true });
      }
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') {
      body = cleanTokens[++i];
      if (method === 'GET') method = 'POST';
    } else if (token === '-u' || token === '--user') {
      const userPass = cleanTokens[++i];
      const parts = userPass.split(':');
      auth = {
        type: 'basic',
        username: parts[0] || '',
        password: parts[1] || ''
      };
    } else if (token.startsWith('http://') || token.startsWith('https://') || token.includes('localhost') || token.includes('127.0.0.1')) {
      url = token;
    }
  }

  if (!url) {
    for (let i = 1; i < cleanTokens.length; i++) {
      const token = cleanTokens[i];
      const prev = cleanTokens[i - 1];
      if (!token.startsWith('-') && !['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '-u', '--user'].includes(prev)) {
        url = token;
        break;
      }
    }
  }

  return { method, url, headers, body, auth };
}

// Helper: query JSON object using a simple JSONPath-like query (e.g. $.items[*].name)
function queryJson(obj, query) {
  if (!query || query === '$') return obj;

  const parts = query.replace(/^\$\.?/, '').split('.');
  let current = obj;

  for (let part of parts) {
    if (current === undefined || current === null) return undefined;

    const arrayMatch = part.match(/^([^\[]+)\[([^\]]+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const indexStr = arrayMatch[2];
      current = current[key];
      if (current === undefined || current === null) return undefined;

      if (indexStr === '*') {
        const remainingQuery = parts.slice(parts.indexOf(part) + 1).join('.');
        if (!remainingQuery) return current;
        if (Array.isArray(current)) {
          return current.map(item => queryJson(item, remainingQuery)).filter(x => x !== undefined);
        }
        return undefined;
      } else {
        const index = parseInt(indexStr, 10);
        if (Array.isArray(current)) {
          current = current[index];
        } else {
          return undefined;
        }
      }
    } else {
      current = current[part];
    }
  }
  return current;
}

// Auto-save debounce timer
let saveTimeout = null;
function queueSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    if (state.activeCollectionId && state.loadedCollections[state.activeCollectionId]) {
      try {
        const col = state.loadedCollections[state.activeCollectionId];
        await window.teamapi.collections.save(col);
      } catch (err) {
        showToast('Auto-save failed: ' + err.message, 'error');
      }
    }
  }, 800);
}

// Toast Notifications Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const textSpan = document.createElement('span');
  textSpan.style.flex = '1';
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  // If it's an error/warning, add a copy details button and a close button
  if (type === 'error' || type === 'warning') {
    const btnCopy = document.createElement('span');
    btnCopy.innerHTML = '📋';
    btnCopy.style.cursor = 'pointer';
    btnCopy.style.marginLeft = '8px';
    btnCopy.style.flexShrink = '0';
    btnCopy.title = 'Copy error message';
    btnCopy.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(message);
      showToast('Error copied to clipboard', 'success');
    };
    toast.appendChild(btnCopy);

    const btnClose = document.createElement('span');
    btnClose.innerHTML = '✕';
    btnClose.style.cursor = 'pointer';
    btnClose.style.marginLeft = '8px';
    btnClose.style.flexShrink = '0';
    btnClose.title = 'Close';
    btnClose.onclick = (e) => {
      e.stopPropagation();
      toast.remove();
    };
    toast.appendChild(btnClose);
  }

  container.appendChild(toast);

  if (type !== 'error' && type !== 'warning') {
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }
}

// Application Startup
window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupAutocompleteForScripts();

  showWelcomeScreen();

  // Register workspace change watcher listener
  if (window.teamapi && window.teamapi.workspace && window.teamapi.workspace.onWorkspaceChanged) {
    window.teamapi.workspace.onWorkspaceChanged(async (data) => {
      const filename = data.filename || '';
      
      const lastWriteTime = selfWrittenFiles.get(filename);
      if (lastWriteTime && (Date.now() - lastWriteTime < 1200)) {
        return;
      }

      if (filename.startsWith('collections/')) {
        await refreshCollections();
        
        const parts = filename.split('/');
        const fileBasename = parts[parts.length - 1];
        const colId = fileBasename.replace('.json', '');
        
        if (state.activeCollectionId === colId) {
          await loadCollectionDetails(colId);
          const colDetail = state.loadedCollections[colId];
          if (colDetail && state.activeRequestId) {
            const currentReq = colDetail.requests.find(r => r.id === state.activeRequestId);
            if (currentReq && state.activeRequest) {
              const changed = currentReq.url !== state.activeRequest.url ||
                              currentReq.method !== state.activeRequest.method ||
                              (currentReq.body && currentReq.body.content) !== (state.activeRequest.body && state.activeRequest.body.content);
              if (changed) {
                showToast(`Request updated on disk. Click standard reload if needed.`, 'info');
              }
            }
          }
        }
        renderCollectionsTree();
      } else if (filename.startsWith('environments/')) {
        await refreshEnvironments();
        populateEnvironmentDropdown();
        
        const parts = filename.split('/');
        const fileBasename = parts[parts.length - 1];
        const envId = fileBasename.replace('.json', '');
        if (state.activeEnvId === envId) {
          state.activeEnv = state.environments.find(env => env.id === envId) || null;
          showToast(`Active environment was updated on disk.`, 'info');
        }
      }
    });
  }
});

// Setup DOM Event Listeners
function setupEventListeners() {
  // Welcome page buttons
  document.getElementById('welcomeOpenBtn').onclick = () => selectWorkspace();
  document.getElementById('welcomeNewBtn').onclick = () => openCreateWorkspaceModal();
  document.getElementById('btnChangeWorkspace').onclick = () => showWelcomeScreen();

  const welcomeCloseBtn = document.getElementById('welcomeCloseBtn');
  if (welcomeCloseBtn) {
    welcomeCloseBtn.onclick = () => {
      const welcomeScreen = document.getElementById('welcomeScreen');
      if (welcomeScreen) {
        welcomeScreen.style.display = 'none';
      }
    };
  }

  // Dialog actions
  document.getElementById('btnCancelCreateWorkspace').onclick = () => closeDialog('modalCreateWorkspace');
  document.getElementById('btnConfirmCreateWorkspace').onclick = confirmCreateWorkspace;

  document.getElementById('btnCancelCreateCollection').onclick = () => closeDialog('modalCreateCollection');
  document.getElementById('btnConfirmCreateCollection').onclick = confirmCreateCollection;

  document.getElementById('btnCancelPrompt').onclick = () => closeDialog('modalInputPrompt');

  // Sidebar actions
  document.getElementById('btnAddCollection').onclick = () => openDialog('modalCreateCollection');

  const btnClearHistory = document.getElementById('btnClearHistory');
  if (btnClearHistory) {
    btnClearHistory.onclick = async () => {
      if (!state.currentWorkspace) return;
      try {
        await window.teamapi.history.clear();
        showToast('History cleared', 'success');
        await refreshHistory();
      } catch (err) {
        showToast('Failed to clear history: ' + err.message, 'error');
      }
    };
  }

  const btnNewRequestTab = document.getElementById('btnNewRequestTab');
  if (btnNewRequestTab) {
    btnNewRequestTab.onclick = createNewTab;
  }

  const placeholderNewTabBtn = document.getElementById('placeholderNewTabBtn');
  if (placeholderNewTabBtn) {
    placeholderNewTabBtn.onclick = createNewTab;
  }

  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  if (btnToggleSidebar) {
    btnToggleSidebar.onclick = () => {
      const sidebar = document.querySelector('.sidebar');
      const isCollapsed = sidebar.classList.toggle('collapsed');
      localStorage.setItem('sidebarCollapsed', isCollapsed);
    };
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
      e.preventDefault();
      const btn = document.getElementById('btnToggleSidebar');
      if (btn && btn.style.display !== 'none') {
        btn.click();
      }
    }
  });

  // URL Bar & SEND Action
  document.getElementById('requestUrl').oninput = (e) => {
    const val = e.target.value.trim();
    if (val.startsWith('curl ')) {
      try {
        const parsed = parseCurlCommand(e.target.value);
        if (parsed) {
          if (state.activeRequest) {
            state.activeRequest.method = parsed.method;
            state.activeRequest.url = parsed.url;
            state.activeRequest.headers = parsed.headers;
            state.activeRequest.auth = parsed.auth;
            
            if (parsed.body) {
              state.activeRequest.body = {
                type: 'raw',
                subType: 'json',
                content: parsed.body,
                formData: []
              };
              const contentTypeHeader = parsed.headers.find(h => h.key.toLowerCase() === 'content-type');
              if (contentTypeHeader) {
                const cVal = contentTypeHeader.value.toLowerCase();
                if (cVal.includes('json')) state.activeRequest.body.subType = 'json';
                else if (cVal.includes('xml')) state.activeRequest.body.subType = 'xml';
                else if (cVal.includes('html')) state.activeRequest.body.subType = 'html';
                else if (cVal.includes('javascript')) state.activeRequest.body.subType = 'javascript';
                else state.activeRequest.body.subType = 'text';
              }
            } else {
              state.activeRequest.body = { type: 'none', content: '', formData: [] };
            }
            
            loadRequestIntoEditor(state.activeCollectionId, state.activeRequestId);
            showToast('Parsed cURL command successfully!', 'success');
            queueSave();
          } else {
            showToast('Open/create a request first to import cURL.', 'warning');
          }
        }
      } catch (err) {
        showToast('Failed to parse cURL command: ' + err.message, 'error');
      }
    } else {
      syncUrlToParams();
    }
  };
  document.getElementById('btnSend').onclick = executeRequest;

  // Send request with Ctrl+Enter shortcut
  document.getElementById('requestUrl').onkeydown = (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      executeRequest();
    }
  };

  // Editor Tabs
  setupTabs('editorTabs', (tabId) => {
    const tabPanels = ['tabParams', 'tabHeaders', 'tabAuth', 'tabBody', 'tabScripts'];
    tabPanels.forEach(panelId => {
      document.getElementById(panelId).classList.toggle('active', panelId === tabId);
    });
  });

  // Response Tabs
  setupTabs('responseTabs', (tabId) => {
    const tabPanels = ['tabRespBody', 'tabRespHeaders', 'tabRespLog'];
    tabPanels.forEach(panelId => {
      document.getElementById(panelId).classList.toggle('active', panelId === tabId);
    });
  });

  // Auth Type Change
  document.getElementById('authType').onchange = (e) => {
    const type = e.target.value;
    if (state.activeRequest) {
      if (!state.activeRequest.auth) state.activeRequest.auth = { type: 'none' };
      state.activeRequest.auth.type = type;
      queueSave();
    }
    renderAuthFields(type);
  };

  // Auth Fields Input Handlers
  document.getElementById('authBearerToken').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.auth) {
      state.activeRequest.auth.token = e.target.value;
      queueSave();
    }
  };
  document.getElementById('authBasicUser').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.auth) {
      state.activeRequest.auth.username = e.target.value;
      queueSave();
    }
  };
  document.getElementById('authBasicPassword').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.auth) {
      state.activeRequest.auth.password = e.target.value;
      queueSave();
    }
  };
  document.getElementById('authApiKeyVal').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.auth) {
      state.activeRequest.auth.key = e.target.value;
      queueSave();
    }
  };
  document.getElementById('authApiKeyHeader').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.auth) {
      state.activeRequest.auth.headerName = e.target.value;
      queueSave();
    }
  };

  // Body Type Segmented Control Buttons
  const bodyTypeSelect = document.getElementById('bodyTypeSelect');
  const bodySubTypeSelect = document.getElementById('bodySubTypeSelect');
  if (bodyTypeSelect) {
    bodyTypeSelect.addEventListener('click', (e) => {
      const btn = e.target.closest('.body-type-btn');
      if (!btn) return;

      bodyTypeSelect.querySelectorAll('.body-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const type = btn.dataset.value;
      if (state.activeRequest) {
        if (!state.activeRequest.body) state.activeRequest.body = { type: 'none', content: '', formData: [] };
        state.activeRequest.body.type = type;

        if (type === 'raw') {
          if (!state.activeRequest.body.subType) {
            state.activeRequest.body.subType = 'json';
          }
          if (bodySubTypeSelect) {
            bodySubTypeSelect.value = state.activeRequest.body.subType;
            bodySubTypeSelect.style.display = 'block';
          }
        } else {
          if (bodySubTypeSelect) {
            bodySubTypeSelect.style.display = 'none';
          }
        }

        queueSave();
      }
      renderBodyEditorFields(type);
    });
  }

  if (bodySubTypeSelect) {
    bodySubTypeSelect.addEventListener('change', (e) => {
      const subType = e.target.value;
      if (state.activeRequest && state.activeRequest.body) {
        state.activeRequest.body.subType = subType;
        queueSave();
        renderBodyEditorFields(state.activeRequest.body.type);
      }
    });
  }

  // Body Textarea Content
  document.getElementById('bodyContent').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.body) {
      state.activeRequest.body.content = e.target.value;
      queueSave();
    }
  };

  // Scripts Type Segmented Control Buttons
  const scriptsTypeSelect = document.getElementById('scriptsTypeSelect');
  if (scriptsTypeSelect) {
    scriptsTypeSelect.addEventListener('click', (e) => {
      const btn = e.target.closest('.scripts-type-btn');
      if (!btn) return;

      scriptsTypeSelect.querySelectorAll('.scripts-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const type = btn.dataset.value;
      document.getElementById('preScriptPane').style.display = (type === 'pre') ? 'flex' : 'none';
      document.getElementById('postScriptPane').style.display = (type === 'post') ? 'flex' : 'none';
    });
  }

  // Pre/Post scripts Inputs
  document.getElementById('preScript').oninput = (e) => {
    if (state.activeRequest) {
      state.activeRequest.preScript = e.target.value;
      queueSave();
    }
  };
  document.getElementById('postScript').oninput = (e) => {
    if (state.activeRequest) {
      state.activeRequest.postScript = e.target.value;
      queueSave();
    }
  };

  // GraphQL Inputs
  document.getElementById('graphqlQuery').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.body) {
      state.activeRequest.body.query = e.target.value;
      queueSave();
    }
  };
  document.getElementById('graphqlVariables').oninput = (e) => {
    if (state.activeRequest && state.activeRequest.body) {
      state.activeRequest.body.variables = e.target.value;
      queueSave();
    }
  };

  // Code Snippets Listeners
  document.getElementById('btnCodeSnippet').onclick = openCodeSnippetModal;
  document.getElementById('btnCancelSnippet').onclick = () => closeDialog('modalCodeSnippet');
  document.getElementById('btnCopySnippet').onclick = copySnippetToClipboard;
  document.getElementById('snippetLanguageSelect').onchange = updateCodeSnippetDisplay;

  // Search Bar Listeners
  document.getElementById('responseSearchInput').oninput = performResponseSearch;
  document.getElementById('btnPrevSearch').onclick = () => navigateSearch(-1);
  document.getElementById('btnNextSearch').onclick = () => navigateSearch(1);

  // Live Variable Preview Listeners
  document.addEventListener('focusin', handleVariablePreviewFocus);
  document.addEventListener('input', handleVariablePreviewInput);
  document.addEventListener('focusout', handleVariablePreviewBlur);

  // Request Method Dropdown
  document.getElementById('requestMethod').onchange = (e) => {
    if (state.activeRequest) {
      state.activeRequest.method = e.target.value;
      updateActiveTabTitle();
      queueSave();
      refreshCollectionSidebar();
    }
  };

  // Environment Selector (Bottom status bar)
  document.getElementById('envSelector').onchange = handleEnvSelectorChange;

  // Environment Manager Modal controls
  document.getElementById('btnEnvCreateNew').onclick = createNewEnvironment;
  document.getElementById('btnEnvSave').onclick = saveActiveEnvironmentChanges;
  document.getElementById('btnEnvDelete').onclick = deleteActiveEnvironment;
  document.getElementById('btnEnvClose').onclick = () => closeDialog('modalEnvManager');


  // Response Panel actions
  document.getElementById('btnCopyResponse').onclick = copyResponseToClipboard;

  // Response pretty-raw toggle
  document.querySelectorAll('#prettyRawToggle .toggle-btn').forEach(btn => {
    btn.onclick = (e) => {
      document.querySelectorAll('#prettyRawToggle .toggle-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      const query = document.getElementById('responseJsonPathInput').value.trim();
      if (query && (e.target.dataset.mode === 'pretty' || e.target.dataset.mode === 'raw')) {
        document.getElementById('responseJsonPathInput').dispatchEvent(new Event('input'));
      } else {
        renderResponseBody(state.lastResponseText, e.target.dataset.mode);
      }
    };
  });

  // JSONPath Filter input listener
  const jsonPathInput = document.getElementById('responseJsonPathInput');
  const clearJsonPathBtn = document.getElementById('btnClearJsonPath');

  if (jsonPathInput) {
    jsonPathInput.oninput = (e) => {
      const query = e.target.value.trim();
      const activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;

      if (clearJsonPathBtn) {
        clearJsonPathBtn.style.display = query ? 'block' : 'none';
      }

      if (!query || !state.lastResponseText) {
        renderResponseBody(state.lastResponseText, activeMode);
        return;
      }

      try {
        const parsed = JSON.parse(state.lastResponseText);
        const filtered = queryJson(parsed, query);
        const display = document.getElementById('responseBodyDisplay');
        display.innerHTML = '';

        if (filtered === undefined) {
          display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">No match found for this JSONPath query</div>';
        } else {
          const pre = document.createElement('pre');
          pre.className = 'mono';
          if (activeMode === 'pretty') {
            pre.innerHTML = syntaxHighlightJson(JSON.stringify(filtered, null, 2));
          } else {
            pre.textContent = JSON.stringify(filtered, null, 2);
          }
          display.appendChild(pre);
        }
      } catch (err) {
        renderResponseBody(state.lastResponseText, activeMode);
      }
    };
  }

  if (clearJsonPathBtn) {
    clearJsonPathBtn.onclick = () => {
      jsonPathInput.value = '';
      clearJsonPathBtn.style.display = 'none';
      const activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;
      renderResponseBody(state.lastResponseText, activeMode);
    };
  }

  // Global Context Menu closer
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  // Context Menu listener on tree items & request tabs
  window.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.collection-item, .folder-item, .request-item, .request-tab');
    if (item) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, item);
    } else {
      hideContextMenu();
    }
  });

  // Native Menu Listeners (Workspace triggers)
  window.teamapi.workspace.onOpenRequest(() => {
    selectWorkspace();
  });
  window.teamapi.workspace.onNewRequest(() => {
    openCreateWorkspaceModal();
  });
  window.teamapi.workspace.onGoToHome(() => {
    showWelcomeScreen();
  });

  // Import Collection Dialog listeners
  const btnImport = document.getElementById('btnImport');
  if (btnImport) {
    btnImport.onclick = () => {
      document.getElementById('importFileInput').value = '';
      document.getElementById('importTextContent').value = '';
      openDialog('modalImportCollection');
    };
  }

  document.getElementById('btnCancelImport').onclick = () => closeDialog('modalImportCollection');

  document.getElementById('btnConfirmImport').onclick = async () => {
    const fileInput = document.getElementById('importFileInput');
    const textContent = document.getElementById('importTextContent').value.trim();

    try {
      if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            await importCollection(e.target.result);
            closeDialog('modalImportCollection');
            showToast('Collection imported successfully!', 'success');
            await refreshCollections();
            await refreshEnvironments();
            renderCollectionsTree();
          } catch (err) {
            showToast('Import failed: ' + err.message, 'error');
          }
        };
        reader.readAsText(file);
      } else if (textContent) {
        await importCollection(textContent);
        closeDialog('modalImportCollection');
        showToast('Collection imported successfully!', 'success');
        await refreshCollections();
        await refreshEnvironments();
        renderCollectionsTree();
      } else {
        showToast('Please select a file or paste JSON content to import.', 'warning');
      }
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
  };
}

// Dialog Helpers using native `<dialog>` HTML5 elements
function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
  }
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && typeof dialog.close === 'function') {
    dialog.close();
  }
}

// Tab Selector Helper
function setupTabs(containerId, onTabChange) {
  const container = document.getElementById(containerId);
  container.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tab-btn');
    if (!tabBtn) return;

    container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');

    onTabChange(tabBtn.dataset.tab);
  });
}

// Input Prompt Modal helper (reusable input dialog)
let promptCallback = null;
function openPromptDialog(title, label, defaultValue, callback) {
  document.getElementById('inputPromptHeader').textContent = title;
  document.getElementById('inputPromptLabel').textContent = label;
  document.getElementById('inputPromptValue').value = defaultValue;
  promptCallback = callback;
  openDialog('modalInputPrompt');

  document.getElementById('btnConfirmPrompt').onclick = () => {
    const val = document.getElementById('inputPromptValue').value.trim();
    if (val) {
      promptCallback(val);
      closeDialog('modalInputPrompt');
    }
  };
}

function showWelcomeScreen() {
  const welcomeScreen = document.getElementById('welcomeScreen');
  if (!welcomeScreen) return;
  
  welcomeScreen.style.display = 'flex';
  
  // Show close/back button if there is a loaded workspace
  const backBtn = document.getElementById('welcomeCloseBtn');
  if (backBtn) {
    backBtn.style.display = state.currentWorkspace ? 'flex' : 'none';
  }

  const lastPath = localStorage.getItem('lastWorkspacePath');
  const recentEl = document.getElementById('welcomeRecent');
  if (recentEl) {
    if (lastPath) {
      recentEl.style.display = 'flex';
      
      const separator = lastPath.includes('\\') ? '\\' : '/';
      const parts = lastPath.split(separator);
      const folderName = parts[parts.length - 1] || lastPath;
      
      const itemEl = document.getElementById('recentWorkspaceItem');
      if (itemEl) {
        itemEl.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-blue); flex-shrink: 0; margin-right: 4px;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span style="font-weight: 700; color: var(--text-primary); margin-right: 8px;">${folderName}</span>
          <span style="color: var(--text-muted); font-size: 11px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: left;">${lastPath}</span>
          <svg class="recent-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-dim); transition: transform 0.2s ease; margin-left: 4px;">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
        itemEl.onclick = async () => {
          try {
            const ws = await window.teamapi.workspace.openPath(lastPath);
            if (ws) {
              await loadWorkspace(ws);
            } else {
              showToast('Workspace path no longer exists on disk', 'error');
              localStorage.removeItem('lastWorkspacePath');
              showWelcomeScreen();
            }
          } catch (err) {
            showToast('Failed to open workspace: ' + err.message, 'error');
          }
        };
      }
    } else {
      recentEl.style.display = 'none';
    }
  }
}

// Workspace Dialog Handlers
async function selectWorkspace(defaultPath = null) {
  try {
    const ws = await window.teamapi.workspace.openDialog(defaultPath);
    if (ws) {
      await loadWorkspace(ws);
    }
  } catch (err) {
    showToast('Failed to open workspace: ' + err.message, 'error');
  }
}

function openCreateWorkspaceModal() {
  document.getElementById('newWorkspaceName').value = '';
  openDialog('modalCreateWorkspace');
}

async function confirmCreateWorkspace() {
  const name = document.getElementById('newWorkspaceName').value.trim();
  if (!name) {
    showToast('Name is required', 'warning');
    return;
  }
  closeDialog('modalCreateWorkspace');
  try {
    const ws = await window.teamapi.workspace.createDialog(name);
    if (ws) {
      await loadWorkspace(ws);
      showToast(`Workspace "${name}" created successfully.`, 'success');
    }
  } catch (err) {
    showToast('Failed to create workspace: ' + err.message, 'error');
  }
}

// Helper to save expanded tree nodes
function saveExpandedNodes() {
  if (state.currentWorkspace) {
    const list = Array.from(state.expandedNodes);
    localStorage.setItem(`expandedNodes:${state.currentWorkspace.path}`, JSON.stringify(list));
  }
}

// Loads a workspace
async function loadWorkspace(ws) {
  state.currentWorkspace = ws;
  state.loadedCollections = {};
  state.activeCollectionId = null;
  state.activeRequestId = null;
  state.activeRequest = null;
  
  // Clear open tabs on workspace change
  state.tabs = [];
  state.activeTabId = null;
  renderRequestTabs();
  
  const placeholderEl = document.getElementById('noRequestPlaceholder');
  const mainContentEl = document.getElementById('editorMainContent');
  if (placeholderEl && mainContentEl) {
    placeholderEl.style.display = 'flex';
    mainContentEl.style.display = 'none';
  }
  
  // Rehydrate expanded tree nodes
  state.expandedNodes.clear();
  try {
    const savedNodes = localStorage.getItem(`expandedNodes:${ws.path}`);
    if (savedNodes) {
      const parsed = JSON.parse(savedNodes);
      if (Array.isArray(parsed)) {
        parsed.forEach(id => state.expandedNodes.add(id));
      }
    }
  } catch (err) {
    console.error('Failed to parse expandedNodes:', err);
  }

  // Restore sidebar collapse state
  const sidebar = document.querySelector('.sidebar');
  const sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }

  // Hide welcome overlay
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('btnToggleSidebar').style.display = 'flex';

  // Update layout header
  document.getElementById('workspaceTitle').textContent = ws.name;
  document.getElementById('titlebarWorkspaceName').textContent = ws.name;

  // Persist current workspace path
  localStorage.setItem('lastWorkspacePath', ws.path);

  // Load data components
  await refreshCollections();

  // Pre-load details for expanded collections
  if (state.collections && state.collections.length > 0) {
    for (const col of state.collections) {
      if (state.expandedNodes.has(col.id)) {
        await loadCollectionDetails(col.id);
      }
    }
  }

  await refreshEnvironments();
  await refreshHistory();
}

// Collections Core Operations
async function refreshCollections() {
  try {
    state.collections = await window.teamapi.collections.list();
    renderCollectionsTree();
  } catch (err) {
    showToast('Failed to list collections: ' + err.message, 'error');
  }
}

async function refreshEnvironments() {
  try {
    state.environments = await window.teamapi.environments.list();
    
    // Resolve active environment for the current workspace
    if (state.currentWorkspace) {
      const wsEnvKey = `activeEnvId:${state.currentWorkspace.path}`;
      const savedEnvId = localStorage.getItem(wsEnvKey) || 'none';
      const envExists = state.environments.some(env => env.id === savedEnvId);
      state.activeEnvId = envExists ? savedEnvId : 'none';
      state.activeEnv = state.environments.find(env => env.id === state.activeEnvId) || null;
    } else {
      state.activeEnvId = 'none';
      state.activeEnv = null;
    }

    populateEnvironmentDropdown();
  } catch (err) {
    showToast('Failed to list environments: ' + err.message, 'error');
  }
}

async function refreshHistory() {
  try {
    state.history = await window.teamapi.history.list();
    renderHistory();
  } catch (err) {
    showToast('Failed to list history: ' + err.message, 'error');
  }
}


// Dialog: New Collection
async function confirmCreateCollection() {
  const name = document.getElementById('newCollectionName').value.trim();
  if (!name) return;
  closeDialog('modalCreateCollection');
  try {
    const newCol = {
      name,
      description: '',
      folders: [],
      requests: []
    };
    const saved = await window.teamapi.collections.save(newCol);
    showToast(`Collection "${name}" created`, 'success');
    await refreshCollections();
    // Auto-expand new collection
    state.expandedNodes.add(saved.id);
    saveExpandedNodes();
    await loadCollectionDetails(saved.id);
  } catch (err) {
    showToast('Failed to save collection: ' + err.message, 'error');
  }
}

// Loads full collection details (requests/folders tree)
async function loadCollectionDetails(id) {
  try {
    const colObj = await window.teamapi.collections.get(id);
    if (colObj) {
      state.loadedCollections[id] = colObj;
      renderCollectionsTree();
    }
  } catch (err) {
    showToast('Failed to load collection details: ' + err.message, 'error');
  }
}

// Tree view renderer
function renderCollectionsTree() {
  const container = document.getElementById('collectionsList');
  container.innerHTML = '';

  if (state.collections.length === 0) {
    container.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 12px;">No collections found</div>';
    return;
  }

  state.collections.forEach(colSummary => {
    const colId = colSummary.id;
    const colDetail = state.loadedCollections[colId];
    const isExpanded = state.expandedNodes.has(colId);

    const colNode = document.createElement('div');
    colNode.className = 'collection-node';

    // Header element
    const colHeader = document.createElement('div');
    colHeader.className = 'collection-item';
    colHeader.dataset.id = colId;
    colHeader.dataset.type = 'collection';

    const chevron = document.createElement('span');
    chevron.className = `chevron ${isExpanded ? '' : 'collapsed'}`;
    chevron.innerHTML = '&#9660;';
    colHeader.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = colSummary.name;
    colHeader.appendChild(name);

    colNode.appendChild(colHeader);

    // Click handler to toggle expansion
    colHeader.onclick = async (e) => {
      // Toggle node expand state
      if (isExpanded) {
        state.expandedNodes.delete(colId);
        saveExpandedNodes();
        renderCollectionsTree();
      } else {
        state.expandedNodes.add(colId);
        saveExpandedNodes();
        await loadCollectionDetails(colId);
      }
    };

    // Render contents (Folders and Requests) if expanded
    if (isExpanded && colDetail) {
      const contentPane = document.createElement('div');
      contentPane.className = 'collection-content tree-node';
      contentPane.id = `col-content-${colId}`;

      // 1. Render Folders
      if (colDetail.folders && colDetail.folders.length > 0) {
        colDetail.folders.forEach(folder => {
          const folderId = folder.id;
          const folderExpanded = state.expandedNodes.has(folderId);

          const folderNode = document.createElement('div');
          folderNode.className = 'folder-node';

          const folderHeader = document.createElement('div');
          folderHeader.className = 'folder-item';
          folderHeader.dataset.colId = colId;
          folderHeader.dataset.folderId = folderId;
          folderHeader.dataset.type = 'folder';

          const fChevron = document.createElement('span');
          fChevron.className = `chevron ${folderExpanded ? '' : 'collapsed'}`;
          fChevron.innerHTML = '&#9660;';
          folderHeader.appendChild(fChevron);

          const fName = document.createElement('span');
          fName.className = 'item-name';
          fName.textContent = folder.name;
          folderHeader.appendChild(fName);

          folderNode.appendChild(folderHeader);

          // Click folder to expand
          folderHeader.onclick = (evt) => {
            evt.stopPropagation();
            if (folderExpanded) {
              state.expandedNodes.delete(folderId);
            } else {
              state.expandedNodes.add(folderId);
            }
            saveExpandedNodes();
            renderCollectionsTree();
          };

          // Render requests inside folder if expanded
          if (folderExpanded) {
            const folderContent = document.createElement('div');
            folderContent.className = 'folder-content tree-node';

            const folderRequests = colDetail.requests.filter(r => r.folderId === folderId);
            if (folderRequests.length === 0) {
              folderContent.innerHTML = '<div style="color: var(--text-dim); padding: 4px 10px; font-size: 11px;">Empty folder</div>';
            } else {
              folderRequests.forEach(req => {
                const reqItem = createRequestTreeItem(req, colId);
                folderContent.appendChild(reqItem);
              });
            }
            folderNode.appendChild(folderContent);
          }

          contentPane.appendChild(folderNode);
        });
      }

      // 2. Render root-level Requests (not inside any folder)
      const rootRequests = colDetail.requests.filter(r => !r.folderId);
      rootRequests.forEach(req => {
        const reqItem = createRequestTreeItem(req, colId);
        contentPane.appendChild(reqItem);
      });

      if ((!colDetail.folders || colDetail.folders.length === 0) && rootRequests.length === 0) {
        contentPane.innerHTML = '<div style="color: var(--text-dim); padding: 6px 12px; font-size: 11px;">Empty collection</div>';
      }

      colNode.appendChild(contentPane);
    }

    container.appendChild(colNode);
  });
}

function createRequestTreeItem(req, colId) {
  const reqItem = document.createElement('div');
  reqItem.className = `request-item ${state.activeRequestId === req.id ? 'active' : ''}`;
  reqItem.dataset.colId = colId;
  reqItem.dataset.reqId = req.id;
  reqItem.dataset.type = 'request';

  const badge = document.createElement('span');
  badge.className = `method-badge ${req.method || 'GET'}`;
  badge.textContent = req.method || 'GET';
  reqItem.appendChild(badge);

  const rName = document.createElement('span');
  rName.className = 'item-name';
  rName.textContent = req.name;
  reqItem.appendChild(rName);

  reqItem.onclick = (e) => {
    e.stopPropagation();
    loadRequestIntoEditor(colId, req.id);
  };

  return reqItem;
}

// Refreshes the active request sidebar item when method or name is updated
function refreshCollectionSidebar() {
  renderCollectionsTree();
}

// Request Loader
function loadRequestIntoEditor(colId, reqId) {
  const colDetail = state.loadedCollections[colId];
  if (!colDetail) return;

  const req = colDetail.requests.find(r => r.id === reqId);
  if (!req) return;

  openRequestInTab(req.id, 'saved', req.name, req, colId);
}

// Tab system helpers
async function flushSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (state.activeCollectionId && state.loadedCollections[state.activeCollectionId]) {
    try {
      const col = state.loadedCollections[state.activeCollectionId];
      await window.teamapi.collections.save(col);
    } catch (err) {
      showToast('Auto-save failed: ' + err.message, 'error');
    }
  }
}

async function openRequestInTab(id, type, name, requestObj, collectionId = null) {
  let existingTab = state.tabs.find(t => t.id === id);
  if (existingTab) {
    await activateTab(id);
  } else {
    const newTab = {
      id: id,
      type: type, // 'saved', 'history', 'new'
      name: name,
      collectionId: collectionId,
      request: requestObj
    };
    state.tabs.push(newTab);
    await activateTab(id);
  }
}

async function activateTab(tabId) {
  await flushSave();
  
  state.activeTabId = tabId;
  const tab = state.tabs.find(t => t.id === tabId);
  if (tab) {
    state.activeRequest = tab.request;
    state.activeCollectionId = tab.collectionId;
    state.activeRequestId = (tab.type === 'saved') ? tab.id : null;
    renderActiveTabToEditor();
  } else {
    state.activeRequest = null;
    state.activeCollectionId = null;
    state.activeRequestId = null;
    renderActiveTabToEditor();
  }
  renderRequestTabs();
  renderCollectionsTree();
}

async function closeTab(tabId, e) {
  if (e) e.stopPropagation();
  await flushSave();

  const tabIndex = state.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  state.tabs.splice(tabIndex, 1);

  if (state.activeTabId === tabId) {
    if (state.tabs.length > 0) {
      const nextActiveIndex = Math.min(tabIndex, state.tabs.length - 1);
      await activateTab(state.tabs[nextActiveIndex].id);
    } else {
      await activateTab(null);
    }
  } else {
    renderRequestTabs();
  }
}

async function closeOtherTabs(keepTabId) {
  await flushSave();
  state.tabs = state.tabs.filter(t => t.id === keepTabId);
  const activeTabStillExists = state.tabs.some(t => t.id === state.activeTabId);
  if (!activeTabStillExists) {
    if (state.tabs.length > 0) {
      await activateTab(keepTabId);
    } else {
      await activateTab(null);
    }
  } else {
    renderRequestTabs();
  }
}

async function closeTabsToTheRight(tabId) {
  await flushSave();
  const index = state.tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;

  const tabsToKeep = state.tabs.slice(0, index + 1);
  const activeTabStillExists = tabsToKeep.some(t => t.id === state.activeTabId);
  state.tabs = tabsToKeep;

  if (!activeTabStillExists) {
    await activateTab(tabId);
  } else {
    renderRequestTabs();
  }
}

async function closeAllTabs() {
  await flushSave();
  state.tabs = [];
  await activateTab(null);
}

function createNewTab() {
  const newId = 'new-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const blankRequest = {
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none', content: '', formData: [] },
    preScript: '',
    postScript: ''
  };
  openRequestInTab(newId, 'new', 'Untitled Request', blankRequest);
}

function updateActiveTabTitle() {
  if (!state.activeTabId) return;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  if (tab.type === 'new' || tab.type === 'history') {
    let url = tab.request.url || '';
    let name = url ? url.replace(/^https?:\/\/[^\/]+/i, '') : '';
    if (!name || name === '/') name = url || (tab.type === 'new' ? 'Untitled Request' : 'History');
    if (name.length > 20) name = name.substring(0, 17) + '...';
    tab.name = name;
  }
  renderRequestTabs();
}

function renderRequestTabs() {
  const container = document.getElementById('requestTabsList');
  if (!container) return;
  container.innerHTML = '';

  state.tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `request-tab ${state.activeTabId === tab.id ? 'active' : ''}`;
    tabEl.dataset.type = 'tab';
    tabEl.dataset.id = tab.id;
    tabEl.onclick = () => activateTab(tab.id);

    // Method badge
    const methodSpan = document.createElement('span');
    const method = tab.request.method || 'GET';
    methodSpan.className = `request-tab-method ${method}`;
    methodSpan.textContent = method;
    tabEl.appendChild(methodSpan);

    // Name text
    const nameSpan = document.createElement('span');
    nameSpan.className = 'request-tab-title';
    nameSpan.textContent = tab.name || 'Untitled';
    tabEl.appendChild(nameSpan);

    // Close button
    const closeSpan = document.createElement('span');
    closeSpan.className = 'request-tab-close';
    closeSpan.innerHTML = '×';
    closeSpan.onclick = (e) => closeTab(tab.id, e);
    tabEl.appendChild(closeSpan);

    container.appendChild(tabEl);
  });
}

function renderActiveTabToEditor() {
  const req = state.activeRequest;
  const placeholderEl = document.getElementById('noRequestPlaceholder');
  const mainContentEl = document.getElementById('editorMainContent');

  if (!req) {
    if (placeholderEl) placeholderEl.style.display = 'flex';
    if (mainContentEl) mainContentEl.style.display = 'none';
    return;
  }

  if (placeholderEl) placeholderEl.style.display = 'none';
  if (mainContentEl) mainContentEl.style.display = 'flex';

  // Render elements in editor
  document.getElementById('requestMethod').value = req.method || 'GET';
  document.getElementById('requestUrl').value = req.url || '';

  // Params tab rendering
  if (!req.params) req.params = [];
  renderParamsTable();

  // Headers tab
  if (!req.headers) req.headers = [];
  renderHeadersTable();

  // Auth tab
  if (!req.auth) req.auth = { type: 'none' };
  document.getElementById('authType').value = req.auth.type;
  renderAuthFields(req.auth.type);
  if (req.auth.type === 'bearer') {
    document.getElementById('authBearerToken').value = req.auth.token || '';
  } else if (req.auth.type === 'basic') {
    document.getElementById('authBasicUser').value = req.auth.username || '';
    document.getElementById('authBasicPassword').value = req.auth.password || '';
  } else if (req.auth.type === 'apikey') {
    document.getElementById('authApiKeyVal').value = req.auth.key || '';
    document.getElementById('authApiKeyHeader').value = req.auth.headerName || '';
  }

  // Body tab
  if (!req.body) req.body = { type: 'none', content: '', formData: [] };
  const bType = req.body.type || 'none';
  const bodyTypeSelectEl = document.getElementById('bodyTypeSelect');
  if (bodyTypeSelectEl) {
    bodyTypeSelectEl.querySelectorAll('.body-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === bType);
    });
  }
  const bodySubTypeSelectEl = document.getElementById('bodySubTypeSelect');
  if (bodySubTypeSelectEl) {
    if (bType === 'raw') {
      bodySubTypeSelectEl.value = req.body.subType || 'json';
      bodySubTypeSelectEl.style.display = 'block';
    } else {
      bodySubTypeSelectEl.style.display = 'none';
    }
  }
  renderBodyEditorFields(bType);
  document.getElementById('bodyContent').value = req.body.content || '';
  document.getElementById('graphqlQuery').value = req.body.query || '';
  document.getElementById('graphqlVariables').value = req.body.variables || '';
  renderBodyFormTable();

  // Scripts
  document.getElementById('preScript').value = req.preScript || '';
  document.getElementById('postScript').value = req.postScript || '';

  const scriptsTypeSelectEl = document.getElementById('scriptsTypeSelect');
  if (scriptsTypeSelectEl) {
    scriptsTypeSelectEl.querySelectorAll('.scripts-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === 'pre');
    });
    document.getElementById('preScriptPane').style.display = 'flex';
    document.getElementById('postScriptPane').style.display = 'none';
  }
}

// Parameters Table Manager
function renderParamsTable() {
  const container = document.getElementById('paramsContainer');
  renderKeyValueGrid(container, state.activeRequest.params, (newList) => {
    state.activeRequest.params = newList;
    syncParamsToUrl();
    queueSave();
  });
}

// Headers Table Manager
function renderHeadersTable() {
  const container = document.getElementById('headersContainer');
  renderKeyValueGrid(container, state.activeRequest.headers, (newList) => {
    state.activeRequest.headers = newList;
    queueSave();
  });
}

// Body Form Data Table Manager
function renderBodyFormTable() {
  const container = document.getElementById('bodyFormContainer');
  renderKeyValueGrid(container, state.activeRequest.body.formData, (newList) => {
    state.activeRequest.body.formData = newList;
    queueSave();
  });
}

// Shared Key-Value Grid Utility
function renderKeyValueGrid(container, list, onChange, options = {}) {
  // Preserve header
  const header = container.querySelector('.kv-header');
  container.innerHTML = '';
  container.appendChild(header);

  if (options.showSecret) {
    header.style.gridTemplateColumns = '30px 1fr 1fr 60px 30px';
    if (header.children.length === 4) {
      const secretHeader = document.createElement('div');
      secretHeader.textContent = 'Secret';
      secretHeader.style.textAlign = 'center';
      header.insertBefore(secretHeader, header.children[3]);
    }
  } else {
    header.style.gridTemplateColumns = '';
    if (header.children.length === 5) {
      header.children[3].remove();
    }
  }

  // Renders the rows
  list.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    if (options.showSecret) {
      row.style.gridTemplateColumns = '30px 1fr 1fr 60px 30px';
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'kv-checkbox';
    checkbox.checked = item.enabled !== false;
    checkbox.onchange = (e) => {
      item.enabled = e.target.checked;
      onChange(list);
    };
    row.appendChild(checkbox);

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'kv-input';
    keyInput.value = item.key || '';
    keyInput.placeholder = 'Key';
    keyInput.oninput = (e) => {
      item.key = e.target.value;
      onChange(list);
    };
    row.appendChild(keyInput);

    const valCol = document.createElement('div');
    valCol.style.position = 'relative';
    valCol.style.display = 'flex';
    valCol.style.alignItems = 'center';
    valCol.style.width = '100%';

    const valInput = document.createElement('input');
    valInput.type = (item.isSecret && !item.showPlain) ? 'password' : 'text';
    valInput.className = 'kv-input';
    valInput.value = item.value || '';
    valInput.placeholder = 'Value';
    valInput.style.width = '100%';
    if (item.isSecret) {
      valInput.style.paddingRight = '24px';
    }
    valInput.oninput = (e) => {
      item.value = e.target.value;
      onChange(list);
    };
    valCol.appendChild(valInput);

    if (item.isSecret) {
      const eyeBtn = document.createElement('button');
      eyeBtn.className = 'secret-toggle-btn';
      eyeBtn.innerHTML = item.showPlain ? '🙈' : '👁️';
      eyeBtn.title = item.showPlain ? 'Hide Value' : 'Show Value';
      eyeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        item.showPlain = !item.showPlain;
        valInput.type = item.showPlain ? 'text' : 'password';
        eyeBtn.innerHTML = item.showPlain ? '🙈' : '👁️';
        eyeBtn.title = item.showPlain ? 'Hide Value' : 'Show Value';
      };
      valCol.appendChild(eyeBtn);
    }
    row.appendChild(valCol);

    if (options.showSecret) {
      const secretWrapper = document.createElement('div');
      secretWrapper.style.display = 'flex';
      secretWrapper.style.alignItems = 'center';
      secretWrapper.style.gap = '4px';
      secretWrapper.style.justifyContent = 'center';

      const secretCheckbox = document.createElement('input');
      secretCheckbox.type = 'checkbox';
      secretCheckbox.className = 'kv-checkbox';
      secretCheckbox.checked = item.isSecret === true;
      secretCheckbox.title = 'Mask value';
      secretCheckbox.onchange = (e) => {
        item.isSecret = e.target.checked;
        onChange(list);
      };
      secretWrapper.appendChild(secretCheckbox);
      row.appendChild(secretWrapper);
    }

    const delBtn = document.createElement('div');
    delBtn.className = 'kv-delete';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = () => {
      list.splice(index, 1);
      onChange(list);
    };
    row.appendChild(delBtn);

    container.appendChild(row);
  });

  // Always append an empty row for new additions
  const emptyRow = document.createElement('div');
  emptyRow.className = 'kv-row';
  if (options.showSecret) {
    emptyRow.style.gridTemplateColumns = '30px 1fr 1fr 60px 30px';
  }

  const emptyCheckbox = document.createElement('input');
  emptyCheckbox.type = 'checkbox';
  emptyCheckbox.className = 'kv-checkbox';
  emptyCheckbox.disabled = true;
  emptyRow.appendChild(emptyCheckbox);

  const emptyKey = document.createElement('input');
  emptyKey.type = 'text';
  emptyKey.className = 'kv-input';
  emptyKey.placeholder = 'Add key';
  emptyRow.appendChild(emptyKey);

  const emptyVal = document.createElement('input');
  emptyVal.type = 'text';
  emptyVal.className = 'kv-input';
  emptyVal.placeholder = 'Add value';
  emptyRow.appendChild(emptyVal);

  if (options.showSecret) {
    const emptySecretWrapper = document.createElement('div');
    emptySecretWrapper.style.display = 'flex';
    emptySecretWrapper.style.justifyContent = 'center';
    const emptySecretCheckbox = document.createElement('input');
    emptySecretCheckbox.type = 'checkbox';
    emptySecretCheckbox.className = 'kv-checkbox';
    emptySecretCheckbox.disabled = true;
    emptySecretWrapper.appendChild(emptySecretCheckbox);
    emptyRow.appendChild(emptySecretWrapper);
  }

  const emptyDel = document.createElement('div');
  emptyDel.className = 'kv-delete';
  emptyRow.appendChild(emptyDel);

  // Input triggers creation
  const handleAddNew = () => {
    const k = emptyKey.value.trim();
    const v = emptyVal.value.trim();
    if (k || v) {
      list.push({ key: k, value: v, enabled: true });
      onChange(list);
    }
  };
  emptyKey.onchange = handleAddNew;
  emptyVal.onchange = handleAddNew;

  container.appendChild(emptyRow);
}

// URL - Parameter Synchronization
function syncUrlToParams() {
  if (state.isSyncingParams || !state.activeRequest) return;
  state.isSyncingParams = true;

  const urlText = document.getElementById('requestUrl').value;
  state.activeRequest.url = urlText;
  queueSave();

  const qIndex = urlText.indexOf('?');

  if (qIndex === -1) {
    state.activeRequest.params = [];
    renderParamsTable();
    state.isSyncingParams = false;
    updateActiveTabTitle();
    return;
  }

  const queryString = urlText.substring(qIndex + 1);
  const searchParams = new URLSearchParams(queryString);
  const params = [];

  for (const [key, value] of searchParams.entries()) {
    params.push({ key, value, enabled: true });
  }

  state.activeRequest.params = params;
  renderParamsTable();
  state.isSyncingParams = false;
  updateActiveTabTitle();
}

function syncParamsToUrl() {
  if (state.isSyncingParams || !state.activeRequest) return;
  state.isSyncingParams = true;

  const urlInput = document.getElementById('requestUrl');
  const urlText = urlInput.value;
  const qIndex = urlText.indexOf('?');
  const baseUrl = qIndex === -1 ? urlText : urlText.substring(0, qIndex);

  const enabledParams = state.activeRequest.params.filter(p => p.enabled && p.key);
  if (enabledParams.length > 0) {
    const parts = enabledParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`);
    urlInput.value = `${baseUrl}?${parts.join('&')}`;
  } else {
    urlInput.value = baseUrl;
  }

  state.activeRequest.url = urlInput.value;
  state.isSyncingParams = false;
  updateActiveTabTitle();
  queueSave();
}

// Dynamic Auth Fields renderer
function renderAuthFields(type) {
  document.querySelectorAll('.auth-fields').forEach(f => f.style.display = 'none');
  if (type === 'bearer') {
    document.getElementById('authBearerFields').style.display = 'block';
  } else if (type === 'basic') {
    document.getElementById('authBasicFields').style.display = 'block';
  } else if (type === 'apikey') {
    document.getElementById('authApiKeyFields').style.display = 'block';
  }
}

// Dynamic Body Fields renderer
function renderBodyEditorFields(type) {
  document.getElementById('bodyContentPane').style.display = 'none';
  document.getElementById('bodyFormPane').style.display = 'none';
  document.getElementById('bodyGraphqlPane').style.display = 'none';

  const isRaw = (type === 'raw' || type === 'json' || type === 'text' || type === 'xml' || type === 'html' || type === 'javascript');

  if (isRaw) {
    document.getElementById('bodyContentPane').style.display = 'flex';
    let subType = (state.activeRequest && state.activeRequest.body && state.activeRequest.body.subType) || 'json';
    if (type !== 'raw') {
      subType = type;
    }
    const textarea = document.getElementById('bodyContent');
    if (textarea) {
      if (subType === 'json') {
        textarea.placeholder = '{\n  "key": "value"\n}';
      } else if (subType === 'xml') {
        textarea.placeholder = '<xml>\n  <key>value</key>\n</xml>';
      } else if (subType === 'html') {
        textarea.placeholder = '<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>';
      } else if (subType === 'javascript') {
        textarea.placeholder = '// Write Javascript body payload here...';
      } else {
        textarea.placeholder = 'Write text payload here...';
      }
    }
  } else if (type === 'form' || type === 'urlencoded') {
    document.getElementById('bodyFormPane').style.display = 'block';
  } else if (type === 'graphql') {
    document.getElementById('bodyGraphqlPane').style.display = 'flex';
  }
}

// Execute HTTP Request
async function executeRequest() {
  if (!state.activeRequest) {
    showToast('Open or create a request first', 'warning');
    return;
  }

  const btnSend = document.getElementById('btnSend');
  btnSend.textContent = 'SENDING...';
  btnSend.disabled = true;

  try {
    const envVars = state.activeEnv ? state.activeEnv.variables : {};

    // Execute request IPC
    const result = await window.teamapi.request.execute({
      request: state.activeRequest,
      envVars
    });

    // Handle results
    btnSend.textContent = 'SEND';
    btnSend.disabled = false;

    // Show response status badge details
    const statusBadge = document.getElementById('responseStatus');
    statusBadge.textContent = result.status;
    statusBadge.style.display = 'block';

    // Render status badge colors
    statusBadge.className = 'response-badge';
    if (result.status >= 200 && result.status < 300) {
      statusBadge.style.backgroundColor = 'var(--accent-green)';
    } else if (result.status >= 300 && result.status < 400) {
      statusBadge.style.backgroundColor = 'var(--accent-yellow)';
    } else if (result.status >= 400) {
      statusBadge.style.backgroundColor = 'var(--accent-red)';
    } else {
      statusBadge.style.backgroundColor = 'var(--text-dim)';
    }

    // Response time and size
    document.getElementById('responseTime').textContent = `${result.duration}ms`;
    document.getElementById('responseSize').textContent = formatBytes(result.size);
    document.getElementById('responseMeta').style.display = 'flex';

    // Show control layouts
    document.getElementById('prettyRawToggle').style.display = 'flex';
    document.getElementById('btnCopyResponse').style.display = 'block';
    
    // Toggle search bar visibility
    document.getElementById('responseSearchBar').style.display = (result.error || !result.body) ? 'none' : 'flex';
    document.getElementById('responseSearchInput').value = '';
    document.getElementById('responseSearchCount').textContent = '0/0';

    // Body content display
    if (result.error) {
      state.lastResponseText = result.error;
      state.lastResponseIsBinary = false;
      state.lastResponseContentType = '';
      renderResponseBody(`Error sending request:\n${result.error}`, 'raw');
      statusBadge.textContent = 'Error';
      statusBadge.style.backgroundColor = 'var(--accent-red)';
    } else {
      state.lastResponseText = result.body || '';
      state.lastResponseIsBinary = result.isBinary || false;
      state.lastResponseContentType = result.contentType || '';
      
      let activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;
      const isHtml = result.contentType && result.contentType.toLowerCase().includes('html');
      if (isHtml) {
        document.querySelectorAll('#prettyRawToggle .toggle-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.mode === 'preview');
        });
        activeMode = 'preview';
      }
      
      renderResponseBody(result.body, activeMode);
    }

    // Headers list
    renderResponseHeaders(result.headers);

    // Scripts sandbox log display
    renderScriptLogs(result.scriptLog);

    // Render test results
    renderTestResults(result.tests);

    // Save environment updates back to filesystem if script mutated them
    if (state.activeEnv && result.updatedEnvVars) {
      state.activeEnv.variables = result.updatedEnvVars;
      await window.teamapi.environments.save(state.activeEnv);
      refreshEnvironments();
    }

    // Refresh history sidebar list
    await refreshHistory();

  } catch (err) {
    btnSend.textContent = 'SEND';
    btnSend.disabled = false;
    showToast('Execution error: ' + err.message, 'error');
  }
}

// Bytes formatter
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// JSON Syntax Highlighter
function syntaxHighlightJson(json) {
  if (typeof json !== 'string') {
    json = JSON.stringify(json, undefined, 2);
  }
  // Escape HTML entities to prevent XSS
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Highlight keys, strings, numbers, booleans, and null
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}

// Display body content
function renderResponseBody(text, mode) {
  const display = document.getElementById('responseBodyDisplay');
  display.innerHTML = '';

  // Show/Hide JSONPath bar based on if the response is JSON-like and in Pretty/Raw mode
  const jsonPathBar = document.getElementById('responseJsonPathBar');
  if (jsonPathBar) {
    let isJson = false;
    try {
      if (text && !state.lastResponseIsBinary) {
        JSON.parse(text);
        isJson = true;
      }
    } catch(e) {}
    jsonPathBar.style.display = (isJson && (mode === 'pretty' || mode === 'raw')) ? 'flex' : 'none';
  }

  if (!text) {
    display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">Response body is empty</div>';
    return;
  }

  if (mode === 'preview') {
    if (state.lastResponseIsBinary) {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.src = `data:${state.lastResponseContentType};base64,${text}`;
      display.appendChild(img);
    } else {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-iframe';
      iframe.sandbox = 'allow-scripts';
      iframe.srcdoc = text;
      display.appendChild(iframe);
    }
  } else if (mode === 'pretty') {
    try {
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);

      const pre = document.createElement('pre');
      pre.className = 'mono';
      pre.innerHTML = syntaxHighlightJson(formatted);
      display.appendChild(pre);
    } catch (e) {
      // Non JSON representation raw text
      const pre = document.createElement('pre');
      pre.className = 'mono';
      pre.textContent = text;
      display.appendChild(pre);
    }
  } else {
    // Raw output representation
    const pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = text;
    display.appendChild(pre);
  }
}

// Display Headers
function renderResponseHeaders(headers) {
  const table = document.getElementById('responseHeadersTable');
  table.innerHTML = '';

  if (!headers || Object.keys(headers).length === 0) {
    table.innerHTML = '<tr><td colspan="2" style="color: var(--text-dim); text-align: center;">No headers</td></tr>';
    return;
  }

  for (const [key, val] of Object.entries(headers)) {
    const row = document.createElement('tr');

    const tdKey = document.createElement('td');
    tdKey.textContent = key;
    row.appendChild(tdKey);

    const tdVal = document.createElement('td');
    tdVal.className = 'mono';
    tdVal.textContent = val;
    row.appendChild(tdVal);

    table.appendChild(row);
  }
}

// Display Pre/Post execution script log statements
function renderScriptLogs(logs) {
  const display = document.getElementById('scriptLogsDisplay');
  display.innerHTML = '';

  if (!logs || logs.length === 0) {
    display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">No console logs printed</div>';
    return;
  }

  logs.forEach(line => {
    const row = document.createElement('div');
    row.className = 'log-line';
    row.textContent = line;
    display.appendChild(row);
  });
}

function copyResponseToClipboard() {
  if (state.lastResponseText) {
    navigator.clipboard.writeText(state.lastResponseText);
    showToast('Copied to clipboard', 'success');
  }
}

// Environments management
function populateEnvironmentDropdown() {
  const selector = document.getElementById('envSelector');
  // Clear extra options, keep the base ones
  selector.innerHTML = `
    <option value="none">No Environment</option>
    <option value="edit-envs">-- Manage Environments --</option>
  `;

  state.environments.forEach(env => {
    const option = document.createElement('option');
    option.value = env.id;
    option.textContent = env.name;
    selector.insertBefore(option, selector.lastElementChild);
  });

  selector.value = state.activeEnvId;
}

function handleEnvSelectorChange(e) {
  const val = e.target.value;
  if (val === 'edit-envs') {
    // Revert dropdown index
    e.target.value = state.activeEnvId;
    openEnvironmentManager();
  } else {
    state.activeEnvId = val;
    state.activeEnv = state.environments.find(env => env.id === val) || null;
    if (state.currentWorkspace) {
      localStorage.setItem(`activeEnvId:${state.currentWorkspace.path}`, val);
    }
    showToast(`Switched environment to: ${state.activeEnv ? state.activeEnv.name : 'None'}`);
  }
}

// Environment Management Dialog Modal
let envModalActiveId = null;
let envModalDraftVariables = {};
let envModalDraftSecrets = new Set();

function openEnvironmentManager() {
  envModalActiveId = null;
  envModalDraftVariables = {};
  envModalDraftSecrets = new Set();

  renderEnvManagerList();

  document.getElementById('envVariablesPane').style.display = 'none';
  document.getElementById('envNoSelectedPane').style.display = 'flex';
  document.getElementById('btnEnvSave').style.display = 'none';

  openDialog('modalEnvManager');
}

function renderEnvManagerList() {
  const listDiv = document.getElementById('envManagerList');
  listDiv.innerHTML = '';

  state.environments.forEach(env => {
    const btn = document.createElement('button');
    btn.className = `sidebar-btn ${envModalActiveId === env.id ? 'active' : ''}`;
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.textContent = env.name;
    btn.onclick = () => loadEnvIntoManager(env.id);
    listDiv.appendChild(btn);
  });
}

function loadEnvIntoManager(id) {
  envModalActiveId = id;
  const env = state.environments.find(e => e.id === id);
  if (!env) return;

  envModalDraftVariables = { ...env.variables };
  envModalDraftSecrets = new Set(env.secrets || []);

  // Set panes visible
  document.getElementById('envNoSelectedPane').style.display = 'none';
  document.getElementById('envVariablesPane').style.display = 'flex';
  document.getElementById('btnEnvSave').style.display = 'block';

  document.getElementById('envNameInput').value = env.name;

  renderEnvManagerVarsTable();
  renderEnvManagerList();
}

function renderEnvManagerVarsTable() {
  const container = document.getElementById('envVarsContainer');

  // Parse draft object map to structured key-value list
  const list = [];
  for (const [key, value] of Object.entries(envModalDraftVariables)) {
    list.push({ 
      key, 
      value, 
      enabled: true,
      isSecret: envModalDraftSecrets.has(key)
    });
  }

  renderKeyValueGrid(container, list, (newList) => {
    // Re-pack list to draft variables map
    envModalDraftVariables = {};
    envModalDraftSecrets.clear();
    newList.forEach(item => {
      if (item.key) {
        envModalDraftVariables[item.key] = item.value || '';
        if (item.isSecret) {
          envModalDraftSecrets.add(item.key);
        }
      }
    });
  }, { showSecret: true });
}

async function createNewEnvironment() {
  try {
    const newEnv = {
      name: 'New Environment',
      variables: {},
      secrets: []
    };
    const saved = await window.teamapi.environments.save(newEnv);
    await refreshEnvironments();
    loadEnvIntoManager(saved.id);
    showToast('Environment created');
  } catch (err) {
    showToast('Failed to create environment: ' + err.message, 'error');
  }
}

async function saveActiveEnvironmentChanges() {
  if (!envModalActiveId) return;
  const env = state.environments.find(e => e.id === envModalActiveId);
  if (!env) return;

  const newName = document.getElementById('envNameInput').value.trim();
  if (!newName) {
    showToast('Environment name is required', 'warning');
    return;
  }

  env.name = newName;
  env.variables = envModalDraftVariables;
  env.secrets = Array.from(envModalDraftSecrets);

  try {
    await window.teamapi.environments.save(env);
    showToast('Changes saved successfully', 'success');
    await refreshEnvironments();
    loadEnvIntoManager(envModalActiveId);
  } catch (err) {
    showToast('Failed to save environment changes: ' + err.message, 'error');
  }
}

async function deleteActiveEnvironment() {
  if (!envModalActiveId) return;
  if (!confirm('Are you sure you want to delete this environment?')) return;

  try {
    await window.teamapi.environments.delete(envModalActiveId);
    showToast('Environment deleted', 'success');
    await refreshEnvironments();

    // Reset panes
    envModalActiveId = null;
    document.getElementById('envVariablesPane').style.display = 'none';
    document.getElementById('envNoSelectedPane').style.display = 'flex';
    document.getElementById('btnEnvSave').style.display = 'none';

    renderEnvManagerList();
  } catch (err) {
    showToast('Failed to delete environment: ' + err.message, 'error');
  }
}



// History sidebar logger renderer
function renderHistory() {
  const container = document.getElementById('historyList');
  container.innerHTML = '';

  if (state.history.length === 0) {
    container.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 12px; font-size: 11px;">No history entries</div>';
    return;
  }

  state.history.slice(0, 10).forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-item';

    const badge = document.createElement('span');
    badge.className = `method-badge ${item.request.method}`;
    badge.textContent = item.request.method;
    row.appendChild(badge);

    const url = document.createElement('span');
    url.className = 'history-url';
    url.textContent = item.request.url;
    row.appendChild(url);

    const status = document.createElement('span');
    status.className = 'history-status';
    status.textContent = item.response.status;

    if (item.response.status >= 200 && item.response.status < 300) {
      status.classList.add('status-success');
    } else if (item.response.status >= 300 && item.response.status < 400) {
      status.classList.add('status-warning');
    } else {
      status.classList.add('status-error');
    }
    row.appendChild(status);

    row.onclick = () => {
      // Create a unique ephemeral ID
      const tabId = 'history-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      // Copy history request properties to a fresh editable object
      const clonedRequest = {
        method: item.request.method || 'GET',
        url: item.request.url || '',
        params: Array.isArray(item.request.params) ? JSON.parse(JSON.stringify(item.request.params)) : [],
        headers: Array.isArray(item.request.headers) ? JSON.parse(JSON.stringify(item.request.headers)) : [],
        auth: item.request.auth ? JSON.parse(JSON.stringify(item.request.auth)) : { type: 'none' },
        body: item.request.body ? JSON.parse(JSON.stringify(item.request.body)) : { type: 'none', content: '', formData: [] },
        preScript: item.request.preScript || '',
        postScript: item.request.postScript || ''
      };
      
      let name = clonedRequest.url ? clonedRequest.url.replace(/^https?:\/\/[^\/]+/i, '') : 'History';
      if (!name || name === '/') name = clonedRequest.url || 'History';
      if (name.length > 20) name = name.substring(0, 17) + '...';
      
      openRequestInTab(tabId, 'history', `${clonedRequest.method} ${name}`, clonedRequest);
      showToast('Loaded request from history into new tab');
    };

    container.appendChild(row);
  });
}

// Tree view Context Menus management
let activeContextTarget = null;

function showContextMenu(x, y, item) {
  activeContextTarget = item;
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = '';

  const type = item.dataset.type;
  if (type === 'collection') {
    const colId = item.dataset.id;
    addContextMenuItem('New Request', () => createRequestPrompt(colId));
    addContextMenuItem('New Folder', () => createFolderPrompt(colId));
    addContextMenuItem('Delete Collection', () => deleteCollectionPrompt(colId));
  } else if (type === 'folder') {
    const colId = item.dataset.colId;
    const folderId = item.dataset.folderId;
    addContextMenuItem('New Request', () => createRequestPrompt(colId, folderId));
    addContextMenuItem('Rename Folder', () => renameFolderPrompt(colId, folderId));
    addContextMenuItem('Delete Folder', () => deleteFolderPrompt(colId, folderId));
  } else if (type === 'request') {
    const colId = item.dataset.colId;
    const reqId = item.dataset.reqId;
    addContextMenuItem('Rename Request', () => renameRequestPrompt(colId, reqId));
    addContextMenuItem('Duplicate Request', () => duplicateRequestPrompt(colId, reqId));
    addContextMenuItem('Delete Request', () => deleteRequestPrompt(colId, reqId));
  } else if (type === 'tab') {
    const tabId = item.dataset.id;
    addContextMenuItem('Close Tab', () => closeTab(tabId));
    addContextMenuItem('Close Other Tabs', () => closeOtherTabs(tabId));
    addContextMenuItem('Close Tabs to the Right', () => closeTabsToTheRight(tabId));
    addContextMenuItem('Close All Tabs', () => closeAllTabs());
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'block';
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
}

function addContextMenuItem(label, action) {
  const menu = document.getElementById('contextMenu');
  const div = document.createElement('div');
  div.className = 'context-menu-item';
  div.textContent = label;
  div.onclick = (e) => {
    e.stopPropagation();
    hideContextMenu();
    action();
  };
  menu.appendChild(div);
}

// Action triggers on items
function createRequestPrompt(colId, folderId = null) {
  openPromptDialog('New Request', 'Request Name', 'New Request', async (name) => {
    const col = state.loadedCollections[colId];
    if (!col) return;
    const newReq = {
      id: window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2),
      folderId,
      name,
      method: 'GET',
      url: '',
      headers: [],
      auth: { type: 'none' },
      body: { type: 'none', content: '', formData: [] },
      preScript: '',
      postScript: '',
      description: ''
    };
    col.requests.push(newReq);
    try {
      await window.teamapi.collections.save(col);
      showToast('Request created');
      renderCollectionsTree();
      loadRequestIntoEditor(colId, newReq.id);
    } catch (e) {
      showToast('Failed to create request: ' + e.message, 'error');
    }
  });
}

function createFolderPrompt(colId) {
  openPromptDialog('New Folder', 'Folder Name', 'New Folder', async (name) => {
    const col = state.loadedCollections[colId];
    if (!col) return;
    const newFolder = {
      id: window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2),
      name,
      requestIds: []
    };
    col.folders.push(newFolder);
    try {
      await window.teamapi.collections.save(col);
      showToast('Folder created');
      renderCollectionsTree();
    } catch (e) {
      showToast('Failed to create folder: ' + e.message, 'error');
    }
  });
}

async function deleteCollectionPrompt(colId) {
  if (!confirm('Are you sure you want to delete this collection?')) return;
  try {
    await window.teamapi.collections.delete(colId);
    if (state.activeCollectionId === colId) {
      state.activeCollectionId = null;
      state.activeRequestId = null;
      state.activeRequest = null;
    }
    delete state.loadedCollections[colId];
    showToast('Collection deleted', 'success');
    await refreshCollections();
  } catch (e) {
    showToast('Failed to delete collection: ' + e.message, 'error');
  }
}

function renameFolderPrompt(colId, folderId) {
  const col = state.loadedCollections[colId];
  const folder = col.folders.find(f => f.id === folderId);
  if (!folder) return;

  openPromptDialog('Rename Folder', 'Folder Name', folder.name, async (newName) => {
    folder.name = newName;
    try {
      await window.teamapi.collections.save(col);
      renderCollectionsTree();
    } catch (e) {
      showToast('Rename failed: ' + e.message, 'error');
    }
  });
}

async function deleteFolderPrompt(colId, folderId) {
  if (!confirm('Delete this folder? Requests inside will be moved to root collection.')) return;
  const col = state.loadedCollections[colId];
  col.folders = col.folders.filter(f => f.id !== folderId);

  // Set folderId of child requests to null
  col.requests.forEach(r => {
    if (r.folderId === folderId) r.folderId = null;
  });

  try {
    await window.teamapi.collections.save(col);
    showToast('Folder deleted');
    renderCollectionsTree();
  } catch (e) {
    showToast('Delete folder failed: ' + e.message, 'error');
  }
}

function renameRequestPrompt(colId, reqId) {
  const col = state.loadedCollections[colId];
  const req = col.requests.find(r => r.id === reqId);
  if (!req) return;

  openPromptDialog('Rename Request', 'Request Name', req.name, async (newName) => {
    req.name = newName;
    try {
      await window.teamapi.collections.save(col);
      
      // Update tab title if open
      const tab = state.tabs.find(t => t.id === reqId);
      if (tab) {
        tab.name = newName;
        renderRequestTabs();
      }
      
      renderCollectionsTree();
      if (state.activeRequestId === reqId) {
        renderActiveTabToEditor();
      }
    } catch (e) {
      showToast('Rename failed: ' + e.message, 'error');
    }
  });
}

async function duplicateRequestPrompt(colId, reqId) {
  const col = state.loadedCollections[colId];
  const req = col.requests.find(r => r.id === reqId);
  if (!req) return;

  const duplicated = JSON.parse(JSON.stringify(req));
  duplicated.id = window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2);
  duplicated.name = `${req.name} Copy`;

  col.requests.push(duplicated);
  try {
    await window.teamapi.collections.save(col);
    showToast('Request duplicated');
    renderCollectionsTree();
    loadRequestIntoEditor(colId, duplicated.id);
  } catch (e) {
    showToast('Duplicate failed: ' + e.message, 'error');
  }
}

async function deleteRequestPrompt(colId, reqId) {
  if (!confirm('Are you sure you want to delete this request?')) return;
  const col = state.loadedCollections[colId];
  col.requests = col.requests.filter(r => r.id !== reqId);

  try {
    await window.teamapi.collections.save(col);
    
    // Close the tab if it was open
    const openTab = state.tabs.find(t => t.id === reqId);
    if (openTab) {
      await closeTab(reqId);
    }
    
    showToast('Request deleted');
    renderCollectionsTree();
  } catch (e) {
    showToast('Delete request failed: ' + e.message, 'error');
  }
}

// Autocomplete Suggestions system
const SCRIPT_SUGGESTIONS = [
  { label: 'pm', value: 'pm', type: 'object' },
  { label: 'pm.environment', value: 'pm.environment', type: 'object' },
  { label: 'pm.environment.set(key, val)', value: 'pm.environment.set("key", "value");', type: 'method' },
  { label: 'pm.environment.get(key)', value: 'pm.environment.get("key");', type: 'method' },
  { label: 'pm.response', value: 'pm.response', type: 'object' },
  { label: 'pm.response.code', value: 'pm.response.code', type: 'property' },
  { label: 'pm.response.body', value: 'pm.response.body', type: 'property' },
  { label: 'pm.response.json()', value: 'pm.response.json()', type: 'method' },
  { label: 'console.log(msg)', value: 'console.log("message");', type: 'method' }
];

let activeAutocompleteTextarea = null;
let currentAutocompleteMatches = [];
let activeAutocompleteIndex = 0;

function setupAutocompleteForScripts() {
  const preScript = document.getElementById('preScript');
  const postScript = document.getElementById('postScript');

  if (preScript) bindAutocomplete(preScript);
  if (postScript) bindAutocomplete(postScript);

  // Close popup when clicking outside or resizing
  window.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-item') && e.target !== preScript && e.target !== postScript) {
      hideAutocompletePopup();
    }
  });

  window.addEventListener('resize', hideAutocompletePopup);
}

function bindAutocomplete(textarea) {
  textarea.addEventListener('input', (e) => {
    handleAutocompleteInput(textarea);
  });

  textarea.addEventListener('keydown', (e) => {
    handleAutocompleteKeydown(textarea, e);
  });
  
  // Close suggestions if cursor is moved via click
  textarea.addEventListener('click', () => {
    hideAutocompletePopup();
  });
}

function handleAutocompleteInput(textarea) {
  const selStart = textarea.selectionStart;
  const text = textarea.value;
  
  // Get current word prefix before cursor
  const lastSpace = text.lastIndexOf(' ', selStart - 1);
  const lastNewline = text.lastIndexOf('\n', selStart - 1);
  const lastParen = text.lastIndexOf('(', selStart - 1);
  const lastSemi = text.lastIndexOf(';', selStart - 1);
  const wordStart = Math.max(lastSpace, lastNewline, lastParen, lastSemi) + 1;
  
  const currentWord = text.substring(wordStart, selStart).trim();
  
  if (currentWord.length >= 1) {
    const matches = SCRIPT_SUGGESTIONS.filter(s => 
      s.label.toLowerCase().startsWith(currentWord.toLowerCase()) && 
      s.label !== currentWord
    );

    if (matches.length > 0) {
      activeAutocompleteTextarea = textarea;
      currentAutocompleteMatches = matches;
      activeAutocompleteIndex = 0;
      showAutocompletePopup(textarea, matches, currentWord, wordStart);
      return;
    }
  }
  
  hideAutocompletePopup();
}

function showAutocompletePopup(textarea, matches, currentWord, wordStart) {
  const popup = document.getElementById('autocompleteSuggestions');
  if (!popup) return;

  popup.innerHTML = '';
  matches.forEach((match, idx) => {
    const div = document.createElement('div');
    div.className = `autocomplete-item ${idx === activeAutocompleteIndex ? 'active' : ''}`;
    
    const label = document.createElement('span');
    label.textContent = match.label;
    div.appendChild(label);

    const typeSpan = document.createElement('span');
    typeSpan.className = 'autocomplete-type';
    typeSpan.textContent = match.type;
    div.appendChild(typeSpan);

    div.onclick = (e) => {
      e.stopPropagation();
      applyAutocompleteMatch(textarea, match.value, currentWord, wordStart);
    };

    popup.appendChild(div);
  });

  // Calculate coordinates using shadow div mirror algorithm
  const coords = getCursorPixelCoords(textarea);
  popup.style.left = `${coords.left}px`;
  popup.style.top = `${coords.top}px`;
  popup.style.display = 'block';
}

function hideAutocompletePopup() {
  const popup = document.getElementById('autocompleteSuggestions');
  if (popup) {
    popup.style.display = 'none';
  }
  activeAutocompleteTextarea = null;
  currentAutocompleteMatches = [];
}

function applyAutocompleteMatch(textarea, value, currentWord, wordStart) {
  const text = textarea.value;
  const selStart = textarea.selectionStart;
  
  // Replace current prefix word with the full autocomplete value
  const before = text.substring(0, wordStart);
  const after = text.substring(selStart);
  
  textarea.value = before + value + after;
  textarea.selectionStart = textarea.selectionEnd = wordStart + value.length;
  textarea.focus();
  
  // Save new value
  if (textarea.id === 'preScript' && state.activeRequest) {
    state.activeRequest.preScript = textarea.value;
    queueSave();
  } else if (textarea.id === 'postScript' && state.activeRequest) {
    state.activeRequest.postScript = textarea.value;
    queueSave();
  }

  hideAutocompletePopup();
}

function handleAutocompleteKeydown(textarea, e) {
  const popup = document.getElementById('autocompleteSuggestions');
  if (!popup || popup.style.display !== 'block') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeAutocompleteIndex = (activeAutocompleteIndex + 1) % currentAutocompleteMatches.length;
    updateAutocompleteActiveState();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeAutocompleteIndex = (activeAutocompleteIndex - 1 + currentAutocompleteMatches.length) % currentAutocompleteMatches.length;
    updateAutocompleteActiveState();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const match = currentAutocompleteMatches[activeAutocompleteIndex];
    if (match) {
      // Find the word bounds
      const selStart = textarea.selectionStart;
      const text = textarea.value;
      const lastSpace = text.lastIndexOf(' ', selStart - 1);
      const lastNewline = text.lastIndexOf('\n', selStart - 1);
      const lastParen = text.lastIndexOf('(', selStart - 1);
      const lastSemi = text.lastIndexOf(';', selStart - 1);
      const wordStart = Math.max(lastSpace, lastNewline, lastParen, lastSemi) + 1;
      const currentWord = text.substring(wordStart, selStart).trim();
      
      applyAutocompleteMatch(textarea, match.value, currentWord, wordStart);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideAutocompletePopup();
  }
}

function updateAutocompleteActiveState() {
  const popup = document.getElementById('autocompleteSuggestions');
  if (!popup) return;

  popup.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
    item.classList.toggle('active', idx === activeAutocompleteIndex);
    if (idx === activeAutocompleteIndex) {
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

function getCursorPixelCoords(textarea) {
  const selectionStart = textarea.selectionStart;
  const text = textarea.value.substring(0, selectionStart);
  
  const div = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  for (const prop of style) {
    div.style[prop] = style[prop];
  }
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  
  div.textContent = text;
  const span = document.createElement('span');
  span.textContent = '|';
  div.appendChild(span);
  
  document.body.appendChild(div);
  
  const textareaRect = textarea.getBoundingClientRect();
  
  // Calculate relative top/left inside textarea
  const left = textareaRect.left + span.offsetLeft - textarea.scrollLeft;
  const top = textareaRect.top + span.offsetTop - textarea.scrollTop + 16;
  
  div.remove();
  
  return { left, top };
}

// -------------------------------------------------------------
// New Features Implementations
// -------------------------------------------------------------

// 1. Variable Previews
function updateVariablePreview(inputEl) {
  const tooltip = document.getElementById('variablePreviewTooltip');
  if (!tooltip) return;

  const value = inputEl.value;
  if (!value) {
    tooltip.style.display = 'none';
    return;
  }

  // Scan for {{variable}} pattern
  const matches = [...value.matchAll(/\{\{([^}]+)\}\}/g)];
  if (matches.length === 0) {
    tooltip.style.display = 'none';
    return;
  }

  // Resolve matching variables
  const envVars = state.activeEnv ? state.activeEnv.variables : {};
  const envSecrets = (state.activeEnv && state.activeEnv.secrets) || [];
  let previewHtml = '';
  matches.forEach(m => {
    const key = m[1].trim();
    const isSecret = envSecrets.includes(key);
    let resolved = envVars.hasOwnProperty(key) ? envVars[key] : 'undefined';
    if (isSecret && resolved !== 'undefined') {
      resolved = '••••••••';
    }
    previewHtml += `<div><span class="var-preview-name">{{${key}}}</span><span class="var-preview-arrow">➔</span><span class="var-preview-value">${resolved}</span></div>`;
  });

  tooltip.innerHTML = previewHtml;

  // Position tooltip below input
  const rect = inputEl.getBoundingClientRect();
  tooltip.style.left = `${rect.left + window.scrollX}px`;
  tooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
  tooltip.style.display = 'block';
}

function handleVariablePreviewFocus(e) {
  const target = e.target;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    updateVariablePreview(target);
  }
}

function handleVariablePreviewInput(e) {
  const target = e.target;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    updateVariablePreview(target);
  }
}

function handleVariablePreviewBlur(e) {
  setTimeout(() => {
    const tooltip = document.getElementById('variablePreviewTooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }, 150);
}


// 2. Response Search & Highlight
let searchMatches = [];
let activeSearchIndex = -1;

function performResponseSearch() {
  const query = document.getElementById('responseSearchInput').value.trim();
  const display = document.getElementById('responseBodyDisplay');
  const countEl = document.getElementById('responseSearchCount');

  if (!query || !state.lastResponseText) {
    countEl.textContent = '0/0';
    searchMatches = [];
    activeSearchIndex = -1;
    // Re-render display normally without search marks
    const activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;
    renderResponseBody(state.lastResponseText, activeMode);
    return;
  }

  // Get plain formatted string
  let plainText = '';
  const activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;
  if (activeMode === 'pretty') {
    try {
      const parsed = JSON.parse(state.lastResponseText);
      plainText = JSON.stringify(parsed, null, 2);
    } catch (e) {
      plainText = state.lastResponseText;
    }
  } else {
    plainText = state.lastResponseText;
  }

  // Escape HTML entities to prevent rendering issues
  const escapedText = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Find all matches index bounds (case insensitive)
  const regex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
  searchMatches = [];
  
  // Replace and insert marks
  let matchCount = 0;
  const highlighted = escapedText.replace(regex, (match) => {
    const idx = matchCount++;
    searchMatches.push(idx);
    return `<mark class="search-match" id="search-match-${idx}">${match}</mark>`;
  });

  display.innerHTML = `<pre class="mono">${highlighted}</pre>`;

  if (matchCount > 0) {
    activeSearchIndex = 0;
    countEl.textContent = `1/${matchCount}`;
    highlightCurrentMatch();
  } else {
    activeSearchIndex = -1;
    countEl.textContent = '0/0';
  }
}

function highlightCurrentMatch() {
  // Remove current active mark states
  document.querySelectorAll('mark.search-match').forEach(m => m.classList.remove('current'));

  const activeMark = document.getElementById(`search-match-${activeSearchIndex}`);
  if (activeMark) {
    activeMark.classList.add('current');
    activeMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function navigateSearch(direction) {
  if (searchMatches.length === 0) return;
  
  activeSearchIndex = (activeSearchIndex + direction + searchMatches.length) % searchMatches.length;
  document.getElementById('responseSearchCount').textContent = `${activeSearchIndex + 1}/${searchMatches.length}`;
  highlightCurrentMatch();
}

// 3. Client Code Snippet Generator
function openCodeSnippetModal() {
  if (!state.activeRequest) return;
  updateCodeSnippetDisplay();
  openDialog('modalCodeSnippet');
}

function updateCodeSnippetDisplay() {
  const language = document.getElementById('snippetLanguageSelect').value;
  const display = document.getElementById('snippetCodeDisplay');
  const req = state.activeRequest;

  // Resolve url and headers with active environment vars
  const envVars = state.activeEnv ? state.activeEnv.variables : {};
  const url = interpolate(req.url, envVars) || 'https://httpbin.org/anything';
  const method = req.method || 'GET';

  // Build headers
  const headers = {};
  if (req.headers) {
    req.headers.forEach(h => {
      if (h.enabled && h.key) {
        headers[interpolate(h.key, envVars)] = interpolate(h.value, envVars);
      }
    });
  }
  // Auth header mapping
  if (req.auth && req.auth.type !== 'none') {
    const type = req.auth.type;
    if (type === 'bearer') {
      headers['Authorization'] = `Bearer ${interpolate(req.auth.token, envVars)}`;
    } else if (type === 'basic') {
      const user = interpolate(req.auth.username, envVars);
      const pass = interpolate(req.auth.password, envVars);
      const creds = btoa(`${user}:${pass}`);
      headers['Authorization'] = `Basic ${creds}`;
    } else if (type === 'apikey') {
      const key = interpolate(req.auth.key, envVars);
      const headerName = interpolate(req.auth.headerName, envVars) || 'X-API-Key';
      headers[headerName] = key;
    }
  }

  // Get body
  let bodyContent = '';
  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'raw' || req.body.type === 'json' || req.body.type === 'text' || req.body.type === 'xml' || req.body.type === 'html' || req.body.type === 'javascript') {
      bodyContent = interpolate(req.body.content, envVars) || '';
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        const sub = req.body.subType || 'json';
        headers['Content-Type'] = sub === 'json' ? 'application/json' : 'text/plain';
      }
    } else if (req.body.type === 'graphql') {
      const q = interpolate(req.body.query || '', envVars);
      let vars = {};
      try {
        vars = JSON.parse(interpolate(req.body.variables || '{}', envVars));
      } catch(e){}
      bodyContent = JSON.stringify({ query: q, variables: vars }, null, 2);
      headers['Content-Type'] = 'application/json';
    } else if (req.body.type === 'urlencoded' || req.body.type === 'form') {
      const params = [];
      if (req.body.formData) {
        req.body.formData.forEach(f => {
          if (f.enabled && f.key) {
            params.push(`${encodeURIComponent(interpolate(f.key, envVars))}=${encodeURIComponent(interpolate(f.value, envVars))}`);
          }
        });
      }
      bodyContent = params.join('&');
      if (req.body.type === 'urlencoded') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        headers['Content-Type'] = 'multipart/form-data; boundary=---Boundary';
      }
    }
  }

  let code = '';
  switch (language) {
    case 'curl':
      let curlCmd = `curl -X ${method} "${url}"`;
      Object.entries(headers).forEach(([k, v]) => {
        curlCmd += ` \\\n  -H "${k}: ${v}"`;
      });
      if (bodyContent) {
        // Escape quotes for bash compatibility
        const escapedBody = bodyContent.replace(/"/g, '\\"').replace(/\n/g, '');
        curlCmd += ` \\\n  -d "${escapedBody}"`;
      }
      code = curlCmd;
      break;

    case 'fetch':
      const fetchOpts = { method, headers };
      if (bodyContent && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = bodyContent;
      }
      code = `fetch("${url}", ${JSON.stringify(fetchOpts, null, 2)})\n  .then(response => response.json())\n  .then(data => console.log(data))\n  .catch(error => console.error(error));`;
      break;

    case 'axios':
      const axiosConfig = { method, url, headers };
      if (bodyContent && method !== 'GET' && method !== 'HEAD') {
        try {
          axiosConfig.data = JSON.parse(bodyContent);
        } catch(e) {
          axiosConfig.data = bodyContent;
        }
      }
      code = `const axios = require('axios');\n\naxios(${JSON.stringify(axiosConfig, null, 2)})\n  .then(response => {\n    console.log(response.data);\n  })\n  .catch(error => {\n    console.error(error);\n  });`;
      break;

    case 'python':
      let pyHeaders = JSON.stringify(headers, null, 4);
      let pyCode = `import requests\n\nurl = "${url}"\nheaders = ${pyHeaders}\n`;
      if (bodyContent && method !== 'GET' && method !== 'HEAD') {
        try {
          const parsed = JSON.parse(bodyContent);
          pyCode += `payload = ${JSON.stringify(parsed, null, 4)}\nresponse = requests.request("${method}", url, headers=headers, json=payload)\n`;
        } catch(e) {
          pyCode += `payload = """${bodyContent}"""\nresponse = requests.request("${method}", url, headers=headers, data=payload)\n`;
        }
      } else {
        pyCode += `response = requests.request("${method}", url, headers=headers)\n`;
      }
      pyCode += `print(response.text)\n`;
      code = pyCode;
      break;

    case 'go':
      let goHeaders = '';
      Object.entries(headers).forEach(([k, v]) => {
        goHeaders += `\treq.Header.Add("${k}", "${v}")\n`;
      });
      let goBody = 'nil';
      let goBodyInit = '';
      if (bodyContent && method !== 'GET' && method !== 'HEAD') {
        goBodyInit = `\tvar jsonStr = []byte(\`${bodyContent}\`)\n`;
        goBody = 'bytes.NewBuffer(jsonStr)';
      }
      code = `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"io"\n${goBody !== 'nil' ? '\t"bytes"\n' : ''})\n\nfunc main() {\n\turl := "${url}"\n${goBodyInit}\treq, err := http.NewRequest("${method}", url, ${goBody})\n\tif err != nil {\n\t\tpanic(err)\n\t}\n${goHeaders}\tclient := &http.Client{}\n\tresp, err := client.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer resp.Body.Close()\n\n\tbody, _ := io.ReadAll(resp.Body)\n\tfmt.Println(string(body))\n}`;
      break;

    case 'java':
      let javaHeaders = '';
      Object.entries(headers).forEach(([k, v]) => {
        const escapedKey = k.replace(/"/g, '\\"');
        const escapedVal = v.replace(/"/g, '\\"');
        javaHeaders += `\n            .header("${escapedKey}", "${escapedVal}")`;
      });
      let javaBody = 'HttpRequest.BodyPublishers.noBody()';
      if (bodyContent && method !== 'GET' && method !== 'HEAD') {
        const escapedBody = bodyContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r');
        javaBody = `HttpRequest.BodyPublishers.ofString("${escapedBody}")`;
      }
      code = `import java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        HttpClient client = HttpClient.newHttpClient();\n        \n        HttpRequest request = HttpRequest.newBuilder()\n            .uri(URI.create("${url}"))${javaHeaders}\n            .method("${method}", ${javaBody})\n            .build();\n            \n        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n        \n        System.out.println("Response status code: " + response.statusCode());\n        System.out.println(response.body());\n    }\n}`;
      break;
  }

  display.textContent = code;
}

function copySnippetToClipboard() {
  const display = document.getElementById('snippetCodeDisplay');
  if (display && display.textContent) {
    navigator.clipboard.writeText(display.textContent);
    showToast('Code copied to clipboard', 'success');
  }
}

// 4. Sandbox Test Results Renderer
function renderTestResults(tests) {
  const display = document.getElementById('responseTestsDisplay');
  display.innerHTML = '';

  if (!tests || tests.length === 0) {
    display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">No tests executed for this request</div>';
    return;
  }

  tests.forEach(test => {
    const row = document.createElement('div');
    row.className = `test-result-row ${test.passed ? 'passed' : 'failed'}`;

    const badge = document.createElement('span');
    badge.className = `test-badge ${test.passed ? 'passed' : 'failed'}`;
    badge.textContent = test.passed ? 'PASS' : 'FAIL';
    row.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'test-name';
    name.textContent = test.name;
    row.appendChild(name);

    if (!test.passed && test.error) {
      const errSpan = document.createElement('span');
      errSpan.className = 'test-error';
      errSpan.textContent = `(${test.error})`;
      row.appendChild(errSpan);
    }

    display.appendChild(row);
  });
}

// 5. Postman & OpenAPI Importer
async function importCollection(jsonData) {
  let parsed = null;
  try {
    parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  } catch (e) {
    throw new Error('Invalid JSON format');
  }

  let collectionObj = {
    id: '', // Will be set by save
    name: '',
    folders: [],
    requests: []
  };

  const generateUuid = () => {
    return window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2, 9);
  };

  // 1. Detect Postman Collection
  if (parsed.info && (parsed.info.schema || parsed.item)) {
    collectionObj.name = parsed.info.name || 'Imported Postman Collection';

    // Auto-create collection-based environment
    let envVars = {};
    if (Array.isArray(parsed.variable)) {
      parsed.variable.forEach(v => {
        if (v.key) {
          envVars[v.key] = v.value || '';
        }
      });
    }

    const envObj = {
      name: `${collectionObj.name} Env`,
      variables: envVars,
      secrets: []
    };
    try {
      await window.teamapi.environments.save(envObj);
    } catch (e) {
      console.error('Failed to auto-create environment for imported collection:', e);
    }
    
    const parsePostmanItems = (items, folderId = null) => {
      items.forEach(item => {
        if (item.item) {
          const newFolderId = generateUuid();
          collectionObj.folders.push({
            id: newFolderId,
            name: item.name || 'Folder'
          });
          parsePostmanItems(item.item, newFolderId);
        } else if (item.request) {
          let url = '';
          if (item.request.url) {
            url = typeof item.request.url === 'string' ? item.request.url : (item.request.url.raw || '');
          }

          const headers = (item.request.header || []).map(h => ({
            key: h.key || '',
            value: h.value || '',
            enabled: !h.disabled
          }));

          let auth = { type: 'none' };
          if (item.request.auth) {
            const type = item.request.auth.type;
            if (type === 'bearer') {
              const tokenObj = item.request.auth.bearer;
              const tokenVal = Array.isArray(tokenObj) ? (tokenObj.find(t => t.key === 'token') || {}).value : (tokenObj || {}).value;
              auth = { type: 'bearer', token: tokenVal || '' };
            } else if (type === 'basic') {
              const basicList = item.request.auth.basic || [];
              const username = (basicList.find(b => b.key === 'username') || {}).value || '';
              const password = (basicList.find(b => b.key === 'password') || {}).value || '';
              auth = { type: 'basic', username, password };
            }
          }

          let body = { type: 'none', content: '', formData: [] };
          if (item.request.body) {
            const mode = item.request.body.mode;
            if (mode === 'raw') {
              body.type = 'raw';
              body.content = item.request.body.raw || '';
              const options = item.request.body.options || {};
              body.subType = (options.raw || {}).language || 'json';
            } else if (mode === 'formdata') {
              body.type = 'form';
              body.formData = (item.request.body.formdata || []).map(f => ({
                key: f.key || '',
                value: f.value || '',
                enabled: !f.disabled
              }));
            } else if (mode === 'urlencoded') {
              body.type = 'urlencoded';
              body.formData = (item.request.body.urlencoded || []).map(f => ({
                key: f.key || '',
                value: f.value || '',
                enabled: !f.disabled
              }));
            }
          }

          collectionObj.requests.push({
            id: generateUuid(),
            folderId,
            name: item.name || 'Request',
            method: item.request.method || 'GET',
            url,
            headers,
            auth,
            body,
            params: [],
            preScript: '',
            postScript: ''
          });
        }
      });
    };

    parsePostmanItems(parsed.item || []);
  }
  // 2. Detect OpenAPI
  else if (parsed.openapi || parsed.swagger) {
    collectionObj.name = (parsed.info && parsed.info.title) || 'Imported OpenAPI Spec';
    
    let serverUrl = 'http://localhost:3000';
    if (parsed.servers && parsed.servers.length > 0) {
      serverUrl = parsed.servers[0].url || serverUrl;
    }

    if (parsed.paths) {
      for (const [pathKey, pathObj] of Object.entries(parsed.paths)) {
        for (const [methodKey, methodObj] of Object.entries(pathObj)) {
          if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(methodKey)) {
            const name = methodObj.summary || methodObj.operationId || `${methodKey.toUpperCase()} ${pathKey}`;
            const headers = [];
            const params = [];
            let body = { type: 'none', content: '', formData: [] };

            if (methodObj.requestBody && methodObj.requestBody.content) {
              const content = methodObj.requestBody.content;
              if (content['application/json']) {
                body.type = 'raw';
                body.subType = 'json';
                body.content = '{\n  \n}';
                headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
              } else if (content['application/x-www-form-urlencoded']) {
                body.type = 'urlencoded';
              } else if (content['multipart/form-data']) {
                body.type = 'form';
              }
            }

            if (methodObj.parameters) {
              methodObj.parameters.forEach(p => {
                if (p.in === 'query') {
                  params.push({ key: p.name, value: '', enabled: true });
                } else if (p.in === 'header') {
                  headers.push({ key: p.name, value: '', enabled: true });
                }
              });
            }

            collectionObj.requests.push({
              id: generateUuid(),
              folderId: null,
              name,
              method: methodKey.toUpperCase(),
              url: serverUrl + pathKey,
              headers,
              auth: { type: 'none' },
              body,
              params,
              preScript: '',
              postScript: ''
            });
          }
        }
      }
    }
  } else {
    throw new Error('Unsupported format. Make sure you import a Postman v2/v2.1 collection or an OpenAPI v3 spec.');
  }

  if (collectionObj.requests.length === 0) {
    throw new Error('No requests found in import file.');
  }

  const saved = await window.teamapi.collections.save(collectionObj);
  return saved;
}

