const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
app.name = 'Team API';
app.setName('Team API');
const pathModule = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const vm = require('vm');
const { PROVIDERS, streamChat, listModels } = require('./ai-providers');

// Resolve the OS-configured proxy for a URL into an axios `proxy` config ({} if none).
// Lets "Use system proxy" route Node/axios requests (which ignore Electron's
// session proxy) through the same proxy the OS would use.
async function resolveSystemProxy(url) {
  if (!url) return {};
  try {
    const line = await session.defaultSession.resolveProxy(url);
    if (!line || /^direct/i.test(line.trim())) return {};
    const first = line.split(';')[0].trim();
    const m = first.match(/^(PROXY|HTTPS|SOCKS\d?)\s+(.+)/i);
    if (!m || /^SOCKS/i.test(m[1])) return {}; // axios built-in can't do SOCKS
    const [host, port] = m[2].trim().split(':');
    return { proxy: { protocol: 'http', host, port: parseInt(port, 10) || 80 } };
  } catch (e) {
    return {};
  }
}

let mainWindow = null;
let currentWorkspace = null;
let activeWatchers = [];

function setupWorkspaceWatcher(path) {
  // Close any existing watchers
  activeWatchers.forEach(w => {
    try {
      w.close();
    } catch (e) {
      console.error('Error closing watcher:', e);
    }
  });
  activeWatchers = [];

  if (!path) return;

  const collectionsPath = pathModule.join(path, 'collections');
  const environmentsPath = pathModule.join(path, 'environments');

  let debounceTimeout = null;
  const notifyChanged = (eventType, filename) => {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      if (mainWindow) {
        mainWindow.webContents.send('workspace:changed', { eventType, filename });
      }
    }, 200);
  };

  try {
    if (fs.existsSync(collectionsPath)) {
      const colWatcher = fs.watch(collectionsPath, (eventType, filename) => {
        notifyChanged(eventType, 'collections/' + filename);
      });
      activeWatchers.push(colWatcher);
    }
    if (fs.existsSync(environmentsPath)) {
      const envWatcher = fs.watch(environmentsPath, (eventType, filename) => {
        notifyChanged(eventType, 'environments/' + filename);
      });
      activeWatchers.push(envWatcher);
    }
  } catch (err) {
    console.error('Error starting fs.watch:', err);
  }
}

function createWindow() {
  const options = {
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 800,
    resizable: true,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: pathModule.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (process.platform !== 'darwin') {
    options.titleBarOverlay = {
      color: '#0b0e14',
      symbolColor: '#94a3b8',
      height: 40
    };
  }

  mainWindow = new BrowserWindow(options);

  // Open external links (e.g. markdown links in AI chat) in the system browser,
  // never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(pathModule.join(__dirname, '../renderer/index.html'));

  // Open DevTools in development if needed, standard behavior
  // mainWindow.webContents.openDevTools();

  // Create Application Menu
  const template = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        {
          label: 'Go to Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('workspace:onGoToHome');
          }
        },
        { type: 'separator' },
        {
          label: 'New Workspace',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('workspace:onNewRequest');
          }
        },
        {
          label: 'Open Workspace',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('workspace:onOpenRequest');
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  );

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Use the OS-configured proxy so resolveProxy() (for "Use system proxy")
  // reflects the system settings.
  try { session.defaultSession.setProxy({ mode: 'system' }); } catch (e) {}
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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

// IPC Handlers

// Workspace
ipcMain.handle('workspace:openPath', async (event, path) => {
  if (!path || !fs.existsSync(path)) return null;
  const name = pathModule.basename(path);
  currentWorkspace = path;

  // Initialize workspace directories if missing
  const metaDir = pathModule.join(path, '.teamapi');
  const metaPath = pathModule.join(metaDir, 'meta.json');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({
      name,
      version: '1.0.0',
      createdAt: new Date().toISOString()
    }, null, 2));
  }

  // Ensure collections and environments dirs exist
  const collectionsDir = pathModule.join(path, 'collections');
  if (!fs.existsSync(collectionsDir)) fs.mkdirSync(collectionsDir, { recursive: true });

  const envsDir = pathModule.join(path, 'environments');
  if (!fs.existsSync(envsDir)) fs.mkdirSync(envsDir, { recursive: true });

  setupWorkspaceWatcher(path);

  return { path, name };
});

