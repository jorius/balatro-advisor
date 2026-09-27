import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function createServer({ port = 8787, host = '127.0.0.1', publicDir } = {}) {
  const clients = new Set();
  let latest = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      res.write(':ok\n\n');
      if (latest) res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/state.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(latest));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const html = await readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('public/index.html missing');
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const heartbeat = setInterval(() => { for (const c of clients) c.write(':hb\n\n'); }, 15000);
  heartbeat.unref();

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });

  return {
    server,
    ready,
    broadcast(payload, event = 'state') {
      if (event === 'state') latest = payload;
      const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const c of clients) c.write(msg);
    },
    close() {
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      clients.clear();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
