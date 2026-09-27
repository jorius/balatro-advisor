import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodeLuaFile, readLuaFile, resolvePaths } from '../src/save/reader.js';

test('decodeLuaFile accepts plain and raw-deflate content', () => {
  const plain = 'return {["a"]=1,}';
  assert.equal(decodeLuaFile(Buffer.from(plain)), plain);
  assert.equal(decodeLuaFile(deflateRawSync(Buffer.from(plain))), plain);
});

test('readLuaFile reads a compressed file from disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  const file = path.join(dir, 'save.jkr');
  await writeFile(file, deflateRawSync(Buffer.from('return {["x"]=2,}')));
  assert.equal(await readLuaFile(file), 'return {["x"]=2,}');
});

test('resolvePaths uses the profile from settings.jkr', async () => {
  const appData = await mkdtemp(path.join(tmpdir(), 'adv-'));
  await mkdir(path.join(appData, 'Balatro'), { recursive: true });
  await writeFile(path.join(appData, 'Balatro', 'settings.jkr'), 'return {["profile"]=3,}');
  const { savePath } = await resolvePaths({ appData });
  assert.equal(savePath, path.join(appData, 'Balatro', '3', 'save.jkr'));
});

test('resolvePaths falls back to profile 1 and honours overrides', async () => {
  const appData = await mkdtemp(path.join(tmpdir(), 'adv-'));
  assert.equal((await resolvePaths({ appData })).savePath, path.join(appData, 'Balatro', '1', 'save.jkr'));
  assert.equal((await resolvePaths({ appData, profile: 2 })).savePath, path.join(appData, 'Balatro', '2', 'save.jkr'));
  assert.equal((await resolvePaths({ appData, save: 'C:/x/save.jkr' })).savePath, path.resolve('C:/x/save.jkr'));
});
