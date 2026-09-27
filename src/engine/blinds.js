// Boss blind rules from Balatro's blind.lua / game.lua P_BLINDS. Only card- and hand-type constraints are modelled.
import { isFace } from './cards.js';
import { DEFAULT_RULES } from './hands.js';

export const BLIND_TEXT = {
  bl_hook: 'Discards 2 random cards per hand played',
  bl_ox: 'Playing your most played hand sets money to $0',
  bl_tooth: 'Lose $1 per card played',
  bl_fish: 'Cards drawn face down after each hand played',
  bl_house: 'First hand is drawn face down',
  bl_mark: 'All face cards are drawn face down',
  bl_wheel: '1 in 7 cards get drawn face down',
  bl_final_acorn: 'Flips and shuffles all Joker cards',
  bl_final_bell: 'Forces 1 card to always be selected',
  bl_final_heart: 'One random Joker disabled every hand',
  bl_final_leaf: 'All cards debuffed until 1 Joker sold',
};

const SUIT_DEBUFF = { bl_club: 'Clubs', bl_goad: 'Spades', bl_head: 'Hearts', bl_window: 'Diamonds' };
const FREE = new Set(['', 'bl_small', 'bl_big', 'bl_water', 'bl_needle', 'bl_manacle', 'bl_wall', 'bl_final_vessel']);

export function cloneRules(rules) {
  return { ...rules, bannedTypes: new Set(rules.bannedTypes), warnings: [...rules.warnings] };
}

export function blindRules(state) {
  const rules = cloneRules({
    ...DEFAULT_RULES,
    fourFingers: state.flags?.fourFingers === true,
    shortcut: state.flags?.shortcut === true,
  });
  const blind = state.blind ?? {};
  const key = blind.key ?? '';
  if (blind.disabled || FREE.has(key)) return rules;

  if (SUIT_DEBUFF[key]) {
    const suit = SUIT_DEBUFF[key];
    rules.debuff = (c) => c.suit === suit;
    return rules;
  }
  switch (key) {
    case 'bl_plant': rules.debuff = (c) => isFace(c); break;
    case 'bl_pillar': rules.debuff = (c) => c.playedThisAnte === true; break;
    case 'bl_psychic': rules.playSizeExact = 5; break;
    case 'bl_eye': rules.trackEye = true; rules.bannedTypes = new Set(blind.usedHandTypes ?? []); break;
    case 'bl_mouth': rules.trackMouth = true; rules.lockedType = blind.lockedHandType ?? null; break;
    case 'bl_arm': rules.levelDelta = -1; break;
    case 'bl_flint': rules.halve = true; break;
    case 'bl_serpent': rules.drawOverride = 3; break;
    default: {
      const text = BLIND_TEXT[key] ?? 'effect not modelled';
      rules.warnings.push(`${blind.name || key}: ${text} (not modelled, adjust manually)`);
    }
  }
  return rules;
}

/** Update Eye/Mouth tracking after a hand of the given type is played. */
export function afterPlay(rules, type) {
  if (rules.trackEye) rules.bannedTypes.add(type);
  if (rules.trackMouth && !rules.lockedType) rules.lockedType = type;
}
