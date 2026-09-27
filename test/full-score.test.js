import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFullScorer, buildScoreContext } from '../src/engine/full-score.js';
import { mapJoker } from '../src/engine/joker-map.js';
import { blindRules } from '../src/engine/blinds.js';
import { makeCard, cardFromCode } from '../src/engine/cards.js';
import { makeState, cards } from './helpers.js';

const joker = (key, ability = {}, extra = {}) => ({ key, name: key, edition: null, ability, debuffed: false, sellCost: 0, ...extra });
const fullState = (over = {}) => makeState({ money: 0, deckName: 'Red Deck', jokerSlots: 5, consumables: [], vouchers: [], startingDeckSize: 52, tarotUsed: 0, enhancementCounts: {}, chosen: { idol: null, ancient: null }, ...over });

test('reproduces a Balatrolator reference case through our card and joker model', () => {
  // Balatrolator test-files/010: Two Pair with a Stone card, Even Steven, Bootstraps, Joker, Crazy Joker, Splash, $16 → 102 × 28 = 2856
  const hand = [
    cardFromCode('S_T', 'a'), cardFromCode('C_T', 'b'),
    makeCard({ id: 'c', rank: 8, suit: 'Spades', enhancement: 'Stone', chips: 50 }),
    cardFromCode('S_6', 'd'), cardFromCode('S_6', 'e'),
  ];
  const state = fullState({ hand, money: 16, jokers: [joker('j_even_steven'), joker('j_bootstraps'), joker('j_joker'), joker('j_crazy'), joker('j_splash')] });
  const r = createFullScorer(state, blindRules(state))(hand);
  assert.equal(r.legal, true);
  assert.equal(r.type, 'Two Pair');
  assert.equal(r.chips, 102);
  assert.equal(r.mult, 28);
  assert.equal(r.score, 2856);
  assert.equal(r.scoringCards.length, 5);
});

test('live joker values from the save change the score', () => {
  const hand = cards('S_9 D_9 H_K C_2 S_3');
  const base = createFullScorer(fullState({ hand }), blindRules(fullState()))(hand.slice(0, 2)).score; // Pair of nines = 56
  assert.equal(base, 56);
  const holo = fullState({ hand, jokers: [joker('j_hologram', { x_mult: 2.5, extra: 0.25 })] });
  assert.equal(createFullScorer(holo, blindRules(holo))(hand.slice(0, 2)).score, 56 * 2.5);
  const bus = fullState({ hand, jokers: [joker('j_ride_the_bus', { mult: 7, extra: 1 })] });
  assert.equal(createFullScorer(bus, blindRules(bus))(hand.slice(0, 2)).score, 28 * (2 + 7));
  const blue = fullState({ hand, deck: cards('S_2 S_3 S_4 S_5'), jokers: [joker('j_blue_joker', { extra: 2 })] });
  assert.equal(createFullScorer(blue, blindRules(blue))(hand.slice(0, 2)).score, (28 + 8) * 2);
  const idol = fullState({ hand, chosen: { idol: { rank: 9, suit: 'Spades' }, ancient: null }, jokers: [joker('j_idol', { extra: 2 })] });
  assert.equal(createFullScorer(idol, blindRules(idol))(hand.slice(0, 2)).score, 28 * 2 * 2);
});

test('Card Sharp is active only for a hand type already played this round', () => {
  const hand = cards('S_9 D_9 H_K');
  const s = fullState({ hand, jokers: [joker('j_card_sharp', { extra: 3 })] });
  assert.equal(createFullScorer(s, blindRules(s))(hand.slice(0, 2)).score, 56);
  s.handLevels['Pair'] = { ...s.handLevels['Pair'], playedThisRound: 1 };
  assert.equal(createFullScorer(s, blindRules(s))(hand.slice(0, 2)).score, 56 * 3);
});

test('held cards count: Steel in hand multiplies, Baron with a held King', () => {
  const hand = [...cards('S_9 D_9'), makeCard({ id: 'steel', rank: 4, suit: 'Clubs', enhancement: 'Steel' })];
  const s = fullState({ hand });
  assert.equal(createFullScorer(s, blindRules(s))(hand.slice(0, 2)).score, 28 * 3); // mult 2 × 1.5
  const kings = fullState({ hand: [...cards('S_9 D_9'), cardFromCode('H_K', 'k')], jokers: [joker('j_baron', { extra: 1.5 })] });
  assert.equal(createFullScorer(kings, blindRules(kings))(kings.hand.slice(0, 2)).score, 28 * 3);
});

