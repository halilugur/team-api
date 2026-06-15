const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const pathModule = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const vm = require('vm');

let mainWindow = null;
let currentWorkspace = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: pathModule.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(pathModule.join(__dirname, '../renderer/index.html'));

  // Open DevTools in development if needed, standard behavior
  // mainWindow.webContents.openDevTools();

  // Create Application Menu
  const template = [
    {
      label: 'File',
      submenu: [
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
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Helper: variable interpolator
function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();
    return vars.hasOwnProperty(trimmedKey) ? vars[trimmedKey] : match;
  });
}

// IPC Handlers

// Workspace
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

  // Init git repository
  try {
    const git = simpleGit(path);
    await git.init();
  } catch (err) {
    console.error('Failed to init git:', err);
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
        const isConflicted = content.includes('<<<<<<<') || content.includes('=======') || content.includes('>>>>>>>');
        if (isConflicted) {
          let id = file.replace('.json', '');
          let name = `⚠️ (Git Conflict) - ${file}`;
          try {
            const nameMatch = content.match(/"name":\s*"([^"]+)"/);
            if (nameMatch) name = nameMatch[1];
          } catch (e) {}
          list.push({
            id: id,
            name: name,
            isConflicted: true,
            requestCount: 0
          });
        } else {
          const col = JSON.parse(content);
          list.push({
            id: col.id,
            name: col.name,
            isConflicted: false,
            requestCount: col.requests ? col.requests.length : 0
          });
        }
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
      const isConflicted = content.includes('<<<<<<<') || content.includes('=======') || content.includes('>>>>>>>');
      if (isConflicted) {
        return {
          id: id,
          isConflicted: true,
          name: `⚠️ (Git Conflict) - ${id}.json`,
          filePath: filePath,
          rawContent: content
        };
      }
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
    response = await axios({
      method: requestObj.method || 'GET',
      url: interpolatedUrl,
      headers: requestHeaders,
      data: bodyData,
      transformResponse: [(data) => data], // Get raw string
      validateStatus: () => true, // Accept all response status codes
      timeout: 15000 // 15s timeout
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

  // 4. Run Post-Request Script
  if (requestObj.postScript) {
    pm.response = {
      code: response.status,
      body: response.data,
      json: () => {
        try {
          return JSON.parse(response.data);
        } catch (e) {
          return null;
        }
      }
    };

    try {
      const sandbox = vm.createContext({
        pm,
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
    body: response.data,
    size: response.data ? Buffer.byteLength(response.data, 'utf8') : 0,
    duration,
    scriptLog,
    tests,
    updatedEnvVars: activeEnvVars
  };
});

