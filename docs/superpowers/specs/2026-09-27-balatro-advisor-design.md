# Balatro Advisor — Design

**Date:** 2026-09-27
**Status:** Approved by owner (sections reviewed one by one in conversation)

## 1. Goal

A companion tool that watches a live Balatro run and, every time the player has to choose cards, recommends what to play or discard. Recommendations are based only on card ranks, suits, poker hand combinations, and current hand levels (Planet cards). Jokers, seals, editions and card enhancements are **not** scored; the player accounts for those manually. Two exceptions: the jokers *Four Fingers* and *Shortcut* are detected because they change what counts as a Flush or Straight.

Must work for the current run and for any future run without reconfiguration.

## 2. How the game exposes its state

Verified against the game's Lua source extracted from `Balatro.exe` (files dated 2025-02-21).

- Balatro writes `%APPDATA%\Balatro\<profile>\save.jkr` from one routine, `save_run()` in `functions/misc_functions.lua`. It is called when the game enters hand selection after cards are drawn (`Game:update_selecting_hand`), on blind select, on round evaluation, and after shop purchases. A fresh snapshot therefore exists at every decision point.
- **Save throttle (source of the visible delay):** `save_run()` only *queues* the write (`G.FILE_HANDLER.update_queued`). `Game:update` (game.lua ≈ line 2686) flushes the queue to the save thread only when `G.FILE_HANDLER.force` is set, the stage changes, the pause state toggles, or `G.F_SAVE_TIMER` seconds have passed since the last flush. `F_SAVE_TIMER` is 5 on Windows and macOS (globals.lua). `force` is set only at round end, game win/over, unlocks and profile loads, never after a play or discard. So mid-round the file can lag the screen by 0 to 5 s. Nothing outside the game can change this; a one-line Lovely patch setting `F_SAVE_TIMER = 0` would make every queued save flush on the next frame.
- The file is the output of `STR_PACK` (`engine/string_packer.lua`): a Lua table literal beginning with `return {`, compressed with `love.data.compress('string','deflate',…)`, which produces a **raw deflate** stream (no zlib header). `zlib.inflateRawSync` decodes it. Files whose text begins with `return` are stored uncompressed; the reader must accept both.
- Serializer rules the parser must handle: keys are `["string"]` or `[integer]`; string values use Lua `%q` quoting (`\"`, `\\`, backslash-newline, `\ddd` decimal escapes); numbers are Lua `tostring` output and can be `1e+15`, `inf`, `-inf`, `nan`, `-nan(ind)`; booleans; nested tables; trailing commas. Tables whose keys are exactly 1..n are exposed as arrays.
- Top-level fields used: `STATE`, `BLIND`, `cardAreas`, `GAME`.
- `STATE` values (from `globals.lua`): 1 SELECTING_HAND, 2 HAND_PLAYED, 3 DRAW_TO_HAND, 4 GAME_OVER, 5 SHOP, 6 PLAY_TAROT, 7 BLIND_SELECT, 8 ROUND_EVAL, 9/10/15/17/18 pack opening, 19 NEW_ROUND. Advice is produced only for state 1.
- `cardAreas.{hand,deck,discard,play,jokers}.cards[i]`: each card has `base.id` (2–14, Ace = 14), `base.suit`, `base.value`, `base.nominal` (chip value), `debuff` (bool), `ability` (with `played_this_ante`, `effect`, `bonus`, `perma_bonus`), `save_fields.card` (e.g. `C_Q`) and `save_fields.center` (`c_base`, or a joker key such as `j_four_fingers`).
- `GAME.current_round.{hands_left,discards_left,hands_played,discards_used,most_played_poker_hand}`; `GAME.chips` (chips scored so far this round); `GAME.round`; `GAME.round_resets.ante`; `GAME.blind_on_deck`.
- `GAME.hands[<hand name>].{level,chips,mult,s_chips,s_mult,l_chips,l_mult,played_this_round}`: `chips`/`mult` are already the leveled values.
- `BLIND.{name,config_blind,chips,disabled,hands,only_hand}`: `config_blind` is the key (e.g. `bl_club`), `chips` is the target, `hands` is The Eye's set of used hand types, `only_hand` is The Mouth's locked type.
- The active profile number is read from `%APPDATA%\Balatro\settings.jkr` (same pack/compress format); default 1 if absent.

## 3. Architecture

Single Node 24 project, ES modules, **no third-party runtime dependencies**, at `D:\Sources\GameProjects\balatro-advisor`. One long-running process started with `npm start`. Data flows one way:

```
Balatro writes save.jkr
  → watcher (fs.watch on profile dir, debounce, content hash)
  → reader (read file, inflateRaw or plain, retry on mid-write)
  → parser (Lua table literal → JS object)
  → extractor (raw object → GameState)
  → engine (hand evaluation, scoring, advisor)  [pure, no I/O]
  → server (HTTP + Server-Sent Events) → browser page
```

