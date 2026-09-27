import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchSave } from '../src/save/watcher.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('emits a snapshot per distinct content, including files created later', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  const file = path.join(dir, 'save.jkr');
  const seen = [];
  const w = watchSave(file, (s) => seen.push(s), { debounceMs: 20, pollMs: 100 });
  try {
    await wait(150);
    assert.equal(seen.length, 0);
    await writeFile(file, 'return {["a"]=1,}');
    await wait(300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].buf.toString(), 'return {["a"]=1,}');
    assert.equal(typeof seen[0].hash, 'string');
    await writeFile(file, 'return {["a"]=1,}'); // same content → no new snapshot
    await wait(300);
    assert.equal(seen.length, 1);
    await writeFile(file, 'return {["a"]=2,}');
    await wait(300);
    assert.equal(seen.length, 2);
  } finally {
    w.close();
  }
});
