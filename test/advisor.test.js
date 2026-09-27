import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/rng.js';
import { enumeratePlays, candidateDiscards, advise } from '../src/engine/advisor.js';
import { blindRules } from '../src/engine/blinds.js';
import { makeState, cards } from './helpers.js';

const labels = (cs) => cs.map(c => c.label).join(' ');

test('rng is deterministic per seed and in [0,1)', () => {
  const a = createRng('abc'), b = createRng('abc'), c = createRng('abd');
  const xs = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], xs);
  assert.notDeepEqual([c(), c(), c()], xs);
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('enumeratePlays ranks every legal subset by score', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3') });
  const plays = enumeratePlays(state.hand, state, blindRules(state));
  assert.equal(plays.length, 31); // 5 + 10 + 10 + 5 + 1
  assert.equal(plays[0].type, 'Pair');
  assert.equal(plays[0].score, 56);
  assert.equal(plays[0].cards.length, 2); // shortest among equal scores first
});

test('candidateDiscards keeps flush draws, pairs and low-card dumps, all unique and 1-5 cards', () => {
  const hand = cards('H_2 H_7 H_9 H_J S_9 C_3 D_4 S_K');
  const state = makeState({ hand });
  const ds = candidateDiscards(hand, enumeratePlays(hand, state, blindRules(state)));
  const keys = ds.map(d => d.map(c => c.id).sort().join(','));
  assert.equal(new Set(keys).size, keys.length);
  for (const d of ds) assert.ok(d.length >= 1 && d.length <= 5);
  // keeps the four hearts → discards the other four
  assert.ok(ds.some(d => labels(d).split(' ').sort().join(' ') === '3♣ 4♦ 9♠ K♠'));
  // keeps the pair of nines
  assert.ok(ds.some(d => !d.some(c => c.rank === 9)));
});

test('immediate win: recommends the best clearing play', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3 D_7 C_8 H_A'), target: 50, chipsScored: 0 });
  const a = advise(state, { seed: 't' });
  assert.equal(a.action, 'play');
  assert.equal(a.clearsBlind, true);
  assert.equal(a.pClear, 1);
  assert.equal(a.handType, 'Pair');
  assert.equal(a.score, 56);
  assert.match(a.reason, /clears/);
  assert.ok(a.topPlays.length > 0);
});

test('prefers discarding to a one-card flush draw over a weak play when hands are scarce', () => {
  // Hand: four hearts + junk. Deck: mostly hearts so the draw almost always completes the flush.
  const hand = cards('H_2 H_7 H_9 H_J S_4 C_3 D_6 S_8');
  const deck = cards('H_3 H_4 H_5 H_6 H_8 H_T H_Q H_K H_A S_2');
  const state = makeState({ hand, deck, target: 250, handsLeft: 1, discardsLeft: 2 });
  const a = advise(state, { seed: 'flush', minSamples: 64, maxSamples: 64 });
  assert.equal(a.action, 'discard');
  assert.ok(!a.cards.some(c => c.label === '9♥' || c.label === 'J♥'));
  assert.ok(a.pClear > 0.5, `pClear was ${a.pClear}`);
});

test('plays when no discards are left and the hand cannot clear', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3'), deck: cards('S_2 S_5'), target: 1000, handsLeft: 2, discardsLeft: 0 });
  const a = advise(state, { seed: 'x', minSamples: 16, maxSamples: 16 });
  assert.equal(a.action, 'play');
  assert.equal(a.clearsBlind, false);
  assert.ok(a.alternatives.every(o => o.action === 'play'));
});

test('respects boss rules: psychic forces 5 cards, eye bans repeats', () => {
  const psychic = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3 D_7'), target: 10, blind: { key: 'bl_psychic', name: 'The Psychic', disabled: false, usedHandTypes: [], lockedHandType: null } });
  assert.equal(advise(psychic, { seed: 'p' }).cards.length, 5);
  const eye = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3'), target: 10, blind: { key: 'bl_eye', name: 'The Eye', disabled: false, usedHandTypes: ['Pair'], lockedHandType: null } });
  assert.notEqual(advise(eye, { seed: 'e' }).handType, 'Pair');
});

test('is deterministic for the same seed and reports timing', () => {
  const state = makeState({ hand: cards('H_2 H_7 H_9 H_J S_4 C_3 D_6 S_8'), deck: cards('H_3 S_5 C_6 D_7 H_8 S_T H_Q C_K D_A S_2 C_4 D_9'), target: 400 });
  const a = advise(state, { seed: 's', minSamples: 16, maxSamples: 16 });
  const b = advise(state, { seed: 's', minSamples: 16, maxSamples: 16 });
  assert.equal(a.action, b.action);
  assert.equal(labels(a.cards), labels(b.cards));
  assert.equal(a.pClear, b.pClear);
  assert.ok(a.elapsedMs >= 0);
  assert.equal(a.samples, 16);
});

test('non-selecting phase or no hands left yields no action', () => {
  assert.equal(advise(makeState({ phase: 'shop' })).action, 'none');
  assert.equal(advise(makeState({ hand: cards('S_2'), handsLeft: 0 })).action, 'none');
});

test('an 8-card hand with 4 discards stays within the budget', () => {
  const hand = cards('H_2 H_7 S_9 H_J S_4 C_3 D_6 S_8');
  const deck = cards('H_3 S_5 C_6 D_7 H_8 S_T H_Q C_K D_A S_2 C_4 D_9 H_5 S_6 C_7 D_8 H_T S_J C_Q D_K H_A S_3 C_5 D_2');
  const state = makeState({ hand, deck, target: 600, handsLeft: 3, discardsLeft: 4 });
  const t0 = performance.now();
  const a = advise(state, { seed: 'b', budgetMs: 500 });
  const took = performance.now() - t0;
  assert.ok(took < 1500, `took ${took}ms`);
  assert.ok(a.samples >= 32);
});
