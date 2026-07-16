// Tiny static file server: node serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2]) || 8377;
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  // dev aid: POST a canvas data-URL to /shot and it lands in .shots/ as a jpg
  if (req.method === 'POST' && req.url.startsWith('/shot')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const name = (req.url.split('?name=')[1] || 'shot').replace(/[^\w-]/g, '');
      const b64 = body.split(',')[1] || '';
      fs.mkdirSync(path.join(root, '.shots'), { recursive: true });
      fs.writeFileSync(path.join(root, '.shots', name + '.jpg'), Buffer.from(b64, 'base64'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}`));