### 3.1 Modules and interfaces

| Module | Responsibility | Interface |
|---|---|---|
| `src/save/reader.js` | Locate profile, read and decode `save.jkr` and `settings.jkr` | `resolvePaths({appData, profile?, save?}) → {settingsPath, savePath}`, `readLuaFile(path) → Promise<string>` |
| `src/save/lua-table.js` | Parse `STR_PACK` output | `parseLuaTable(text) → object` (arrays for 1..n keyed tables) |
| `src/save/watcher.js` | Emit new snapshots | `watchSave(savePath, onSnapshot, {debounceMs, pollMs}) → {close()}`; snapshot = `{buf, hash, path}` (raw bytes; the CLI decodes and re-reads the file on retry); duplicate hashes and empty reads are dropped; a slow poll backs up `fs.watch` |
| `src/state/extract.js` | Reduce raw save to `GameState` | `extractState(raw) → GameState` |
| `src/engine/cards.js` | Card model, chip values, deck composition helpers | `cardFromSave(rawCard) → Card`, `chipValue(card)` |
| `src/engine/hands.js` | Port of `evaluate_poker_hand`, scoring | `evaluateHand(cards, rules) → {type, scoringCards}`, `scorePlay(cards, state, rules) → PlayResult` |
| `src/engine/blinds.js` | Boss blind rule table | `blindRules(state) → Rules` (legal sizes, banned/locked types, debuff predicate, level delta, halve flag, draw override, warnings) |
| `src/engine/advisor.js` | Recommendation search | `advise(state, {budgetMs, seed, minSamples, maxSamples}) → Advice` |
| `src/server.js` | Serve page, SSE, JSON | `createServer({port, host, publicDir}) → {broadcast(payload), close()}`; routes `/`, `/events`, `/state.json` |
| `src/cli.js` | Wire everything, flags | `--port 8787 --host 127.0.0.1 --profile N --save <path> --budget-ms 500` |
| `public/index.html` | The page (single file, inline CSS/JS) | connects to `/events` |

The engine never touches the file system or network, so it is unit-testable and reusable later by an in-game mod bridge.

### 3.2 GameState

```ts
type Card = { id: string; rank: number /* 2..14 */; suit: 'Spades'|'Hearts'|'Clubs'|'Diamonds';
              chips: number; debuffed: boolean; playedThisAnte: boolean; label: string /* e.g. "Q♣" */ };
type HandLevel = { level: number; chips: number; mult: number; sChips: number; sMult: number;
                   lChips: number; lMult: number; playedThisRound: number };
type GameState = {
  phase: 'selecting'|'shop'|'blind_select'|'round_eval'|'game_over'|'other';
  stateCode: number;
  ante: number; round: number; blindOnDeck: string;
  hand: Card[]; deck: Card[]; discard: Card[];
  handsLeft: number; discardsLeft: number; handSize: number;
  chipsScored: number; target: number;
  blind: { key: string; name: string; disabled: boolean; usedHandTypes: string[]; lockedHandType: string|null };
  handLevels: Record<string, HandLevel>;
  jokers: { key: string; name: string }[];
  flags: { fourFingers: boolean; shortcut: boolean };
};
```

## 4. Scoring engine

- Chip value of a card: rank 2–10 = rank, J/Q/K = 10, Ace = 11 (taken from `base.nominal`).
- Hand detection is a direct port of `evaluate_poker_hand` and its helpers `get_X_same`, `get_flush`, `get_straight`, `get_highest`, including: Ace-low straights (A-2-3-4-5), Two Pair formed from a triple plus a pair when no second pair exists, Five of a Kind / Flush House / Flush Five, and the precedence order Flush Five > Flush House > Five of a Kind > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > Pair > High Card.
- Rule flags: `fourFingers` lowers the minimum for Flush and Straight from 5 to 4 cards; `shortcut` allows one skipped rank inside a Straight. Both mirror the game's logic exactly.
- Score of a play = `(handChips + Σ chips of scoring cards) × handMult`, where `handChips`/`handMult` are the leveled values from the save. Only the cards that form the hand score (High Card: the single highest; Pair: two cards; etc.). Debuffed cards count toward the hand type but contribute 0 chips.
- Base values, used by tests and by The Arm's level adjustment (`chips(level) = sChips + lChips×(level−1)`, `mult` likewise, floors 0 and 1):

