const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLibraryDir: () => ipcRenderer.invoke('get-library-dir'),
  // Mirror of the library for the web/phone client served by server/server.js
  saveLibraryIndex: (index) => ipcRenderer.invoke('save-library-index', index),
  // Lets the app pick up folders/placements written by the Archives installer
  getLibraryIndex: () => ipcRenderer.invoke('get-library-index'),
  importFiles: (paths) => ipcRenderer.invoke('import-files', paths),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  deleteFile: (p) => ipcRenderer.invoke('delete-file', p),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  listLibraryFiles: () => ipcRenderer.invoke('list-library-files'),
  saveCover: (bookId, dataUrl) => ipcRenderer.invoke('save-cover', { bookId, dataUrl }),
  getAudioMeta: (p) => ipcRenderer.invoke('get-audio-meta', p),
  readFileBase64: (p) => ipcRenderer.invoke('read-file-buffer', p),
  // In Electron, dropped File objects expose .path — this helper normalizes them
  getPathForFile: (file) => {
    try {
      if (file && file.path) return file.path;
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    } catch {}
    return null;
  },
  fileUrl: (p) => {
    if (!p) return '';
    let norm = String(p).replace(/\\/g, '/');
    if (!norm.startsWith('/')) norm = '/' + norm;
    // encode each segment to keep spaces/unicode working
    const encoded = norm.split('/').map(s => encodeURIComponent(s)).join('/');
    return 'file://' + encoded.replace(/%3A/g, ':');
  }
});
