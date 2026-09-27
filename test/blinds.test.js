import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blindRules, cloneRules, BLIND_TEXT } from '../src/engine/blinds.js';
import { scorePlay } from '../src/engine/hands.js';
import { makeState, cards } from './helpers.js';

const withBlind = (key, name, extra = {}) => makeState({ blind: { key, name, disabled: false, usedHandTypes: [], lockedHandType: null, ...extra } });

test('suit blinds debuff their suit', () => {
  const state = withBlind('bl_club', 'The Club');
  const rules = blindRules(state);
  assert.equal(scorePlay(cards('C_9 D_9'), state, rules).score, (10 + 9) * 2);
  assert.equal(blindRules(withBlind('bl_goad', 'The Goad')).debuff(cards('S_2')[0]), true);
  assert.equal(blindRules(withBlind('bl_head', 'The Head')).debuff(cards('H_2')[0]), true);
  assert.equal(blindRules(withBlind('bl_window', 'The Window')).debuff(cards('D_2')[0]), true);
  assert.equal(blindRules(withBlind('bl_window', 'The Window')).debuff(cards('S_2')[0]), false);
});

test('the plant debuffs face cards, the pillar debuffs cards played this ante', () => {
  assert.equal(blindRules(withBlind('bl_plant', 'The Plant')).debuff(cards('S_K')[0]), true);
  assert.equal(blindRules(withBlind('bl_plant', 'The Plant')).debuff(cards('S_A')[0]), false);
  const c = cards('S_5')[0];
  c.playedThisAnte = true;
  assert.equal(blindRules(withBlind('bl_pillar', 'The Pillar')).debuff(c), true);
});

test('psychic, eye and mouth restrict legality', () => {
  assert.equal(blindRules(withBlind('bl_psychic', 'The Psychic')).playSizeExact, 5);
  const eye = blindRules(withBlind('bl_eye', 'The Eye', { usedHandTypes: ['Pair'] }));
  assert.equal(eye.trackEye, true);
  assert.equal(scorePlay(cards('S_9 D_9'), makeState(), eye).legal, false);
  assert.equal(scorePlay(cards('S_9 D_9 H_9'), makeState(), eye).legal, true);
  const mouth = blindRules(withBlind('bl_mouth', 'The Mouth', { lockedHandType: 'Flush' }));
  assert.equal(mouth.trackMouth, true);
  assert.equal(scorePlay(cards('S_9 D_9'), makeState(), mouth).legal, false);
  assert.equal(blindRules(withBlind('bl_mouth', 'The Mouth')).lockedType, null);
});

test('the arm lowers the level, the flint halves with round-half-up', () => {
  const state = withBlind('bl_arm', 'The Arm');
  state.handLevels['Pair'] = { level: 3, chips: 40, mult: 4, sChips: 10, sMult: 2, lChips: 15, lMult: 1, playedThisRound: 0 };
  assert.equal(scorePlay(cards('S_9 D_9'), state, blindRules(state)).score, (25 + 18) * 3);
  const lvl1 = withBlind('bl_arm', 'The Arm');
  assert.equal(scorePlay(cards('S_9 D_9'), lvl1, blindRules(lvl1)).score, 56);
  const flint = withBlind('bl_flint', 'The Flint');
  // High Card: chips 5 → 3, mult 1 → 1 ; (3 + 11) * 1
  assert.equal(scorePlay(cards('S_A'), flint, blindRules(flint)).score, 14);
  // Flush: chips 35 → 18, mult 4 → 2
  assert.equal(scorePlay(cards('C_2 C_5 C_9 C_J C_K'), flint, blindRules(flint)).score, (18 + 36) * 2);
});

test('serpent sets the draw override; free blinds add nothing; unknown or unmodelled bosses warn', () => {
  assert.equal(blindRules(withBlind('bl_serpent', 'The Serpent')).drawOverride, 3);
  for (const key of ['bl_small', 'bl_big', 'bl_water', 'bl_needle', 'bl_manacle', 'bl_wall', 'bl_final_vessel']) {
    assert.deepEqual(blindRules(withBlind(key, key)).warnings, []);
  }
  const hook = blindRules(withBlind('bl_hook', 'The Hook'));
  assert.equal(hook.warnings.length, 1);
  assert.match(hook.warnings[0], /The Hook/);
  assert.match(hook.warnings[0], new RegExp(BLIND_TEXT.bl_hook));
  assert.match(blindRules(withBlind('bl_mystery', 'Mystery')).warnings[0], /not modelled/);
});

test('a disabled blind applies no rules, and cloneRules copies the mutable parts', () => {
  const r = blindRules(withBlind('bl_club', 'The Club', { disabled: true }));
  assert.equal(r.debuff(cards('C_2')[0]), false);
  const eye = blindRules(withBlind('bl_eye', 'The Eye', { usedHandTypes: ['Pair'] }));
  const copy = cloneRules(eye);
  copy.bannedTypes.add('Flush');
  assert.equal(eye.bannedTypes.has('Flush'), false);
});