| Hand | Chips | Mult | +Chips/level | +Mult/level |
|---|---|---|---|---|
| Flush Five | 160 | 16 | 50 | 3 |
| Flush House | 140 | 14 | 40 | 4 |
| Five of a Kind | 120 | 12 | 35 | 3 |
| Straight Flush | 100 | 8 | 40 | 4 |
| Four of a Kind | 60 | 7 | 30 | 3 |
| Full House | 40 | 4 | 25 | 2 |
| Flush | 35 | 4 | 15 | 2 |
| Straight | 30 | 4 | 30 | 3 |
| Three of a Kind | 30 | 3 | 20 | 2 |
| Two Pair | 20 | 2 | 20 | 1 |
| Pair | 10 | 2 | 15 | 1 |
| High Card | 5 | 1 | 10 | 1 |

### 4.1 Boss blinds

Modelled (rules from `blind.lua`):

| Blind | Rule in engine |
|---|---|
| The Club / Goad / Head / Window | Cards of Clubs / Spades / Hearts / Diamonds are debuffed (0 chips) |
| The Plant | Face cards (J, Q, K) are debuffed |
| The Pillar | Cards with `playedThisAnte` are debuffed |
| The Psychic | Only 5-card plays are legal |
| The Eye | Hand types in `blind.usedHandTypes` are illegal |
| The Mouth | If `blind.lockedHandType` is set, only that type is legal |
| The Arm | Played hand scores at `max(level−1, 1)` |
| The Flint | `handChips = max(floor(chips×0.5+0.5), 0)`, `handMult = max(floor(mult×0.5+0.5), 1)` |
| The Serpent | After a play or discard the player draws exactly 3 cards |
| The Water / Needle / Manacle / Wall | Nothing to do; discards, hands, hand size and target already reflect them |

A disabled blind (`blind.disabled`) applies no rule. Every other boss (The Hook, Ox, Tooth, Fish, House, Mark, Wheel, Amber Acorn, Verdant Leaf, Violet Vessel, Crimson Heart, Cerulean Bell) is **not** modelled: the page shows a warning naming the blind and its effect text. Unknown blind keys also produce a warning and unmodified scoring.

## 5. Advisor

Input: a `GameState` in phase `selecting`. Output: an `Advice`:

```ts
type Option = { action: 'play'|'discard'; cards: Card[]; handType?: string; score?: number;
                pClear: number; expChips: number; samples: number };
type Advice = { action: 'play'|'discard'|'none'; cards: Card[]; handType?: string; score?: number;
                clearsBlind: boolean; remaining: number; pClear: number; expChips: number;
                reason: string; alternatives: Option[]; warnings: string[];
                samples: number; elapsedMs: number; seed: string };
```

Algorithm:

1. `remaining = max(0, target − chipsScored)`. Build `rules` from the blind and joker flags.
2. Enumerate every legal subset of 1–5 cards from the hand (≤ 218 for 8 cards; 56 when The Psychic forces 5). Score each with the engine. Sort by score, then by fewer cards.
3. **Immediate win:** if the best play's score ≥ `remaining`, recommend it. `pClear = 1`. Alternatives = other clearing plays, then the next best plays.
4. **Otherwise, lookahead.** Candidates: `play(S)` for the top 5 plays by score, and `discard(D)` for each candidate discard set if `discardsLeft > 0`. Candidate discard sets are the complements (lowest chips first, at most 5 cards) of these keep-sets: the top 3 plays, each suit held 3+ times, each rank held 2+ times and the union of the two highest such groups, each 5-rank straight window in which 3+ ranks are held, plus the k lowest cards for k = 1..5, de-duplicated. This keeps the lookahead inside the time budget; the full 218-subset enumeration is used only for scoring plays. Each candidate is evaluated by Monte Carlo rollouts over the **known remaining deck** (`state.deck`), sampled without replacement with a seeded PRNG (seed = snapshot hash, so identical states give identical advice).
   - After `play(S)`: chips += score(S), handsLeft −= 1, refill the hand to hand size (exactly 3 cards under The Serpent), capped by deck size.
   - After `discard(D)`: discardsLeft −= 1, refill the hand the same way.
   - Rollout policy until the round ends (chips ≥ target, or handsLeft = 0): if the best legal play clears the remainder, play it; else if discards remain, discard the cards not in the best play (lowest ranks first, max 5); else play the best legal play. Boss rules (Eye, Mouth, Arm) are updated along the rollout.
   - Each candidate yields `pClear` (fraction of rollouts that reached the target) and `expChips` (mean total chips at round end).
