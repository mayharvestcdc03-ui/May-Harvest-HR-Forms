/**
 * May Harvest Corporation - HR Forms Management System
 * Fullstack Cloud Server Engine with Automatic 2-Way Live Sync (v1.0)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'hr-forms-database.json');

// Ensure directories exist
[DATA_DIR, BACKUPS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getInitialState() {
  return {
    requests: {},
    accounts: {},
    audit: [],
    settings: {},
    lastUpdated: new Date().toISOString()
  };
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      return {
        requests: (data.requests && typeof data.requests === 'object') ? data.requests : {},
        accounts: (data.accounts && typeof data.accounts === 'object') ? data.accounts : {},
        audit: Array.isArray(data.audit) ? data.audit : [],
        settings: (data.settings && typeof data.settings === 'object') ? data.settings : {},
        lastUpdated: data.lastUpdated || new Date().toISOString()
      };
    }
  } catch (err) {
    console.error('[MHC HR Server] Error reading DB:', err.message);
  }
  const init = getInitialState();
  saveDatabase(init);
  return init;
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[MHC HR Server] Error saving DB:', err.message);
    return false;
  }
}

function createBackup(reason = 'auto') {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUPS_DIR, `hr-forms-backup-${reason}-${ts}.json`);
    const db = loadDatabase();
    fs.writeFileSync(backupFile, JSON.stringify(db, null, 2), 'utf8');

    // Keep latest 30 backups
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('hr-forms-backup-'))
      .map(f => path.join(BACKUPS_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    if (files.length > 30) {
      files.slice(30).forEach(f => {
        try { fs.unlinkSync(f); } catch (_) {}
      });
    }
    return backupFile;
  } catch (e) {
    console.error('[MHC HR Server] Backup error:', e.message);
    return null;
  }
}

// Scheduled auto-backup every 6 hours
setInterval(() => {
  createBackup('interval');
}, 6 * 60 * 60 * 1000);

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Health Check
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', serverTime: new Date().toISOString(), system: 'May Harvest HR Forms' }));
    return;
  }

  // API: 2-Way Sync
  if (pathname === '/api/sync') {
    if (req.method === 'GET') {
      const data = loadDatabase();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', data }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const current = loadDatabase();

          // Non-destructive merge
          const merged = {
            requests: Object.assign({}, current.requests, incoming.requests || {}),
            accounts: Object.assign({}, current.accounts, incoming.accounts || {}),
            audit: (incoming.audit && incoming.audit.length >= current.audit.length) ? incoming.audit : current.audit,
            settings: Object.assign({}, current.settings, incoming.settings || {}),
            lastUpdated: new Date().toISOString()
          };

          saveDatabase(merged);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', message: 'Sync successful', lastUpdated: merged.lastUpdated }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
      });
      return;
    }
  }

  // API: Backups list and trigger
  if (pathname === '/api/backup') {
    if (req.method === 'POST') {
      const bFile = createBackup('manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', backup: path.basename(bFile || '') }));
      return;
    }
    if (req.method === 'GET') {
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', backups: files }));
      return;
    }
  }

  // Static File Serving
  let targetFile = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let filePath = path.join(ROOT_DIR, targetFile);

  // Security check: restrict within ROOT_DIR
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`[MHC HR Forms Server] Active and listening on port ${PORT}`);
  console.log(`[MHC HR Forms Server] Ready for Render & Cloudflare Dual Deployment`);
});
