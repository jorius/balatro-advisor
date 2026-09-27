import { watch, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Watches savePath and calls onSnapshot({ buf, hash, path }) whenever its content changes.
 * Uses fs.watch on the directory (so a file created later is seen) plus a slow poll as a safety net.
 * Read errors other than "file missing" are reported as onSnapshot({ error, path }).
 */
export function watchSave(savePath, onSnapshot, { debounceMs = 150, pollMs = 2000 } = {}) {
  const dir = path.dirname(savePath);
  const file = path.basename(savePath);
  let timer = null;
  let lastHash = null;
  let closed = false;
  let watcher = null;

  async function check() {
    if (closed) return;
    try {
      const buf = await readFile(savePath);
      if (buf.length === 0) return; // caught mid-truncate; the write that follows triggers another event
      const hash = createHash('sha1').update(buf).digest('hex');
      if (hash === lastHash) return;
      lastHash = hash;
      onSnapshot({ buf, hash, path: savePath });
    } catch (e) {
      if (e.code !== 'ENOENT') onSnapshot({ error: e, path: savePath });
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  }

  function startWatch() {
    if (watcher || !existsSync(dir)) return;
    try {
      watcher = watch(dir, (_event, name) => { if (!name || name === file) schedule(); });
      watcher.on('error', () => { watcher = null; });
    } catch {
      watcher = null;
    }
  }

  startWatch();
  const poll = setInterval(() => { startWatch(); schedule(); }, pollMs);
  schedule();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