5. Rank candidates by `pClear` descending, then `expChips` descending, then prefer `play` on exact ties. The top candidate is the recommendation; the next 6 are `alternatives`.
6. **Budget:** default 500 ms. Start at 64 samples per candidate; while elapsed < 60% of budget, double the sample count (continuing the same PRNG stream) up to 512. Report samples used. `budgetMs` is configurable.
7. `reason` is one sentence, e.g. `Play now clears 41% of the time; discarding 3♦ 6♣ clears 68%.`
8. **Two-phase delivery.** `advise(state, { lookahead: false })` returns steps 1–3 only, in a few milliseconds, with `pending: true` and `pClear`/`expChips` set to `null` (an immediate win is already final). The CLI broadcasts that first, yields to the event loop so the SSE write flushes, then runs the full lookahead and broadcasts again. A newer snapshot arriving in between cancels the stale lookahead (sequence number check). The watcher debounce is 40 ms.

Edge cases: `handsLeft = 0` in selecting phase → `action: 'none'`. Deck smaller than the draw count → draw what remains. Hand smaller than 5 (The Manacle, late deck) → subsets are limited accordingly; if no legal play exists (e.g. The Psychic with 4 cards in hand) → `action: 'none'` with a warning.

## 6. Page

Single static file `public/index.html`, served at `http://127.0.0.1:8787` (use `--host 0.0.0.0` to reach it from a phone on the LAN). Dark theme, large type, no build step, updates via SSE without reload. Sections top to bottom:

1. **Status bar**: ante/round, blind name, `chipsScored / target`, hands and discards left. Green when the target is met.
2. **Recommendation**: `PLAY` + cards + hand type + exact score + "clears the blind" / "leaves N to go", or `DISCARD` + cards + expected best score after redraw + clear probability. One-sentence reason. While the lookahead is pending it shows the best exact play with "checking discards…". The player's whole hand is shown below it with the recommended cards outlined.
3. **Alternatives**: one merged list, up to 8 rows, each rendered as card chips: lookahead candidates first (with clear % and expected chips), then the remaining best-scoring plays (score only), de-duplicated by card set.
4. **Deck panel**: one row per suit, 13 fixed slots rendered as mini cards; a slot the deck no longer holds is a dashed ghost, duplicates carry a `×n` badge. Suit totals on the left. On screens 1200 px and wider it sits in a right-hand column beside the recommendation; narrower screens stack it below. Alternatives always follow at full width.
   The status bar also carries the timing line (samples per option, lookahead ms, last update time); when every option has 0% the recommendation shows a note that the target is out of reach for card-only scoring, jokers are not counted, and the ranking falls back to expected chips. The alternatives list has a one-line legend for %, exp. and scores.
5. **Warnings**: unmodelled boss effect (with effect text), jokers held (names only), parse/read errors.
6. **Idle states**: "In shop", "Choosing blind", "Round over", "Game over", "Waiting for Balatro save…" with the last recommendation greyed out.

Endpoints: `/` page, `/events` SSE stream (`state` and `error` events), `/state.json` latest payload.

## 7. Error handling

- Mid-write reads (inflate or parse failure): retry up to 5 times over 500 ms, then keep the last good state and send an `error` event shown as a thin strip on the page.
- Missing profile folder or save file: page shows "Waiting for Balatro save…"; the watcher watches the profile directory so the file appearing (new run) is picked up.
- Unknown blind key or hand name: warning, unmodified scoring, never an exception.
- Any exception inside the pipeline is logged to the console and reported to the page; the process keeps running.

## 8. Testing (Node built-in test runner, `npm test`)

- **Parser:** escaped strings (`\"`, `\\`, `\n`, `\ddd`), nested tables, 1..n arrays vs sparse tables, `inf`/`-inf`/`nan`/`-nan(ind)`, trailing commas, empty tables.
- **Reader:** compressed and plain (`return …`) files; profile resolution.
- **Extractor:** runs against `test/fixtures/save-shop.jkr` (copy of a real save taken in the shop) and hand-built selecting-phase fixtures.
- **Hands:** each hand type, Ace-low straight, triple+pair Two Pair rule, Four Fingers 4-card flush/straight, Shortcut gap straight, precedence order.
- **Scoring:** known values, e.g. level-1 Pair of nines = (10 + 18) × 2 = 56; debuffed card contributes 0; The Flint rounding; The Arm level drop.
- **Blind rules:** each modelled blind's legality/debuff behaviour; unknown key → warning.
- **Advisor:** immediate-win path; discard preferred when a 4-flush has one draw; determinism with fixed seed; timing test that an 8-card hand with 4 discards and 3 hands completes under the 500 ms budget.
- **Server:** SSE broadcast delivers the latest payload to a connected client.

## 9. Out of scope (first version)

- Scoring any joker other than the Four Fingers / Shortcut detection rules; seals, editions, enhancements (a Stone card is treated by its underlying base rank, a known inaccuracy); consumables; money; shop decisions.
- Multi-round planning; boss blinds listed as unmodelled in §4.1.
- In-game overlay / Lua mod. The engine is kept I/O-free so a mod bridge can reuse it later.
- Non-Windows save locations are supported only via `--save <path>`.
