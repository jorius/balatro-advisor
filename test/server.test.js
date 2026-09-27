import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';

function sseOnce(port, pathname, skip = 0) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const all = [...buf.matchAll(/event: state\ndata: (.*)\n\n/g)];
        if (all.length > skip) { req.destroy(); resolve(JSON.parse(all[skip][1])); }
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

function getText(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

test('serves the page, the latest state and an SSE stream', async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  await writeFile(path.join(publicDir, 'index.html'), '<title>x</title>');
  const srv = createServer({ port: 0, host: '127.0.0.1', publicDir });
  const { port } = await srv.ready;
  try {
    assert.equal((await getText(port, '/')).body, '<title>x</title>');
    assert.equal((await getText(port, '/nope')).status, 404);
    srv.broadcast({ phase: 'shop' });
    assert.deepEqual(JSON.parse((await getText(port, '/state.json')).body), { phase: 'shop' });
    assert.deepEqual(await sseOnce(port, '/events'), { phase: 'shop' });
    const next = sseOnce(port, '/events', 1); // skip the replayed latest state
    await new Promise((r) => setTimeout(r, 50));
    srv.broadcast({ phase: 'selecting' });
    assert.deepEqual(await next, { phase: 'selecting' });
  } finally {
    await srv.close();
  }
});