test('boss rules still apply: Psychic, Eye, The Arm, The Flint', () => {
  const hand = cards('S_9 D_9 H_K C_2 S_3 D_A');
  const blind = (key, name, extra = {}) => ({ key, name, disabled: false, usedHandTypes: [], lockedHandType: null, ...extra });
  const psychic = fullState({ hand, blind: blind('bl_psychic', 'The Psychic') });
  assert.equal(createFullScorer(psychic, blindRules(psychic))(hand.slice(0, 2)).legal, false);
  assert.equal(createFullScorer(psychic, blindRules(psychic))(hand.slice(0, 5)).legal, true);
  const eye = fullState({ hand, blind: blind('bl_eye', 'The Eye', { usedHandTypes: ['Pair'] }) });
  assert.equal(createFullScorer(eye, blindRules(eye))(hand.slice(0, 2)).legal, false);
  const arm = fullState({ hand, blind: blind('bl_arm', 'The Arm') });
  arm.handLevels['Pair'] = { ...arm.handLevels['Pair'], level: 3, chips: 40, mult: 4 };
  assert.equal(createFullScorer(arm, blindRules(arm))(hand.slice(0, 2)).score, (25 + 18) * 3);
  const flint = fullState({ hand, blind: blind('bl_flint', 'The Flint') });
  assert.equal(createFullScorer(flint, blindRules(flint))([hand[5]]).score, 14); // High Card: 5→3 chips, mult 1
  const club = fullState({ hand: cards('C_9 D_9'), blind: blind('bl_club', 'The Club') });
  assert.equal(createFullScorer(club, blindRules(club))(club.hand).score, (10 + 9) * 2);
});

test('unmappable jokers produce warnings and are skipped', () => {
  const s = fullState({ hand: cards('S_9 D_9'), jokers: [joker('j_nope'), joker('j_drivers_license', { extra: 3 }), joker('j_joker', {}, { debuffed: true })] });
  const ctx = buildScoreContext(s, blindRules(s));
  assert.equal(ctx.jokers.length, 1); // only Driver's License survives (with a warning)
  assert.ok(ctx.warnings.some((w) => /j_nope/.test(w)));
  assert.ok(ctx.warnings.some((w) => /Driver's license/i.test(w)));
  assert.ok(ctx.warnings.some((w) => /debuffed/.test(w)));
});

test('mapJoker reads each family of live values', () => {
  const ctx = { deckCount: 30, fullDeckCount: 48, startingDeckSize: 52, tarotUsed: 6, steelInDeck: 2, stoneInDeck: 3, idol: null, ancient: { rank: 0, suit: 'Hearts' } };
  assert.equal(mapJoker(joker('j_castle', { extra: { chips: 27, chip_mod: 3 } }), ctx).joker.plusChips, 27);
  assert.equal(mapJoker(joker('j_erosion', { extra: 4 }), ctx).joker.plusMultiplier, 16);
  assert.equal(mapJoker(joker('j_fortune_teller', { extra: 1 }), ctx).joker.plusMultiplier, 6);
  assert.equal(mapJoker(joker('j_steel_joker', { extra: 0.2, steel_tally: 2 }), ctx).joker.timesMultiplier, 1.4);
  assert.equal(mapJoker(joker('j_stone', { extra: 25 }), ctx).joker.plusChips, 75);
  assert.equal(mapJoker(joker('j_loyalty_card', { loyalty_remaining: 0 }), ctx).joker.active, true);
  assert.equal(mapJoker(joker('j_loyalty_card', { loyalty_remaining: 2 }), ctx).joker.active, false);
  assert.equal(mapJoker(joker('j_ancient', { extra: 1.5 }), ctx).joker.suit, 'Hearts');
  assert.equal(mapJoker(joker('j_caino', { caino_xmult: 3 }), ctx).joker.timesMultiplier, 3);
  assert.equal(mapJoker(joker('j_joker', {}, { edition: 'polychrome' }), ctx).joker.edition, 'Polychrome');
});
