import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeLuaFile } from '../src/save/reader.js';
import { parseLuaTable } from '../src/save/lua-table.js';
import { extractState, toList } from '../src/state/extract.js';

const fixture = new URL('./fixtures/save-shop.jkr', import.meta.url);

test('extracts a real save captured in the shop', async () => {
  const raw = parseLuaTable(decodeLuaFile(await readFile(fixture)));
  const s = extractState(raw);
  assert.equal(s.phase, 'shop');
  assert.equal(s.stateCode, 5);
  assert.equal(s.hand.length, 0);
  assert.equal(s.deck.length, 52);
  assert.equal(s.handsLeft, 4);
  assert.equal(s.discardsLeft, 4);
  assert.equal(s.handSize, 8);
  assert.equal(s.ante, 1);
  assert.equal(s.handLevels['Two Pair'].chips, 20);
  assert.equal(s.handLevels['Two Pair'].lChips, 20);
  assert.equal(Object.keys(s.handLevels).length, 12);
  assert.equal(s.jokers.length, 0);
  assert.equal(new Set(s.deck.map(c => c.id)).size, 52);
  assert.deepEqual(s.flags, { fourFingers: false, shortcut: false });
});

function rawCard(sortId, id, suit, extra = {}) {
  return { sort_id: sortId, debuff: false, base: { id, suit, nominal: id === 14 ? 11 : id > 10 ? 10 : id }, ...extra };
}

test('extracts a synthetic selecting-hand save', () => {
  const raw = {
    STATE: 1,
    BLIND: { name: 'The Eye', config_blind: 'bl_eye', chips: 800, disabled: false, hands: { Pair: true }, only_hand: false },
    cardAreas: {
      hand: { cards: [rawCard(1, 9, 'Spades'), rawCard(2, 9, 'Hearts'), rawCard(3, 14, 'Clubs')], config: { card_limit: 8 } },
      deck: { cards: [rawCard(4, 2, 'Diamonds'), rawCard(5, 3, 'Diamonds')] },
      discard: { cards: [] },
      jokers: { cards: [{ save_fields: { center: 'j_four_fingers' }, label: 'Four Fingers' }] },
    },
    GAME: {
      chips: 150, round: 3, blind_on_deck: 'Boss',
      round_resets: { ante: 2 },
      current_round: { hands_left: 2, discards_left: 1 },
      hands: { Pair: { level: 2, chips: 25, mult: 3, s_chips: 10, s_mult: 2, l_chips: 15, l_mult: 1, played_this_round: 1 } },
    },
  };
  const s = extractState(raw);
  assert.equal(s.phase, 'selecting');
  assert.equal(s.hand.map(c => c.label).join(' '), '9♠ 9♥ A♣');
  assert.equal(s.deck.length, 2);
  assert.equal(s.chipsScored, 150);
  assert.equal(s.target, 800);
  assert.equal(s.ante, 2);
  assert.equal(s.round, 3);
  assert.equal(s.blindOnDeck, 'Boss');
  assert.equal(s.handsLeft, 2);
  assert.equal(s.discardsLeft, 1);
  assert.deepEqual(s.blind, { key: 'bl_eye', name: 'The Eye', disabled: false, usedHandTypes: ['Pair'], lockedHandType: null });
  assert.equal(s.handLevels.Pair.level, 2);
  assert.equal(s.handLevels.Pair.playedThisRound, 1);
  assert.deepEqual(s.jokers.map(({ key, name }) => ({ key, name })), [{ key: 'j_four_fingers', name: 'Four Fingers' }]);
  assert.deepEqual(s.flags, { fourFingers: true, shortcut: false });
  assert.equal(s.money, 0);
  assert.equal(s.deckName, 'Red Deck');
  assert.equal(s.fullDeckCount, 5);
  assert.equal(s.handsPlayed, 0);
});

test('extracts full-scoring inputs: money, deck, vouchers, consumables, chosen cards, enhancement counts', () => {
  const raw = {
    STATE: 1, BACK: { name: 'Blue Deck' },
    BLIND: { name: 'Small Blind', config_blind: 'bl_small', chips: 300 },
    cardAreas: {
      hand: { cards: [rawCard(1, 9, 'Spades', { ability: { effect: 'Steel Card' } })], config: { card_limit: 8 } },
      deck: { cards: [rawCard(2, 2, 'Diamonds', { ability: { effect: 'Stone Card', bonus: 50 } }), rawCard(3, 3, 'Diamonds')] },
      discard: { cards: [rawCard(4, 4, 'Clubs', { ability: { effect: 'Steel Card' } })] },
      jokers: { cards: [{ save_fields: { center: 'j_hologram' }, label: 'Hologram', edition: { type: 'foil' }, ability: { x_mult: 1.75, extra: 0.25 }, sell_cost: 4 }], config: { card_limit: 6 } },
      consumeables: { cards: [{ save_fields: { center: 'c_pluto' } }] },
    },
    GAME: {
      chips: 0, round: 1, dollars: 23, starting_deck_size: 52, used_vouchers: { v_observatory: true, v_grabber: false },
      consumeable_usage_total: { tarot: 3 }, round_resets: { ante: 1 },
      current_round: { hands_left: 4, discards_left: 3, hands_played: 1, discards_used: 2, idol_card: { suit: 'Hearts', rank: 'Queen', id: 12 }, ancient_card: { suit: 'Clubs' } },
      hands: { Pair: { level: 1, chips: 10, mult: 2, s_chips: 10, s_mult: 2, l_chips: 15, l_mult: 1, played_this_round: 0, played: 7 } },
    },
  };
  const s = extractState(raw);
  assert.equal(s.money, 23);
  assert.equal(s.deckName, 'Blue Deck');
  assert.equal(s.jokerSlots, 6);
  assert.deepEqual(s.vouchers, ['v_observatory']);
  assert.deepEqual(s.consumables, ['c_pluto']);
  assert.equal(s.startingDeckSize, 52);
  assert.equal(s.tarotUsed, 3);
  assert.equal(s.fullDeckCount, 4);
  assert.deepEqual(s.enhancementCounts, { Steel: 2, Stone: 1 });
  assert.deepEqual(s.chosen, { idol: { rank: 12, suit: 'Hearts' }, ancient: { rank: 0, suit: 'Clubs' } });
  assert.equal(s.handsPlayed, 1);
  assert.equal(s.discardsUsed, 2);
  assert.equal(s.handLevels.Pair.played, 7);
  assert.deepEqual(s.jokers[0], { key: 'j_hologram', name: 'Hologram', edition: 'foil', ability: { x_mult: 1.75, extra: 0.25 }, debuffed: false, sellCost: 4 });
});

test('tolerates missing sections and empty tables parsed as arrays', () => {
  const s = extractState({ STATE: 7, cardAreas: { hand: { cards: [] } }, BLIND: { hands: [], only_hand: false } });
  assert.equal(s.phase, 'blind_select');
  assert.deepEqual(s.hand, []);
  assert.deepEqual(s.blind.usedHandTypes, []);
  assert.equal(s.blind.lockedHandType, null);
  assert.throws(() => extractState(null), TypeError);
});

test('toList accepts arrays, numeric-key objects and junk', () => {
  assert.deepEqual(toList([1, 2]), [1, 2]);
  assert.deepEqual(toList({ 2: 'b', 1: 'a' }), ['a', 'b']);
  assert.deepEqual(toList(undefined), []);
});
