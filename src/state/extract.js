import { cardFromSave } from '../engine/cards.js';

const PHASE_BY_STATE = { 1: 'selecting', 4: 'game_over', 5: 'shop', 7: 'blind_select', 8: 'round_eval' };

export function toList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

/** Reduce a parsed save.jkr to the GameState shape the engine and page consume. */
export function extractState(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('save is not a table');
  const areas = raw.cardAreas ?? {};
  const game = raw.GAME ?? {};
  const round = game.current_round ?? {};
  const blind = raw.BLIND ?? {};

  const cardsOf = (name) => toList(areas[name]?.cards).map((c, i) => cardFromSave(c, `${name}${i}`)).filter(Boolean);
  const hand = cardsOf('hand');
  const deck = cardsOf('deck');
  const discard = cardsOf('discard');

  const jokers = toList(areas.jokers?.cards).map((j) => {
    const key = str(j?.save_fields?.center);
    const label = str(j?.label);
    return { key, name: label && label !== 'Base Card' ? label : key };
  });

  const handLevels = {};
  for (const [name, h] of Object.entries(game.hands ?? {})) {
    if (!h || typeof h !== 'object') continue;
    handLevels[name] = {
      level: num(h.level, 1), chips: num(h.chips, 0), mult: num(h.mult, 1),
      sChips: num(h.s_chips, 0), sMult: num(h.s_mult, 1), lChips: num(h.l_chips, 0), lMult: num(h.l_mult, 0),
      playedThisRound: num(h.played_this_round, 0),
    };
  }

  const stateCode = num(raw.STATE, 0);
  const usedHands = blind.hands && typeof blind.hands === 'object' && !Array.isArray(blind.hands) ? Object.keys(blind.hands) : [];

  return {
    phase: PHASE_BY_STATE[stateCode] ?? 'other',
    stateCode,
    ante: num(game.round_resets?.ante, 0),
    round: num(game.round, 0),
    blindOnDeck: str(game.blind_on_deck),
    hand, deck, discard,
    handsLeft: num(round.hands_left, 0),
    discardsLeft: num(round.discards_left, 0),
    handSize: num(areas.hand?.config?.card_limit, hand.length),
    chipsScored: num(game.chips, 0),
    target: num(blind.chips, 0),
    blind: {
      key: str(blind.config_blind),
      name: str(blind.name),
      disabled: blind.disabled === true,
      usedHandTypes: usedHands,
      lockedHandType: typeof blind.only_hand === 'string' ? blind.only_hand : null,
    },
    handLevels,
    jokers,
    flags: {
      fourFingers: jokers.some((j) => j.key === 'j_four_fingers'),
      shortcut: jokers.some((j) => j.key === 'j_shortcut'),
    },
  };
}
