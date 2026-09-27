import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildPayload, reconcileLastHand, makeScorer } from '../src/cli.js';
import { advise } from '../src/engine/advisor.js';
import { makeState, cards } from './helpers.js';

test('parseArgs reads flags with defaults', () => {
  assert.deepEqual(parseArgs([]), { port: 8787, host: '127.0.0.1', profile: null, save: null, budgetMs: 500, cardOnly: false });
  assert.deepEqual(parseArgs(['--port', '9000', '--host', '0.0.0.0', '--profile', '2', '--save', 'x.jkr', '--budget-ms', '250', '--card-only']),
    { port: 9000, host: '0.0.0.0', profile: 2, save: 'x.jkr', budgetMs: 250, cardOnly: true });
});

test('reconcileLastHand compares the predicted score of the cards that left the hand with the chips gained', () => {
  const before = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3'), handsPlayed: 0, round: 2, chipsScored: 100 });
  const scorer = (played) => ({ legal: true, type: 'Pair', score: 56, min: 56, max: 56 });
  const after = makeState({ hand: cards('H_K C_2 S_3 D_7 C_8'), handsPlayed: 1, round: 2, chipsScored: 156 });
  after.hand[0].id = before.hand[2].id; after.hand[1].id = before.hand[3].id; after.hand[2].id = before.hand[4].id;
  const r = reconcileLastHand(before, after, scorer);
  assert.equal(r.actual, 56);
  assert.equal(r.predicted, 56);
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 2);
  // a discard (hands_played unchanged) is not a hand
  assert.equal(reconcileLastHand(before, { ...after, handsPlayed: 0 }, scorer), null);
  // a mismatch is flagged
  assert.equal(reconcileLastHand(before, { ...after, chipsScored: 400 }, scorer).ok, false);
});

test('makeScorer returns a full scorer with warnings for a selecting state, null otherwise', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K'), jokers: [{ key: 'j_hologram', name: 'Hologram', edition: null, ability: { x_mult: 2, extra: 0.25 }, debuffed: false, sellCost: 3 }, { key: 'j_nope', name: 'x', edition: null, ability: {}, debuffed: false, sellCost: 0 }] });
  const s = makeScorer(state);
  assert.equal(s.scorer(state.hand.slice(0, 2)).score, 56 * 2);
  assert.equal(s.warnings.length, 1);
  assert.equal(makeScorer(state, true), null);
  assert.equal(makeScorer(makeState({ phase: 'shop' })), null);
});

test('buildPayload serialises state and advice for the page', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K'), deck: cards('S_2 S_2 H_3'), target: 50, jokers: [{ key: 'j_trio', name: 'Trio' }] });
  const advice = advise(state, { seed: 'p' });
  const p = buildPayload(state, advice, { savePath: 'x' });
  assert.equal(p.phase, 'selecting');
  assert.equal(p.blind.target, 50);
  assert.equal(p.hand.length, 3);
  assert.deepEqual(Object.keys(p.hand[0]).sort(), ['chips', 'debuffed', 'edition', 'enhancement', 'id', 'label', 'rank', 'seal', 'stone', 'suit']);
  assert.equal(p.deckCount, 3);
  assert.deepEqual(p.stones, { hand: 0, deck: 0 });
  assert.equal(p.handLevels['Pair'].chips, 10);
  assert.equal(p.deckCounts['Spades:2'], 2);
  assert.equal(p.advice.action, 'play');
  assert.equal(p.advice.cards.length, 2);
  assert.equal(p.advice.topPlays[0].handType, 'Pair');
  assert.deepEqual(p.jokers, [{ key: 'j_trio', name: 'Trio', edition: null, debuffed: false }]);
  assert.equal(p.scoreMode, 'cards');
  assert.equal(p.savePath, 'x');
  assert.equal(p.error, null);
  assert.equal(p.advice.pending, false);
  assert.equal(buildPayload(makeState({ phase: 'shop' }), null).advice, null);
  const quick = buildPayload(state, advise(makeState({ hand: cards('S_9 D_9 H_K'), target: 900 }), { lookahead: false }));
  assert.equal(quick.advice.pending, true);
  assert.equal(quick.advice.pClear, null);
});
