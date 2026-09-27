import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHand, DEFAULT_RULES } from '../src/engine/hands.js';
import { cards } from './helpers.js';

const type = (s, rules) => evaluateHand(cards(s), rules).type;
const scoring = (s, rules) => evaluateHand(cards(s), rules).scoringCards.map(c => c.label).sort();

test('detects every hand type in precedence order', () => {
  assert.equal(type('S_A S_A S_A S_A S_A'), 'Flush Five');
  assert.equal(type('H_K H_K H_K H_3 H_3'), 'Flush House');
  assert.equal(type('S_A H_A C_A D_A S_A'), 'Five of a Kind');
  assert.equal(type('D_9 D_T D_J D_Q D_K'), 'Straight Flush');
  assert.equal(type('S_7 H_7 C_7 D_7 S_2'), 'Four of a Kind');
  assert.equal(type('S_7 H_7 C_7 D_2 S_2'), 'Full House');
  assert.equal(type('C_2 C_5 C_9 C_J C_K'), 'Flush');
  assert.equal(type('S_5 H_6 C_7 D_8 S_9'), 'Straight');
  assert.equal(type('S_7 H_7 C_7 D_2 S_3'), 'Three of a Kind');
  assert.equal(type('S_7 H_7 C_2 D_2 S_3'), 'Two Pair');
  assert.equal(type('S_7 H_7 C_2 D_4 S_3'), 'Pair');
  assert.equal(type('S_7 H_9 C_2 D_4 S_3'), 'High Card');
});

test('ace-low and ace-high straights', () => {
  assert.equal(type('S_A H_2 C_3 D_4 S_5'), 'Straight');
  assert.equal(type('S_T H_J C_Q D_K S_A'), 'Straight');
  assert.equal(type('S_Q H_K C_A D_2 S_3'), 'High Card'); // no wrap-around
});

test('only the cards that form the hand score', () => {
  assert.deepEqual(scoring('S_9 D_9 H_K C_2 S_3'), ['9♠', '9♦']);
  assert.deepEqual(scoring('S_A H_9 C_2 D_4 S_3'), ['A♠']);
  assert.deepEqual(scoring('S_7 H_7 C_2 D_2 S_3'), ['2♣', '2♦', '7♠', '7♥']);
  assert.deepEqual(scoring('C_2 C_5 C_9 C_J C_K').length, 5);
});

test('high card picks the highest nominal (Ace over King, King over Queen)', () => {
  assert.deepEqual(scoring('S_K H_Q C_2'), ['K♠']);
  assert.deepEqual(scoring('S_K H_A'), ['A♥']);
});

test('four fingers allows 4-card flushes and straights', () => {
  const ff = { ...DEFAULT_RULES, fourFingers: true };
  assert.equal(type('C_2 C_5 C_9 C_J'), 'High Card');
  assert.equal(type('C_2 C_5 C_9 C_J', ff), 'Flush');
  assert.equal(type('C_2 C_5 C_9 C_J D_K', ff), 'Flush');
  assert.deepEqual(scoring('C_2 C_5 C_9 C_J D_K', ff), ['2♣', '5♣', '9♣', 'J♣']);
  assert.equal(type('S_5 H_6 C_7 D_8', ff), 'Straight');
});

test('shortcut allows one gap in a straight', () => {
  const sc = { ...DEFAULT_RULES, shortcut: true };
  assert.equal(type('S_2 H_3 C_5 D_6 S_7'), 'High Card');
  assert.equal(type('S_2 H_3 C_5 D_6 S_7', sc), 'Straight');
  assert.equal(type('S_2 H_4 C_6 D_8 S_T', sc), 'Straight'); // several single-rank gaps are fine
  assert.equal(type('S_2 H_3 C_6 D_7 S_8', sc), 'High Card'); // a two-rank gap is not
});

test('1 to 5 cards; more than 5 never forms flush or straight', () => {
  assert.equal(type('S_A'), 'High Card');
  assert.equal(type('S_A H_A'), 'Pair');
  assert.equal(evaluateHand([]), null);
});
