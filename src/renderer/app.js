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

// Helper: dynamic variable generators (e.g. {{random.uuid}}, {{timestamp}})
function tpRandomInt(min, max) { min = Math.ceil(min); max = Math.floor(max); return Math.floor(Math.random() * (max - min + 1)) + min; }
function tpRandomChars(len, charset) { let s = ''; for (let i = 0; i < len; i++) s += charset[tpRandomInt(0, charset.length - 1)]; return s; }
function tpGenerateUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
}

// Returns a generated value for a known dynamic key, or null if it isn't one.
// Supports parametric syntax like {{random.int(1,100)}} and random.string(16).
function resolveDynamicVar(rawKey) {
  const key = rawKey.trim();
  const m = key.match(/^([a-zA-Z0-9.$]+)\((.*)\)$/);
  const base = m ? m[1].toLowerCase() : key.toLowerCase();
  const args = m ? m[2].split(',').map(s => s.trim()).filter(s => s.length) : [];
  const num = (i, def) => { const n = parseInt(args[i], 10); return isNaN(n) ? def : n; };
  const lenArg = (i, def) => { const n = parseInt(args[i], 10); if (isNaN(n)) return def; return Math.max(0, Math.min(n, 1024)); };

  switch (base) {
    case 'random.uuid': case '$guid': case '$randomuuid': case 'uuid':
      return tpGenerateUuid();
    case 'random.int': case '$randomint':
      return String(tpRandomInt(num(0, 0), num(1, 1000)));
    case 'random.float': case '$randomfloat':
      return String(Math.random() * (num(1, 1) - num(0, 0)) + num(0, 0));
    case 'random.string': case 'random.alpha': case '$randomalpha':
      return tpRandomChars(lenArg(0, 8), 'abcdefghijklmnopqrstuvwxyz');
    case 'random.alphanum': case '$randomalphanumeric':
      return tpRandomChars(lenArg(0, 8), 'abcdefghijklmnopqrstuvwxyz0123456789');
    case 'random.hex': case '$randomhex':
      return tpRandomChars(lenArg(0, 8), '0123456789abcdef');
    case 'random.number':
      return tpRandomChars(lenArg(0, 8), '0123456789');
    case 'random.boolean': case '$randomboolean':
      return Math.random() < 0.5 ? 'true' : 'false';
    case 'random.color': case '$randomcolor':
      return '#' + tpRandomChars(6, '0123456789abcdef');
    case 'random.email':
      return tpRandomChars(8, 'abcdefghijklmnopqrstuvwxyz') + '@example.com';
    case 'timestamp': case '$timestamp':
      return String(Date.now());
    case 'timestamp.seconds':
      return String(Math.floor(Date.now() / 1000));
    case 'datetime': case 'datetime.iso': case '$datetime':
      return new Date().toISOString();
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'time':
      return new Date().toISOString().slice(11, 19);
    default:
      return null;
  }
}

// Helper: variable interpolator (resolves {{random.*}}, {{timestamp}}, then env vars)
function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();
    const dyn = resolveDynamicVar(trimmedKey);
    if (dyn !== null) return dyn;
    return vars.hasOwnProperty(trimmedKey) ? vars[trimmedKey] : match;
  });
}

// Helper: tokenize a shell command string with quote + escape awareness.
// Handles bash/sh backslash escapes and PowerShell backtick escapes inside double quotes.
function tokenizeCurl(s) {
  const tokens = [];
  let cur = '';
  let started = false;
  let inD = false, inS = false;
  const push = () => { tokens.push(cur); cur = ''; started = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (c === "'") inS = false; else cur += c;
      continue;
    }
    if (inD) {
      if (c === '\\' || c === '`') {
        const n = s[i + 1];
        if (n === '"' || n === c || n === '$') { cur += n; i++; }
        else cur += c;
        continue;
      }
      if (c === '"') inD = false; else cur += c;
      continue;
    }
    if (c === '"') { inD = true; started = true; continue; }
    if (c === "'") { inS = true; started = true; continue; }
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '"' || n === "'" || n === '\\' || n === ' ' || n === '\t') { cur += n; i++; started = true; }
      else { cur += c; started = true; }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started) push();
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) push();
  return tokens;
}

