// Port of evaluate_poker_hand / get_X_same / get_flush / get_straight / get_highest
// from Balatro's functions/misc_functions.lua, plus scoring from state_events.lua.
import { SUITS, SUIT_NOMINAL, faceNominal, HAND_BASE } from './cards.js';

export const HAND_ORDER = [
  'Flush Five', 'Flush House', 'Five of a Kind', 'Straight Flush', 'Four of a Kind', 'Full House',
  'Flush', 'Straight', 'Three of a Kind', 'Two Pair', 'Pair', 'High Card',
];

export const DEFAULT_RULES = Object.freeze({
  fourFingers: false, shortcut: false,
  playSizeExact: null,          // The Psychic → 5
  bannedTypes: new Set(),       // The Eye
  lockedType: null,             // The Mouth
  trackEye: false, trackMouth: false,
  debuff: () => false,          // suit / face / pillar debuffs
  levelDelta: 0,                // The Arm → -1
  halve: false,                 // The Flint
  drawOverride: null,           // The Serpent → 3
  warnings: [],
});

function groupsOf(num, byRank) {
  const out = [];
  for (let r = 14; r >= 2; r--) {
    const g = byRank[r];
    if (g && g.length === num) out.push(g);
  }
  return out;
}

function getFlush(cards, min) {
  if (cards.length > 5 || cards.length < min) return null;
  for (const suit of SUITS) {
    const t = [];
    for (const c of cards) if (c.suit === suit) t.push(c);
    if (t.length >= min) return t;
  }
  return null;
}

function getStraight(cards, min, shortcut, byRank) {
  if (cards.length > 5 || cards.length < min) return null;
  let t = [];
  let len = 0, straight = false, skipped = false;
  for (let j = 1; j <= 14; j++) {
    const g = byRank[j === 1 ? 14 : j];
    if (g) {
      len++;
      skipped = false;
      for (const c of g) t.push(c);
    } else if (shortcut && !skipped && j !== 14) {
      skipped = true;
    } else {
      len = 0;
      skipped = false;
      if (!straight) t = [];
      if (straight) break;
    }
    if (len >= min) straight = true;
  }
  return straight ? t : null;
}

function nominal(c) {
  return 10 * c.chips + SUIT_NOMINAL[c.suit] + faceNominal(c.rank);
}

function getHighest(cards) {
  let h = null;
  for (const c of cards) if (!h || nominal(c) > nominal(h)) h = c;
  return h;
}

/** Returns { type, scoringCards } for 1..5 cards, or null for an empty list. */
export function evaluateHand(cards, rules = DEFAULT_RULES) {
  if (cards.length === 0) return null;
  const min = rules.fourFingers ? 4 : 5;
  const byRank = [];
  for (const c of cards) (byRank[c.rank] ||= []).push(c);
  const g5 = groupsOf(5, byRank), g4 = groupsOf(4, byRank), g3 = groupsOf(3, byRank), g2 = groupsOf(2, byRank);
  const flush = getFlush(cards, min);
  const straight = getStraight(cards, min, rules.shortcut, byRank);

  if (g5.length && flush) return { type: 'Flush Five', scoringCards: g5[0] };
  if (g3.length && g2.length && flush) return { type: 'Flush House', scoringCards: [...g3[0], ...g2[0]] };
  if (g5.length) return { type: 'Five of a Kind', scoringCards: g5[0] };
  if (flush && straight) {
    const inFlush = new Set(flush);
    const sc = [...flush];
    for (const c of straight) if (!inFlush.has(c)) sc.push(c);
    return { type: 'Straight Flush', scoringCards: sc };
  }
  if (g4.length) return { type: 'Four of a Kind', scoringCards: g4[0] };
  if (g3.length && g2.length) return { type: 'Full House', scoringCards: [...g3[0], ...g2[0]] };
  if (flush) return { type: 'Flush', scoringCards: flush };
  if (straight) return { type: 'Straight', scoringCards: straight };
  if (g3.length) return { type: 'Three of a Kind', scoringCards: g3[0] };
  if (g2.length === 2 || (g3.length === 1 && g2.length === 1)) {
    return { type: 'Two Pair', scoringCards: [...g2[0], ...(g2[1] || g3[0])] };
  }
  if (g2.length) return { type: 'Pair', scoringCards: g2[0] };
  return { type: 'High Card', scoringCards: [getHighest(cards)] };
}

/** Leveled chips/mult for a hand, optionally shifted by levelDelta (The Arm). Mirrors level_up_hand. */
export function levelValues(hl, levelDelta = 0) {
  if (!levelDelta) return { level: hl.level, chips: hl.chips, mult: hl.mult };
  const level = Math.max(1, hl.level + levelDelta);
  if (level === hl.level) return { level, chips: hl.chips, mult: hl.mult };
  return {
    level,
    chips: Math.max(hl.sChips + hl.lChips * (level - 1), 0),
    mult: Math.max(hl.sMult + hl.lMult * (level - 1), 1),
  };
}

function fallbackLevel(type) {
  const [chips, mult, lChips, lMult] = HAND_BASE[type] ?? [5, 1, 10, 1];
  return { level: 1, chips, mult, sChips: chips, sMult: mult, lChips, lMult, playedThisRound: 0 };
}

/**
 * Scores a play of 1..5 cards under the given rules.
 * Returns { legal:false, reason } or { legal:true, type, level, scoringCards, handChips, handMult, cardChips, score }.
 */
export function scorePlay(cards, state, rules = DEFAULT_RULES) {
  const n = cards.length;
  if (n < 1 || n > 5) return { legal: false, reason: 'Play 1 to 5 cards' };
  if (rules.playSizeExact != null && n !== rules.playSizeExact) {
    return { legal: false, reason: `Must play exactly ${rules.playSizeExact} cards` };
  }
  const ev = evaluateHand(cards, rules);
  const type = ev.type;
  if (rules.bannedTypes.has(type)) return { legal: false, reason: `${type} already played this round`, type };
  if (rules.lockedType && rules.lockedType !== type) return { legal: false, reason: `Only ${rules.lockedType} may be played`, type };

  const hl = state.handLevels?.[type] ?? fallbackLevel(type);
  let { level, chips: handChips, mult: handMult } = levelValues(hl, rules.levelDelta);
  if (rules.halve) {
    handChips = Math.max(Math.floor(handChips * 0.5 + 0.5), 0);
    handMult = Math.max(Math.floor(handMult * 0.5 + 0.5), 1);
  }
  let cardChips = 0;
  for (const c of ev.scoringCards) if (!c.debuffed && !rules.debuff(c)) cardChips += c.chips;
  return { legal: true, type, level, scoringCards: ev.scoringCards, handChips, handMult, cardChips, score: (handChips + cardChips) * handMult };
}
