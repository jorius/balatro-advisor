import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildPayload } from '../src/cli.js';
import { advise } from '../src/engine/advisor.js';
import { makeState, cards } from './helpers.js';

test('parseArgs reads flags with defaults', () => {
  assert.deepEqual(parseArgs([]), { port: 8787, host: '127.0.0.1', profile: null, save: null, budgetMs: 500 });
  assert.deepEqual(parseArgs(['--port', '9000', '--host', '0.0.0.0', '--profile', '2', '--save', 'x.jkr', '--budget-ms', '250']),
    { port: 9000, host: '0.0.0.0', profile: 2, save: 'x.jkr', budgetMs: 250 });
});

test('buildPayload serialises state and advice for the page', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K'), deck: cards('S_2 S_2 H_3'), target: 50, jokers: [{ key: 'j_trio', name: 'Trio' }] });
  const advice = advise(state, { seed: 'p' });
  const p = buildPayload(state, advice, { savePath: 'x' });
  assert.equal(p.phase, 'selecting');
  assert.equal(p.blind.target, 50);
  assert.equal(p.hand.length, 3);
  assert.deepEqual(Object.keys(p.hand[0]).sort(), ['chips', 'debuffed', 'id', 'label', 'rank', 'suit']);
  assert.equal(p.deckCount, 3);
  assert.equal(p.deckCounts['Spades:2'], 2);
  assert.equal(p.advice.action, 'play');
  assert.equal(p.advice.cards.length, 2);
  assert.equal(p.advice.topPlays[0].handType, 'Pair');
  assert.deepEqual(p.jokers, [{ key: 'j_trio', name: 'Trio' }]);
  assert.equal(p.savePath, 'x');
  assert.equal(p.error, null);
  assert.equal(p.advice.pending, false);
  assert.equal(buildPayload(makeState({ phase: 'shop' }), null).advice, null);
  const quick = buildPayload(state, advise(makeState({ hand: cards('S_9 D_9 H_K'), target: 900 }), { lookahead: false }));
  assert.equal(quick.advice.pending, true);
  assert.equal(quick.advice.pClear, null);
});
