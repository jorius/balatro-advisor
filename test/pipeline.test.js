import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeLuaFile } from '../src/save/reader.js';
import { parseLuaTable } from '../src/save/lua-table.js';
import { extractState } from '../src/state/extract.js';
import { advise } from '../src/engine/advisor.js';
import { buildPayload } from '../src/cli.js';

const fixture = new URL('./fixtures/save-shop.jkr', import.meta.url);

/** Turn the real shop save into a selecting-hand save: deal 8 cards from the deck, set a blind. */
async function selectingSave() {
  const raw = parseLuaTable(decodeLuaFile(await readFile(fixture)));
  raw.STATE = 1;
  raw.cardAreas.hand.cards = raw.cardAreas.deck.cards.slice(0, 8);
  raw.cardAreas.deck.cards = raw.cardAreas.deck.cards.slice(8);
  raw.BLIND = { ...raw.BLIND, name: 'Small Blind', config_blind: 'bl_small', chips: 300 };
  raw.GAME.chips = 0;
  return raw;
}

test('real-format cards flow from save to advice to page payload', async () => {
  const state = extractState(await selectingSave());
  assert.equal(state.phase, 'selecting');
  assert.equal(state.hand.length, 8);
  assert.equal(state.deck.length, 44);
  assert.equal(state.target, 300);
  const advice = advise(state, { seed: 'pipeline', budgetMs: 300 });
  assert.ok(advice.action === 'play' || advice.action === 'discard', advice.reason);
  const handIds = new Set(state.hand.map((c) => c.id));
  for (const c of advice.cards) assert.ok(handIds.has(c.id), `${c.label} not in hand`);
  assert.ok(advice.topPlays.length > 0);
  const payload = buildPayload(state, advice, { savePath: 'fixture' });
  assert.equal(payload.advice.action, advice.action);
  assert.equal(payload.hand.length, 8);
  assert.equal(Object.values(payload.deckCounts).reduce((a, b) => a + b, 0), 44);
  JSON.stringify(payload); // must be serialisable for SSE
});

test('a boss with an unmodelled effect surfaces a warning through the payload', async () => {
  const raw = await selectingSave();
  raw.BLIND = { ...raw.BLIND, name: 'The Hook', config_blind: 'bl_hook', chips: 300 };
  const state = extractState(raw);
  const payload = buildPayload(state, advise(state, { seed: 'hook', budgetMs: 200 }), {});
  assert.ok(payload.warnings.some((w) => /The Hook/.test(w)));
});
