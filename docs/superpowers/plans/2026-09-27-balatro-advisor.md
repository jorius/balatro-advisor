# Balatro Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node process that watches Balatro's autosave, scores every possible play with the game's own rules, and pushes a play/discard recommendation to a live localhost page.

**Architecture:** One-way pipeline: file watcher → deflate + Lua-table parser → `GameState` extractor → pure engine (hand evaluation, scoring, boss rules, Monte Carlo advisor) → HTTP server with Server-Sent Events → single static page. The engine has no I/O so every rule is unit-tested against values derived from the game's Lua source.

**Tech Stack:** Node 24, ES modules, zero runtime dependencies, `node:test` runner, `node:zlib`, `node:http`, vanilla HTML/JS page.

**Spec:** `docs/superpowers/specs/2026-09-27-balatro-advisor-design.md`

**Deviations from spec (decided while planning, for speed):** discard candidates are generated from "keep sets" (best plays, suit groups, rank groups, straight windows, k-lowest) instead of all 218 subsets, so the lookahead fits the 500 ms budget; after a play or discard the simulator refills the hand to hand size (3 cards under The Serpent), which equals the spec's "draw |S|" when the hand is full; The Arm's level drop is applied per play from the saved level rather than tracked across a rollout.

---

## File structure

```
balatro-advisor/
  package.json                 type=module, scripts start/test
  src/save/lua-table.js        parseLuaTable(text) — STR_PACK literal → JS
  src/save/reader.js           decodeLuaFile, readLuaFile, resolvePaths
  src/save/watcher.js          watchSave(savePath, onSnapshot) — fs.watch + poll + hash dedupe
  src/state/extract.js         extractState(raw) → GameState
  src/engine/cards.js          card model, chip values, HAND_BASE, test builders
  src/engine/hands.js          evaluateHand, scorePlay (port of evaluate_poker_hand)
  src/engine/blinds.js         blindRules(state), cloneRules, BLIND_TEXT
  src/engine/rng.js            seeded PRNG
  src/engine/advisor.js        enumeratePlays, candidateDiscards, advise
  src/server.js                createServer → { ready, broadcast, close }
  src/cli.js                   flags, pipeline wiring, payload
  public/index.html            the page
  test/helpers.js              makeState(), cards()
  test/*.test.js               one file per module
  test/fixtures/save-shop.jkr  real save captured in the shop
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `README.md`, `test/helpers.js`
- Modify: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "balatro-advisor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Watches Balatro's autosave and recommends what to play or discard.",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/cli.js",
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Create README.md**

```markdown
# Balatro Advisor

Watches `%APPDATA%\Balatro\<profile>\save.jkr`, scores every play with Balatro's own hand rules, and shows a live recommendation at http://127.0.0.1:8787.

    npm start                      # default profile from settings.jkr
    npm start -- --profile 2       # explicit profile
    npm start -- --host 0.0.0.0    # reachable from a phone on the LAN
    npm start -- --save path\to\save.jkr
    npm test

Scores card ranks, suits, hand types and Planet levels only. Jokers (except Four Fingers / Shortcut hand-detection rules), seals, editions and enhancements are not scored.
```

- [ ] **Step 3: Create test/helpers.js**

```js
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
```

- [ ] **Step 4: Commit**

```bash
git add package.json README.md test/helpers.js .gitignore
git commit -m "chore: scaffold balatro-advisor project"
```

---

### Task 2: Lua table parser

**Files:**
- Create: `src/save/lua-table.js`, `test/lua-table.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/lua-table.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLuaTable } from '../src/save/lua-table.js';

test('parses scalars, strings and nested tables', () => {
  const v = parseLuaTable('return {["a"]=1,["b"]="x",["c"]=true,["d"]=false,["e"]={["f"]=-2.5,},}');
  assert.deepEqual(v, { a: 1, b: 'x', c: true, d: false, e: { f: -2.5 } });
});

test('tables keyed 1..n become arrays regardless of entry order', () => {
  const v = parseLuaTable('return {[2]="b",[1]="a",[3]="c",}');
  assert.deepEqual(v, ['a', 'b', 'c']);
});

test('sparse or mixed tables stay objects; empty table is an empty array', () => {
  assert.deepEqual(parseLuaTable('return {[1]="a",[3]="c",}'), { 1: 'a', 3: 'c' });
  assert.deepEqual(parseLuaTable('return {[1]="a",["k"]=2,}'), { 1: 'a', k: 2 });
  assert.deepEqual(parseLuaTable('return {}'), []);
});

test('handles %q string escapes', () => {
  const v = parseLuaTable('return {["s"]="q\\"uote \\\\ back\\\nnl \\065 tab\\t",}');
  assert.equal(v.s, 'q"uote \\ back\nnl A tab\t');
});

test('handles exponent, inf and nan numbers', () => {
  const v = parseLuaTable('return {["a"]=1e+15,["b"]=inf,["c"]=-inf,["d"]=nan,["e"]=-nan(ind),["f"]=1.#INF,["g"]=-1.#IND,}');
  assert.equal(v.a, 1e15);
  assert.equal(v.b, Infinity);
  assert.equal(v.c, -Infinity);
  assert.ok(Number.isNaN(v.d));
  assert.ok(Number.isNaN(v.e));
  assert.equal(v.f, Infinity);
  assert.ok(Number.isNaN(v.g));
});

test('works without the return prefix and tolerates whitespace', () => {
  assert.deepEqual(parseLuaTable('  { ["a"] = { [1] = 1 , [2] = 2 } }  '), { a: [1, 2] });
});

test('throws on malformed input', () => {
  assert.throws(() => parseLuaTable('return {["a"]=1'), /expected/);
  assert.throws(() => parseLuaTable('return {["a"]=@,}'), /number|unexpected/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/lua-table.test.js` (or `node --test test/lua-table.test.js`)
Expected: FAIL, cannot find module `src/save/lua-table.js`.

- [ ] **Step 3: Implement the parser**

```js
// src/save/lua-table.js
// Parses the Lua table literal Balatro writes via STR_PACK (engine/string_packer.lua):
//   return {["key"]=value,[1]=value,...}
// Values: nested tables, %q-quoted strings, numbers (incl. inf/nan spellings), true/false/nil.

export function parseLuaTable(text) {
  const p = new Parser(text);
  p.skipWs();
  if (p.text.startsWith('return', p.i)) { p.i += 6; p.skipWs(); }
  const value = p.parseValue();
  p.skipWs();
  if (p.i < p.text.length) p.fail('trailing content');
  return value;
}

class Parser {
  constructor(text) { this.text = text; this.i = 0; }

  fail(msg) { throw new SyntaxError(`${msg} at offset ${this.i}`); }

  skipWs() {
    const t = this.text;
    while (this.i < t.length) {
      const c = t.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++; else break;
    }
  }

  parseValue() {
    const t = this.text;
    if (this.i >= t.length) this.fail('unexpected end');
    const c = t[this.i];
    if (c === '{') return this.parseTable();
    if (c === '"') return this.parseString();
    if (t.startsWith('true', this.i)) { this.i += 4; return true; }
    if (t.startsWith('false', this.i)) { this.i += 5; return false; }
    if (t.startsWith('nil', this.i)) { this.i += 3; return null; }
    return this.parseNumber();
  }

  parseTable() {
    this.i++; // '{'
    const entries = [];
    for (;;) {
      this.skipWs();
      const c = this.text[this.i];
      if (c === undefined) this.fail('expected } before end of input');
      if (c === '}') { this.i++; break; }
      if (c === ',') { this.i++; continue; }
      if (c !== '[') this.fail('expected [');
      this.i++;
      this.skipWs();
      const key = this.parseValue();
      this.skipWs();
      if (this.text[this.i] !== ']') this.fail('expected ]');
      this.i++;
      this.skipWs();
      if (this.text[this.i] !== '=') this.fail('expected =');
      this.i++;
      this.skipWs();
      entries.push([key, this.parseValue()]);
    }
    return toJs(entries);
  }

  parseString() {
    const t = this.text;
    let i = this.i + 1;
    let out = '';
    for (;;) {
      if (i >= t.length) this.fail('unterminated string');
      const c = t[i];
      if (c === '"') { i++; break; }
      if (c !== '\\') { out += c; i++; continue; }
      const d = t[i + 1];
      if (d === undefined) this.fail('unterminated escape');
      if (d >= '0' && d <= '9') {
        let j = i + 1, digits = '';
        while (j < i + 4 && t[j] >= '0' && t[j] <= '9') digits += t[j++];
        out += String.fromCharCode(parseInt(digits, 10));
        i = j;
        continue;
      }
      switch (d) {
        case 'n': case '\n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        default: out += d; // \\ \" \'
      }
      i += 2;
    }
    this.i = i;
    return out;
  }

  parseNumber() {
    const t = this.text;
    let j = this.i;
    while (j < t.length && isNumberChar(t.charCodeAt(j))) j++;
    const tok = t.slice(this.i, j);
    if (!tok) this.fail(`unexpected character '${t[this.i]}'`);
    this.i = j;
    const low = tok.toLowerCase();
    const neg = low.startsWith('-');
    if (low.includes('nan') || low.includes('#ind') || low.includes('#qnan')) return NaN;
    if (low === 'inf' || low === '+inf' || low === '-inf' || low.includes('#inf')) return neg ? -Infinity : Infinity;
    const n = Number(tok);
    if (Number.isNaN(n)) this.fail(`bad number '${tok}'`);
    return n;
  }
}

function isNumberChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 43 || c === 45 || c === 35 || c === 40 || c === 41; // . + - # ( )
}

function toJs(entries) {
  if (entries.length === 0) return [];
  const n = entries.length;
  const seen = new Uint8Array(n + 1);
  let isArray = true;
  for (const [k] of entries) {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > n || seen[k]) { isArray = false; break; }
    seen[k] = 1;
  }
  if (isArray) {
    const arr = new Array(n);
    for (const [k, v] of entries) arr[k - 1] = v;
    return arr;
  }
  const obj = {};
  for (const [k, v] of entries) obj[String(k)] = v;
  return obj;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/lua-table.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/save/lua-table.js test/lua-table.test.js
git commit -m "feat: parse Balatro STR_PACK Lua table literals"
```

---

### Task 3: Save reader

**Files:**
- Create: `src/save/reader.js`, `test/reader.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/reader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodeLuaFile, readLuaFile, resolvePaths } from '../src/save/reader.js';

test('decodeLuaFile accepts plain and raw-deflate content', () => {
  const plain = 'return {["a"]=1,}';
  assert.equal(decodeLuaFile(Buffer.from(plain)), plain);
  assert.equal(decodeLuaFile(deflateRawSync(Buffer.from(plain))), plain);
});

test('readLuaFile reads a compressed file from disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  const file = path.join(dir, 'save.jkr');
  await writeFile(file, deflateRawSync(Buffer.from('return {["x"]=2,}')));
  assert.equal(await readLuaFile(file), 'return {["x"]=2,}');
});

