import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlay, DEFAULT_RULES } from '../src/engine/hands.js';
import { makeState, cards } from './helpers.js';

test('level-1 pair of nines scores (10 + 18) x 2 = 56', () => {
  const r = scorePlay(cards('S_9 D_9'), makeState());
  assert.equal(r.legal, true);
  assert.equal(r.type, 'Pair');
  assert.equal(r.score, 56);
});

test('kickers do not add chips', () => {
  assert.equal(scorePlay(cards('S_9 D_9 H_K C_2 S_3'), makeState()).score, 56);
});

test('planet levels come from state.handLevels', () => {
  const state = makeState();
  state.handLevels['Pair'] = { level: 3, chips: 40, mult: 4, sChips: 10, sMult: 2, lChips: 15, lMult: 1, playedThisRound: 0 };
  assert.equal(scorePlay(cards('S_9 D_9'), state).score, (40 + 18) * 4);
});

test('debuffed cards count for the type but score no chips', () => {
  const cs = cards('S_9 D_9');
  cs[0].debuffed = true;
  assert.equal(scorePlay(cs, makeState()).score, (10 + 9) * 2);
});

test('a flush of level 1 scores hand chips plus all five cards', () => {
  const r = scorePlay(cards('C_2 C_5 C_9 C_J C_K'), makeState());
  assert.equal(r.type, 'Flush');
  assert.equal(r.score, (35 + 2 + 5 + 9 + 10 + 10) * 4);
});

test('stone cards never shape the hand but always score their chips', () => {
  const stone = () => ({ ...cards('S_5')[0], id: 'stone', stone: true, enhancement: 'Stone', chips: 50, label: 'ST' });
  // Pair of nines + a stone: still a Pair, and the stone adds 50 chips → (10 + 18 + 50) × 2
  const r = scorePlay([...cards('S_9 D_9'), stone()], makeState());
  assert.equal(r.type, 'Pair');
  assert.equal(r.score, (10 + 18 + 50) * 2);
  // four hearts + a stone is not a flush
  assert.equal(scorePlay([...cards('H_2 H_5 H_9 H_J'), stone()], makeState()).type, 'High Card');
  // a lone stone is a High Card worth its chips
  const lone = scorePlay([stone()], makeState());
  assert.equal(lone.type, 'High Card');
  assert.equal(lone.score, (5 + 50) * 1);
});

test('illegal plays report a reason', () => {
  assert.equal(scorePlay([], makeState()).legal, false);
  assert.equal(scorePlay(cards('S_2 S_3 S_4 S_5 S_6 S_7'), makeState()).legal, false);
  const psychic = { ...DEFAULT_RULES, playSizeExact: 5 };
  assert.match(scorePlay(cards('S_9 D_9'), makeState(), psychic).reason, /5 cards/);
});
