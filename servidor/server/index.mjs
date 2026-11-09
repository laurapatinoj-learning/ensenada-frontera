// Ensenada Frontera server: serves the built game (dist/) and the multiplayer WebSocket at /ws.
// Usage: node server/index.mjs [port]      (default 8080; PORT env also works)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Hub } from './rooms.mjs';

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DIST = path.resolve(new URL('../dist/', import.meta.url).pathname);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.resolve(path.join(DIST, p));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(fs.existsSync(DIST) ? 'No encontrado' : 'Falta la carpeta dist/. Ejecuta primero: pnpm build');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const hub = new Hub();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const client = { id: randomUUID().slice(0, 8), room: null, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
  let last = Date.now();
  ws.on('pong', () => (last = Date.now()));
  ws.on('message', (data) => {
    last = Date.now();
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    hub.handle(client, msg);
  });
  ws.on('close', () => hub.disconnect(client));
  ws.on('error', () => {});
  const beat = setInterval(() => {
    if (Date.now() - last > 45000) return ws.terminate();
    if (ws.readyState === 1) ws.ping();
  }, 15000);
  ws.on('close', () => clearInterval(beat));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ensenada Frontera → http://localhost:${PORT}   (WebSocket en /ws)`);
  console.log('Para la clase: abre la dirección de esta máquina en la red local (http://<IP>:' + PORT + ') o despliega esta carpeta en un servicio con Node.');
});
