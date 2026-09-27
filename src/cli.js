#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolvePaths, decodeLuaFile } from './save/reader.js';
import { parseLuaTable } from './save/lua-table.js';
import { watchSave } from './save/watcher.js';
import { extractState } from './state/extract.js';
import { advise } from './engine/advisor.js';
import { createServer } from './server.js';

export function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', profile: null, save: null, budgetMs: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--port') { out.port = Number(v); i++; }
    else if (a === '--host') { out.host = v; i++; }
    else if (a === '--profile') { out.profile = Number(v); i++; }
    else if (a === '--save') { out.save = v; i++; }
    else if (a === '--budget-ms') { out.budgetMs = Number(v); i++; }
  }
  return out;
}

export function serializeCard(c) {
  return {
    id: c.id, label: c.label, rank: c.rank, suit: c.suit, chips: c.chips, debuffed: c.debuffed,
    enhancement: c.enhancement ?? 'None', edition: c.edition ?? 'Base', seal: c.seal ?? 'None', stone: c.stone === true,
  };
}

const countStones = (cards) => cards.reduce((n, c) => n + (c.stone ? 1 : 0), 0);

export function buildPayload(state, advice, extra = {}) {
  const deckCounts = {};
  for (const c of state.deck) {
    if (c.stone) continue;
    const k = `${c.suit}:${c.rank}`;
    deckCounts[k] = (deckCounts[k] || 0) + 1;
  }
  const handLevels = Object.fromEntries(Object.entries(state.handLevels ?? {}).map(([name, h]) => [name, { level: h.level, chips: h.chips, mult: h.mult }]));
  const stones = { hand: countStones(state.hand), deck: countStones(state.deck) };
  const opt = (o) => ({ action: o.action, cards: o.cards.map(serializeCard), handType: o.handType, score: o.score, pClear: o.pClear, expChips: o.expChips, samples: o.samples });
  return {
    updatedAt: new Date().toISOString(),
    phase: state.phase,
    ante: state.ante, round: state.round, blindOnDeck: state.blindOnDeck,
    blind: { name: state.blind.name, key: state.blind.key, target: state.target },
    chipsScored: state.chipsScored, handsLeft: state.handsLeft, discardsLeft: state.discardsLeft,
    hand: state.hand.map(serializeCard),
    deckCount: state.deck.length, deckCounts, stones, handLevels,
    jokers: state.jokers,
    warnings: advice?.warnings ?? [],
    advice: advice ? {
      action: advice.action, cards: advice.cards.map(serializeCard), handType: advice.handType, score: advice.score,
      clearsBlind: advice.clearsBlind, remaining: advice.remaining, pClear: advice.pClear, expChips: advice.expChips,
      reason: advice.reason, alternatives: advice.alternatives.map(opt),
      topPlays: advice.topPlays.map((p) => ({ cards: p.cards.map(serializeCard), handType: p.handType, score: p.score })),
      samples: advice.samples, elapsedMs: advice.elapsedMs, pending: advice.pending === true,
    } : null,
    error: null,
    ...extra,
  };
}

async function parseWithRetry(savePath, firstBuf, attempts = 5, delayMs = 100) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try {
      const buf = i === 0 && firstBuf ? firstBuf : await readFile(savePath);
      return parseLuaTable(decodeLuaFile(buf));
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw err;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { savePath } = await resolvePaths({ profile: args.profile, save: args.save });
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const server = createServer({ port: args.port, host: args.host, publicDir });
  const addr = await server.ready;
  console.log(`Balatro Advisor  →  http://${args.host}:${addr.port}`);
  console.log(`watching ${savePath}`);

  let lastPayload = { updatedAt: new Date().toISOString(), phase: 'waiting', savePath, warnings: [], advice: null, error: null };
  server.broadcast(lastPayload);
  let latestSeq = 0;
  const stamp = () => new Date().toLocaleTimeString();
  const describe = (advice) => `${advice.action.toUpperCase()} ${advice.cards.map((c) => c.label).join(' ')}  —  ${advice.reason}`;

  watchSave(savePath, async (snap) => {
    if (snap.error) {
      server.broadcast({ ...lastPayload, error: String(snap.error.message || snap.error) });
      return;
    }
    const seq = ++latestSeq;
    try {
      const raw = await parseWithRetry(savePath, snap.buf);
      const state = extractState(raw);
      if (state.phase !== 'selecting') {
        lastPayload = buildPayload(state, null, { savePath });
        server.broadcast(lastPayload);
        console.log(`[${stamp()}] ${state.phase}`);
        return;
      }
      // Phase 1: instant exact ranking so the page updates the moment the save lands.
      const quick = advise(state, { lookahead: false, seed: snap.hash });
      lastPayload = buildPayload(state, quick, { savePath });
      server.broadcast(lastPayload);
      console.log(`[${stamp()}] ${describe(quick)}`);
      // Let the SSE write flush before the CPU-heavy lookahead, and skip it if a newer save arrived.
      await new Promise((r) => setImmediate(r));
      if (seq !== latestSeq) return;
      const full = advise(state, { budgetMs: args.budgetMs, seed: snap.hash });
      if (seq !== latestSeq) return;
      lastPayload = buildPayload(state, full, { savePath });
      server.broadcast(lastPayload);
      console.log(`[${stamp()}] ${describe(full)}  (${full.samples} samples, ${Math.round(full.elapsedMs)} ms)`);
    } catch (e) {
      console.error('snapshot failed:', e.message);
      server.broadcast({ ...lastPayload, error: e.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
