import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { parseLuaTable } from './lua-table.js';

/** Balatro stores .jkr files either as plain "return {...}" text or as a raw deflate stream. */
export function decodeLuaFile(buf) {
  if (buf.subarray(0, 6).toString('latin1') === 'return') return buf.toString('latin1');
  return inflateRawSync(buf).toString('latin1');
}

export async function readLuaFile(filePath) {
  return decodeLuaFile(await readFile(filePath));
}

export async function resolvePaths({ appData = process.env.APPDATA, profile = null, save = null } = {}) {
  if (save) return { settingsPath: null, savePath: path.resolve(save) };
  const base = path.join(appData, 'Balatro');
  const settingsPath = path.join(base, 'settings.jkr');
  let prof = profile;
  if (prof == null) {
    try {
      const settings = parseLuaTable(await readLuaFile(settingsPath));
      prof = Number.isInteger(settings?.profile) ? settings.profile : 1;
    } catch {
      prof = 1;
    }
  }
  return { settingsPath, savePath: path.join(base, String(prof), 'save.jkr') };
}