ipcMain.handle('workspace:openDialog', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const path = result.filePaths[0];
  const name = pathModule.basename(path);
  currentWorkspace = path;

  // Initialize workspace directories if missing
  const metaDir = pathModule.join(path, '.teamapi');
  const metaPath = pathModule.join(metaDir, 'meta.json');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({
      name,
      version: '1.0.0',
      createdAt: new Date().toISOString()
    }, null, 2));
  }

  // Ensure collections and environments dirs exist
  const collectionsDir = pathModule.join(path, 'collections');
  if (!fs.existsSync(collectionsDir)) fs.mkdirSync(collectionsDir, { recursive: true });

  const envsDir = pathModule.join(path, 'environments');
  if (!fs.existsSync(envsDir)) fs.mkdirSync(envsDir, { recursive: true });

  setupWorkspaceWatcher(path);

  return { path, name };
});

ipcMain.handle('workspace:createDialog', async (event, name) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Parent Folder for new Workspace'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const parentPath = result.filePaths[0];
  const path = pathModule.join(parentPath, name);

  if (!fs.existsSync(path)) {
    fs.mkdirSync(path, { recursive: true });
  }

  // Create workspace metadata
  const metaDir = pathModule.join(path, '.teamapi');
  const metaPath = pathModule.join(metaDir, 'meta.json');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    name,
    version: '1.0.0',
    createdAt: new Date().toISOString()
  }, null, 2));

  // Create default directories
  fs.mkdirSync(pathModule.join(path, 'collections'), { recursive: true });
  fs.mkdirSync(pathModule.join(path, 'environments'), { recursive: true });

  currentWorkspace = path;
  setupWorkspaceWatcher(path);
  return { path, name };
});

ipcMain.handle('workspace:getMeta', async () => {
  if (!currentWorkspace) return null;
  const metaPath = pathModule.join(currentWorkspace, '.teamapi', 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      return null;
    }
  }
  return null;
});

// Collections
ipcMain.handle('collections:list', async () => {
  if (!currentWorkspace) return [];
  const colDir = pathModule.join(currentWorkspace, 'collections');
  if (!fs.existsSync(colDir)) return [];

  const files = fs.readdirSync(colDir);
  const list = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const content = fs.readFileSync(pathModule.join(colDir, file), 'utf8');
        const col = JSON.parse(content);
        list.push({
          id: col.id,
          name: col.name,
          requestCount: col.requests ? col.requests.length : 0
        });
      } catch (e) {
        console.error('Error reading collection file:', file, e);
      }
    }
  }
  return list;
});