// Helper: parse a cURL command (bash/sh, Windows cmd, or PowerShell) into request properties.
function parseCurlCommand(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();

  // Normalize multi-line continuations across shells:
  //   bash/sh '\' + newline · Windows cmd '^' + newline · PowerShell '`' + newline
  s = s.replace(/\\\r?\n/g, ' ')
       .replace(/\^\r?\n/g, ' ')
       .replace(/`\r?\n/g, ' ');

  const tokens = tokenizeCurl(s);
  if (!tokens.length) return null;

  // Drop a leading curl / curl.exe token and PowerShell's --% stop-parsing token.
  const start = /^curl(\.exe)?$/i.test(tokens[0]) ? 1 : 0;
  const args = tokens.slice(start).filter(t => t !== '--%');
  if (!args.length) return null;

  // Flags that consume the following token as a value (so it isn't mistaken for the URL).
  const VALUE_FLAGS = new Set([
    '-X', '--request', '-H', '--header',
    '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
    '-u', '--user', '-b', '--cookie', '--cookie-jar',
    '-A', '--user-agent', '-e', '--referer',
    '-o', '--output', '-w', '--write-out',
    '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
    '--url', '-K', '--config', '-x', '--proxy', '-U', '--proxy-user',
    '-E', '--cert', '--key', '--cacert', '--capath', '--resolve',
    '-F', '--form', '--form-string', '-D', '--dump-header', '-r', '--range', '--rate'
  ]);
  const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode']);

  let method = 'GET';
  let url = '';
  let explicitUrl = '';
  const headers = [];
  const dataParts = [];
  let auth = { type: 'none' };

  let i = 0;
  while (i < args.length) {
    const tok = args[i];

    if (!tok.startsWith('-') || tok === '-') {
      // Non-flag token → URL candidate (first one wins).
      if (!url) url = tok;
      i++;
      continue;
    }

    let flag, inline;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) { flag = tok.slice(0, eq); inline = tok.slice(eq + 1); }
      else { flag = tok; inline = undefined; }
    } else {
      // Short flag(s): first two chars are the flag; the rest is an attached value (-XPOST) or combined booleans (-kLsI).
      flag = tok.slice(0, 2);
      inline = tok.length > 2 ? tok.slice(2) : undefined;
    }

    const takesValue = VALUE_FLAGS.has(flag) || DATA_FLAGS.has(flag);

    if (!takesValue) {
      // Boolean flag. A few carry meaning.
      if (flag === '-I' || flag === '--head' || tok.includes('I')) method = 'HEAD';
      i++;
      continue;
    }

    // Resolve the value: inline (attached or =form) else the next token.
    const value = inline !== undefined ? inline : args[i + 1];
    if (inline === undefined && i + 1 < args.length) i++; // consume next token

    if (DATA_FLAGS.has(flag)) {
      if (value !== undefined) dataParts.push(value);
      if (method === 'GET') method = 'POST';
    } else if (flag === '-X' || flag === '--request') {
      if (value) method = String(value).toUpperCase();
    } else if (flag === '-H' || flag === '--header') {
      if (value !== undefined) {
        const ci = value.indexOf(':');
        if (ci !== -1) headers.push({ key: value.slice(0, ci).trim(), value: value.slice(ci + 1).trim(), enabled: true });
      }
    } else if (flag === '-u' || flag === '--user') {
      if (value !== undefined) {
        const p = String(value).split(':');
        auth = { type: 'basic', username: p[0] || '', password: p.slice(1).join(':') || '' };
      }
    } else if (flag === '--url') {
      if (value) explicitUrl = String(value);
    } else if (flag === '-b' || flag === '--cookie') {
      if (value !== undefined && !headers.some(h => h.key.toLowerCase() === 'cookie')) {
        headers.push({ key: 'Cookie', value: String(value), enabled: true });
      }
    } else if ((flag === '-A' || flag === '--user-agent') && value) {
      if (!headers.some(h => h.key.toLowerCase() === 'user-agent')) {
        headers.push({ key: 'User-Agent', value: String(value), enabled: true });
      }
    } else if ((flag === '-e' || flag === '--referer') && value) {
      if (!headers.some(h => h.key.toLowerCase() === 'referer')) {
        headers.push({ key: 'Referer', value: String(value), enabled: true });
      }
    }
    // Other value flags: value already consumed (otherwise ignored).
    i++;
  }

  if (explicitUrl) url = explicitUrl;
  if (!url) {
    for (const t of args) {
      if (!t.startsWith('-') && /^https?:\/\//i.test(t)) { url = t; break; }
    }
  }

  const body = dataParts.join('&');
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

// Drag-to-resize for the sidebar (width) and response panel (height). Sizes persist to localStorage.
function setupPanelResizers() {
  const sidebar = document.querySelector('.sidebar');
  const sidebarResizer = document.getElementById('sidebarResizer');
  const responsePanel = document.getElementById('responsePanel');
  const responseResizer = document.getElementById('responseResizer');
  const chatPanel = document.getElementById('chatPanel');
  const chatResizer = document.getElementById('chatResizer');

  // Restore saved sizes.
  const savedSidebarWidth = parseInt(localStorage.getItem('sidebarWidth'), 10);
  if (savedSidebarWidth && sidebar) sidebar.style.width = savedSidebarWidth + 'px';
  const savedResponseHeight = parseInt(localStorage.getItem('responseHeight'), 10);
  if (savedResponseHeight && responsePanel) responsePanel.style.flex = '0 0 ' + savedResponseHeight + 'px';
  const savedChatWidth = parseInt(localStorage.getItem('chatWidth'), 10);
  if (savedChatWidth && chatPanel) chatPanel.style.width = savedChatWidth + 'px';

  // Pointer-event drag with setPointerCapture: capturing the pointer on the
  // handle guarantees we receive pointerup even if the cursor passes over an
  // iframe (which would otherwise swallow mouseup and leave is-resizing stuck
  // on <body>, making inputs feel unclickable).
  function startDrag(handle, init) {
    handle.addEventListener('pointerdown', (e) => {
      const ctx = init(e);
      if (!ctx) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      handle.classList.add('active');
      const start = e[ctx.axis];
      const move = (ev) => ctx.onMove(ev[ctx.axis] - start);
      const up = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        ctx.onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // Sidebar width resizer.
  if (sidebarResizer && sidebar) {
    startDrag(sidebarResizer, () => {
      if (sidebar.classList.contains('collapsed')) return null;
      const startWidth = sidebar.offsetWidth;
      document.body.classList.add('is-resizing');
      return {
        axis: 'clientX',
        onMove: (dx) => { sidebar.style.width = Math.max(180, Math.min(560, startWidth + dx)) + 'px'; },
        onEnd: () => {
          document.body.classList.remove('is-resizing');
          localStorage.setItem('sidebarWidth', parseInt(sidebar.style.width, 10) || 260);
        }
      };
    });
  }

  // Response panel height resizer.
  if (responseResizer && responsePanel) {
    startDrag(responseResizer, () => {
      if (responsePanel.classList.contains('collapsed')) return null;
      const startHeight = responsePanel.offsetHeight;
      document.body.classList.add('is-resizing', 'is-resizing-row');
      return {
        axis: 'clientY',
        // Dragging up increases the panel height.
        onMove: (dy) => { responsePanel.style.flex = '0 0 ' + Math.max(120, Math.min(window.innerHeight * 0.85, startHeight - dy)) + 'px'; },
        onEnd: () => {
          document.body.classList.remove('is-resizing', 'is-resizing-row');
          localStorage.setItem('responseHeight', responsePanel.offsetHeight);
        }
      };
    });
  }

  // Chat panel width resizer (drag left grows width — it's on the right edge).
  if (chatResizer && chatPanel) {
    startDrag(chatResizer, () => {
      if (chatPanel.classList.contains('collapsed')) return null;
      const startWidth = chatPanel.offsetWidth;
      document.body.classList.add('is-resizing');
      return {
        axis: 'clientX',
        onMove: (dx) => { chatPanel.style.width = Math.max(300, Math.min(640, startWidth - dx)) + 'px'; },
        onEnd: () => {
          document.body.classList.remove('is-resizing');
          localStorage.setItem('chatWidth', parseInt(chatPanel.style.width, 10) || 380);
        }
      };
    });
  }
}

// Application Startup
// ===== Theme (light / dark) =====
// The initial data-theme attribute is set before first paint by theme-init.js
// (anti-flash). Here we add persistence, the toggle button, system-preference
// tracking, and keep the native title-bar overlay (Windows/Linux) in sync.
function getStoredTheme() {
  return localStorage.getItem('theme'); // 'light' | 'dark' | null (null = follow system)
}

function resolveSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// Apply the data-theme attribute with ALL transitions disabled for one frame,
// so the whole UI snaps to the new theme at once instead of animating each
// element at a different speed (which looked staggered/laggy on theme switch).
function paintTheme(theme) {
  const root = document.documentElement;
  root.classList.add('no-transition');
  root.dataset.theme = theme;
  // Force a synchronous reflow so the new variable values commit while
  // transitions are off, then re-enable them after the next paint.
  void root.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-transition')));
}

function applyTheme(theme, { persist = true } = {}) {
  paintTheme(theme);
  if (persist) localStorage.setItem('theme', theme);
  syncNativeThemeOverlay(theme);
}

// Clear any explicit choice so the app follows the OS preference again.
function followSystemTheme() {
  localStorage.removeItem('theme');
  const theme = resolveSystemTheme();
  paintTheme(theme);
  syncNativeThemeOverlay(theme);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Recolor the native window-control overlay on Windows/Linux (no-op on macOS).
function syncNativeThemeOverlay(theme) {
  if (window.teamapi && window.teamapi.theme && window.teamapi.theme.set) {
    window.teamapi.theme.set(theme);
  }
}

function initTheme() {
  // Reflect the OS platform so CSS can reserve space for native window controls.
  if (window.teamapi && window.teamapi.platform) {
    document.documentElement.dataset.platform = window.teamapi.platform;
  }

  const themeBtn = document.getElementById('btnToggleTheme');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // Titlebar gear → Settings dialog (Appearance + AI Provider).
  const settingsBtn = document.getElementById('btnOpenSettings');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);

  // Appearance segmented control inside Settings (live preview on click).
  const themeControl = document.getElementById('settingsThemeControl');
  if (themeControl) {
    themeControl.addEventListener('click', (e) => {
      const opt = e.target.closest('.theme-opt');
      if (opt && opt.dataset.theme) setThemeMode(opt.dataset.theme);
    });
  }

  // Settings dialog category tabs.
  const settingsTabs = document.querySelector('.settings-tabs');
  if (settingsTabs) {
    settingsTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.settings-tab');
      if (!tab || !tab.dataset.settingsTab) return;
      settingsTabs.querySelectorAll('.settings-tab').forEach((t) =>
        t.classList.toggle('active', t === tab));
      document.querySelectorAll('.settings-pane').forEach((p) =>
        p.classList.toggle('active', p.dataset.settingsPane === tab.dataset.settingsTab));
    });
  }

  // Advanced pane: show the userData path + wire the reset button.
  const dataPathEl = document.getElementById('userDataPath');
  if (dataPathEl && window.teamapi && window.teamapi.app && window.teamapi.app.getDataPath) {
    window.teamapi.app.getDataPath().then((p) => { if (p) dataPathEl.textContent = p; });
  }
  const resetBtn = document.getElementById('btnResetAppData');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!window.confirm('Reset all app data?\n\nThis clears AI settings, theme, cache and stored UI state, then restarts the app. This cannot be undone.')) return;
      if (window.teamapi && window.teamapi.app && window.teamapi.app.resetData) {
        await window.teamapi.app.resetData();
      }
    });
  }

  // Follow the OS theme, but only while the user hasn't chosen explicitly.
  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', (e) => {
    if (!getStoredTheme()) {
      const theme = e.matches ? 'light' : 'dark';
      paintTheme(theme);
      syncNativeThemeOverlay(theme);
    }
  });

  // Sync the native overlay with whatever theme was applied before paint.
  syncNativeThemeOverlay(document.documentElement.dataset.theme || 'dark');
}

// Active theme mode shown in Settings: explicit choice, or 'system' when following OS.
function currentThemeMode() {
  const stored = getStoredTheme();
  return stored || 'system';
}

function syncSettingsThemeControl() {
  const mode = currentThemeMode();
  document.querySelectorAll('#settingsThemeControl .theme-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === mode);
  });
}

function setThemeMode(mode) {
  if (mode === 'system') followSystemTheme();
  else applyTheme(mode);
  syncSettingsThemeControl();
}

// Open the Settings dialog from the titlebar gear. Reflects the current theme in
// the Appearance control, then lets ai-chat.js populate the AI provider fields.
function openSettingsModal() {
  syncSettingsThemeControl();
  if (typeof window.openAISettings === 'function') {
    window.openAISettings();
  } else {
    openDialog('modalAISettings');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
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

  const btnSave = document.getElementById('btnSave');
  if (btnSave) btnSave.onclick = saveCurrentRequest;

  // Save split-button: default click = Save; caret opens dropdown (Save As…)
  const saveMenu = document.getElementById('saveMenu');
  const btnSaveCaret = document.getElementById('btnSaveCaret');
  const saveMenuItemSaveAs = document.getElementById('saveMenuItemSaveAs');
  if (btnSaveCaret && saveMenu) {
    btnSaveCaret.onclick = (e) => {
      e.stopPropagation();
      saveMenu.classList.toggle('open');
    };
  }
  if (saveMenuItemSaveAs) {
    saveMenuItemSaveAs.onclick = () => {
      if (saveMenu) saveMenu.classList.remove('open');
      saveAsCurrentRequest();
    };
  }
  // Close the dropdown on outside click.
  window.addEventListener('click', (e) => {
    if (!saveMenu || !saveMenu.classList.contains('open')) return;
    if (!e.target.closest('#saveSplit')) saveMenu.classList.remove('open');
  });

  const btnCancelSaveReq = document.getElementById('btnCancelSaveReq');
  if (btnCancelSaveReq) btnCancelSaveReq.onclick = () => closeDialog('modalSaveRequest');

  const btnSaveReqNewCollection = document.getElementById('btnSaveReqNewCollection');
  if (btnSaveReqNewCollection) btnSaveReqNewCollection.onclick = () => {
    closeDialog('modalSaveRequest');
    openDialog('modalCreateCollection');
  };

  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  if (btnToggleSidebar) {
    btnToggleSidebar.onclick = () => {
      const sidebar = document.querySelector('.sidebar');
      const isCollapsed = sidebar.classList.toggle('collapsed');
      localStorage.setItem('sidebarCollapsed', isCollapsed);
      const sResizer = document.getElementById('sidebarResizer');
      if (sResizer) sResizer.style.display = isCollapsed ? 'none' : '';
    };
  }

  const btnToggleChat = document.getElementById('btnToggleChat');
  if (btnToggleChat) {
    btnToggleChat.onclick = () => {
      const chatPanel = document.getElementById('chatPanel');
      if (!chatPanel) return;
      const isCollapsed = chatPanel.classList.toggle('collapsed');
      localStorage.setItem('chatCollapsed', isCollapsed);
      const cResizer = document.getElementById('chatResizer');
      if (cResizer) cResizer.style.display = isCollapsed ? 'none' : '';
      if (!isCollapsed && window.refreshAIChatState) window.refreshAIChatState();
    };
  }

  const btnOpenFileManager = document.getElementById('btnOpenFileManager');
  if (btnOpenFileManager) {
    btnOpenFileManager.onclick = () => {
      window.teamapi.windows.openFileManager().catch((err) => {
        showToast('Failed to open TeamFolder: ' + (err && err.message ? err.message : err), 'error');
      });
    };
  }

  setupPanelResizers();

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
      e.preventDefault();
      const btn = document.getElementById('btnToggleSidebar');
      if (btn && btn.style.display !== 'none') {
        btn.click();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ']') {
      e.preventDefault();
      const btn = document.getElementById('btnToggleChat');
      if (btn && btn.style.display !== 'none') {
        btn.click();
      }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveCurrentRequest();
    }
  });

  // URL Bar & SEND Action
  document.getElementById('requestUrl').oninput = (e) => {
    const val = e.target.value.trim();
    if (/^curl(\.exe)?[\s]/i.test(val)) {
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
            
            renderActiveTabToEditor();
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

  // OAuth 2.0 inline panel (Current Token + Configure New Token)
  setupOauthPanel();

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
  const btnManageEnvs = document.getElementById('btnManageEnvs');
  if (btnManageEnvs) btnManageEnvs.onclick = openEnvironmentManager;

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

// Recent workspaces (latest RECENT_MAX shown on the home screen)
const RECENT_MAX = 5;
function deriveWorkspaceName(path) {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(separator);
  return parts[parts.length - 1] || path;
}
function getRecentWorkspaces() {
  try { return JSON.parse(localStorage.getItem('recentWorkspaces') || '[]'); } catch (e) { return []; }
}
function addRecentWorkspace(name, path) {
  if (!path) return;
  let list = getRecentWorkspaces().filter(ws => ws.path !== path);
  list.unshift({ name: name || deriveWorkspaceName(path), path });
  localStorage.setItem('recentWorkspaces', JSON.stringify(list.slice(0, RECENT_MAX)));
}
function removeRecentWorkspace(path) {
  localStorage.setItem('recentWorkspaces', JSON.stringify(getRecentWorkspaces().filter(ws => ws.path !== path)));
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

  let recents = getRecentWorkspaces();
  // One-time migration from the legacy single-path key.
  if (recents.length === 0) {
    const legacy = localStorage.getItem('lastWorkspacePath');
    if (legacy) recents = [{ name: deriveWorkspaceName(legacy), path: legacy }];
  }

  const recentEl = document.getElementById('welcomeRecent');
  const listEl = document.getElementById('recentWorkspaceList');
  if (recentEl && listEl) {
    if (recents.length > 0) {
      recentEl.style.display = 'flex';
      listEl.innerHTML = '';
      recents.forEach(ws => {
        const folderName = ws.name || deriveWorkspaceName(ws.path);
        const itemEl = document.createElement('div');
        itemEl.className = 'recent-workspace-item';
        itemEl.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-blue); flex-shrink: 0; margin-right: 4px;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span style="font-weight: 700; color: var(--text-primary); margin-right: 8px;">${folderName}</span>
          <span style="color: var(--text-muted); font-size: 11px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: left;">${ws.path}</span>
          <svg class="recent-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-dim); transition: transform 0.2s ease; margin-left: 4px;">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
        itemEl.onclick = async () => {
          try {
            const opened = await window.teamapi.workspace.openPath(ws.path);
            if (opened) {
              await loadWorkspace(opened);
            } else {
              showToast('Workspace path no longer exists on disk', 'error');
              removeRecentWorkspace(ws.path);
              showWelcomeScreen();
            }
          } catch (err) {
            showToast('Failed to open workspace: ' + err.message, 'error');
          }
        };
        listEl.appendChild(itemEl);
      });
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
    const sResizer = document.getElementById('sidebarResizer');
    if (sResizer) sResizer.style.display = 'none';
  } else {
    sidebar.classList.remove('collapsed');
  }

  // Hide welcome overlay
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('btnToggleSidebar').style.display = 'flex';
  document.getElementById('btnToggleChat').style.display = 'flex';
  document.getElementById('btnOpenFileManager').style.display = 'flex';

  // Restore chat panel collapse state (defaults to collapsed/hidden; the colorful
  // titlebar AI button is the entry point).
  const chatPanel = document.getElementById('chatPanel');
  const chatCollapsed = localStorage.getItem('chatCollapsed') !== 'false';
  if (chatPanel) {
    chatPanel.classList.toggle('collapsed', chatCollapsed);
    const cResizer = document.getElementById('chatResizer');
    if (cResizer) cResizer.style.display = chatCollapsed ? 'none' : '';
  }

  // Initialize the AI chat module (loads providers, settings, chats).
  if (window.initAIChat) window.initAIChat();

  // Update layout header
  document.getElementById('workspaceTitle').textContent = ws.name;
  document.getElementById('titlebarWorkspaceName').textContent = ws.name;

  // Persist current workspace path
  localStorage.setItem('lastWorkspacePath', ws.path);
  addRecentWorkspace(ws.name, ws.path);

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

      // 1. Render root folders (recursively nests sub-folders + requests)
      if (colDetail.folders && colDetail.folders.length > 0) {
        const rootFolders = colDetail.folders.filter(f => !f.parentId);
        rootFolders.forEach(folder => {
          contentPane.appendChild(renderFolderNode(folder, colId, colDetail));
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

// Recursively render a folder node: its header +, when expanded, its sub-folders and direct requests.
function renderFolderNode(folder, colId, colDetail) {
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

  if (folderExpanded) {
    const folderContent = document.createElement('div');
    folderContent.className = 'folder-content tree-node';

    const subFolders = (colDetail.folders || []).filter(f => f.parentId === folderId);
    subFolders.forEach(sub => {
      folderContent.appendChild(renderFolderNode(sub, colId, colDetail));
    });

    const folderRequests = (colDetail.requests || []).filter(r => r.folderId === folderId);
    if (subFolders.length === 0 && folderRequests.length === 0) {
      folderContent.innerHTML = '<div style="color: var(--text-dim); padding: 4px 10px; font-size: 11px;">Empty folder</div>';
    } else {
      folderRequests.forEach(req => {
        folderContent.appendChild(createRequestTreeItem(req, colId));
      });
    }
    folderNode.appendChild(folderContent);
  }

  return folderNode;
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
    closeSpan.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
    closeSpan.onclick = (e) => closeTab(tab.id, e);
    tabEl.appendChild(closeSpan);

    container.appendChild(tabEl);
  });

  refreshSaveButtonTarget();
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

  // Restore the saved response for this request, or clear the panel.
  if (req.lastResponse) {
    applyResponseToView(req.lastResponse);
  } else {
    clearResponseView();
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
  // OAuth 2.0 uses a wide two-column row; other auth types stay compact.
  const container = document.querySelector('.auth-container');
  if (container) container.classList.toggle('auth-wide', type === 'oauth2');
  if (type === 'bearer') {
    document.getElementById('authBearerFields').style.display = 'block';
  } else if (type === 'basic') {
    document.getElementById('authBasicFields').style.display = 'block';
  } else if (type === 'apikey') {
    document.getElementById('authApiKeyFields').style.display = 'block';
  } else if (type === 'oauth2') {
    document.getElementById('authOauthFields').style.display = 'flex';
    toggleOauthPasswordFields();
    refreshOauthTokenSelect();
  }
}

// ---- OAuth 2.0 (inline, Postman-style) ----
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function oauthTokenStatus(tok) {
  if (!tok) return { cls: '', text: 'No token selected' };
  if (!tok.accessToken) return { cls: 'expired', text: 'No access token — click "Get New Access Token" below' };
  if (tok.expiresAt && Date.now() >= tok.expiresAt) return { cls: 'expired', text: 'Expired' + (tok.refreshToken ? ' (will auto-refresh on send)' : '') };
  return { cls: 'valid', text: 'Valid' + (tok.expiresAt ? ` · expires ${new Date(tok.expiresAt).toLocaleString()}` : '') };
}
const oauthEl = (id) => document.getElementById(id);

async function refreshOauthTokenSelect() {
  const sel = oauthEl('oauthTokenSelect');
  if (!sel || !window.teamapi || !window.teamapi.oauth) return;
  const tokens = await window.teamapi.oauth.listTokens();
  const current = state.activeRequest && state.activeRequest.auth ? state.activeRequest.auth.tokenId : '';
  sel.innerHTML = '<option value="">— No token —</option>' +
    tokens.map(t => `<option value="${t.id}"${t.id === current ? ' selected' : ''}>${escapeHtml(t.name || 'Untitled')}</option>`).join('');
  const tok = tokens.find(t => t.id === current) || null;
  refreshOauthTokenStatus(tok);
  const delBtn = oauthEl('btnOauthDelete');
  if (delBtn) delBtn.disabled = !tok;
  const prefix = oauthEl('oauthHeaderPrefix');
  if (prefix) { prefix.disabled = !tok; prefix.value = tok ? (tok.headerPrefix == null ? 'Bearer' : tok.headerPrefix) : 'Bearer'; }
}

function refreshOauthTokenStatus(tok) {
  const el = oauthEl('oauthTokenStatus');
  if (!el) return;
  const s = oauthTokenStatus(tok);
  el.className = 'oauth-status ' + (s.cls || '');
  el.textContent = s.text;
}

function toggleOauthPasswordFields() {
  const pf = oauthEl('oauthPasswordFields');
  if (pf) pf.style.display = (oauthEl('oauthGrant').value === 'password') ? 'flex' : 'none';
}

function readOauthForm() {
  return {
    name: oauthEl('oauthName').value.trim() || 'Untitled',
    grantType: oauthEl('oauthGrant').value,
    tokenUrl: oauthEl('oauthTokenUrl').value.trim(),
    clientId: oauthEl('oauthClientId').value,
    clientSecret: oauthEl('oauthClientSecret').value,
    username: oauthEl('oauthUsername').value,
    password: oauthEl('oauthPassword').value,
    scope: oauthEl('oauthScope').value,
    clientAuth: oauthEl('oauthClientAuth').value,
    headerPrefix: (oauthEl('oauthHeaderPrefix').value || '').trim() || 'Bearer'
  };
}

function clearOauthForm() {
  ['oauthName', 'oauthTokenUrl', 'oauthClientId', 'oauthClientSecret', 'oauthUsername', 'oauthPassword', 'oauthScope'].forEach((id) => {
    const el = oauthEl(id); if (el) el.value = '';
  });
  oauthEl('oauthGrant').value = 'client_credentials';
  oauthEl('oauthClientAuth').value = 'body';
  toggleOauthPasswordFields();
}

async function oauthGetToken() {
  const cfg = readOauthForm();
  if (!cfg.tokenUrl) { showToast('Access Token URL is required', 'warning'); return; }
  if (!cfg.clientId) { showToast('Client ID is required', 'warning'); return; }
  if (cfg.grantType === 'password' && (!cfg.username || !cfg.password)) { showToast('Username and password are required for the password grant', 'warning'); return; }
  showToast('Requesting token…', 'info');
  try {
    const tok = await window.teamapi.oauth.getToken(cfg);
    if (state.activeRequest) {
      if (!state.activeRequest.auth) state.activeRequest.auth = { type: 'oauth2' };
      state.activeRequest.auth.type = 'oauth2';
      state.activeRequest.auth.tokenId = tok.id;
      queueSave();
    }
    showToast(`Got token "${tok.name}"`, 'success');
    await refreshOauthTokenSelect();
    clearOauthForm();
  } catch (err) {
    showToast('Token request failed: ' + ((err && err.message) || err), 'error');
  }
}

async function oauthSelectToken(id) {
  if (state.activeRequest) {
    if (!state.activeRequest.auth) state.activeRequest.auth = { type: 'oauth2' };
    state.activeRequest.auth.type = 'oauth2';
    state.activeRequest.auth.tokenId = id || '';
    queueSave();
  }
  await refreshOauthTokenSelect();
}

async function oauthDeleteSelected() {
  const auth = state.activeRequest && state.activeRequest.auth;
  const id = auth && auth.tokenId;
  if (!id) return;
  if (!window.confirm('Delete the selected token?')) return;
  await window.teamapi.oauth.deleteToken(id);
  auth.tokenId = '';
  queueSave();
  await refreshOauthTokenSelect();
  showToast('Token deleted', 'success');
}

async function oauthUpdatePrefix(value) {
  const auth = state.activeRequest && state.activeRequest.auth;
  const id = auth && auth.tokenId;
  if (!id) return;
  const tokens = await window.teamapi.oauth.listTokens();
  const tok = tokens.find(t => t.id === id);
  if (!tok) return;
  tok.headerPrefix = (value || '').trim() || 'Bearer';
  await window.teamapi.oauth.saveToken(tok);
}

function setupOauthPanel() {
  const sel = oauthEl('oauthTokenSelect');
  if (sel) sel.addEventListener('change', (e) => oauthSelectToken(e.target.value));
  const grant = oauthEl('oauthGrant');
  if (grant) grant.addEventListener('change', toggleOauthPasswordFields);
  const get = oauthEl('btnOauthGetToken');
  if (get) get.addEventListener('click', oauthGetToken);
  const del = oauthEl('btnOauthDelete');
  if (del) del.addEventListener('click', oauthDeleteSelected);
  const prefix = oauthEl('oauthHeaderPrefix');
  if (prefix) prefix.addEventListener('change', (e) => oauthUpdatePrefix(e.target.value));
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

    // Render the response into the view (shared with restore-on-open).
    applyResponseToView(result);

    // Persist the latest response on the request so saved requests keep it.
    if (state.activeRequest) {
      state.activeRequest.lastResponse = makeResponseSnapshot(result);
      queueSave();
    }

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

// Build a persistable snapshot of the latest response (stored on the request).
function makeResponseSnapshot(result) {
  return {
    status: result.status,
    duration: result.duration,
    size: result.size,
    body: result.body || '',
    isBinary: result.isBinary || false,
    contentType: result.contentType || '',
    headers: result.headers || [],
    error: result.error || null,
    scriptLog: result.scriptLog || [],
    tests: result.tests || [],
    savedAt: new Date().toISOString()
  };
}

// Render a response (live result or stored snapshot) into the response panel.
function applyResponseToView(result) {
  if (!result) { clearResponseView(); return; }

  const statusBadge = document.getElementById('responseStatus');
  statusBadge.textContent = result.status;
  statusBadge.style.display = 'block';

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

  document.getElementById('responseTime').textContent = `${result.duration}ms`;
  document.getElementById('responseSize').textContent = formatBytes(result.size);
  document.getElementById('responseMeta').style.display = 'flex';

  document.getElementById('prettyRawToggle').style.display = 'flex';
  document.getElementById('btnCopyResponse').style.display = 'block';

  document.getElementById('responseSearchBar').style.display = (result.error || !result.body) ? 'none' : 'flex';
  document.getElementById('responseSearchInput').value = '';
  document.getElementById('responseSearchCount').textContent = '0/0';

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

  renderResponseHeaders(result.headers);
  renderScriptLogs(result.scriptLog);
  renderTestResults(result.tests);
}

// Reset the response panel to its empty placeholder state.
function clearResponseView() {
  const statusBadge = document.getElementById('responseStatus');
  if (statusBadge) {
    statusBadge.textContent = '';
    statusBadge.style.display = 'none';
    statusBadge.className = 'response-badge';
    statusBadge.style.backgroundColor = '';
  }
  ['responseMeta', 'prettyRawToggle', 'btnCopyResponse', 'responseSearchBar', 'responseJsonPathBar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  state.lastResponseText = '';
  state.lastResponseIsBinary = false;
  state.lastResponseContentType = '';

  const display = document.getElementById('responseBodyDisplay');
  if (display) display.innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 40px;">Send a request to see output</div>';

  if (typeof renderResponseHeaders === 'function') renderResponseHeaders([]);
  if (typeof renderScriptLogs === 'function') renderScriptLogs([]);
  if (typeof renderTestResults === 'function') renderTestResults([]);
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
      iframe.sandbox = 'allow-scripts allow-popups';
      // Load via a data: URL. Unlike blob:/srcdoc:, a data: document gets an
      // opaque origin and does NOT inherit the app's strict CSP — so the
      // previewed HTML (inline scripts/styles/images) renders fully. The sandbox
      // (no allow-same-origin) still keeps it isolated from the app's origin.
      iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(text);
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
  selector.innerHTML = `<option value="none">No Environment</option>`;

  state.environments.forEach(env => {
    const option = document.createElement('option');
    option.value = env.id;
    option.textContent = env.name;
    selector.appendChild(option);
  });

  selector.value = state.activeEnvId || 'none';
}

function handleEnvSelectorChange(e) {
  const val = e.target.value;
  state.activeEnvId = val;
  state.activeEnv = state.environments.find(env => env.id === val) || null;
  if (state.currentWorkspace) {
    localStorage.setItem(`activeEnvId:${state.currentWorkspace.path}`, val);
  }
  showToast(`Switched environment to: ${state.activeEnv ? state.activeEnv.name : 'None'}`);
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
    addContextMenuItem('New Folder', () => createFolderPrompt(colId, folderId));
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

function createFolderPrompt(colId, parentFolderId = null) {
  openPromptDialog('New Folder', 'Folder Name', 'New Folder', async (name) => {
    const col = state.loadedCollections[colId];
    if (!col) return;
    const newFolder = {
      id: window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2),
      parentId: parentFolderId,
      name
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
  if (!confirm('Delete this folder? Its requests and sub-folders will be moved to the parent.')) return;
  const col = state.loadedCollections[colId];
  if (!col) return;

  // Re-parent direct sub-folders and requests to the deleted folder's parent (or root).
  const folder = (col.folders || []).find(f => f.id === folderId);
  const grandparent = folder ? folder.parentId : null;
  (col.folders || []).forEach(f => { if (f.parentId === folderId) f.parentId = grandparent; });
  (col.requests || []).forEach(r => { if (r.folderId === folderId) r.folderId = grandparent; });

  col.folders = col.folders.filter(f => f.id !== folderId);

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

// ── Save / Save As ──────────────────────────────────────────────────────────
let saveReqDialogMode = 'save';   // 'save' | 'saveAs'
let saveReqOriginTabId = null;    // tab to replace when saving an unsaved tab

function getActiveTab() {
  if (!state.activeTabId) return null;
  return state.tabs.find(t => t.id === state.activeTabId) || null;
}

// Build a fresh, id-less request object from the current editor state.
function buildRequestSnapshot() {
  const src = state.activeRequest || {};
  const snap = JSON.parse(JSON.stringify(src));
  delete snap.id;
  delete snap.folderId;
  delete snap.name;
  if (!Array.isArray(snap.params)) snap.params = [];
  if (!Array.isArray(snap.headers)) snap.headers = [];
  if (!snap.auth) snap.auth = { type: 'none' };
  if (!snap.body) snap.body = { type: 'none', content: '', formData: [] };
  if (!Array.isArray(snap.body.formData)) snap.body.formData = [];
  if (typeof snap.preScript !== 'string') snap.preScript = '';
  if (typeof snap.postScript !== 'string') snap.postScript = '';
  if (typeof snap.description !== 'string') snap.description = '';
  return snap;
}

// "Collection" or "Collection › Folder" label for toasts / buttons.
function describeCollectionPath(col, folderId) {
  if (!col) return 'collection';
  let label = col.name;
  if (folderId && Array.isArray(col.folders)) {
    const folder = col.folders.find(f => f.id === folderId);
    if (folder) label += ' › ' + folder.name;
  }
  return label;
}

async function saveCurrentRequest() {
  const tab = getActiveTab();
  if (!tab) {
    showToast('No active request to save', 'error');
    return;
  }
  // Already saved → one-click persist to its own collection.
  if (tab.type === 'saved' && tab.collectionId && state.loadedCollections[tab.collectionId]) {
    try {
      const col = state.loadedCollections[tab.collectionId];
      await window.teamapi.collections.save(col);
      showToast('Saved to ' + describeCollectionPath(col, tab.request && tab.request.folderId), 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
    return;
  }
  // New / history → must pick a destination.
  openSaveRequestDialog('save');
}

function saveAsCurrentRequest() {
  if (!getActiveTab()) {
    showToast('No active request to save', 'error');
    return;
  }
  openSaveRequestDialog('saveAs');
}

// Refresh the live "Saving to: …" line from current dialog selections.
function updateSaveReqTargetLabel() {
  const targetEl = document.getElementById('saveReqTarget');
  const colSelect = document.getElementById('saveReqCollection');
  const folderSelect = document.getElementById('saveReqFolder');
  if (!targetEl || !colSelect) return;

  const colId = colSelect.value;
  const col = state.collections.find(c => c.id === colId);
  const colName = col ? col.name : '—';
  const folderId = folderSelect && folderSelect.value ? folderSelect.value : null;
  const colDetail = state.loadedCollections[colId];
  let folderName = 'Root';
  if (folderId && colDetail) {
    const folder = (colDetail.folders || []).find(f => f.id === folderId);
    if (folder) folderName = folder.name;
  }

  targetEl.textContent = '';
  targetEl.appendChild(document.createTextNode('Saving to: '));
  const strong = document.createElement('strong');
  strong.textContent = colName;
  targetEl.appendChild(strong);
  targetEl.appendChild(document.createTextNode(' › ' + folderName));
}

async function populateSaveReqFolders() {
  const colSelect = document.getElementById('saveReqCollection');
  const folderSelect = document.getElementById('saveReqFolder');
  const folderGroup = document.getElementById('saveReqFolderGroup');
  if (!colSelect || !folderSelect) return;

  const colId = colSelect.value;
  // Ensure the chosen collection's full detail is loaded.
  if (colId && !state.loadedCollections[colId]) {
    await loadCollectionDetails(colId);
  }
  const colDetail = state.loadedCollections[colId];

  folderSelect.innerHTML = '';
  const rootOpt = document.createElement('option');
  rootOpt.value = '';
  rootOpt.textContent = 'Root (No folder)';
  folderSelect.appendChild(rootOpt);

  let preferredFolderId = '';
  if (colDetail && Array.isArray(colDetail.folders)) {
    colDetail.folders.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      folderSelect.appendChild(opt);
    });
    // Default to the active request's folder if it lives in this collection.
    const tab = getActiveTab();
    if (tab && tab.type === 'saved' && tab.collectionId === colId && tab.request && tab.request.folderId) {
      preferredFolderId = tab.request.folderId;
    }
  }
  folderSelect.value = preferredFolderId || '';
  folderSelect.onchange = updateSaveReqTargetLabel;

  const hasFolders = !!(colDetail && colDetail.folders && colDetail.folders.length);
  if (folderGroup) folderGroup.style.display = hasFolders ? '' : 'none';
}

async function openSaveRequestDialog(mode) {
  saveReqDialogMode = mode;
  saveReqOriginTabId = state.activeTabId;

  const tab = getActiveTab();
  const header = document.getElementById('saveReqHeader');
  if (header) header.textContent = mode === 'saveAs' ? 'Save Request As…' : 'Save Request';

  // Default name: saved-tab name, else URL-derived, else "New Request".
  let defaultName = '';
  if (tab) {
    if (tab.type === 'saved') {
      defaultName = tab.name || '';
    } else {
      const url = (tab.request && tab.request.url) || '';
      let derived = url ? url.replace(/^https?:\/\/[^/]+/i, '') : '';
      if (!derived || derived === '/') derived = url;
      defaultName = derived || 'New Request';
    }
  }
  const nameInput = document.getElementById('saveReqName');
  if (nameInput) {
    nameInput.value = defaultName;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
  }

  const colSelect = document.getElementById('saveReqCollection');
  const folderGroup = document.getElementById('saveReqFolderGroup');
  const emptyEl = document.getElementById('saveReqEmpty');
  const targetEl = document.getElementById('saveReqTarget');
  const confirmBtn = document.getElementById('btnConfirmSaveReq');

  // No collections → guard.
  if (!state.collections || state.collections.length === 0) {
    if (colSelect) colSelect.innerHTML = '';
    if (folderGroup) folderGroup.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    if (targetEl) targetEl.style.display = 'none';
    if (confirmBtn) confirmBtn.disabled = true;
    openDialog('modalSaveRequest');
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (targetEl) targetEl.style.display = '';
  if (confirmBtn) confirmBtn.disabled = false;

  // Populate collections; default to the active request's collection if saved.
  if (colSelect) {
    colSelect.innerHTML = '';
    state.collections.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      colSelect.appendChild(opt);
    });
    const savedColId = (tab && tab.type === 'saved' && tab.collectionId) ? tab.collectionId : null;
    colSelect.value = state.collections.some(c => c.id === savedColId) ? savedColId : state.collections[0].id;
    colSelect.onchange = async () => { await populateSaveReqFolders(); updateSaveReqTargetLabel(); };
  }

  await populateSaveReqFolders();
  updateSaveReqTargetLabel();

  if (confirmBtn) confirmBtn.onclick = confirmSaveRequest;

  openDialog('modalSaveRequest');
}

async function confirmSaveRequest() {
  const nameInput = document.getElementById('saveReqName');
  const colSelect = document.getElementById('saveReqCollection');
  const folderSelect = document.getElementById('saveReqFolder');
  if (!nameInput || !colSelect) return;

  const name = nameInput.value.trim();
  if (!name) {
    showToast('Please enter a request name', 'error');
    nameInput.focus();
    return;
  }
  const colId = colSelect.value;
  if (!colId) {
    showToast('Please choose a collection', 'error');
    return;
  }
  const folderId = folderSelect && folderSelect.value ? folderSelect.value : null;

  if (!state.loadedCollections[colId]) {
    await loadCollectionDetails(colId);
  }
  const col = state.loadedCollections[colId];
  if (!col) {
    showToast('Could not load target collection', 'error');
    return;
  }

  // New request from current editor state.
  const newReq = buildRequestSnapshot();
  newReq.id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).substring(2);
  newReq.name = name;
  newReq.folderId = folderId;

  if (!Array.isArray(col.requests)) col.requests = [];
  col.requests.push(newReq);

  try {
    await window.teamapi.collections.save(col);
    renderCollectionsTree();
    const label = describeCollectionPath(col, folderId);
    showToast('Saved to ' + label, 'success');
    closeDialog('modalSaveRequest');

    const newId = newReq.id;
    if (saveReqDialogMode === 'saveAs') {
      // Open the saved copy in its own tab; leave the original untouched.
      loadRequestIntoEditor(colId, newId);
    } else {
      // 'save' from an unsaved tab: replace the origin tab with the saved one.
      const originId = saveReqOriginTabId;
      if (originId) await closeTab(originId);
      loadRequestIntoEditor(colId, newId);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

// Reflect the active tab's save target on the Save button subtitle/tooltip.
function refreshSaveButtonTarget() {
  const btn = document.getElementById('btnSave');
  const targetEl = btn ? btn.querySelector('.btn-save-target') : null;
  if (!btn || !targetEl) return;
  const tab = getActiveTab();
  if (tab && tab.type === 'saved' && tab.collectionId && state.loadedCollections[tab.collectionId]) {
    const col = state.loadedCollections[tab.collectionId];
    const path = describeCollectionPath(col, tab.request && tab.request.folderId);
    targetEl.textContent = '→ ' + path;
    btn.title = 'Save to ' + path + ' (Ctrl/Cmd+S)';
  } else {
    targetEl.textContent = 'Save to…';
    btn.title = 'Save to a collection (Ctrl/Cmd+S)';
  }
}

// Autocomplete Suggestions system
// Coverage comes from compact JS built-in lists rather than a hand-curated set.
// Two pools: GLOBALS (keywords + identifiers at statement level) and MEMBERS
// (anything after a `.`). Members are the union of String/Array/Object/Number/
// Math/JSON/console/Date/Promise prototype members plus the pm runtime API.
const JS_KEYWORDS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'void', 'this', 'try', 'catch', 'finally', 'throw', 'class', 'extends', 'super', 'import', 'export', 'default', 'async', 'await', 'yield', 'in', 'of'];

const JS_GLOBALS = ['JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'NaN', 'Infinity', 'undefined', 'globalThis', 'console', 'tp'];

// Callable members are inserted with a trailing `(`.
const JS_MEMBER_METHODS = ['charAt', 'charCodeAt', 'codePointAt', 'concat', 'includes', 'endsWith', 'indexOf', 'lastIndexOf', 'localeCompare', 'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'slice', 'split', 'startsWith', 'substring', 'substr', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'valueOf', 'at', 'toString', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'join', 'keys', 'map', 'pop', 'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'some', 'sort', 'splice', 'unshift', 'values', 'assign', 'create', 'defineProperty', 'defineProperties', 'freeze', 'fromEntries', 'getOwnPropertyNames', 'getPrototypeOf', 'hasOwn', 'is', 'isFrozen', 'seal', 'toFixed', 'toPrecision', 'toExponential', 'abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'sqrt', 'cbrt', 'pow', 'exp', 'log', 'log2', 'log10', 'max', 'min', 'random', 'sin', 'cos', 'tan', 'atan', 'atan2', 'parse', 'stringify', 'error', 'warn', 'info', 'debug', 'table', 'group', 'groupEnd', 'time', 'timeEnd', 'dir', 'trace', 'getTime', 'getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds', 'toISOString', 'toDateString', 'setTime', 'setFullYear', 'then', 'catch', 'finally', 'all', 'race', 'allSettled', 'any', 'resolve', 'reject', 'get', 'set', 'test', 'expect', 'json', 'equal', 'notEqual', 'include', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString'];

// Non-callable members (properties, chain objects) are inserted as-is.
const JS_MEMBER_PROPERTIES = ['length', 'name', 'prototype', 'constructor', 'size', 'environment', 'response', 'request', 'variables', 'globals', 'collection', 'code', 'status', 'body', 'headers', 'time', 'responseTime', 'to', 'be', 'a', 'an'];

// Team API script snippets — type `tp` to surface these templates.
const TP_SNIPPETS = [
  { label: 'tp — set env', value: 'tp.environment.set("key", "value");', type: 'snippet' },
  { label: 'tpset', value: 'tp.environment.set("key", "value");', type: 'snippet' },
  { label: 'tpget', value: 'tp.environment.get("key");', type: 'snippet' },
  { label: 'tptest', value: 'tp.test("status is 200", function () {\n  tp.expect(tp.response.code).to.equal(200);\n});', type: 'snippet' },
  { label: 'tpexpect', value: 'tp.expect(value).to.equal(expected);', type: 'snippet' },
  { label: 'tpjson', value: 'const body = tp.response.json();', type: 'snippet' },
  { label: 'tplog', value: 'console.log("message");', type: 'snippet' }
];

const SCRIPT_GLOBAL_SUGGESTIONS = [
  ...JS_KEYWORDS.map(k => ({ label: k, value: k + ' ', type: 'keyword' })),
  ...JS_GLOBALS.map(g => ({ label: g, value: g, type: 'global' })),
  ...TP_SNIPPETS
];

const SCRIPT_MEMBER_SUGGESTIONS = (() => {
  const seen = new Set();
  const out = [];
  const add = (name, type, value) => { if (!seen.has(name)) { seen.add(name); out.push({ label: name, value, type }); } };
  JS_MEMBER_METHODS.forEach(m => add(m, 'method', m + '('));
  JS_MEMBER_PROPERTIES.forEach(p => add(p, 'property', p));
  return out;
})();

const SCRIPT_SUGGESTION_CAP = 60;

// Identify the identifier token ending at `pos`. A `.` immediately before the token
// means we're completing a member (e.g. `obj.foo|`).
function getScriptToken(text, pos) {
  let wordStart = pos;
  while (wordStart > 0 && /[A-Za-z0-9_$]/.test(text[wordStart - 1])) wordStart--;
  const currentWord = text.substring(wordStart, pos);
  const isMember = wordStart > 0 && text[wordStart - 1] === '.';
  return { wordStart, currentWord, isMember };
}

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

  const { wordStart, currentWord, isMember } = getScriptToken(text, selStart);
  const needle = currentWord.toLowerCase();

  if (currentWord.length >= 1 || isMember) {
    const pool = isMember ? SCRIPT_MEMBER_SUGGESTIONS : SCRIPT_GLOBAL_SUGGESTIONS;
    const matches = pool
      .filter(s => s.label.toLowerCase().startsWith(needle) && s.label.toLowerCase() !== needle)
      .slice(0, SCRIPT_SUGGESTION_CAP);

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
      const selStart = textarea.selectionStart;
      const text = textarea.value;
      const { wordStart, currentWord } = getScriptToken(text, selStart);
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
// Estimate the pixel position of `position` inside an <input>/<textarea> by mirroring
// its styles into a hidden div and measuring the caret span. Used to anchor the
// preview tooltip to the actual {{variable}} text instead of the field corner.
function getCaretCoordinates(element, position) {
  const isInput = element.tagName === 'INPUT';
  const props = ['direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'textDecoration',
    'letterSpacing', 'wordSpacing', 'tabSize'];
  const style = window.getComputedStyle(element);
  const div = document.createElement('div');
  props.forEach(p => { div.style[p] = style[p]; });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
  if (!isInput) div.style.wordWrap = 'break-word';
  div.textContent = element.value.substring(0, position);
  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const coords = { top: span.offsetTop, left: span.offsetLeft };
  document.body.removeChild(div);
  return coords;
}

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

  // Resolve matching variables (dynamic generators first, then env vars)
  const envVars = state.activeEnv ? state.activeEnv.variables : {};
  const envSecrets = (state.activeEnv && state.activeEnv.secrets) || [];
  let previewHtml = '';
  matches.forEach(m => {
    const key = m[1].trim();
    let resolved = resolveDynamicVar(key);
    if (resolved === null) resolved = envVars.hasOwnProperty(key) ? envVars[key] : 'undefined';
    const isSecret = envSecrets.includes(key) && resolved !== 'undefined';
    if (isSecret) resolved = '••••••••';
    let display = String(resolved);
    if (display.length > 200) display = display.slice(0, 200) + '…';
    const safe = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    previewHtml += `<div><span class="var-preview-name">{{${key}}}</span><span class="var-preview-arrow">➔</span><span class="var-preview-value">${safe}</span></div>`;
  });

  tooltip.innerHTML = previewHtml;

  // Anchor the tooltip to the first variable — stable, doesn't chase the caret/mouse.
  const anchorPos = matches[0].index;
  const coords = getCaretCoordinates(inputEl, anchorPos);
  const rect = inputEl.getBoundingClientRect();
  const cs = window.getComputedStyle(inputEl);
  const bTop = parseFloat(cs.borderTopWidth) || 0;
  const bLeft = parseFloat(cs.borderLeftWidth) || 0;
  const pTop = parseFloat(cs.paddingTop) || 0;
  const pLeft = parseFloat(cs.paddingLeft) || 0;
  const lineH = parseFloat(cs.lineHeight) || 20;

  tooltip.style.display = 'block'; // needed to measure size
  let left = rect.left + bLeft + pLeft + coords.left - (inputEl.scrollLeft || 0) + (window.scrollX || 0);
  let top = rect.top + bTop + pTop + coords.top + lineH + 4 + (window.scrollY || 0);

  // Clamp horizontally within the viewport
  const ttW = tooltip.offsetWidth;
  if (left + ttW > window.innerWidth - 8) left = window.innerWidth - ttW - 8;
  if (left < 8) left = 8;

  // If not enough room below, show above the line
  const ttH = tooltip.offsetHeight;
  if (top + ttH > (window.innerHeight - 8) && (rect.top + bTop + pTop + coords.top) > ttH + 8) {
    top = rect.top + bTop + pTop + coords.top - ttH - 6 + (window.scrollY || 0);
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
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
            parentId: folderId,
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

// =============================================================================
// AI Chat integration — the assistant reads the active request/response and can
// apply modifications. Exposed on window for ai-chat.js. Reuses buildRequestSnapshot,
// renderActiveTabToEditor, executeRequest, and state.lastResponseText.
// =============================================================================

// Compact text snapshot of the active request + last response, injected into the
// AI system prompt each turn so the assistant is grounded in what the user is doing.
function getRequestContextForAI() {
  if (!state.activeRequest) return 'No active request is open.';
  const r = state.activeRequest;
  const lines = [];
  lines.push('CURRENT REQUEST');
  lines.push('METHOD: ' + (r.method || 'GET'));
  lines.push('URL: ' + (r.url || '(none)'));
  const headers = (r.headers || []).filter(h => h.enabled && h.key);
  lines.push('HEADERS: ' + (headers.length ? headers.map(h => h.key + ': ' + h.value).join(' | ') : '(none)'));
  const params = (r.params || []).filter(p => p.enabled && p.key);
  lines.push('PARAMS: ' + (params.length ? params.map(p => p.key + '=' + p.value).join(' | ') : '(none)'));
  if (r.auth && r.auth.type && r.auth.type !== 'none') lines.push('AUTH: ' + r.auth.type);
  if (r.body && r.body.type && r.body.type !== 'none') {
    lines.push('BODY (' + (r.body.subType || r.body.type) + '):');
    lines.push(String(r.body.content || '').slice(0, 2000));
  } else {
    lines.push('BODY: (none)');
  }
  if (state.lastResponseText) {
    lines.push('');
    lines.push('LAST RESPONSE (first 1500 chars):');
    lines.push(String(state.lastResponseText).slice(0, 1500));
  }
  return lines.join('\n');
}

// Apply an array of AI-emitted operations to the active request. Each op is
// { op: "...", ... }. Mutates state.activeRequest and re-renders the editor in
// one pass; runs the request if a `send` op is present. Returns { applied, skipped }.
// Guards each op so malformed input never crashes. No-ops safely with no request.
async function applyRequestOps(ops) {
  const result = { applied: [], skipped: [] };
  if (!Array.isArray(ops)) return result;

  // 1. create_request first — opens a new tab and makes it the active request,
  //    so any following ops (set_header, send, …) apply to the new request.
  const remaining = [];
  for (const op of ops) {
    if (op && op.op === 'create_request') {
      try {
        const newId = 'new-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const req = {
          method: String(op.method || 'GET').toUpperCase(),
          url: String(op.url || ''),
          params: [],
          headers: Array.isArray(op.headers)
            ? op.headers.map(h => ({ key: String(h.key || ''), value: String(h.value != null ? h.value : ''), enabled: h.enabled !== false }))
            : [],
          auth: { type: 'none' },
          body: op.body
            ? { type: 'raw', subType: op.body.type || 'json', content: String(op.body.content || ''), formData: [] }
            : { type: 'none', content: '', formData: [] },
          preScript: '', postScript: ''
        };
        await openRequestInTab(newId, 'new', op.url || 'New Request', req);
        result.applied.push('new ' + req.method + ' ' + (req.url || 'request'));
      } catch (e) {
        result.skipped.push('create_request');
      }
    } else {
      remaining.push(op);
    }
  }

  // 2. Apply remaining ops to the (possibly newly created) active request.
  const r = state.activeRequest;
  if (!r) {
    if (typeof renderRequestTabs === 'function') renderRequestTabs();
    return result;
  }
  if (!Array.isArray(r.headers)) r.headers = [];
  if (!Array.isArray(r.params)) r.params = [];
  if (!r.body) r.body = { type: 'none', content: '', formData: [] };
  if (!r.auth) r.auth = { type: 'none' };
  let doSend = false;

  // Hold the URL<->params sync flag during programmatic edits + re-render.
  state.isSyncingParams = true;
  try {
    for (const op of remaining) {
      try {
        switch (op && op.op) {
          case 'set_method':
            r.method = String(op.value || 'GET').toUpperCase();
            result.applied.push('method ' + r.method);
            break;
          case 'set_url':
            r.url = String(op.value || '');
            result.applied.push('url');
            break;
          case 'set_header': {
            const key = String(op.key || '');
            const existing = r.headers.find(h => (h.key || '').toLowerCase() === key.toLowerCase());
            if (existing) existing.value = String(op.value != null ? op.value : '');
            else r.headers.push({ key, value: String(op.value != null ? op.value : ''), enabled: true });
            result.applied.push('header ' + key);
            break;
          }
          case 'remove_header': {
            const key = String(op.key || '').toLowerCase();
            r.headers = r.headers.filter(h => (h.key || '').toLowerCase() !== key);
            result.applied.push('remove header ' + op.key);
            break;
          }
          case 'set_param': {
            const key = String(op.key || '');
            const existing = r.params.find(p => (p.key || '').toLowerCase() === key.toLowerCase());
            if (existing) existing.value = String(op.value != null ? op.value : '');
            else r.params.push({ key, value: String(op.value != null ? op.value : ''), enabled: true });
            result.applied.push('param ' + key);
            break;
          }
          case 'remove_param': {
            const key = String(op.key || '').toLowerCase();
            r.params = r.params.filter(p => (p.key || '').toLowerCase() !== key);
            result.applied.push('remove param ' + op.key);
            break;
          }
          case 'set_body':
            r.body = { type: 'raw', subType: String(op.type || 'json'), content: String(op.content || ''), formData: [] };
            result.applied.push('body');
            break;
          case 'set_auth':
            r.auth = {
              type: op.type || 'none',
              token: op.token || '',
              username: op.username || '',
              password: op.password || '',
              key: op.key || '',
              headerName: op.headerName || 'X-API-Key'
            };
            result.applied.push('auth ' + (op.type || 'none'));
            break;
          case 'send':
            doSend = true;
            result.applied.push('send');
            break;
          default:
            result.skipped.push(op && op.op ? op.op : '(unknown)');
        }
      } catch (e) {
        result.skipped.push(op && op.op ? op.op : '(unknown)');
      }
    }
    if (typeof renderActiveTabToEditor === 'function') renderActiveTabToEditor();
  } catch (e) {
    // ignore render errors
  } finally {
    state.isSyncingParams = false;
  }

  if (typeof renderRequestTabs === 'function') renderRequestTabs();
  if (doSend && typeof executeRequest === 'function') {
    try { executeRequest(); } catch (e) {}
  }
  return result;
}

window.getRequestContextForAI = getRequestContextForAI;
window.applyRequestOps = applyRequestOps;

