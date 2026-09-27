import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { advise } from '../src/engine/advisor.js';
import { buildPayload } from '../src/cli.js';
import { makeState, cards } from './helpers.js';
import { cardFromSave } from '../src/engine/cards.js';

/** Load public/index.html's inline script with a minimal DOM stub and return { render, els }. */
async function loadPage() {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nconnect\(\);\s*$/, '\n');
  const els = {};
  const el = (id) => (els[id] ??= { id, innerHTML: '', textContent: '', hidden: false, className: '', querySelectorAll: () => [] });
  const ctx = {
    document: { getElementById: el },
    EventSource: class { addEventListener() {} },
    location: { reloads: 0, reload() { this.reloads++; } },
    setTimeout, performance, console,
  };
  vm.createContext(ctx);
  vm.runInContext(script + '\nglobalThis.__render = render;', ctx);
  return { render: ctx.__render, els, location: ctx.location };
}

const ids = new Set(['status', 'error', 'levels', 'rec', 'alts', 'altsBody', 'deck', 'deckCount', 'deckBody', 'notes', 'notesBody']);

test('every element id the script touches exists in the markup', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  const { els } = await loadPage();
  for (const id of Object.keys(els)) assert.ok(ids.has(id), `script uses unknown element #${id}`);
});

test('renders shop, pending, final and out-of-reach states without throwing', async () => {
  const { render, els } = await loadPage();

  const shop = makeState({ phase: 'shop', deck: cards('S_2 S_2 H_A') });
  shop.handLevels['Flush'] = { ...shop.handLevels['Flush'], level: 3, chips: 65, mult: 8 };
  shop.deck.push(cardFromSave({ sort_id: 9, base: { id: 5, suit: 'Clubs', nominal: 5 }, ability: { effect: 'Stone Card', bonus: 50 } }, 'x'));
  render(buildPayload(shop, null, { savePath: 'x' }));
  assert.match(els.rec.innerHTML, /In the shop/);
  assert.match(els.status.innerHTML, /updated/);
  assert.equal(els.alts.hidden, true);
  assert.match(els.deckBody.innerHTML, /×2/);           // duplicate badge
  assert.match(els.deckBody.innerHTML, /mini gone/);    // ghost slot for a missing card
  assert.match(els.levels.innerHTML, /lvl up[^]*Flush[^]*lvl 3 · 65×8/);
  assert.match(els.deckCount.textContent, /stone: 1 in deck/);
  assert.match(els.deckBody.innerHTML, /card stone mini/);

  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3 D_7 C_8 H_A'), deck: cards('S_2 S_5 H_4 C_6'), target: 900, handsLeft: 2, discardsLeft: 1 });
  render(buildPayload(state, advise(state, { lookahead: false }), {}));
  assert.match(els.rec.innerHTML, /checking discards/);
  assert.match(els.status.innerHTML, /lookahead running/);
  assert.match(els.altsBody.innerHTML, /Ranked by exact score/);

  const full = advise(state, { seed: 'p', minSamples: 16, maxSamples: 16 });
  render(buildPayload(state, full, {}));
  assert.match(els.status.innerHTML, /16 samples per option/);
  assert.match(els.altsBody.innerHTML, /chance to clear the blind/);
  assert.match(els.rec.innerHTML, /No simulated line reaches/); // 900 is out of reach for card-only scoring
  assert.match(els.rec.innerHTML, /Jokers are not counted/);

  const win = makeState({ hand: cards('S_9 D_9 H_K'), target: 50 });
  render(buildPayload(win, advise(win), {}));
  assert.match(els.rec.innerHTML, /Clears the blind/);
  assert.doesNotMatch(els.rec.innerHTML, /No simulated line/);
});

test('reloads the page when a different server id shows up', async () => {
  const { render, els, location } = await loadPage();
  const shop = makeState({ phase: 'shop' });
  render(buildPayload(shop, null, { serverId: 'a' }));
  assert.match(els.rec.innerHTML, /In the shop/);
  render(buildPayload(shop, null, { serverId: 'a' }));
  assert.equal(location.reloads, 0);
  els.rec.innerHTML = '';
  render(buildPayload(shop, null, { serverId: 'b' }));
  assert.equal(location.reloads, 1);
  assert.equal(els.rec.innerHTML, ''); // nothing rendered from the payload that triggered the reload
});
