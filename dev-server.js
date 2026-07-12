// Local dev server: serves static files and mounts /api/* the way Vercel does.
// Usage: node dev-server.js   (http://localhost:3210)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3210;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function mockRes(res) {
  return {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.replace('/api/', '').replace(/[^a-z0-9_-]/gi, '');
    const mod = path.join(__dirname, 'api', name + '.js');
    if (fs.existsSync(mod)) {
      try {
        delete require.cache[require.resolve(mod)];
        await require(mod)(req, mockRes(res));
      } catch (e) {
        res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.statusCode = 404; return res.end('{"error":"no such api"}');
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(__dirname, path.normalize(file).replace(/^([\\/])+/, ''));
  if (!fp.startsWith(__dirname) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(`Dryvn IQFX dev server → http://localhost:${PORT}`));
