const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const MAIN_WINDOW_OPTS = {
  width: 1120,
  height: 780,
  minWidth: 860,
  minHeight: 600,
  backgroundColor: '#ffffff',
  title: 'Sailing Books',
  autoHideMenuBar: true,
  // window/taskbar icon (Windows also picks this up from the exe resource)
  icon: path.join(__dirname, 'assets', 'icon.png')
};

function libraryDir() {
  const dir = path.join(app.getPath('userData'), 'Library');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Covers live as files (userData/Covers) — never in localStorage (quota!).
function coversDir() {
  const dir = path.join(app.getPath('userData'), 'Covers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueTarget(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext).replace(/[<>:"/\\|?*]/g, '').slice(0, 80) || 'book';
  let candidate = `${base}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function createWindow() {
  const win = new BrowserWindow({
    ...MAIN_WINDOW_OPTS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  libraryDir();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

ipcMain.handle('get-library-dir', () => libraryDir());

// The phone/web client reads the library through server/server.js, which cannot
// see the renderer's localStorage. So the app mirrors its book list here.
ipcMain.handle('save-library-index', (event, index) => {
  try {
    if (!index || !Array.isArray(index.books)) return false;
    fs.writeFileSync(path.join(app.getPath('userData'), 'library-index.json'),
      JSON.stringify({ version: 1, updatedAt: Date.now(), ...index }, null, 0));
    return true;
  } catch (e) {
    console.warn('save library index failed', e);
    return false;
  }
});

ipcMain.handle('import-files', async (event, filePaths) => {
  const dir = libraryDir();
  const results = [];
  for (const p of filePaths || []) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) continue;
      const fileName = path.basename(p);
      const targetName = uniqueTarget(dir, fileName);
      const targetPath = path.join(dir, targetName);
      fs.copyFileSync(p, targetPath);
      results.push({ originalPath: p, storedPath: targetPath, fileName: targetName, size: stat.size });
    } catch (e) {
      results.push({ originalPath: p, error: String(e && e.message || e) });
    }
  }
  return results;
});

ipcMain.handle('pick-files', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import books',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Books', extensions: ['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'] },
      { name: 'EPUB', extensions: ['epub'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Audio', extensions: ['mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('read-file-buffer', async (event, storedPath) => {
  // Only allow reads inside library dir (or any absolute path the library points to)
  const data = fs.readFileSync(storedPath);
  return data.toString('base64');
});

ipcMain.handle('delete-file', async (event, storedPath) => {
  try {
    if (storedPath && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('file-exists', async (event, storedPath) => {
  try { return storedPath && fs.existsSync(storedPath); } catch { return false; }
});

ipcMain.handle('save-cover', async (event, { bookId, dataUrl }) => {
  try {
    const m = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(dataUrl || '');
    if (!m || !bookId) return null;
    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : m[1].includes('gif') ? 'gif' : 'jpg';
    const safeId = String(bookId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'cover';
    const target = path.join(coversDir(), `${safeId}.${ext}`);
    fs.writeFileSync(target, Buffer.from(m[2], 'base64'));
    return target;
  } catch {
    return null;
  }
});

// Audiobook metadata: embedded chapters + cover art + duration.
// Runs in main (Node fs) so huge files stream instead of loading into RAM.
ipcMain.handle('get-audio-meta', async (event, storedPath) => {
  try {
    if (!storedPath || !fs.existsSync(storedPath)) return null;
    const mm = require('music-metadata');
    const meta = await mm.parseFile(storedPath, { duration: true, includeChapters: true });
    let size = 0;
    try { size = fs.statSync(storedPath).size; } catch {}
    const chapters = Array.isArray(meta.format.chapters)
      ? meta.format.chapters
          .filter(c => c && isFinite(c.start))
          .map(c => ({ title: String(c.title || '').slice(0, 120), start: +c.start, end: isFinite(c.end) ? +c.end : null }))
      : [];
    let cover = null;
    const pic = meta.common.picture && meta.common.picture[0];
    if (pic && pic.data && pic.data.length > 512 && pic.data.length < 8 * 1024 * 1024) {
      const mime = pic.format && pic.format.includes('/') ? pic.format : 'image/jpeg';
      cover = `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`;
    }
    return {
      duration: isFinite(meta.format.duration) ? +meta.format.duration : null,
      chapters, cover,
      size,                      // so callers can skip multi-GB files when sweeping
      title: meta.common.title || null,
      artist: meta.common.artist || null,
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

const LIB_EXTS = ['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac'];

// Lists supported book files already sitting in the library folder.
// Lets the app auto-adopt files copied there from elsewhere (e.g. Thorium).
ipcMain.handle('list-library-files', async () => {
  const dir = libraryDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      const ext = path.extname(name).slice(1).toLowerCase();
      if (LIB_EXTS.includes(ext)) out.push({ fileName: name, storedPath: p });
    } catch {}
  }
  return out;
});
