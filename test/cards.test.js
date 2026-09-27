import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipValue, cardFromCode, cardsFromCodes, cardFromSave, isFace, HAND_BASE, defaultHandLevels } from '../src/engine/cards.js';

test('chip values follow Balatro: 2-10 face value, J/Q/K 10, A 11', () => {
  assert.equal(chipValue(2), 2);
  assert.equal(chipValue(10), 10);
  assert.equal(chipValue(11), 10);
  assert.equal(chipValue(13), 10);
  assert.equal(chipValue(14), 11);
});

test('cardFromCode builds a card with label and chips', () => {
  const c = cardFromCode('H_Q');
  assert.equal(c.rank, 12);
  assert.equal(c.suit, 'Hearts');
  assert.equal(c.chips, 10);
  assert.equal(c.label, 'Q♥');
  assert.equal(isFace(c), true);
  assert.equal(isFace(cardFromCode('S_A')), false);
});

test('cardsFromCodes gives unique ids', () => {
  const cs = cardsFromCodes('S_9 D_9 S_9');
  assert.equal(cs.length, 3);
  assert.equal(new Set(cs.map(c => c.id)).size, 3);
});

test('cardFromSave maps save fields and rejects junk', () => {
  const raw = { sort_id: 236, debuff: true, ability: { played_this_ante: true }, base: { id: 12, suit: 'Clubs', nominal: 10, value: 'Queen' } };
  const c = cardFromSave(raw, 'hand0');
  assert.equal(c.id, 'c236');
  assert.equal(c.rank, 12);
  assert.equal(c.suit, 'Clubs');
  assert.equal(c.chips, 10);
  assert.equal(c.debuffed, true);
  assert.equal(c.playedThisAnte, true);
  assert.equal(cardFromSave({ base: { id: 99, suit: 'Clubs' } }, 'x'), null);
  assert.equal(cardFromSave({}, 'x'), null);
});

test('cardFromSave reads enhancements, editions, seals and bonus chips', () => {
  const base = { id: 9, suit: 'Hearts', nominal: 9 };
  const plain = cardFromSave({ sort_id: 1, base, ability: { effect: 'Base', bonus: 0 } }, 'a');
  assert.deepEqual([plain.enhancement, plain.edition, plain.seal, plain.stone, plain.chips], ['None', 'Base', 'None', false, 9]);
  const stone = cardFromSave({ sort_id: 2, base, ability: { effect: 'Stone Card', bonus: 50, perma_bonus: 10 } }, 'b');
  assert.equal(stone.stone, true);
  assert.equal(stone.chips, 60);
  assert.equal(stone.label, 'ST');
  const fancy = cardFromSave({ sort_id: 3, base, ability: { effect: 'Bonus Card', bonus: 30 }, edition: { type: 'polychrome', polychrome: true }, seal: 'Red' }, 'c');
  assert.deepEqual([fancy.enhancement, fancy.edition, fancy.seal, fancy.chips], ['Bonus', 'Polychrome', 'Red', 39]);
  assert.equal(cardFromSave({ sort_id: 4, base, ability: { effect: 'Glass Card' }, edition: { type: 'negative' }, seal: 'Nope' }, 'd').seal, 'None');
});

test('HAND_BASE matches game.lua and defaultHandLevels expands it', () => {
  assert.deepEqual(HAND_BASE['Pair'], [10, 2, 15, 1]);
  assert.deepEqual(HAND_BASE['Straight Flush'], [100, 8, 40, 4]);
  const lv = defaultHandLevels();
  assert.deepEqual(lv['Two Pair'], { level: 1, chips: 20, mult: 2, sChips: 20, sMult: 2, lChips: 20, lMult: 1, playedThisRound: 0 });
  assert.equal(Object.keys(lv).length, 12);
});
