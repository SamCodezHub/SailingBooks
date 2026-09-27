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
  // ---- Archives: the same shelf of books the web client sees ----
  archiveList: () => ipcRenderer.invoke('archive-list'),
  // On the desktop the file already has a path, so main copies it straight over
  archiveUpload: (file) => {
    const p = (file && file.path) || (webUtils && webUtils.getPathForFile && webUtils.getPathForFile(file));
    if (!p) return Promise.reject(new Error('Could not read that file'));
    return ipcRenderer.invoke('archive-upload-path', p);
  },
  archiveExport: (bookId) => ipcRenderer.invoke('archive-export', bookId),
  archiveDeleteItem: (id) => ipcRenderer.invoke('archive-delete', id),
  // Sync on purpose: the renderer needs the URL to build the <a download>
  archiveDownloadUrl: (id) => ipcRenderer.invokeSync('archive-download-url', id),
  fileUrl: (p) => {
    if (!p) return '';
    let norm = String(p).replace(/\\/g, '/');
    if (!norm.startsWith('/')) norm = '/' + norm;
    // encode each segment to keep spaces/unicode working
    const encoded = norm.split('/').map(s => encodeURIComponent(s)).join('/');
    return 'file://' + encoded.replace(/%3A/g, ':');
  }
});
