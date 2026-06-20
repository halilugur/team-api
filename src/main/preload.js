const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamapi', {
  workspace: {
    openDialog: () => ipcRenderer.invoke('workspace:openDialog'),
    openPath: (path) => ipcRenderer.invoke('workspace:openPath', path),
    createDialog: (name) => ipcRenderer.invoke('workspace:createDialog', name),
    getMeta: () => ipcRenderer.invoke('workspace:getMeta'),
    onOpenRequest: (callback) => {
      const listener = (event) => callback();
      ipcRenderer.on('workspace:onOpenRequest', listener);
      return () => ipcRenderer.removeListener('workspace:onOpenRequest', listener);
    },
    onNewRequest: (callback) => {
      const listener = (event) => callback();
      ipcRenderer.on('workspace:onNewRequest', listener);
      return () => ipcRenderer.removeListener('workspace:onNewRequest', listener);
    },
    onGoToHome: (callback) => {
      const listener = (event) => callback();
      ipcRenderer.on('workspace:onGoToHome', listener);
      return () => ipcRenderer.removeListener('workspace:onGoToHome', listener);
    },
    onWorkspaceChanged: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('workspace:changed', listener);
      return () => ipcRenderer.removeListener('workspace:changed', listener);
    }
  },
  collections: {
    list: () => ipcRenderer.invoke('collections:list'),
    get: (id) => ipcRenderer.invoke('collections:get', id),
    save: (collectionObj) => ipcRenderer.invoke('collections:save', collectionObj),
    delete: (id) => ipcRenderer.invoke('collections:delete', id)
  },
  environments: {
    list: () => ipcRenderer.invoke('environments:list'),
    save: (envObj) => ipcRenderer.invoke('environments:save', envObj),
    delete: (id) => ipcRenderer.invoke('environments:delete', id)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  request: {
    execute: (args) => ipcRenderer.invoke('request:execute', args)
  },
  // Open additional app windows (TeamFolder file manager).
  windows: {
    openFileManager: () => ipcRenderer.invoke('window:openFileManager')
  },
  // TeamFolder — workspace file/folder management.
  files: {
    getWorkspace: () => ipcRenderer.invoke('files:getWorkspace'),
    listTree: (dirPath) => ipcRenderer.invoke('files:listTree', dirPath),
    create: (args) => ipcRenderer.invoke('files:create', args),
    delete: (args) => ipcRenderer.invoke('files:delete', args),
    rename: (args) => ipcRenderer.invoke('files:rename', args),
    read: (args) => ipcRenderer.invoke('files:read', args),
    write: (args) => ipcRenderer.invoke('files:write', args),
    openExternal: (args) => ipcRenderer.invoke('files:openExternal', args)
  },
  ai: {
    providers: () => ipcRenderer.invoke('ai:providers:list'),
    getSettings: () => ipcRenderer.invoke('ai:settings:get'),
    saveSettings: (s) => ipcRenderer.invoke('ai:settings:save', s),
    listModels: (provider) => ipcRenderer.invoke('ai:models:list', provider),
    chat: (args) => ipcRenderer.invoke('ai:chat', args),
    stop: (requestId) => ipcRenderer.invoke('ai:chat:stop', requestId),
    listChats: () => ipcRenderer.invoke('ai:chats:list'),
    getChat: (id) => ipcRenderer.invoke('ai:chats:get', id),
    saveChat: (chat) => ipcRenderer.invoke('ai:chats:save', chat),
    deleteChat: (id) => ipcRenderer.invoke('ai:chats:delete', id),
    onChunk: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('ai:stream:chunk', listener);
      return () => ipcRenderer.removeListener('ai:stream:chunk', listener);
    },
    onDone: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('ai:stream:done', listener);
      return () => ipcRenderer.removeListener('ai:stream:done', listener);
    },
    onError: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('ai:stream:error', listener);
      return () => ipcRenderer.removeListener('ai:stream:error', listener);
    }
  },
  // OS platform — used by the renderer to reserve space for native window controls.
  platform: process.platform,
  // Theme — lets the renderer ask the main process to recolor the native
  // title-bar overlay (Windows/Linux) so it matches the chosen theme.
  theme: {
    set: (theme) => ipcRenderer.invoke('theme:set', theme)
  },
  // App — userData path + full data reset (clean-reinstall equivalent).
  app: {
    getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
    resetData: () => ipcRenderer.invoke('app:resetData')
  },
  // OAuth 2.0 — shared token list (Client Credentials / Password grants).
  oauth: {
    listTokens: () => ipcRenderer.invoke('oauth:listTokens'),
    saveToken: (token) => ipcRenderer.invoke('oauth:saveToken', token),
    deleteToken: (id) => ipcRenderer.invoke('oauth:deleteToken', id),
    getToken: (config) => ipcRenderer.invoke('oauth:getToken', config),
    refresh: (payload) => ipcRenderer.invoke('oauth:refresh', payload)
  }
});
