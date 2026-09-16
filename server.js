// Local work-tracker server. No dependencies, plain Node.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3210;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'docs');

const DEFAULT_DATA = {
  settings: { hourlyRate: 5.25, unitPrice: 0, usdUah: 41.5, watcherPath: '', minutesPerHour: 65 },
  games: [],
  videos: [],
  units: [],
  tables: []
};

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return DEFAULT_DATA;
  }
}

function saveData(obj) {
  // Keep one backup of the previous state, just in case.
  if (fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const steamNameCache = {};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/steamname') {
    const appid = new URLSearchParams(req.url.split('?')[1] || '').get('appid');
    if (!appid) return send(res, 400, '{"name":""}');
    if (steamNameCache[appid]) return send(res, 200, JSON.stringify({ name: steamNameCache[appid] }));
    try {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`);
      const j = await r.json();
      const name = j[appid] && j[appid].success ? j[appid].data.name : '';
      if (name) steamNameCache[appid] = name;
      return send(res, 200, JSON.stringify({ name }));
    } catch (e) {
      return send(res, 200, '{"name":""}');
    }
  }

  if (req.method === 'GET' && url === '/api/data') {
    return send(res, 200, JSON.stringify(loadData()));
  }

  if (req.method === 'POST' && url === '/api/data') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const obj = JSON.parse(body);
        saveData(obj);
        send(res, 200, '{"ok":true}');
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/watcher') {
    const p = (loadData().settings.watcherPath || '').trim();
    if (!p) return send(res, 400, '{"ok":false,"error":"no path"}');
    if (!fs.existsSync(p)) return send(res, 400, '{"ok":false,"error":"not found"}');
    // "start" handles .exe, .lnk, anything Windows can open.
    exec(`start "" "${p}"`, { windowsHide: true });
    return send(res, 200, '{"ok":true}');
  }

  // Static files.
  let file = url === '/' ? '/index.html' : url;
  file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'no');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    send(res, 200, buf, types[ext] || 'application/octet-stream');
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Already running — just open the page and exit.
    exec(`start "" "http://localhost:${PORT}"`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`Сайт працює: http://localhost:${PORT}`);
  exec(`start "" "http://localhost:${PORT}"`);
});
