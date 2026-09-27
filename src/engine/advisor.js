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

/**
 * Every legal play from the hand, best first (score desc, then fewer cards).
 * `scorer(cards)` defaults to card-only scoring; pass a full scorer for joker-aware ranking.
 */
export function enumeratePlays(hand, state, rules, scorer = (cards) => scorePlay(cards, state, rules)) {
  const min = rules.playSizeExact ?? 1;
  const max = Math.min(rules.playSizeExact ?? 5, hand.length);
  if (min > hand.length) return [];
  const plays = [];
  for (const cards of subsetsOf(hand, min, max)) {
    const r = scorer(cards);
    if (r.legal) {
      plays.push({
        cards, type: r.type, score: r.score, scoringCards: r.scoringCards,
        handChips: r.handChips, handMult: r.handMult, chips: r.chips, mult: r.mult, min: r.min, max: r.max,
      });
    }
  }
  plays.sort((a, b) => b.score - a.score || a.cards.length - b.cards.length);
  return plays;
}

/**
 * Lookahead scorer: card-only scoring scaled by how much the full scorer exceeded it at the root,
 * per hand type (falls back to the best play's ratio). Exact full scoring is far too slow for rollouts.
 */
function calibratedScorer(state, rules, rootPlays) {
  const ratioByType = {};
  let fallback = 1;
  for (const p of rootPlays) {
    const quick = scorePlay(p.cards, state, rules);
    if (!quick.legal || quick.score <= 0) continue;
    const ratio = p.score / quick.score;
    if (ratioByType[p.type] === undefined) ratioByType[p.type] = ratio;
    if (p === rootPlays[0]) fallback = ratio;
  }
  return (cards) => {
    const r = scorePlay(cards, state, rules);
    if (!r.legal) return r;
    return { ...r, score: r.score * (ratioByType[r.type] ?? fallback) };
  };
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
    const plays = enumeratePlays(hand, root.state, rules, root.rolloutScorer);
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
const summarizePlay = (p) => ({ cards: p.cards, handType: p.type, score: p.score, chips: p.chips, mult: p.mult, min: p.min, max: p.max });
const stripOption = (o) => ({ action: o.action, cards: o.cards, handType: o.handType, score: o.score, chips: o.chips, mult: o.mult, min: o.min, max: o.max, pClear: o.pClear, expChips: o.expChips, samples: o.samples });

/**
 * Recommend a play or discard for a GameState in the 'selecting' phase.
 * opts: { budgetMs=500, seed='', minSamples=32, maxSamples=512, lookahead=true,
 *         scorer: (cards) => PlayResult  (full scorer; card-only when omitted), scorerWarnings: string[] }
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
    warnings: [...rules.warnings, ...(opts.scorerWarnings ?? [])], samples: 0, elapsedMs: 0, seed, pending: false,
    scoreMode: opts.scorer ? 'full' : 'cards',
  };
  const done = (fields) => ({ ...base, ...fields, elapsedMs: performance.now() - t0 });

  if (state.phase !== 'selecting') return done({ reason: 'Not choosing cards right now.' });
  if (state.handsLeft <= 0) return done({ reason: 'No hands left this round.' });

  const plays = enumeratePlays(state.hand, state, rules, opts.scorer);
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

  if (opts.lookahead === false) {
    // Instant answer: exact ranking only. The caller runs the full lookahead afterwards.
    return done({
      action: 'play', cards: best.cards, handType: best.type, score: best.score, clearsBlind: false,
      pClear: null, expChips: null, pending: true, topPlays,
      reason: `Best play now: ${best.type} for ${best.score} (${remaining} needed). Checking discards…`,
      alternatives: plays.slice(1, 7).map((p) => ({ action: 'play', cards: p.cards, handType: p.type, score: p.score, pClear: null, expChips: null, samples: 0 })),
    });
  }

  const candidates = plays.slice(0, 5).map((p) => ({ action: 'play', play: p, cards: p.cards, handType: p.type, score: p.score }));
  if (state.discardsLeft > 0) {
    for (const cards of candidateDiscards(state.hand, plays)) candidates.push({ action: 'discard', cards });
  }
  const root = {
    state, rules, handSize: Math.max(state.handSize, state.hand.length), target: state.target,
    rolloutScorer: opts.scorer ? calibratedScorer(state, rules, plays) : undefined,
  };
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