ipcMain.handle('collections:get', async (event, id) => {
  if (!currentWorkspace) return null;
  const filePath = pathModule.join(currentWorkspace, 'collections', `${id}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return null;
    }
  }
  return null;
});

ipcMain.handle('collections:save', async (event, collectionObj) => {
  if (!currentWorkspace) throw new Error('No workspace selected');
  if (!collectionObj.id) {
    collectionObj.id = uuidv4();
    collectionObj.createdAt = new Date().toISOString();
  }
  collectionObj.updatedAt = new Date().toISOString();

  const colDir = pathModule.join(currentWorkspace, 'collections');
  if (!fs.existsSync(colDir)) fs.mkdirSync(colDir, { recursive: true });

  const filePath = pathModule.join(colDir, `${collectionObj.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(collectionObj, null, 2), 'utf8');
  return collectionObj;
});

ipcMain.handle('collections:delete', async (event, id) => {
  if (!currentWorkspace) return;
  const filePath = pathModule.join(currentWorkspace, 'collections', `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
});

// Environments
ipcMain.handle('environments:list', async () => {
  if (!currentWorkspace) return [];
  const envDir = pathModule.join(currentWorkspace, 'environments');
  if (!fs.existsSync(envDir)) return [];

  const files = fs.readdirSync(envDir);
  const list = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const content = fs.readFileSync(pathModule.join(envDir, file), 'utf8');
        list.push(JSON.parse(content));
      } catch (e) {
        console.error('Error reading environment file:', file, e);
      }
    }
  }
  return list;
});

ipcMain.handle('environments:save', async (event, envObj) => {
  if (!currentWorkspace) throw new Error('No workspace selected');
  if (!envObj.id) {
    envObj.id = uuidv4();
  }
  envObj.updatedAt = new Date().toISOString();

  const envDir = pathModule.join(currentWorkspace, 'environments');
  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });

  const filePath = pathModule.join(envDir, `${envObj.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(envObj, null, 2), 'utf8');
  return envObj;
});

ipcMain.handle('environments:delete', async (event, id) => {
  if (!currentWorkspace) return;
  const filePath = pathModule.join(currentWorkspace, 'environments', `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
});

// History
ipcMain.handle('history:list', async () => {
  if (!currentWorkspace) return [];
  const historyPath = pathModule.join(currentWorkspace, '.teamapi', 'history.json');
  if (fs.existsSync(historyPath)) {
    try {
      return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
});

ipcMain.handle('history:clear', async () => {
  if (!currentWorkspace) return;
  const historyPath = pathModule.join(currentWorkspace, '.teamapi', 'history.json');
  try {
    fs.writeFileSync(historyPath, '[]', 'utf8');
  } catch (e) {
    console.error('Failed to clear history:', e);
    throw e;
  }
});

// Execute Request
ipcMain.handle('request:execute', async (event, { request: requestObj, envVars }) => {
  const scriptLog = [];
  const tests = [];
  const activeEnvVars = { ...envVars };

  // Setup PM API context
  const pm = {
    environment: {
      set: (key, val) => {
        activeEnvVars[key] = String(val);
      },
      get: (key) => activeEnvVars[key]
    },
    response: null,
    test: (name, fn) => {
      try {
        fn();
        tests.push({ name, passed: true });
      } catch (err) {
        tests.push({ name, passed: false, error: err.message });
      }
    },
    expect: (val) => {
      return {
        to: {
          equal: (expected) => {
            if (val !== expected) throw new Error(`expected ${val} to equal ${expected}`);
          },
          notEqual: (expected) => {
            if (val === expected) throw new Error(`expected ${val} not to equal ${expected}`);
          },
          be: {
            a: (type) => {
              if (typeof val !== type) throw new Error(`expected ${val} to be a ${type}`);
            },
            an: (type) => {
              if (typeof val !== type) throw new Error(`expected ${val} to be an ${type}`);
            }
          },
          include: (subset) => {
            if (typeof val === 'string' || Array.isArray(val)) {
              if (!val.includes(subset)) throw new Error(`expected ${JSON.stringify(val)} to include ${JSON.stringify(subset)}`);
            } else if (typeof val === 'object' && val !== null) {
              if (!val.hasOwnProperty(subset)) throw new Error(`expected object to have property ${subset}`);
            } else {
              throw new Error(`cannot run include check on ${typeof val}`);
            }
          }
        }
      };
    }
  };

  // 1. Run Pre-Request Script
  if (requestObj.preScript) {
    try {
      const sandbox = vm.createContext({
        pm,
        tp: pm,
        console: {
          log: (...args) => {
            scriptLog.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
          }
        }
      });
      vm.runInContext(requestObj.preScript, sandbox, { timeout: 1500 });
    } catch (err) {
      scriptLog.push(`[Pre-Script Error] ${err.message}`);
    }
  }

  // 2. Interpolate URL and parameters
  const interpolatedUrl = interpolate(requestObj.url, activeEnvVars);

  // Headers
  const requestHeaders = {};
  if (requestObj.headers && Array.isArray(requestObj.headers)) {
    requestObj.headers.forEach(h => {
      if (h.enabled && h.key) {
        requestHeaders[interpolate(h.key, activeEnvVars)] = interpolate(h.value, activeEnvVars);
      }
    });
  }

  // Auth header mapping
  if (requestObj.auth && requestObj.auth.type !== 'none') {
    const type = requestObj.auth.type;
    if (type === 'bearer') {
      const token = interpolate(requestObj.auth.token, activeEnvVars);
      requestHeaders['Authorization'] = `Bearer ${token}`;
    } else if (type === 'basic') {
      const user = interpolate(requestObj.auth.username, activeEnvVars);
      const pass = interpolate(requestObj.auth.password, activeEnvVars);
      const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
      requestHeaders['Authorization'] = `Basic ${credentials}`;
    } else if (type === 'apikey') {
      const key = interpolate(requestObj.auth.key, activeEnvVars);
      const headerName = interpolate(requestObj.auth.headerName, activeEnvVars) || 'X-API-Key';
      requestHeaders[headerName] = key;
    }
  }

  // Body
  let bodyData = null;
  if (requestObj.body && requestObj.body.type !== 'none') {
    const type = requestObj.body.type;
    
    // Check if Content-Type is already defined in headers
    const hasContentType = Object.keys(requestHeaders).some(
      h => h.toLowerCase() === 'content-type'
    );

    if (type === 'json') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    } else if (type === 'graphql') {
      const query = interpolate(requestObj.body.query || '', activeEnvVars);
      let variables = {};
      try {
        const interpolatedVars = interpolate(requestObj.body.variables || '{}', activeEnvVars);
        variables = JSON.parse(interpolatedVars);
      } catch (e) {
        scriptLog.push(`[GraphQL Variables Error] Failed to parse JSON variables: ${e.message}`);
      }
      bodyData = JSON.stringify({ query, variables });
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    } else if (type === 'text') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'text/plain';
      }
    } else if (type === 'xml') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'application/xml';
      }
    } else if (type === 'html') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'text/html';
      }
    } else if (type === 'javascript') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'application/javascript';
      }
    } else if (type === 'raw') {
      bodyData = interpolate(requestObj.body.content, activeEnvVars);
      if (!hasContentType) {
        const subType = requestObj.body.subType || 'json';
        if (subType === 'json') {
          requestHeaders['Content-Type'] = 'application/json';
        } else if (subType === 'text') {
          requestHeaders['Content-Type'] = 'text/plain';
        } else if (subType === 'xml') {
          requestHeaders['Content-Type'] = 'application/xml';
        } else if (subType === 'html') {
          requestHeaders['Content-Type'] = 'text/html';
        } else if (subType === 'javascript') {
          requestHeaders['Content-Type'] = 'application/javascript';
        } else {
          requestHeaders['Content-Type'] = 'text/plain';
        }
      }
    } else if (type === 'urlencoded') {
      const params = new URLSearchParams();
      if (requestObj.body.formData && Array.isArray(requestObj.body.formData)) {
        requestObj.body.formData.forEach(f => {
          if (f.enabled && f.key) {
            params.append(interpolate(f.key, activeEnvVars), interpolate(f.value, activeEnvVars));
          }
        });
      }
      bodyData = params.toString();
      if (!hasContentType) {
        requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (type === 'form') {
      // Multipart form data using native Node/Electron FormData class
      const formData = new FormData();
      if (requestObj.body.formData && Array.isArray(requestObj.body.formData)) {
        requestObj.body.formData.forEach(f => {
          if (f.enabled && f.key) {
            formData.append(interpolate(f.key, activeEnvVars), interpolate(f.value, activeEnvVars));
          }
        });
      }
      bodyData = formData;
      // Do not manually set Content-Type header so Axios can automatically generate boundary
    }
  }

  // 3. Send Request
  let response = null;
  let duration = 0;
  const start = process.hrtime();
  try {
    const proxyAxios = aiGetSettings().useSystemProxy ? await resolveSystemProxy(interpolatedUrl) : {};
    response = await axios({
      method: requestObj.method || 'GET',
      url: interpolatedUrl,
      headers: requestHeaders,
      data: bodyData,
      responseType: 'arraybuffer', // always fetch as buffer to prevent corruption of images/binary
      validateStatus: () => true, // Accept all response status codes
      timeout: 15000, // 15s timeout
      ...proxyAxios // route through the OS system proxy when enabled
    });
    const diff = process.hrtime(start);
    duration = Math.round((diff[0] * 1000) + (diff[1] / 1000000));
  } catch (err) {
    const diff = process.hrtime(start);
    duration = Math.round((diff[0] * 1000) + (diff[1] / 1000000));
    return {
      status: 0,
      statusText: 'Error',
      headers: {},
      body: '',
      size: 0,
      duration,
      scriptLog,
      tests,
      updatedEnvVars: activeEnvVars,
      error: err.message
    };
  }

  // Parse response body based on content-type
  const contentType = (response.headers && response.headers['content-type']) || '';
  const isImage = contentType.toLowerCase().startsWith('image/');
  
  let isBinary = false;
  let responseBody = '';
  
  if (response.data) {
    if (isImage) {
      responseBody = Buffer.from(response.data).toString('base64');
      isBinary = true;
    } else {
      responseBody = Buffer.from(response.data).toString('utf8');
    }
  }

  // 4. Run Post-Request Script
  if (requestObj.postScript) {
    pm.response = {
      code: response.status,
      body: responseBody,
      json: () => {
        try {
          return JSON.parse(responseBody);
        } catch (e) {
          return null;
        }
      }
    };

    try {
      const sandbox = vm.createContext({
        pm,
        tp: pm,
        console: {
          log: (...args) => {
            scriptLog.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
          }
        }
      });
      vm.runInContext(requestObj.postScript, sandbox, { timeout: 1500 });
    } catch (err) {
      scriptLog.push(`[Post-Script Error] ${err.message}`);
    }
  }

  // Save to History
  if (currentWorkspace) {
    const historyPath = pathModule.join(currentWorkspace, '.teamapi', 'history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch (e) {}
    }
    const historyItem = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      request: {
        name: requestObj.name,
        method: requestObj.method,
        url: interpolatedUrl
      },
      response: {
        status: response.status,
        duration
      }
    };
    history.unshift(historyItem);
    if (history.length > 100) history = history.slice(0, 100);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: responseBody,
    isBinary: isBinary,
    contentType: contentType,
    size: response.data ? response.data.length : 0,
    duration,
    scriptLog,
    tests,
    updatedEnvVars: activeEnvVars
  };
});

// ---------------------------------------------------------------------------
// AI Chat — providers, global settings (userData), workspace chats, streaming
// ---------------------------------------------------------------------------

// Active streaming requests: requestId -> AbortController (for ai:chat:stop).
const aiActiveRequests = new Map();

function aiSettingsPath() {
  return pathModule.join(app.getPath('userData'), 'ai-settings.json');
}
function aiGetSettings() {
  try {
    if (fs.existsSync(aiSettingsPath())) return JSON.parse(fs.readFileSync(aiSettingsPath(), 'utf8'));
  } catch (e) {}
  return { providers: {}, activeProvider: 'openai-compatible' };
}
function aiSaveSettings(s) {
  try { fs.writeFileSync(aiSettingsPath(), JSON.stringify(s, null, 2), 'utf8'); } catch (e) {}
  return s;
}
function aiChatsDir() {
  return currentWorkspace ? pathModule.join(currentWorkspace, '.teamapi', 'chats') : null;
}

// Static provider catalog (no secrets). Returned as an array for the renderer.
ipcMain.handle('ai:providers:list', async () => Object.values(PROVIDERS));

ipcMain.handle('ai:settings:get', async () => aiGetSettings());
ipcMain.handle('ai:settings:save', async (event, s) => aiSaveSettings(s || {}));

// Recolor the native title-bar overlay (Windows/Linux only) to match the chosen
// theme. macOS uses traffic lights on the left and is unaffected.
ipcMain.handle('theme:set', async (event, theme) => {
  if (process.platform === 'darwin' || !mainWindow) return;
  const light = theme === 'light';
  try {
    mainWindow.setTitleBarOverlay({
      color: light ? '#ffffff' : '#0b0e14',
      symbolColor: light ? '#475569' : '#94a3b8'
    });
  } catch (e) {
    /* titleBarOverlay not supported on this platform — ignore */
  }
});

// List models for a provider using the saved baseUrl + apiKey.
ipcMain.handle('ai:models:list', async (event, provider) => {
  const settings = aiGetSettings();
  const ps = (settings.providers && settings.providers[provider]) || {};
  const def = PROVIDERS[provider] || {};
  const baseUrl = ps.baseUrl || def.defaultBaseUrl || '';
  const proxyAxios = settings.useSystemProxy ? await resolveSystemProxy(baseUrl) : {};
  return await listModels(provider, ps.baseUrl, ps.apiKey, !!settings.allowSelfSignedCerts, proxyAxios);
});

// Workspace-scoped chats (mirror collections CRUD pattern).
ipcMain.handle('ai:chats:list', async () => {
  const dir = aiChatsDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(pathModule.join(dir, file), 'utf8'));
      out.push({
        id: c.id,
        title: c.title,
        provider: c.provider,
        model: c.model,
        updatedAt: c.updatedAt,
        messageCount: (c.messages || []).length
      });
    } catch (e) {}
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
});

ipcMain.handle('ai:chats:get', async (event, id) => {
  if (!currentWorkspace) return null;
  const p = pathModule.join(currentWorkspace, '.teamapi', 'chats', `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
});

ipcMain.handle('ai:chats:save', async (event, chat) => {
  if (!currentWorkspace) throw new Error('No workspace selected');
  chat = chat || {};
  if (!chat.id) { chat.id = uuidv4(); chat.createdAt = new Date().toISOString(); }
  chat.updatedAt = new Date().toISOString();
  const dir = pathModule.join(currentWorkspace, '.teamapi', 'chats');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pathModule.join(dir, `${chat.id}.json`), JSON.stringify(chat, null, 2), 'utf8');
  return chat;
});

// Stream a completion. Deltas flow via ai:stream:{chunk|done|error} events; the
// invoke resolves with { ok, fullText } when the stream ends.
ipcMain.handle('ai:chat', async (event, args) => {
  const { requestId, provider, model, messages, system, temperature, maxTokens } = args || {};
  const settings = aiGetSettings();
  const ps = (settings.providers && settings.providers[provider]) || {};
  const def = PROVIDERS[provider] || {};
  const controller = new AbortController();
  if (requestId) aiActiveRequests.set(requestId, controller);

  try {
    const aiBaseUrl = ps.baseUrl || def.defaultBaseUrl || '';
    const proxyAxios = settings.useSystemProxy ? await resolveSystemProxy(aiBaseUrl) : {};
    const fullText = await streamChat({
      provider, baseUrl: aiBaseUrl, apiKey: ps.apiKey, model, messages, system, temperature, maxTokens,
      allowSelfSigned: !!settings.allowSelfSignedCerts,
      proxyAxios
    }, (text) => {
      if (mainWindow && requestId) mainWindow.webContents.send('ai:stream:chunk', { requestId, text });
    }, controller.signal);

    if (mainWindow && requestId) mainWindow.webContents.send('ai:stream:done', { requestId, fullText });
    return { ok: true, fullText };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    if (mainWindow && requestId) mainWindow.webContents.send('ai:stream:error', { requestId, error: msg });
    return { ok: false, error: msg };
  } finally {
    if (requestId) aiActiveRequests.delete(requestId);
  }
});

ipcMain.handle('ai:chat:stop', async (event, requestId) => {
  const c = requestId && aiActiveRequests.get(requestId);
  if (c) { try { c.abort(); } catch (e) {} }
  if (requestId) aiActiveRequests.delete(requestId);
  return true;
});

