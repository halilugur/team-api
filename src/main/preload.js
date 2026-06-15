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
    list: () => ipcRenderer.invoke('history:list')
  },
  request: {
    execute: (args) => ipcRenderer.invoke('request:execute', args)
  }
});
