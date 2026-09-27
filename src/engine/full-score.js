// Full scoring (jokers, enhancements, editions, seals) through the vendored Balatrolator engine.
// Balatrolator scores one given play; we keep our own enumeration, legality rules and lookahead.
import { getState } from '../../vendor/balatrolator/getState.ts';
import { calculateScore } from '../../vendor/balatrolator/calculateScore.ts';
import { getHand } from '../../vendor/balatrolator/getHand.ts';
import { JOKER_DEFINITIONS } from '../../vendor/balatrolator/data.ts';
import { mapJoker } from './joker-map.js';
import { DEFAULT_RULES, levelValues } from './hands.js';

const RANK_NAME = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const KNOWN_BLINDS = new Set([
  'Small Blind', 'Big Blind', 'The Hook', 'The Ox', 'The House', 'The Wall', 'The Wheel', 'The Arm', 'The Club', 'The Fish',
  'The Psychic', 'The Goad', 'The Water', 'The Window', 'The Manacle', 'The Eye', 'The Mouth', 'The Plant', 'The Serpent',
  'The Pillar', 'The Needle', 'The Head', 'The Tooth', 'The Flint', 'The Mark', 'Amber Acorn', 'Verdant Leaf', 'Violet Vessel',
  'Crimson Heart', 'Cerulean Bell',
]);
const PLANET_TO_HAND = {
  c_mercury: 'Pair', c_venus: 'Three of a Kind', c_earth: 'Full House', c_mars: 'Four of a Kind', c_jupiter: 'Flush',
  c_saturn: 'Straight', c_uranus: 'Two Pair', c_neptune: 'Straight Flush', c_pluto: 'High Card', c_planet_x: 'Five of a Kind',
  c_ceres: 'Flush House', c_eris: 'Flush Five',
};

function toScorerCard(card, played, rules) {
  return {
    rank: RANK_NAME[card.rank], suit: card.suit,
    edition: card.edition ?? 'Base', enhancement: card.enhancement ?? 'None', seal: card.seal ?? 'None',
    debuffed: card.debuffed || rules.debuff(card), played,
  };
}

/**
 * Builds the parts of Balatrolator's input that do not depend on the play, plus warnings for what
 * could not be mapped. Call once per GameState; then use createFullScorer.
 */
export function buildScoreContext(state, rules = DEFAULT_RULES) {
  const warnings = [];
  const ctx = {
    deckCount: state.deck.length,
    fullDeckCount: state.fullDeckCount ?? (state.hand.length + state.deck.length + state.discard.length),
    startingDeckSize: state.startingDeckSize ?? 52,
    tarotUsed: state.tarotUsed ?? 0,
    steelInDeck: state.enhancementCounts?.Steel ?? 0,
    stoneInDeck: state.enhancementCounts?.Stone ?? 0,
    idol: state.chosen?.idol ?? null,
    ancient: state.chosen?.ancient ?? null,
  };
  const jokers = [];
  for (const j of state.jokers ?? []) {
    const { joker, warning } = mapJoker(j, ctx);
    if (warning) warnings.push(warning);
    if (!joker) continue;
    if (!JOKER_DEFINITIONS[joker.name]) { warnings.push(`${joker.name} is unknown to the scorer and not scored`); continue; }
    jokers.push(joker);
  }
  const observatory = {};
  if ((state.vouchers ?? []).includes('v_observatory')) {
    for (const key of state.consumables ?? []) {
      const hand = PLANET_TO_HAND[key];
      if (hand) observatory[hand] = (observatory[hand] ?? 0) + 1;
    }
  }
  const handLevels = {};
  for (const [name, h] of Object.entries(state.handLevels ?? {})) handLevels[name] = { level: h.level, plays: h.played ?? 0 };
  const blindName = KNOWN_BLINDS.has(state.blind?.name) ? state.blind.name : 'Small Blind';
  return {
    rules, jokers, observatory, handLevels, warnings,
    base: {
      hands: state.handsLeft, discards: state.discardsLeft, money: state.money ?? 0,
      blind: { name: blindName, active: !(state.blind?.disabled) },
      deck: state.deckName ?? 'Red Deck', jokerSlots: state.jokerSlots ?? 5,
    },
    jokerSet: new Set(jokers.map((j) => j.name)),
    playedThisRound: Object.fromEntries(Object.entries(state.handLevels ?? {}).map(([n, h]) => [n, h.playedThisRound ?? 0])),
  };
}

/**
 * Returns scorer(cards) → { legal, type, scoringCards, score, min, max, chips, mult, log } for a play of
 * cards taken from state.hand; the remaining hand cards are passed as held (Steel, Baron, Raised Fist...).
 * `score` is the average-luck result; min/max are the no-luck / all-luck results.
 */
export function createFullScorer(state, rules = DEFAULT_RULES, context = buildScoreContext(state, rules)) {
  const hand = state.hand;
  return function scoreFull(cards) {
    const n = cards.length;
    if (n < 1 || n > 5) return { legal: false, reason: 'Play 1 to 5 cards' };
    if (rules.playSizeExact != null && n !== rules.playSizeExact) return { legal: false, reason: `Must play exactly ${rules.playSizeExact} cards` };
    const played = new Set(cards);
    const scorerCards = hand.map((c) => toScorerCard(c, played.has(c), rules)).map((c, index) => ({ ...c, index }));
    const { playedHand: type } = getHand(scorerCards.filter((c) => c.played), context.jokerSet);
    if (rules.bannedTypes.has(type)) return { legal: false, reason: `${type} already played this round`, type };
    if (rules.lockedType && rules.lockedType !== type) return { legal: false, reason: `Only ${rules.lockedType} may be played`, type };

    const handLevels = { ...context.handLevels };
    if (rules.levelDelta && handLevels[type]) handLevels[type] = { ...handLevels[type], level: levelValues(state.handLevels[type], rules.levelDelta).level };
    const jokers = context.jokers.map((j) => (j.name === 'Card Sharp' ? { ...j, active: (context.playedThisRound[type] ?? 0) > 0 } : j));
    const result = calculateScore(getState({ ...context.base, handLevels, observatory: context.observatory, jokers, cards: scorerCards }));
    const byLuck = Object.fromEntries(result.results.map((r) => [r.luck, r]));
    const avg = byLuck.average ?? result.results[0];
    const scoringCards = result.scoringCards.map((sc) => hand[sc.index]).filter(Boolean);
    return {
      legal: true, type: result.hand, scoringCards,
      score: Number(avg.score), min: Number((byLuck.none ?? avg).score), max: Number((byLuck.all ?? avg).score),
      chips: Number(avg.chips), mult: Number(avg.multiplier), log: avg.log,
    };
  };
}
