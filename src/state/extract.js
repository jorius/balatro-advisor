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
    const ability = j?.ability && typeof j.ability === 'object' ? j.ability : {};
    return {
      key, name: label && label !== 'Base Card' ? label : (str(ability.name) || key),
      edition: str(j?.edition?.type) || null, ability, debuffed: j?.debuff === true, sellCost: num(j?.sell_cost, 0),
    };
  });
  const consumables = toList(areas.consumeables?.cards).map((c) => str(c?.save_fields?.center)).filter(Boolean);
  const vouchers = game.used_vouchers && typeof game.used_vouchers === 'object' && !Array.isArray(game.used_vouchers)
    ? Object.keys(game.used_vouchers).filter((k) => game.used_vouchers[k])
    : [];

  const handLevels = {};
  for (const [name, h] of Object.entries(game.hands ?? {})) {
    if (!h || typeof h !== 'object') continue;
    handLevels[name] = {
      level: num(h.level, 1), chips: num(h.chips, 0), mult: num(h.mult, 1),
      sChips: num(h.s_chips, 0), sMult: num(h.s_mult, 1), lChips: num(h.l_chips, 0), lMult: num(h.l_mult, 0),
      playedThisRound: num(h.played_this_round, 0), played: num(h.played, 0),
    };
  }

  const play = cardsOf('play');
  const allCards = [...hand, ...deck, ...discard, ...play];
  const enhancementCounts = {};
  for (const c of allCards) if (c.enhancement !== 'None') enhancementCounts[c.enhancement] = (enhancementCounts[c.enhancement] ?? 0) + 1;
  const chosenCard = (v) => (v && typeof v === 'object' ? { rank: num(v.id, 0), suit: str(v.suit) || null } : null);

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
    // Full-scoring inputs
    money: num(game.dollars, 0),
    deckName: str(raw.BACK?.name) || 'Red Deck',
    jokerSlots: num(areas.jokers?.config?.card_limit, 5),
    consumables,
    vouchers,
    startingDeckSize: num(game.starting_deck_size, 52),
    tarotUsed: num(game.consumeable_usage_total?.tarot, 0),
    fullDeckCount: allCards.length,
    enhancementCounts,
    chosen: { idol: chosenCard(round.idol_card), ancient: chosenCard(round.ancient_card) },
    handsPlayed: num(round.hands_played, 0),
    discardsUsed: num(round.discards_used, 0),
  };
}
