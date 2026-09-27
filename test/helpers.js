import { cardsFromCodes, defaultHandLevels } from '../src/engine/cards.js';

export function makeState(over = {}) {
  return {
    phase: 'selecting', stateCode: 1, ante: 1, round: 1, blindOnDeck: 'Small',
    hand: [], deck: [], discard: [],
    handsLeft: 4, discardsLeft: 3, handSize: 8,
    chipsScored: 0, target: 300,
    blind: { key: 'bl_small', name: 'Small Blind', disabled: false, usedHandTypes: [], lockedHandType: null },
    handLevels: defaultHandLevels(), jokers: [],
    flags: { fourFingers: false, shortcut: false },
    ...over,
  };
}

export const cards = cardsFromCodes;