test('resolvePaths uses the profile from settings.jkr', async () => {
  const appData = await mkdtemp(path.join(tmpdir(), 'adv-'));
  await mkdir(path.join(appData, 'Balatro'), { recursive: true });
  await writeFile(path.join(appData, 'Balatro', 'settings.jkr'), 'return {["profile"]=3,}');
  const { savePath } = await resolvePaths({ appData });
  assert.equal(savePath, path.join(appData, 'Balatro', '3', 'save.jkr'));
});

test('resolvePaths falls back to profile 1 and honours overrides', async () => {
  const appData = await mkdtemp(path.join(tmpdir(), 'adv-'));
  assert.equal((await resolvePaths({ appData })).savePath, path.join(appData, 'Balatro', '1', 'save.jkr'));
  assert.equal((await resolvePaths({ appData, profile: 2 })).savePath, path.join(appData, 'Balatro', '2', 'save.jkr'));
  assert.equal((await resolvePaths({ appData, save: 'C:/x/save.jkr' })).savePath, path.resolve('C:/x/save.jkr'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/reader.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the reader**

```js
// src/save/reader.js
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { parseLuaTable } from './lua-table.js';

/** Balatro stores .jkr files either as plain "return {...}" text or as a raw deflate stream. */
export function decodeLuaFile(buf) {
  if (buf.subarray(0, 6).toString('latin1') === 'return') return buf.toString('latin1');
  return inflateRawSync(buf).toString('latin1');
}

export async function readLuaFile(filePath) {
  return decodeLuaFile(await readFile(filePath));
}

export async function resolvePaths({ appData = process.env.APPDATA, profile = null, save = null } = {}) {
  if (save) return { settingsPath: null, savePath: path.resolve(save) };
  const base = path.join(appData, 'Balatro');
  const settingsPath = path.join(base, 'settings.jkr');
  let prof = profile;
  if (prof == null) {
    try {
      const settings = parseLuaTable(await readLuaFile(settingsPath));
      prof = Number.isInteger(settings?.profile) ? settings.profile : 1;
    } catch {
      prof = 1;
    }
  }
  return { settingsPath, savePath: path.join(base, String(prof), 'save.jkr') };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/reader.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/save/reader.js test/reader.test.js
git commit -m "feat: read and decode Balatro save files"
```

---

### Task 4: Card model

**Files:**
- Create: `src/engine/cards.js`, `test/cards.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/cards.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipValue, cardFromCode, cardsFromCodes, cardFromSave, isFace, HAND_BASE, defaultHandLevels } from '../src/engine/cards.js';

test('chip values follow Balatro: 2-10 face value, J/Q/K 10, A 11', () => {
  assert.equal(chipValue(2), 2);
  assert.equal(chipValue(10), 10);
  assert.equal(chipValue(11), 10);
  assert.equal(chipValue(13), 10);
  assert.equal(chipValue(14), 11);
});

test('cardFromCode builds a card with label and chips', () => {
  const c = cardFromCode('H_Q');
  assert.equal(c.rank, 12);
  assert.equal(c.suit, 'Hearts');
  assert.equal(c.chips, 10);
  assert.equal(c.label, 'Q♥');
  assert.equal(isFace(c), true);
  assert.equal(isFace(cardFromCode('S_A')), false);
});

test('cardsFromCodes gives unique ids', () => {
  const cs = cards('S_9 D_9 S_9');
  assert.equal(cs.length, 3);
  assert.equal(new Set(cs.map(c => c.id)).size, 3);
});

test('cardFromSave maps save fields and rejects junk', () => {
  const raw = { sort_id: 236, debuff: true, ability: { played_this_ante: true }, base: { id: 12, suit: 'Clubs', nominal: 10, value: 'Queen' } };
  const c = cardFromSave(raw, 'hand0');
  assert.equal(c.id, 'c236');
  assert.equal(c.rank, 12);
  assert.equal(c.suit, 'Clubs');
  assert.equal(c.chips, 10);
  assert.equal(c.debuffed, true);
  assert.equal(c.playedThisAnte, true);
  assert.equal(cardFromSave({ base: { id: 99, suit: 'Clubs' } }, 'x'), null);
  assert.equal(cardFromSave({}, 'x'), null);
});

test('HAND_BASE matches game.lua and defaultHandLevels expands it', () => {
  assert.deepEqual(HAND_BASE['Pair'], [10, 2, 15, 1]);
  assert.deepEqual(HAND_BASE['Straight Flush'], [100, 8, 40, 4]);
  const lv = defaultHandLevels();
  assert.deepEqual(lv['Two Pair'], { level: 1, chips: 20, mult: 2, sChips: 20, sMult: 2, lChips: 20, lMult: 1, playedThisRound: 0 });
  assert.equal(Object.keys(lv).length, 12);
});

function cards(s) { return cardsFromCodes(s); }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cards.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement cards.js**

```js
// src/engine/cards.js
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
```

- [ ] **Step 4: Run tests**

Run: `node --test test/cards.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/cards.js test/cards.test.js
git commit -m "feat: card model and hand base table"
```

---
### Task 5: Hand evaluation (port of evaluate_poker_hand)

**Files:**
- Create: `src/engine/hands.js`, `test/hands.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/hands.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHand, DEFAULT_RULES } from '../src/engine/hands.js';
import { cards } from './helpers.js';

const type = (s, rules) => evaluateHand(cards(s), rules).type;
const scoring = (s, rules) => evaluateHand(cards(s), rules).scoringCards.map(c => c.label).sort();

test('detects every hand type in precedence order', () => {
  assert.equal(type('S_A S_A S_A S_A S_A'), 'Flush Five');
  assert.equal(type('H_K H_K H_K H_3 H_3'), 'Flush House');
  assert.equal(type('S_A H_A C_A D_A S_A'), 'Five of a Kind');
  assert.equal(type('D_9 D_T D_J D_Q D_K'), 'Straight Flush');
  assert.equal(type('S_7 H_7 C_7 D_7 S_2'), 'Four of a Kind');
  assert.equal(type('S_7 H_7 C_7 D_2 S_2'), 'Full House');
  assert.equal(type('C_2 C_5 C_9 C_J C_K'), 'Flush');
  assert.equal(type('S_5 H_6 C_7 D_8 S_9'), 'Straight');
  assert.equal(type('S_7 H_7 C_7 D_2 S_3'), 'Three of a Kind');
  assert.equal(type('S_7 H_7 C_2 D_2 S_3'), 'Two Pair');
  assert.equal(type('S_7 H_7 C_2 D_4 S_3'), 'Pair');
  assert.equal(type('S_7 H_9 C_2 D_4 S_3'), 'High Card');
});

test('ace-low and ace-high straights', () => {
  assert.equal(type('S_A H_2 C_3 D_4 S_5'), 'Straight');
  assert.equal(type('S_T H_J C_Q D_K S_A'), 'Straight');
  assert.equal(type('S_Q H_K C_A D_2 S_3'), 'High Card'); // no wrap-around
});

test('only the cards that form the hand score', () => {
  assert.deepEqual(scoring('S_9 D_9 H_K C_2 S_3'), ['9♠', '9♦']);
  assert.deepEqual(scoring('S_A H_9 C_2 D_4 S_3'), ['A♠']);
  assert.deepEqual(scoring('S_7 H_7 C_2 D_2 S_3'), ['2♣', '2♦', '7♠', '7♥']);
  assert.deepEqual(scoring('C_2 C_5 C_9 C_J C_K').length, 5);
});

test('high card picks the highest nominal (Ace over King, King over Queen)', () => {
  assert.deepEqual(scoring('S_K H_Q C_2'), ['K♠']);
  assert.deepEqual(scoring('S_K H_A'), ['A♥']);
});

test('four fingers allows 4-card flushes and straights', () => {
  const ff = { ...DEFAULT_RULES, fourFingers: true };
  assert.equal(type('C_2 C_5 C_9 C_J'), 'High Card');
  assert.equal(type('C_2 C_5 C_9 C_J', ff), 'Flush');
  assert.equal(type('C_2 C_5 C_9 C_J D_K', ff), 'Flush');
  assert.deepEqual(scoring('C_2 C_5 C_9 C_J D_K', ff), ['2♣', '5♣', '9♣', 'J♣']);
  assert.equal(type('S_5 H_6 C_7 D_8', ff), 'Straight');
});

test('shortcut allows one gap in a straight', () => {
  const sc = { ...DEFAULT_RULES, shortcut: true };
  assert.equal(type('S_2 H_3 C_5 D_6 S_7'), 'High Card');
  assert.equal(type('S_2 H_3 C_5 D_6 S_7', sc), 'Straight');
  assert.equal(type('S_2 H_4 C_6 D_8 S_T', sc), 'High Card'); // two gaps
});

test('1 to 5 cards; more than 5 never forms flush or straight', () => {
  assert.equal(type('S_A'), 'High Card');
  assert.equal(type('S_A H_A'), 'Pair');
  assert.equal(evaluateHand([]), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/hands.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement evaluateHand**

```js
// src/engine/hands.js
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
```

- [ ] **Step 4: Run tests**

Run: `node --test test/hands.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/hands.js test/hands.test.js
git commit -m "feat: port Balatro hand evaluation and play scoring"
```

---

### Task 6: Scoring tests and boss blind rules

**Files:**
- Create: `src/engine/blinds.js`, `test/scoring.test.js`, `test/blinds.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/scoring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlay, DEFAULT_RULES } from '../src/engine/hands.js';
import { makeState, cards } from './helpers.js';

test('level-1 pair of nines scores (10 + 18) x 2 = 56', () => {
  const r = scorePlay(cards('S_9 D_9'), makeState());
  assert.equal(r.legal, true);
  assert.equal(r.type, 'Pair');
  assert.equal(r.score, 56);
});

test('kickers do not add chips', () => {
  assert.equal(scorePlay(cards('S_9 D_9 H_K C_2 S_3'), makeState()).score, 56);
});

test('planet levels come from state.handLevels', () => {
  const state = makeState();
  state.handLevels['Pair'] = { level: 3, chips: 40, mult: 4, sChips: 10, sMult: 2, lChips: 15, lMult: 1, playedThisRound: 0 };
  assert.equal(scorePlay(cards('S_9 D_9'), state).score, (40 + 18) * 4);
});

test('debuffed cards count for the type but score no chips', () => {
  const cs = cards('S_9 D_9');
  cs[0].debuffed = true;
  assert.equal(scorePlay(cs, makeState()).score, (10 + 9) * 2);
});

test('a flush of level 1 scores hand chips plus all five cards', () => {
  const r = scorePlay(cards('C_2 C_5 C_9 C_J C_K'), makeState());
  assert.equal(r.type, 'Flush');
  assert.equal(r.score, (35 + 2 + 5 + 9 + 10 + 10) * 4);
});

test('illegal plays report a reason', () => {
  assert.equal(scorePlay([], makeState()).legal, false);
  assert.equal(scorePlay(cards('S_2 S_3 S_4 S_5 S_6 S_7'), makeState()).legal, false);
  const psychic = { ...DEFAULT_RULES, playSizeExact: 5 };
  assert.match(scorePlay(cards('S_9 D_9'), makeState(), psychic).reason, /5 cards/);
});
```

```js
// test/blinds.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoring.test.js test/blinds.test.js`
Expected: scoring tests pass (they only use Task 5 code); blinds tests FAIL with cannot find module.

- [ ] **Step 3: Implement blinds.js**

```js
// src/engine/blinds.js
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
```

- [ ] **Step 4: Run tests**

Run: `node --test test/scoring.test.js test/blinds.test.js`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add src/engine/blinds.js test/scoring.test.js test/blinds.test.js
git commit -m "feat: boss blind rules and scoring tests"
```

---

### Task 7: State extractor with a real save fixture

**Files:**
- Create: `src/state/extract.js`, `test/extract.test.js`, `test/fixtures/save-shop.jkr` (copy of `%APPDATA%\Balatro\1\save.jkr`)

- [ ] **Step 1: Copy the fixture**

```bash
mkdir -p test/fixtures && cp "$APPDATA/Balatro/1/save.jkr" test/fixtures/save-shop.jkr
```

- [ ] **Step 2: Write the failing tests**

```js
// test/extract.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeLuaFile } from '../src/save/reader.js';
import { parseLuaTable } from '../src/save/lua-table.js';
import { extractState, toList } from '../src/state/extract.js';

const fixture = new URL('./fixtures/save-shop.jkr', import.meta.url);

test('extracts a real save captured in the shop', async () => {
  const raw = parseLuaTable(decodeLuaFile(await readFile(fixture)));
  const s = extractState(raw);
  assert.equal(s.phase, 'shop');
  assert.equal(s.stateCode, 5);
  assert.equal(s.hand.length, 0);
  assert.equal(s.deck.length, 52);
  assert.equal(s.handsLeft, 4);
  assert.equal(s.discardsLeft, 4);
  assert.equal(s.handSize, 8);
  assert.equal(s.ante, 1);
  assert.equal(s.handLevels['Two Pair'].chips, 20);
  assert.equal(s.handLevels['Two Pair'].lChips, 20);
  assert.equal(Object.keys(s.handLevels).length, 12);
  assert.equal(s.jokers.length, 0);
  assert.equal(new Set(s.deck.map(c => c.id)).size, 52);
  assert.deepEqual(s.flags, { fourFingers: false, shortcut: false });
});

function rawCard(sortId, id, suit, extra = {}) {
  return { sort_id: sortId, debuff: false, base: { id, suit, nominal: id === 14 ? 11 : id > 10 ? 10 : id }, ...extra };
}

test('extracts a synthetic selecting-hand save', () => {
  const raw = {
    STATE: 1,
    BLIND: { name: 'The Eye', config_blind: 'bl_eye', chips: 800, disabled: false, hands: { Pair: true }, only_hand: false },
    cardAreas: {
      hand: { cards: [rawCard(1, 9, 'Spades'), rawCard(2, 9, 'Hearts'), rawCard(3, 14, 'Clubs')], config: { card_limit: 8 } },
      deck: { cards: [rawCard(4, 2, 'Diamonds'), rawCard(5, 3, 'Diamonds')] },
      discard: { cards: [] },
      jokers: { cards: [{ save_fields: { center: 'j_four_fingers' }, label: 'Four Fingers' }] },
    },
    GAME: {
      chips: 150, round: 3, blind_on_deck: 'Boss',
      round_resets: { ante: 2 },
      current_round: { hands_left: 2, discards_left: 1 },
      hands: { Pair: { level: 2, chips: 25, mult: 3, s_chips: 10, s_mult: 2, l_chips: 15, l_mult: 1, played_this_round: 1 } },
    },
  };
  const s = extractState(raw);
  assert.equal(s.phase, 'selecting');
  assert.equal(s.hand.map(c => c.label).join(' '), '9♠ 9♥ A♣');
  assert.equal(s.deck.length, 2);
  assert.equal(s.chipsScored, 150);
  assert.equal(s.target, 800);
  assert.equal(s.ante, 2);
  assert.equal(s.round, 3);
  assert.equal(s.blindOnDeck, 'Boss');
  assert.equal(s.handsLeft, 2);
  assert.equal(s.discardsLeft, 1);
  assert.deepEqual(s.blind, { key: 'bl_eye', name: 'The Eye', disabled: false, usedHandTypes: ['Pair'], lockedHandType: null });
  assert.equal(s.handLevels.Pair.level, 2);
  assert.equal(s.handLevels.Pair.playedThisRound, 1);
  assert.deepEqual(s.jokers, [{ key: 'j_four_fingers', name: 'Four Fingers' }]);
  assert.deepEqual(s.flags, { fourFingers: true, shortcut: false });
});

test('tolerates missing sections and empty tables parsed as arrays', () => {
  const s = extractState({ STATE: 7, cardAreas: { hand: { cards: [] } }, BLIND: { hands: [] , only_hand: false } });
  assert.equal(s.phase, 'blind_select');
  assert.deepEqual(s.hand, []);
  assert.deepEqual(s.blind.usedHandTypes, []);
  assert.equal(s.blind.lockedHandType, null);
  assert.throws(() => extractState(null), TypeError);
});

test('toList accepts arrays, numeric-key objects and junk', () => {
  assert.deepEqual(toList([1, 2]), [1, 2]);
  assert.deepEqual(toList({ 2: 'b', 1: 'a' }), ['a', 'b']);
  assert.deepEqual(toList(undefined), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/extract.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Implement extract.js**

```js
// src/state/extract.js
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
```

- [ ] **Step 5: Run tests**

Run: `node --test test/extract.test.js`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add src/state/extract.js test/extract.test.js test/fixtures/save-shop.jkr
git commit -m "feat: extract GameState from parsed save"
```

---
### Task 8: Seeded RNG and advisor

**Files:**
- Create: `src/engine/rng.js`, `src/engine/advisor.js`, `test/advisor.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/advisor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/rng.js';
import { enumeratePlays, candidateDiscards, advise } from '../src/engine/advisor.js';
import { blindRules } from '../src/engine/blinds.js';
import { makeState, cards } from './helpers.js';

const labels = (cs) => cs.map(c => c.label).join(' ');

test('rng is deterministic per seed and in [0,1)', () => {
  const a = createRng('abc'), b = createRng('abc'), c = createRng('abd');
  const xs = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], xs);
  assert.notDeepEqual([c(), c(), c()], xs);
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('enumeratePlays ranks every legal subset by score', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3') });
  const plays = enumeratePlays(state.hand, state, blindRules(state));
  assert.equal(plays.length, 31); // 5 + 10 + 10 + 5 + 1
  assert.equal(plays[0].type, 'Pair');
  assert.equal(plays[0].score, 56);
  assert.equal(plays[0].cards.length, 2); // shortest among equal scores first
});

test('candidateDiscards keeps flush draws, pairs and low-card dumps, all unique and 1-5 cards', () => {
  const hand = cards('H_2 H_7 H_9 H_J S_9 C_3 D_4 S_K');
  const state = makeState({ hand });
  const ds = candidateDiscards(hand, enumeratePlays(hand, state, blindRules(state)));
  const keys = ds.map(d => d.map(c => c.id).sort().join(','));
  assert.equal(new Set(keys).size, keys.length);
  for (const d of ds) assert.ok(d.length >= 1 && d.length <= 5);
  // keeps the four hearts → discards the other four
  assert.ok(ds.some(d => labels(d).split(' ').sort().join(' ') === '3♣ 4♦ 9♠ K♠'));
  // keeps the pair of nines
  assert.ok(ds.some(d => !d.some(c => c.rank === 9)));
});

test('immediate win: recommends the best clearing play', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3 D_7 C_8 H_A'), target: 50, chipsScored: 0 });
  const a = advise(state, { seed: 't' });
  assert.equal(a.action, 'play');
  assert.equal(a.clearsBlind, true);
  assert.equal(a.pClear, 1);
  assert.equal(a.handType, 'Pair');
  assert.equal(a.score, 56);
  assert.match(a.reason, /clears/);
  assert.ok(a.topPlays.length > 0);
});

test('prefers discarding to a one-card flush draw over a weak play when hands are scarce', () => {
  // Hand: four hearts + junk. Deck: mostly hearts so the draw almost always completes the flush.
  const hand = cards('H_2 H_7 H_9 H_J S_4 C_3 D_6 S_8');
  const deck = cards('H_3 H_4 H_5 H_6 H_8 H_T H_Q H_K H_A S_2');
  const state = makeState({ hand, deck, target: 250, handsLeft: 1, discardsLeft: 2 });
  const a = advise(state, { seed: 'flush', minSamples: 64, maxSamples: 64 });
  assert.equal(a.action, 'discard');
  assert.ok(!a.cards.some(c => c.label === "9♥" || c.label === "J♥"));
  assert.ok(a.pClear > 0.5, `pClear was ${a.pClear}`);
});

test('plays when no discards are left and the hand cannot clear', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3'), deck: cards('S_2 S_5'), target: 1000, handsLeft: 2, discardsLeft: 0 });
  const a = advise(state, { seed: 'x', minSamples: 16, maxSamples: 16 });
  assert.equal(a.action, 'play');
  assert.equal(a.clearsBlind, false);
  assert.ok(a.alternatives.every(o => o.action === 'play'));
});

test('respects boss rules: psychic forces 5 cards, eye bans repeats', () => {
  const psychic = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3 D_7'), target: 10, blind: { key: 'bl_psychic', name: 'The Psychic', disabled: false, usedHandTypes: [], lockedHandType: null } });
  assert.equal(advise(psychic, { seed: 'p' }).cards.length, 5);
  const eye = makeState({ hand: cards('S_9 D_9 H_K C_2 S_3'), target: 10, blind: { key: 'bl_eye', name: 'The Eye', disabled: false, usedHandTypes: ['Pair'], lockedHandType: null } });
  assert.notEqual(advise(eye, { seed: 'e' }).handType, 'Pair');
});

test('is deterministic for the same seed and reports timing', () => {
  const state = makeState({ hand: cards('H_2 H_7 H_9 H_J S_4 C_3 D_6 S_8'), deck: cards('H_3 S_5 C_6 D_7 H_8 S_T H_Q C_K D_A S_2 C_4 D_9'), target: 400 });
  const a = advise(state, { seed: 's', minSamples: 16, maxSamples: 16 });
  const b = advise(state, { seed: 's', minSamples: 16, maxSamples: 16 });
  assert.equal(a.action, b.action);
  assert.equal(labels(a.cards), labels(b.cards));
  assert.equal(a.pClear, b.pClear);
  assert.ok(a.elapsedMs >= 0);
  assert.equal(a.samples, 16);
});

test('non-selecting phase or no hands left yields no action', () => {
  assert.equal(advise(makeState({ phase: 'shop' })).action, 'none');
  assert.equal(advise(makeState({ hand: cards('S_2'), handsLeft: 0 })).action, 'none');
});

test('an 8-card hand with 4 discards stays within the budget', () => {
  const hand = cards('H_2 H_7 S_9 H_J S_4 C_3 D_6 S_8');
  const deck = cards('H_3 S_5 C_6 D_7 H_8 S_T H_Q C_K D_A S_2 C_4 D_9 H_5 S_6 C_7 D_8 H_T S_J C_Q D_K H_A S_3 C_5 D_2');
  const state = makeState({ hand, deck, target: 600, handsLeft: 3, discardsLeft: 4 });
  const t0 = performance.now();
  const a = advise(state, { seed: 'b', budgetMs: 500 });
  const took = performance.now() - t0;
  assert.ok(took < 1500, `took ${took}ms`);
  assert.ok(a.samples >= 32);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/advisor.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement rng.js**

```js
// src/engine/rng.js
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** mulberry32 seeded from a number or string. Returns () => float in [0, 1). */
export function createRng(seed) {
  let a = (typeof seed === 'number' ? seed >>> 0 : hashString(String(seed))) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Implement advisor.js**

```js
// src/engine/advisor.js
import { SUITS } from './cards.js';
import { scorePlay } from './hands.js';
import { blindRules, cloneRules, afterPlay } from './blinds.js';
import { createRng } from './rng.js';

export function subsetsOf(items, minSize, maxSize) {
  const out = [];
  const cur = [];
  const n = items.length;
  (function rec(start) {
    if (cur.length >= minSize) out.push(cur.slice());
    if (cur.length === maxSize) return;
    for (let i = start; i < n; i++) {
      cur.push(items[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

/** Every legal play from the hand, best first (score desc, then fewer cards). */
export function enumeratePlays(hand, state, rules) {
  const min = rules.playSizeExact ?? 1;
  const max = Math.min(rules.playSizeExact ?? 5, hand.length);
  if (min > hand.length) return [];
  const plays = [];
  for (const cards of subsetsOf(hand, min, max)) {
    const r = scorePlay(cards, state, rules);
    if (r.legal) plays.push({ cards, type: r.type, score: r.score, scoringCards: r.scoringCards, handChips: r.handChips, handMult: r.handMult });
  }
  plays.sort((a, b) => b.score - a.score || a.cards.length - b.cards.length);
  return plays;
}

const byChipsAsc = (a, b) => a.chips - b.chips || a.rank - b.rank;
const byChipsDesc = (a, b) => b.chips - a.chips || b.rank - a.rank;

/** Discard sets worth considering: the complement of each "keep set", plus the k lowest cards. */
export function candidateDiscards(hand, plays) {
  const keeps = [];
  for (const p of plays.slice(0, 3)) keeps.push(new Set(p.cards));
  for (const suit of SUITS) {
    const s = hand.filter((c) => c.suit === suit);
    if (s.length >= 3) keeps.push(new Set(s.sort(byChipsDesc).slice(0, 5)));
  }
  const groups = [];
  for (let r = 14; r >= 2; r--) {
    const g = hand.filter((c) => c.rank === r);
    if (g.length >= 2) groups.push(g);
  }
  for (const g of groups) keeps.push(new Set(g));
  if (groups.length >= 2) keeps.push(new Set([...groups[0], ...groups[1]]));
  for (let start = 1; start <= 10; start++) {
    const keep = [];
    for (let r = start; r <= start + 4; r++) {
      const rank = r === 1 ? 14 : r;
      const best = hand.filter((c) => c.rank === rank).sort(byChipsDesc)[0];
      if (best) keep.push(best);
    }
    if (keep.length >= 3) keeps.push(new Set(keep));
  }

  const sorted = [...hand].sort(byChipsAsc);
  const seen = new Map();
  const add = (cards) => {
    if (cards.length < 1 || cards.length > 5) return;
    const key = cards.map((c) => c.id).sort().join(',');
    if (!seen.has(key)) seen.set(key, cards);
  };
  for (const keep of keeps) add(sorted.filter((c) => !keep.has(c)).slice(0, 5));
  for (let k = 1; k <= 5; k++) add(sorted.slice(0, k));
  return [...seen.values()];
}

/** One greedy rollout from the root state after applying `action`. Returns { cleared, chips }. */
function simulate(root, action, rng) {
  const deck = root.state.deck.slice();
  let deckN = deck.length;
  let hand = root.state.hand.slice();
  let chips = root.state.chipsScored;
  let handsLeft = root.state.handsLeft;
  let discardsLeft = root.state.discardsLeft;
  const rules = cloneRules(root.rules);

  const draw = () => {
    const want = rules.drawOverride ?? Math.max(0, root.handSize - hand.length);
    const k = Math.min(want, deckN);
    for (let i = 0; i < k; i++) {
      const j = Math.floor(rng() * deckN);
      const c = deck[j];
      deck[j] = deck[deckN - 1];
      deck[deckN - 1] = c;
      deckN--;
      hand.push(c);
    }
  };
  const remove = (cards) => { const gone = new Set(cards); hand = hand.filter((c) => !gone.has(c)); };
  const play = (p) => { chips += p.score; handsLeft--; afterPlay(rules, p.type); remove(p.cards); draw(); };
  const discard = (cards) => { discardsLeft--; remove(cards); draw(); };

  if (action.action === 'play') play(action.play); else discard(action.cards);

  while (chips < root.target && handsLeft > 0) {
    const plays = enumeratePlays(hand, root.state, rules);
    if (plays.length === 0) break;
    const best = plays[0];
    if (chips + best.score >= root.target || discardsLeft <= 0) { play(best); continue; }
    const keep = new Set(best.cards);
    const junk = hand.filter((c) => !keep.has(c)).sort(byChipsAsc).slice(0, 5);
    if (junk.length === 0) { play(best); continue; }
    discard(junk);
  }
  return { cleared: chips >= root.target, chips };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const summarizePlay = (p) => ({ cards: p.cards, handType: p.type, score: p.score });
const stripOption = (o) => ({ action: o.action, cards: o.cards, handType: o.handType, score: o.score, pClear: o.pClear, expChips: o.expChips, samples: o.samples });

/**
 * Recommend a play or discard for a GameState in the 'selecting' phase.
 * opts: { budgetMs=500, seed='', minSamples=32, maxSamples=512 }
 */
export function advise(state, opts = {}) {
  const t0 = performance.now();
  const budgetMs = opts.budgetMs ?? 500;
  const minSamples = opts.minSamples ?? 32;
  const maxSamples = Math.max(opts.maxSamples ?? 512, minSamples);
  const seed = String(opts.seed ?? '');
  const rules = blindRules(state);
  const remaining = Math.max(0, state.target - state.chipsScored);
  const base = {
    action: 'none', cards: [], handType: undefined, score: undefined, clearsBlind: false, remaining,
    pClear: 0, expChips: state.chipsScored, reason: '', alternatives: [], topPlays: [],
    warnings: [...rules.warnings], samples: 0, elapsedMs: 0, seed,
  };
  const done = (fields) => ({ ...base, ...fields, elapsedMs: performance.now() - t0 });

  if (state.phase !== 'selecting') return done({ reason: 'Not choosing cards right now.' });
  if (state.handsLeft <= 0) return done({ reason: 'No hands left this round.' });

  const plays = enumeratePlays(state.hand, state, rules);
  const topPlays = plays.slice(0, 8).map(summarizePlay);
  if (plays.length === 0) {
    return done({ topPlays, warnings: [...base.warnings, 'No legal play with the current hand.'], reason: 'No legal play.' });
  }
  const best = plays[0];

  if (best.score >= remaining) {
    const clearing = plays.filter((p) => p.score >= remaining);
    return done({
      action: 'play', cards: best.cards, handType: best.type, score: best.score, clearsBlind: true, pClear: 1,
      expChips: state.chipsScored + best.score, topPlays,
      reason: `${best.type} for ${best.score} clears the blind (${remaining} needed).`,
      alternatives: clearing.slice(1, 7).map((p) => ({ action: 'play', cards: p.cards, handType: p.type, score: p.score, pClear: 1, expChips: state.chipsScored + p.score, samples: 0 })),
    });
  }

  const candidates = plays.slice(0, 5).map((p) => ({ action: 'play', play: p, cards: p.cards, handType: p.type, score: p.score }));
  if (state.discardsLeft > 0) {
    for (const cards of candidateDiscards(state.hand, plays)) candidates.push({ action: 'discard', cards });
  }
  const root = { state, rules, handSize: Math.max(state.handSize, state.hand.length), target: state.target };
  const rng = createRng(seed);
  const stats = candidates.map(() => ({ n: 0, cleared: 0, chips: 0 }));
  let samplesPer = 0;
  let batch = minSamples;
  do {
    for (let ci = 0; ci < candidates.length; ci++) {
      const s = stats[ci];
      for (let k = 0; k < batch; k++) {
        const r = simulate(root, candidates[ci], rng);
        s.n++;
        if (r.cleared) s.cleared++;
        s.chips += r.chips;
      }
    }
    samplesPer += batch;
    batch = samplesPer;
  } while (samplesPer < maxSamples && performance.now() - t0 < budgetMs * 0.6);

  const scored = candidates.map((c, i) => ({ ...c, pClear: stats[i].cleared / stats[i].n, expChips: stats[i].chips / stats[i].n, samples: stats[i].n }));
  scored.sort((a, b) => b.pClear - a.pClear || b.expChips - a.expChips || (a.action === 'play' ? -1 : 1) - (b.action === 'play' ? -1 : 1));
  const top = scored[0];
  const bestPlayOpt = scored.find((c) => c.action === 'play');
  const bestDiscardOpt = scored.find((c) => c.action === 'discard');
  const cardList = (cs) => cs.map((c) => c.label).join(' ');

  let reason;
  if (top.action === 'play') {
    reason = `Play ${top.handType} for ${top.score} (${pct(top.pClear)} to clear this round`;
    reason += bestDiscardOpt ? `; best discard ${pct(bestDiscardOpt.pClear)}).` : ').';
  } else {
    reason = `Discard ${cardList(top.cards)}: ${pct(top.pClear)} to clear this round vs ${pct(bestPlayOpt.pClear)} playing ${bestPlayOpt.handType} now.`;
  }

  return done({
    action: top.action, cards: top.cards, handType: top.handType, score: top.score, clearsBlind: false,
    pClear: top.pClear, expChips: top.expChips, reason, topPlays,
    alternatives: scored.slice(1, 7).map(stripOption), samples: samplesPer,
  });
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/advisor.test.js`
Expected: 10 passing. If the timing test fails, lower `minSamples` default to 16 and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/engine/rng.js src/engine/advisor.js test/advisor.test.js
git commit -m "feat: Monte Carlo play/discard advisor"
```

---

### Task 9: Save watcher

**Files:**
- Create: `src/save/watcher.js`, `test/watcher.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/watcher.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchSave } from '../src/save/watcher.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('emits a snapshot per distinct content, including files created later', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  const file = path.join(dir, 'save.jkr');
  const seen = [];
  const w = watchSave(file, (s) => seen.push(s), { debounceMs: 20, pollMs: 100 });
  try {
    await wait(150);
    assert.equal(seen.length, 0);
    await writeFile(file, 'return {["a"]=1,}');
    await wait(300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].buf.toString(), 'return {["a"]=1,}');
    assert.equal(typeof seen[0].hash, 'string');
    await writeFile(file, 'return {["a"]=1,}'); // same content → no new snapshot
    await wait(300);
    assert.equal(seen.length, 1);
    await writeFile(file, 'return {["a"]=2,}');
    await wait(300);
    assert.equal(seen.length, 2);
  } finally {
    w.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/watcher.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement watcher.js**

```js
// src/save/watcher.js
import { watch, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Watches savePath and calls onSnapshot({ buf, hash, path }) whenever its content changes.
 * Uses fs.watch on the directory (so a file created later is seen) plus a slow poll as a safety net.
 * Read errors other than "file missing" are reported as onSnapshot({ error, path }).
 */
export function watchSave(savePath, onSnapshot, { debounceMs = 150, pollMs = 2000 } = {}) {
  const dir = path.dirname(savePath);
  const file = path.basename(savePath);
  let timer = null;
  let lastHash = null;
  let closed = false;
  let watcher = null;

  async function check() {
    if (closed) return;
    try {
      const buf = await readFile(savePath);
      const hash = createHash('sha1').update(buf).digest('hex');
      if (hash === lastHash) return;
      lastHash = hash;
      onSnapshot({ buf, hash, path: savePath });
    } catch (e) {
      if (e.code !== 'ENOENT') onSnapshot({ error: e, path: savePath });
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  }

  function startWatch() {
    if (watcher || !existsSync(dir)) return;
    try {
      watcher = watch(dir, (_event, name) => { if (!name || name === file) schedule(); });
      watcher.on('error', () => { watcher = null; });
    } catch {
      watcher = null;
    }
  }

  startWatch();
  const poll = setInterval(() => { startWatch(); schedule(); }, pollMs);
  schedule();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `node --test test/watcher.test.js`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/save/watcher.js test/watcher.test.js
git commit -m "feat: watch save file for changes"
```

---

### Task 10: HTTP + SSE server

**Files:**
- Create: `src/server.js`, `test/server.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';

function sseOnce(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const m = buf.match(/event: state\ndata: (.*)\n\n/);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
      res.on('error', reject);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

function getText(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

test('serves the page, the latest state and an SSE stream', async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), 'adv-'));
  await writeFile(path.join(publicDir, 'index.html'), '<title>x</title>');
  const srv = createServer({ port: 0, host: '127.0.0.1', publicDir });
  const { port } = await srv.ready;
  try {
    assert.equal((await getText(port, '/')).body, '<title>x</title>');
    assert.equal((await getText(port, '/nope')).status, 404);
    srv.broadcast({ phase: 'shop' });
    assert.deepEqual(JSON.parse((await getText(port, '/state.json')).body), { phase: 'shop' });
    assert.deepEqual(await sseOnce(port, '/events'), { phase: 'shop' });
    const next = sseOnce(port, '/events');
    await new Promise((r) => setTimeout(r, 50));
    srv.broadcast({ phase: 'selecting' });
    assert.deepEqual(await next, { phase: 'selecting' });
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement server.js**

```js
// src/server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function createServer({ port = 8787, host = '127.0.0.1', publicDir } = {}) {
  const clients = new Set();
  let latest = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      res.write(':ok\n\n');
      if (latest) res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/state.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(latest));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const html = await readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('public/index.html missing');
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const heartbeat = setInterval(() => { for (const c of clients) c.write(':hb\n\n'); }, 15000);
  heartbeat.unref();

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });

  return {
    server,
    ready,
    broadcast(payload, event = 'state') {
      if (event === 'state') latest = payload;
      const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const c of clients) c.write(msg);
    },
    close() {
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      clients.clear();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `node --test test/server.test.js`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: localhost server with SSE state stream"
```

---
### Task 11: CLI wiring and page payload

**Files:**
- Create: `src/cli.js`, `test/cli.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/cli.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildPayload } from '../src/cli.js';
import { advise } from '../src/engine/advisor.js';
import { makeState, cards } from './helpers.js';

test('parseArgs reads flags with defaults', () => {
  assert.deepEqual(parseArgs([]), { port: 8787, host: '127.0.0.1', profile: null, save: null, budgetMs: 500 });
  assert.deepEqual(parseArgs(['--port', '9000', '--host', '0.0.0.0', '--profile', '2', '--save', 'x.jkr', '--budget-ms', '250']),
    { port: 9000, host: '0.0.0.0', profile: 2, save: 'x.jkr', budgetMs: 250 });
});

test('buildPayload serialises state and advice for the page', () => {
  const state = makeState({ hand: cards('S_9 D_9 H_K'), deck: cards('S_2 S_2 H_3'), target: 50, jokers: [{ key: 'j_trio', name: 'Trio' }] });
  const advice = advise(state, { seed: 'p' });
  const p = buildPayload(state, advice, { savePath: 'x' });
  assert.equal(p.phase, 'selecting');
  assert.equal(p.blind.target, 50);
  assert.equal(p.hand.length, 3);
  assert.deepEqual(Object.keys(p.hand[0]).sort(), ['chips', 'debuffed', 'id', 'label', 'rank', 'suit']);
  assert.equal(p.deckCount, 3);
  assert.equal(p.deckCounts['Spades:2'], 2);
  assert.equal(p.advice.action, 'play');
  assert.equal(p.advice.cards.length, 2);
  assert.equal(p.advice.topPlays[0].handType, 'Pair');
  assert.deepEqual(p.jokers, [{ key: 'j_trio', name: 'Trio' }]);
  assert.equal(p.savePath, 'x');
  assert.equal(p.error, null);
  assert.equal(buildPayload(makeState({ phase: 'shop' }), null).advice, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement cli.js**

```js
#!/usr/bin/env node
// src/cli.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolvePaths, decodeLuaFile } from './save/reader.js';
import { parseLuaTable } from './save/lua-table.js';
import { watchSave } from './save/watcher.js';
import { extractState } from './state/extract.js';
import { advise } from './engine/advisor.js';
import { createServer } from './server.js';

export function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', profile: null, save: null, budgetMs: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--port') { out.port = Number(v); i++; }
    else if (a === '--host') { out.host = v; i++; }
    else if (a === '--profile') { out.profile = Number(v); i++; }
    else if (a === '--save') { out.save = v; i++; }
    else if (a === '--budget-ms') { out.budgetMs = Number(v); i++; }
  }
  return out;
}

export function serializeCard(c) {
  return { id: c.id, label: c.label, rank: c.rank, suit: c.suit, chips: c.chips, debuffed: c.debuffed };
}

export function buildPayload(state, advice, extra = {}) {
  const deckCounts = {};
  for (const c of state.deck) {
    const k = `${c.suit}:${c.rank}`;
    deckCounts[k] = (deckCounts[k] || 0) + 1;
  }
  const opt = (o) => ({ action: o.action, cards: o.cards.map(serializeCard), handType: o.handType, score: o.score, pClear: o.pClear, expChips: o.expChips, samples: o.samples });
  return {
    updatedAt: new Date().toISOString(),
    phase: state.phase,
    ante: state.ante, round: state.round, blindOnDeck: state.blindOnDeck,
    blind: { name: state.blind.name, key: state.blind.key, target: state.target },
    chipsScored: state.chipsScored, handsLeft: state.handsLeft, discardsLeft: state.discardsLeft,
    hand: state.hand.map(serializeCard),
    deckCount: state.deck.length, deckCounts,
    jokers: state.jokers,
    warnings: advice?.warnings ?? [],
    advice: advice ? {
      action: advice.action, cards: advice.cards.map(serializeCard), handType: advice.handType, score: advice.score,
      clearsBlind: advice.clearsBlind, remaining: advice.remaining, pClear: advice.pClear, expChips: advice.expChips,
      reason: advice.reason, alternatives: advice.alternatives.map(opt),
      topPlays: advice.topPlays.map((p) => ({ cards: p.cards.map(serializeCard), handType: p.handType, score: p.score })),
      samples: advice.samples, elapsedMs: advice.elapsedMs,
    } : null,
    error: null,
    ...extra,
  };
}

async function parseWithRetry(savePath, firstBuf, attempts = 5, delayMs = 100) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try {
      const buf = i === 0 && firstBuf ? firstBuf : await readFile(savePath);
      return parseLuaTable(decodeLuaFile(buf));
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw err;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { savePath } = await resolvePaths({ profile: args.profile, save: args.save });
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const server = createServer({ port: args.port, host: args.host, publicDir });
  const addr = await server.ready;
  console.log(`Balatro Advisor  →  http://${args.host}:${addr.port}`);
  console.log(`watching ${savePath}`);

  let lastPayload = { updatedAt: new Date().toISOString(), phase: 'waiting', savePath, warnings: [], advice: null, error: null };
  server.broadcast(lastPayload);

  watchSave(savePath, async (snap) => {
    if (snap.error) {
      server.broadcast({ ...lastPayload, error: String(snap.error.message || snap.error) });
      return;
    }
    try {
      const raw = await parseWithRetry(savePath, snap.buf);
      const state = extractState(raw);
      const advice = state.phase === 'selecting' ? advise(state, { budgetMs: args.budgetMs, seed: snap.hash }) : null;
      lastPayload = buildPayload(state, advice, { savePath });
      server.broadcast(lastPayload);
      const stamp = new Date().toLocaleTimeString();
      if (advice) console.log(`[${stamp}] ${advice.action.toUpperCase()} ${advice.cards.map((c) => c.label).join(' ')}  —  ${advice.reason}  (${advice.samples} samples, ${Math.round(advice.elapsedMs)} ms)`);
      else console.log(`[${stamp}] ${state.phase}`);
    } catch (e) {
      console.error('snapshot failed:', e.message);
      server.broadcast({ ...lastPayload, error: e.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/cli.test.js`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: CLI wiring save watcher, advisor and server"
```

---

### Task 12: The page

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Balatro Advisor</title>
<style>
  :root { --bg:#12141a; --panel:#1b1e27; --line:#2b3040; --text:#e9ecf2; --muted:#8f97ad; --red:#ff6b7a; --blue:#5ec8ff; --green:#5ee39a; --amber:#ffc65c; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.4 system-ui, Segoe UI, Roboto, sans-serif; padding:16px; }
  header { display:flex; flex-wrap:wrap; gap:12px 24px; align-items:baseline; padding:12px 16px; background:var(--panel); border:1px solid var(--line); border-radius:12px; }
  header .big { font-size:1.6rem; font-weight:700; }
  header .ok { color:var(--green); }
  .muted { color:var(--muted); }
  section { margin-top:16px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  h2 { margin:0 0 10px; font-size:0.85rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  #rec { border-color:var(--blue); }
  #rec.discard { border-color:var(--amber); }
  #rec.win { border-color:var(--green); }
  #rec .action { font-size:2.2rem; font-weight:800; letter-spacing:.02em; }
  #rec.play .action { color:var(--blue); } #rec.discard .action { color:var(--amber); } #rec.win .action { color:var(--green); }
  .cards { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
  .card { display:inline-flex; align-items:center; justify-content:center; min-width:52px; height:68px; padding:0 8px; border-radius:8px; background:#f4f1ea; color:#1a1a1a; font-size:1.5rem; font-weight:700; box-shadow:0 2px 0 #b9b2a3; }
  .card.red { color:#c8323e; }
  .card.debuffed { opacity:.45; text-decoration:line-through; }
  .card.small { min-width:40px; height:48px; font-size:1.1rem; }
  .card.hint { outline:3px solid var(--blue); }
  .reason { font-size:1.15rem; margin-top:6px; }
  table { width:100%; border-collapse:collapse; font-size:0.95rem; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--muted); font-weight:600; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .grid { display:grid; grid-template-columns:auto repeat(13, 1fr); gap:3px; font-variant-numeric:tabular-nums; }
  .grid div { text-align:center; padding:4px 0; border-radius:4px; background:#232838; }
  .grid .h { background:transparent; color:var(--muted); font-size:.8rem; }
  .grid .zero { opacity:.25; }
  .grid .red { color:var(--red); }
  .warn { color:var(--amber); }
  .err { background:#3a1f25; color:#ffb4bb; padding:8px 12px; border-radius:8px; margin-top:12px; }
  .idle { font-size:1.4rem; padding:24px; text-align:center; color:var(--muted); }
  .dim { opacity:.4; }
  .tag { display:inline-block; padding:2px 8px; border-radius:999px; background:#232838; color:var(--muted); font-size:.8rem; margin-right:6px; }
  footer { margin-top:16px; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
<header id="status"><span class="big">Balatro Advisor</span><span class="muted">connecting…</span></header>
<div id="error" class="err" hidden></div>
<section id="rec"><div class="idle">Waiting for Balatro…</div></section>
<section id="alts" hidden><h2>Alternatives</h2><div id="altsBody"></div></section>
<section id="plays" hidden><h2>Best scoring plays</h2><div id="playsBody"></div></section>
<section id="deck" hidden><h2>Remaining deck</h2><div id="deckBody"></div></section>
<section id="notes" hidden><h2>Warnings &amp; jokers</h2><div id="notesBody"></div></section>
<footer id="foot"></footer>
<script>
const RANKS = [14,13,12,11,10,9,8,7,6,5,4,3,2];
const RANK_LABEL = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
const SUITS = [['Spades','♠'],['Hearts','♥'],['Clubs','♣'],['Diamonds','♦']];
const RED = new Set(['Hearts','Diamonds']);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct = (x) => Math.round(x * 100) + '%';
const num = (x) => Math.round(x).toLocaleString();
const PHASE_TEXT = { waiting:'Waiting for Balatro save…', shop:'In the shop', blind_select:'Choosing a blind', round_eval:'Round over', game_over:'Game over', other:'Waiting for the next hand…' };

function cardHtml(c, cls = '') {
  const classes = ['card', RED.has(c.suit) ? 'red' : '', c.debuffed ? 'debuffed' : '', cls].filter(Boolean).join(' ');
  return `<span class="${classes}" title="${c.chips} chips">${esc(c.label)}</span>`;
}
const cardsHtml = (cs, cls = '') => `<div class="cards">${cs.map((c) => cardHtml(c, cls)).join('')}</div>`;
const inline = (cs) => cs.map((c) => `<span class="${RED.has(c.suit) ? 'red' : ''}">${esc(c.label)}</span>`).join(' ');

function render(p) {
  const st = $('status');
  if (p.phase === 'waiting') {
    st.innerHTML = `<span class="big">Balatro Advisor</span><span class="muted">${esc(PHASE_TEXT.waiting)}</span>`;
  } else {
    const cleared = p.chipsScored >= p.blind.target && p.blind.target > 0;
    st.innerHTML = `
      <span class="big">Ante ${p.ante} · Round ${p.round}</span>
      <span>${esc(p.blind.name || p.blindOnDeck || '')}</span>
      <span class="big ${cleared ? 'ok' : ''}">${num(p.chipsScored)} / ${num(p.blind.target)}</span>
      <span><span class="tag">Hands ${p.handsLeft}</span><span class="tag">Discards ${p.discardsLeft}</span><span class="tag">Deck ${p.deckCount}</span></span>`;
  }
  $('error').hidden = !p.error;
  $('error').textContent = p.error ? `Save could not be read: ${p.error}` : '';

  const rec = $('rec');
  const a = p.advice;
  if (p.phase !== 'selecting' || !a) {
    rec.className = '';
    rec.innerHTML = `<div class="idle">${esc(PHASE_TEXT[p.phase] || PHASE_TEXT.other)}</div>` + (p.hand && p.hand.length ? `<div class="dim">${cardsHtml(p.hand, 'small')}</div>` : '');
  } else if (a.action === 'none') {
    rec.className = '';
    rec.innerHTML = `<div class="idle">${esc(a.reason)}</div>${cardsHtml(p.hand, 'small')}`;
  } else {
    const pick = new Set(a.cards.map((c) => c.id));
    rec.className = a.clearsBlind ? 'win' : a.action;
    const headline = a.action === 'play'
      ? `PLAY ${esc(a.handType)} · ${num(a.score)}`
      : `DISCARD ${a.cards.length}`;
    const sub = a.clearsBlind
      ? `Clears the blind (${num(a.remaining)} needed).`
      : a.action === 'play'
        ? `Leaves ${num(Math.max(0, a.remaining - a.score))} to go · ${pct(a.pClear)} to clear this round`
        : `${pct(a.pClear)} to clear this round · expected ${num(a.expChips)} chips`;
    rec.innerHTML = `<div class="action">${headline}</div><div>${sub}</div>${cardsHtml(a.cards)}<div class="reason">${esc(a.reason)}</div>
      <div class="muted" style="margin-top:8px">Your hand</div>${cardsHtml(p.hand.map((c) => ({ ...c })), 'small')}`;
    rec.querySelectorAll('.card.small').forEach((el, i) => { if (pick.has(p.hand[i].id)) el.classList.add('hint'); });
  }

  const alts = $('alts');
  if (a && a.alternatives && a.alternatives.length) {
    alts.hidden = false;
    $('altsBody').innerHTML = `<table><tr><th>Action</th><th>Cards</th><th>Hand</th><th class="num">Score</th><th class="num">Clear</th><th class="num">Exp. chips</th></tr>` +
      a.alternatives.map((o) => `<tr><td>${o.action === 'play' ? 'Play' : 'Discard'}</td><td>${inline(o.cards)}</td><td>${esc(o.handType || '')}</td><td class="num">${o.score != null ? num(o.score) : ''}</td><td class="num">${pct(o.pClear)}</td><td class="num">${num(o.expChips)}</td></tr>`).join('') + '</table>';
  } else alts.hidden = true;

  const plays = $('plays');
  if (a && a.topPlays && a.topPlays.length) {
    plays.hidden = false;
    $('playsBody').innerHTML = `<table><tr><th>Hand</th><th>Cards</th><th class="num">Score</th></tr>` +
      a.topPlays.map((o) => `<tr><td>${esc(o.handType)}</td><td>${inline(o.cards)}</td><td class="num">${num(o.score)}</td></tr>`).join('') + '</table>';
  } else plays.hidden = true;

  const deck = $('deck');
  if (p.deckCounts && p.phase !== 'waiting') {
    deck.hidden = false;
    let html = '<div class="grid"><div class="h"></div>' + RANKS.map((r) => `<div class="h">${RANK_LABEL[r]}</div>`).join('');
    for (const [suit, sym] of SUITS) {
      const red = RED.has(suit) ? 'red' : '';
      let total = 0;
      let row = '';
      for (const r of RANKS) { const n = p.deckCounts[`${suit}:${r}`] || 0; total += n; row += `<div class="${n ? red : 'zero'}">${n}</div>`; }
      html += `<div class="h ${red}">${sym} ${total}</div>` + row;
    }
    $('deckBody').innerHTML = html + '</div>';
  } else deck.hidden = true;

  const notes = [];
  for (const w of p.warnings || []) notes.push(`<div class="warn">⚠ ${esc(w)}</div>`);
  if (p.jokers && p.jokers.length) notes.push(`<div class="muted">Jokers (not scored): ${p.jokers.map((j) => esc(j.name || j.key)).join(', ')}</div>`);
  $('notes').hidden = notes.length === 0;
  $('notesBody').innerHTML = notes.join('');

  $('foot').textContent = (a && a.samples ? `${a.samples} samples per option · ${Math.round(a.elapsedMs)} ms · ` : '') + `updated ${new Date(p.updatedAt).toLocaleTimeString()}`;
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('state', (e) => render(JSON.parse(e.data)));
  es.onerror = () => { es.close(); $('status').innerHTML = '<span class="big">Balatro Advisor</span><span class="muted">reconnecting…</span>'; setTimeout(connect, 1500); };
}
connect();
</script>
</body>
</html>
```

- [ ] **Step 2: Smoke-test the page against the real save**

Run: `npm start` then open http://127.0.0.1:8787. With Balatro in the shop the page shows "In the shop" and the deck grid. Play a hand in Balatro: the page must switch to a PLAY/DISCARD recommendation within a second.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: live advisor page"
```

---

### Phase 2 (done 2026-09-27): full scoring via Balatrolator — see spec §10

Implemented in this order, each with tests: card modifiers + stone cards in the model; extractor full-scoring fields; `vendor/balatrolator` + `scripts/gen-joker-names.js`; `src/engine/joker-map.js`; `src/engine/full-score.js`; scorer injection and root-calibrated rollouts in the advisor; `makeScorer`/`reconcileLastHand` in the CLI; page (scoring mode, chips × mult, luck range, last-hand check). Validation: Balatrolator reference case 010 reproduced through our model (2,856), plus per-family live-value tests.

### Task 13: End-to-end check, spec sync, final test run

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-balatro-advisor-design.md` (sections 5 and 3.1)
- Modify: `README.md`

- [ ] **Step 1: Full test run**

Run: `npm test`
Expected: all tests passing, 0 failing.

- [ ] **Step 2: Run the CLI against the real save and confirm output**

Run: `node src/cli.js --port 8790` for a few seconds (background), then `curl -s http://127.0.0.1:8790/state.json`.
Expected: JSON with `"phase"` matching the game's current screen and `deckCount` 52 or less.

- [ ] **Step 3: Sync the spec with the planning deviations**

In §5 step 4 replace "for every subset D of 1–5 cards" with "for each candidate discard set produced from keep-sets (top 3 plays, suit groups of 3+, rank groups of 2+, straight windows with 3+ ranks, and the k lowest cards for k = 1..5)". In §5 step 4 bullets replace "draw |S| cards" / "draw |D| cards" with "refill the hand to hand size (exactly 3 under The Serpent), capped by deck size". In §3.1 change the watcher snapshot to `{ buf, hash, path }` and note that retries re-read the file.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-balatro-advisor-design.md README.md
git commit -m "docs: sync spec with implementation"
```
