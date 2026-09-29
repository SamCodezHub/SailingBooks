const crypto = require('crypto');

const BUCKET = 'sailing-books';
const QUOTA_BYTES = 1024 * 1024 * 1024;
const EXTENSIONS = new Set(['epub', 'pdf', 'mp3', 'm4a', 'm4b', 'wav', 'ogg', 'opus', 'flac', 'aac']);

function send(res, status, value) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  return res.json(value);
}
function config() {
  return {
    url: String(process.env.SB_SUPABASE_URL || '').replace(/\/$/, ''),
    anonKey: process.env.SB_SUPABASE_ANON_KEY || '',
    serviceKey: process.env.SB_SUPABASE_SERVICE_ROLE_KEY || '',
    adminEmail: String(process.env.SB_ADMIN_EMAIL || '').trim().toLowerCase()
  };
}
function serviceHeaders(c, extra = {}) {
  return { apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}`, 'Content-Type': 'application/json', ...extra };
}
async function sb(c, path, options = {}, service = true) {
  const headers = service ? serviceHeaders(c, options.headers) : { apikey: c.anonKey, ...options.headers };
  const response = await fetch(c.url + path, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data && (data.message || data.error_description || data.error) || `Supabase request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function requireUser(req, c) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) throw Object.assign(new Error('Sign in to continue'), { status: 401 });
  const user = await sb(c, '/auth/v1/user', { headers: { Authorization: `Bearer ${match[1]}` } }, false);
  if (!user || !user.id || !user.email) throw Object.assign(new Error('Sign in to continue'), { status: 401 });
  return { user, accessToken: match[1], isAdmin: !!c.adminEmail && user.email.toLowerCase() === c.adminEmail };
}
function cleanName(value) {
  return String(value || 'book').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'book';
}
function rpcPath(name) { return `/rest/v1/rpc/${name}`; }
function encodePath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }
async function cleanExpiredUploads(c, userId) {
  const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stale = await sb(c, `/rest/v1/cloud_books?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending&created_at=lt.${encodeURIComponent(before)}&select=id,storage_path`);
  if (!stale || !stale.length) return;
  for (const row of stale) {
    try { await sb(c, `/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodePath(row.storage_path)}`, { method: 'DELETE' }); } catch {}
  }
  const ids = stale.map(row => row.id).filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length) await sb(c, `/rest/v1/cloud_books?id=in.(${ids.join(',')})&user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

async function signedUrl(c, storagePath) {
  const data = await sb(c, `/storage/v1/object/sign/${encodeURIComponent(BUCKET)}/${encodePath(storagePath)}`, {
    method: 'POST', body: JSON.stringify({ expiresIn: 3600 })
  });
  const path = data.signedURL || data.signedUrl;
  return path && (path.startsWith('http') ? path : c.url + '/storage/v1' + (path.startsWith('/') ? path : '/' + path));
}
async function getBook(c, id, userId) {
  const rows = await sb(c, `/rest/v1/cloud_books?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*`);
  return rows && rows[0];
}
async function serverAuth(req, c, id) {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  if (!token || token.length > 160) throw Object.assign(new Error('Server is not paired'), { status: 401 });
  const rows = await sb(c, `/rest/v1/cloud_servers?id=eq.${encodeURIComponent(id)}&select=id,user_id,credential_hash`);
  const server = rows && rows[0];
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  if (!server || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(server.credential_hash || ''))) {
    throw Object.assign(new Error('Server is not paired'), { status: 401 });
  }
  return server;
}

module.exports = async function handler(req, res) {
  const c = config();
  if (req.method === 'OPTIONS') {
    res.status(204).setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,apikey');
    return res.end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  const route = Array.isArray(req.query.route) ? req.query.route : String(req.query.route || '').split('/').filter(Boolean);
  if (req.method === 'GET' && route.length === 1 && route[0] === 'config') {
    return send(res, 200, { configured: !!(c.url && c.anonKey && c.serviceKey), url: c.url, anonKey: c.anonKey });
  }
  if (!c.url || !c.anonKey || !c.serviceKey) return send(res, 503, { error: 'Cloud library is not configured yet. Add the Supabase environment settings to the Vercel project.' });

  try {
    if (route[0] === 'servers' && route[1] && route[2] === 'agent') {
      const server = await serverAuth(req, c, route[1]);
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      await sb(c, `/rest/v1/cloud_servers?id=eq.${encodeURIComponent(server.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() })
      });
      if (route[3] === 'complete') {
        const body = req.body || {};
        await sb(c, `/rest/v1/server_jobs?id=eq.${encodeURIComponent(body.jobId)}&server_id=eq.${encodeURIComponent(server.id)}&status=eq.pending`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: body.error ? 'failed' : 'complete', result_message: String(body.error || '').slice(0, 300), completed_at: new Date().toISOString() })
        });
        return send(res, 200, { ok: true });
      }
      if (route[3] !== 'jobs') return send(res, 404, { error: 'Unknown agent route' });
      const jobs = await sb(c, `/rest/v1/server_jobs?server_id=eq.${encodeURIComponent(server.id)}&status=eq.pending&select=id,book_id,user_id&order=created_at.asc&limit=5`);
      const result = [];
      for (const job of jobs || []) {
        const book = await getBook(c, job.book_id, job.user_id);
        if (!book || book.status !== 'ready') continue;
        const url = await signedUrl(c, book.storage_path);
        if (url) result.push({ jobId: job.id, downloadUrl: url, book: { id: book.id, title: book.title || book.file_name, author: book.author || '', fileName: book.file_name, type: book.book_type, sizeBytes: book.size_bytes } });
      }
      return send(res, 200, { jobs: result });
    }

    const { user, isAdmin } = await requireUser(req, c);
    if (route[0] === 'me' && req.method === 'GET') {
      await cleanExpiredUploads(c, user.id);
      const rows = await sb(c, `/rest/v1/cloud_books?user_id=eq.${user.id}&status=in.(pending,ready)&select=size_bytes,status,created_at`);
      const usedBytes = (rows || []).reduce((sum, row) => {
        const active = row.status === 'ready' || (row.status === 'pending' && Date.now() - Date.parse(row.created_at) < 24 * 60 * 60 * 1000);
        return sum + (active ? Number(row.size_bytes || 0) : 0);
      }, 0);
      return send(res, 200, { user: { id: user.id, email: user.email }, isAdmin, quotaBytes: isAdmin ? null : QUOTA_BYTES, usedBytes });
    }
    if (route[0] === 'books' && route.length === 1 && req.method === 'GET') {
      const books = await sb(c, `/rest/v1/cloud_books?user_id=eq.${user.id}&status=eq.ready&select=id,title,author,file_name,book_type,size_bytes,created_at&order=created_at.desc`);
      return send(res, 200, { books: books || [] });
    }
    if (route[0] === 'books' && route[1] === 'reserve' && req.method === 'POST') {
      await cleanExpiredUploads(c, user.id);
      const body = req.body || {};
      const fileName = cleanName(body.fileName);
      const ext = fileName.split('.').pop().toLowerCase();
      const bytes = Number(body.sizeBytes);
      if (!EXTENSIONS.has(ext)) return send(res, 400, { error: 'Choose an EPUB, PDF, or supported audiobook file.' });
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 2 * 1024 * 1024 * 1024) return send(res, 400, { error: 'The selected file size is not supported.' });
      const id = crypto.randomUUID();
      const storagePath = `${user.id}/${id}/${fileName}`;
      const reserved = await sb(c, rpcPath('reserve_online_book_upload'), {
        method: 'POST', body: JSON.stringify({
          p_user_id: user.id, p_book_id: id, p_file_name: fileName,
          p_book_type: ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : 'audio',
          p_size_bytes: bytes, p_storage_path: storagePath,
          p_quota_bytes: isAdmin ? null : QUOTA_BYTES
        })
      });
      return send(res, 201, { book: Array.isArray(reserved) ? reserved[0] : reserved, storagePath, bucket: BUCKET });
    }
    if (route[0] === 'books' && route[1] && route[2] === 'complete' && req.method === 'POST') {
      const id = route[1];
      const book = await getBook(c, id, user.id);
      if (!book) return send(res, 404, { error: 'Upload reservation not found' });
      const completed = await sb(c, rpcPath('complete_online_book_upload'), {
        method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_book_id: id })
      });
      if (!completed) return send(res, 409, { error: 'The uploaded file could not be verified. Please retry the upload.' });
      return send(res, 200, { ok: true });
    }
    if (route[0] === 'books' && route[1] && route[2] === 'download' && req.method === 'GET') {
      const book = await getBook(c, route[1], user.id);
      if (!book || book.status !== 'ready') return send(res, 404, { error: 'Book not found' });
      return send(res, 200, { url: await signedUrl(c, book.storage_path) });
    }
    if (route[0] === 'books' && route[1] && req.method === 'DELETE') {
      const book = await getBook(c, route[1], user.id);
      if (!book) return send(res, 404, { error: 'Book not found' });
      try { await sb(c, `/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodePath(book.storage_path)}`, { method: 'DELETE' }); } catch {}
      await sb(c, `/rest/v1/cloud_books?id=eq.${encodeURIComponent(book.id)}&user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      return send(res, 200, { ok: true });
    }
    if (route[0] === 'servers' && route.length === 1 && req.method === 'GET') {
      const servers = await sb(c, `/rest/v1/cloud_servers?user_id=eq.${user.id}&select=id,name,base_url,last_seen_at,created_at&order=created_at.desc`);
      return send(res, 200, { servers: (servers || []).map(server => ({ ...server, active: !!server.last_seen_at && Date.now() - Date.parse(server.last_seen_at) < 120000 })) });
    }
    if (route[0] === 'servers' && route[1] && route.length === 2 && req.method === 'DELETE') {
      await sb(c, `/rest/v1/cloud_servers?id=eq.${encodeURIComponent(route[1])}&user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      return send(res, 200, { ok: true });
    }
    if (route[0] === 'servers' && route[1] === 'register' && req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 80);
      let parsed;
      try { parsed = new URL(String(body.baseUrl || '').trim()); } catch {}
      if (!name || !parsed || !['http:', 'https:'].includes(parsed.protocol)) return send(res, 400, { error: 'Enter a server name and a valid http or https address.' });
      const token = crypto.randomBytes(32).toString('base64url');
      const digest = crypto.createHash('sha256').update(token).digest('hex');
      const created = await sb(c, '/rest/v1/cloud_servers', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: user.id, name, base_url: parsed.origin, credential_hash: digest })
      });
      const row = created[0] || {};
      return send(res, 201, { server: { id: row.id, name: row.name, base_url: row.base_url, created_at: row.created_at }, pairingToken: token });
    }
    if (route[0] === 'servers' && route[1] && route[2] === 'instances' && req.method === 'POST') {
      const body = req.body || {};
      const servers = await sb(c, `/rest/v1/cloud_servers?id=eq.${encodeURIComponent(route[1])}&user_id=eq.${encodeURIComponent(user.id)}&select=id,last_seen_at`);
      const server = servers && servers[0];
      if (!server || !server.last_seen_at || Date.now() - Date.parse(server.last_seen_at) >= 120000) return send(res, 409, { error: 'This server is offline. Start its Sailing Books server and try again.' });
      const book = await getBook(c, String(body.bookId || ''), user.id);
      if (!book || book.status !== 'ready') return send(res, 404, { error: 'Online book not found' });
      const rows = await sb(c, '/rest/v1/server_jobs', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: user.id, server_id: server.id, book_id: book.id, status: 'pending' })
      });
      return send(res, 201, { job: rows[0] });
    }
    return send(res, 404, { error: 'Unknown cloud library route' });
  } catch (error) {
    console.error('cloud api error', error && error.message);
    return send(res, error.status || 500, { error: error.status ? error.message : 'Cloud library request failed. Check its Supabase setup and try again.' });
  }
};
