export const SUITS = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
export const SUIT_SYMBOL = { Spades: '♠', Hearts: '♥', Clubs: '♣', Diamonds: '♦' };
// Tie-breakers the game uses inside Card:get_nominal (card.lua set_base).
export const SUIT_NOMINAL = { Spades: 0.04, Hearts: 0.03, Clubs: 0.02, Diamonds: 0.01 };
export const RANK_LABEL = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const SUIT_BY_LETTER = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
const RANK_BY_CHAR = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

/** Base chips of a rank (card.lua set_base): 2..10 → rank, J/Q/K → 10, A → 11. */
export function chipValue(rank) {
  if (rank === 14) return 11;
  if (rank >= 11) return 10;
  return rank;
}

export function faceNominal(rank) {
  return rank === 11 ? 0.1 : rank === 12 ? 0.2 : rank === 13 ? 0.3 : 0;
}

export function isFace(card) {
  return card.rank >= 11 && card.rank <= 13;
}

export function makeCard({ id, rank, suit, chips = chipValue(rank), debuffed = false, playedThisAnte = false }) {
  return { id, rank, suit, chips, debuffed, playedThisAnte, label: `${RANK_LABEL[rank]}${SUIT_SYMBOL[suit]}` };
}

/** 'H_Q' → Queen of Hearts. Ranks: 2-9, T, J, Q, K, A. */
export function cardFromCode(code, id = code) {
  const [s, r] = code.split('_');
  const suit = SUIT_BY_LETTER[s];
  const rank = RANK_BY_CHAR[r];
  if (!suit || !rank) throw new Error(`bad card code ${code}`);
  return makeCard({ id, rank, suit });
}

export function cardsFromCodes(text) {
  return text.trim().split(/\s+/).filter(Boolean).map((code, i) => cardFromCode(code, `${code}#${i}`));
}

/** Build a Card from a cardAreas.*.cards[i] entry of the save. Returns null for anything that is not a playing card. */
export function cardFromSave(raw, fallbackId) {
  const base = raw?.base;
  if (!base || typeof base !== 'object') return null;
  const rank = Number(base.id);
  const suit = base.suit;
  if (!Number.isInteger(rank) || rank < 2 || rank > 14 || !SUITS.includes(suit)) return null;
  const id = raw.sort_id != null ? `c${raw.sort_id}` : String(fallbackId);
  const chips = Number.isFinite(base.nominal) ? base.nominal : chipValue(rank);
  return makeCard({
    id, rank, suit, chips,
    debuffed: raw.debuff === true,
    playedThisAnte: raw.ability?.played_this_ante === true,
  });
}

/** [chips, mult, chips per level, mult per level] from game.lua init_game_object. */
export const HAND_BASE = {
  'Flush Five': [160, 16, 50, 3],
  'Flush House': [140, 14, 40, 4],
  'Five of a Kind': [120, 12, 35, 3],
  'Straight Flush': [100, 8, 40, 4],
  'Four of a Kind': [60, 7, 30, 3],
  'Full House': [40, 4, 25, 2],
  'Flush': [35, 4, 15, 2],
  'Straight': [30, 4, 30, 3],
  'Three of a Kind': [30, 3, 20, 2],
  'Two Pair': [20, 2, 20, 1],
  'Pair': [10, 2, 15, 1],
  'High Card': [5, 1, 10, 1],
};

export function defaultHandLevels() {
  const out = {};
  for (const [name, [chips, mult, lChips, lMult]] of Object.entries(HAND_BASE)) {
    out[name] = { level: 1, chips, mult, sChips: chips, sMult: mult, lChips, lMult, playedThisRound: 0 };
  }
  return out;
}
