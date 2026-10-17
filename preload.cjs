const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browser', Object.freeze({
  getState: () => ipcRenderer.invoke('orbit:state'),
  suggest: query => ipcRenderer.invoke('orbit:suggest',query),
  action: (name, payload = {}) => ipcRenderer.invoke('orbit:action', name, payload),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('orbit:state-changed', listener);
    return () => ipcRenderer.removeListener('orbit:state-changed', listener);
  },
  onCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('orbit:command', listener);
    return () => ipcRenderer.removeListener('orbit:command', listener);
  }
}));
