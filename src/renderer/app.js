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
  expandedNodes: new Set()    // Tree nodes expanded states (collection-id, folder-id)
};

// Helper: variable interpolator
function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();
    return vars.hasOwnProperty(trimmedKey) ? vars[trimmedKey] : match;
  });
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

  // Load last workspace from localStorage if saved
  const lastPath = localStorage.getItem('lastWorkspacePath');
  if (lastPath) {
    document.getElementById('welcomeRecent').style.display = 'block';
    
    // Extract folder name safely
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
      itemEl.onclick = () => selectWorkspace(lastPath);
    }
  }
});

// Setup DOM Event Listeners
function setupEventListeners() {
  // Welcome page buttons
  document.getElementById('welcomeOpenBtn').onclick = () => selectWorkspace();
  document.getElementById('welcomeNewBtn').onclick = () => openCreateWorkspaceModal();
  document.getElementById('btnChangeWorkspace').onclick = () => selectWorkspace();

  // Dialog actions
  document.getElementById('btnCancelCreateWorkspace').onclick = () => closeDialog('modalCreateWorkspace');
  document.getElementById('btnConfirmCreateWorkspace').onclick = confirmCreateWorkspace;

  document.getElementById('btnCancelCreateCollection').onclick = () => closeDialog('modalCreateCollection');
  document.getElementById('btnConfirmCreateCollection').onclick = confirmCreateCollection;

  document.getElementById('btnCancelPrompt').onclick = () => closeDialog('modalInputPrompt');

  // Sidebar actions
  document.getElementById('btnAddCollection').onclick = () => openDialog('modalCreateCollection');

  // URL Bar & SEND Action
  document.getElementById('requestUrl').oninput = syncUrlToParams;
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
      renderResponseBody(state.lastResponseText, e.target.dataset.mode);
    };
  });

  // Global Context Menu closer
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  // Context Menu listener on tree items
  window.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.collection-item, .folder-item, .request-item');
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

// Loads a workspace
async function loadWorkspace(ws) {
  state.currentWorkspace = ws;
  state.loadedCollections = {};
  state.activeCollectionId = null;
  state.activeRequestId = null;
  state.activeRequest = null;
  state.expandedNodes.clear();

  // Hide welcome overlay
  document.getElementById('welcomeScreen').style.display = 'none';

  // Update layout header
  document.getElementById('workspaceTitle').textContent = ws.name;
  document.getElementById('titlebarWorkspaceName').textContent = ws.name;

  // Persist current workspace path
  localStorage.setItem('lastWorkspacePath', ws.path);

  // Load data components
  await refreshCollections();
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
        renderCollectionsTree();
      } else {
        state.expandedNodes.add(colId);
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
  state.activeCollectionId = colId;
  state.activeRequestId = reqId;

  const colDetail = state.loadedCollections[colId];
  if (!colDetail) return;

  const req = colDetail.requests.find(r => r.id === reqId);
  if (!req) return;

  state.activeRequest = req;

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

  // Render collections structure highlight
  renderCollectionsTree();
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
function renderKeyValueGrid(container, list, onChange) {
  // Preserve header
  const header = container.querySelector('.kv-header');
  container.innerHTML = '';
  container.appendChild(header);

  // Renders the rows
  list.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'kv-row';

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

    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'kv-input';
    valInput.value = item.value || '';
    valInput.placeholder = 'Value';
    valInput.oninput = (e) => {
      item.value = e.target.value;
      onChange(list);
    };
    row.appendChild(valInput);

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
  document.getElementById('bodyTextEditor').style.display = 'none';
  document.getElementById('bodyFormEditor').style.display = 'none';
  document.getElementById('bodyGraphqlEditor').style.display = 'none';

  const isRaw = (type === 'raw' || type === 'json' || type === 'text' || type === 'xml' || type === 'html' || type === 'javascript');

  if (isRaw) {
    document.getElementById('bodyTextEditor').style.display = 'flex';
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
    document.getElementById('bodyFormEditor').style.display = 'block';
  } else if (type === 'graphql') {
    document.getElementById('bodyGraphqlEditor').style.display = 'flex';
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
      renderResponseBody(`Error sending request:\n${result.error}`, 'raw');
      statusBadge.textContent = 'Error';
      statusBadge.style.backgroundColor = 'var(--accent-red)';
    } else {
      state.lastResponseText = result.body || '';
      const activeMode = document.querySelector('#prettyRawToggle .toggle-btn.active').dataset.mode;
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

  if (!text) {
    display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">Response body is empty</div>';
    return;
  }

  if (mode === 'pretty') {
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
    // Add custom selection check
    if (state.activeEnvId === env.id) {
      option.selected = true;
    }
    selector.insertBefore(option, selector.lastElementChild);
  });
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
    localStorage.setItem('lastActiveEnvId', val);
    showToast(`Switched environment to: ${state.activeEnv ? state.activeEnv.name : 'None'}`);
  }
}

// Environment Management Dialog Modal
let envModalActiveId = null;
let envModalDraftVariables = {};

function openEnvironmentManager() {
  envModalActiveId = null;
  envModalDraftVariables = {};

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
    list.push({ key, value, enabled: true });
  }

  renderKeyValueGrid(container, list, (newList) => {
    // Re-pack list to draft variables map
    envModalDraftVariables = {};
    newList.forEach(item => {
      if (item.key) {
        envModalDraftVariables[item.key] = item.value || '';
      }
    });
  });
}

async function createNewEnvironment() {
  try {
    const newEnv = {
      name: 'New Environment',
      variables: {}
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
      // Load history item properties directly into editor as an ephemeral editable request
      document.getElementById('requestMethod').value = item.request.method || 'GET';
      document.getElementById('requestUrl').value = item.request.url || '';
      syncUrlToParams();
      showToast('Loaded request from history');
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
      renderCollectionsTree();
      if (state.activeRequestId === reqId) {
        loadRequestIntoEditor(colId, reqId);
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
    if (state.activeRequestId === reqId) {
      state.activeRequestId = null;
      state.activeRequest = null;
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
  let previewHtml = '';
  matches.forEach(m => {
    const key = m[1].trim();
    const resolved = envVars.hasOwnProperty(key) ? envVars[key] : 'undefined';
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

