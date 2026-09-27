// Maps a joker from the save (key + live `ability` table) onto Balatrolator's InitialJoker.
// Live values come from the fields Balatro itself mutates in card.lua (calculate_joker); the
// formulas for computed jokers (Blue Joker, Erosion, ...) mirror the game's expressions.
import { JOKER_NAME_BY_KEY } from './joker-names.js';

const EDITION_BY_TYPE = { foil: 'Foil', holo: 'Holographic', polychrome: 'Polychrome', negative: 'Negative' };
const RANK_NAME = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Jokers whose ×Mult is stored in ability.x_mult by the game. */
const X_MULT_FROM_ABILITY = new Set([
  'Hologram', 'Lucky Cat', 'Ramen', 'Vampire', 'Obelisk', 'Constellation', 'Madness', 'Hit the Road',
  'Campfire', 'Throwback', 'Glass Joker', 'Yorick',
]);
/** Jokers whose +Mult is stored in ability.mult by the game. */
const MULT_FROM_ABILITY = new Set([
  'Ride the Bus', 'Green Joker', 'Flash Card', 'Popcorn', 'Red Card', 'Ceremonial Dagger', 'Spare Trousers', 'Swashbuckler',
]);
/** Jokers whose +Chips is stored in ability.extra.chips by the game. */
const CHIPS_FROM_EXTRA = new Set(['Castle', 'Runner', 'Ice Cream', 'Wee Joker', 'Square Joker']);

/** Jokers Balatrolator cannot score correctly from the data we can give it. */
export const UNSCORED_WARNINGS = {
  "Driver's license": 'needs the count of enhanced cards in the whole deck, which the scorer cannot take as input',
  'Space Joker': 'random hand level-ups are not simulated',
};

/**
 * @param {object} joker  extracted joker: { key, name, edition, ability, debuffed }
 * @param {object} ctx    { deckCount, fullDeckCount, startingDeckSize, tarotUsed, steelInDeck, stoneInDeck, idol, ancient }
 * @returns {{ joker: object|null, warning: string|null }}
 */
export function mapJoker(joker, ctx) {
  const name = JOKER_NAME_BY_KEY[joker.key] ?? joker.name;
  if (!name) return { joker: null, warning: `Unknown joker "${joker.key}" is not scored` };
  if (joker.debuffed) return { joker: null, warning: `${name} is debuffed and not scored` };
  const a = joker.ability ?? {};
  const extra = a.extra;
  const out = { name, edition: EDITION_BY_TYPE[joker.edition] ?? 'Base' };

  if (X_MULT_FROM_ABILITY.has(name)) out.timesMultiplier = num(a.x_mult, 1);
  else if (name === 'Canio') out.timesMultiplier = num(a.caino_xmult, 1);
  else if (name === 'Steel Joker') out.timesMultiplier = 1 + num(extra, 0.2) * num(a.steel_tally, ctx.steelInDeck ?? 0);

  if (MULT_FROM_ABILITY.has(name)) out.plusMultiplier = num(a.mult, 0);
  else if (name === 'Erosion') out.plusMultiplier = num(extra, 4) * Math.max(0, num(ctx.startingDeckSize, 52) - num(ctx.fullDeckCount, 52));
  else if (name === 'Fortune Teller') out.plusMultiplier = num(extra, 1) * num(ctx.tarotUsed, 0);

  if (CHIPS_FROM_EXTRA.has(name)) out.plusChips = num(extra && typeof extra === 'object' ? extra.chips : undefined, 0);
  else if (name === 'Blue Joker') out.plusChips = num(extra, 2) * num(ctx.deckCount, 0);
  else if (name === 'Stone Joker') out.plusChips = num(extra, 25) * num(a.stone_tally, ctx.stoneInDeck ?? 0);
  else if (name === 'Hiker') out.plusChips = 0; // its permanent bonuses already live on the cards

  if (name === 'Loyalty Card') out.active = num(a.loyalty_remaining, 1) === 0;
  if (name === 'Card Sharp') out.active = false; // set per play by the scorer (hand type already played this round)

  if (name === 'The Idol' && ctx.idol) { out.rank = RANK_NAME[ctx.idol.rank] ?? String(ctx.idol.rank); out.suit = ctx.idol.suit; }
  if (name === 'Ancient Joker' && ctx.ancient) out.suit = ctx.ancient.suit;

  const warning = UNSCORED_WARNINGS[name] ? `${name}: ${UNSCORED_WARNINGS[name]}` : null;
  return { joker: out, warning };
}
