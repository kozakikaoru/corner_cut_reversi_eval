/**
 * 表示スケール(DISC_SCALE)較正の補助(開発用 / ビルド外)。
 *
 * 評価関数を変えると中盤評価の「生スコアの幅」が変わる。表示値(石差目安)と
 * Perfect/Good/Bad のしきい値(GOOD_THRESHOLD は表示単位)を従来の感覚に保つため、
 * 新旧で「中盤局面における手の評価値の広がり(最善-最悪)」を測り、比率を出す。
 *
 *   新 DISC_SCALE ← 現 DISC_SCALE × (旧spread / 新spread)
 * とすれば、新評価でも表示値の広がりが旧と同程度になり GOOD_THRESHOLD が再利用できる。
 *
 * 実行: npx esbuild ... && node。中盤(空き30)局面で測る。
 */

import {
  createInitialBoard,
  legalMoves,
  applyMove,
  hasLegalMove,
  countEmpties,
  raysFor,
} from '../src/engine/board';
import type { Board } from '../src/engine/types';
import { type Player, type VariantId, BLACK, opponent, VARIANT_ORDER, BOARD_VARIANTS } from '../src/engine/types';
import { evaluatePosition, type Evaluator } from '../src/engine/search';
import { oldPositionWeightsFor, oldEvaluateForPlayer } from './eval-old';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x55aa55aa;
const E = Number.parseInt(process.argv[2] ?? '30', 10);
const N = Number.parseInt(process.argv[3] ?? '25', 10);
const D = 4;
const BIG = 600000;
const OLD: Evaluator = { weights: oldPositionWeightsFor, score: oldEvaluateForPlayer };

const rng = mulberry32(SEED);
const randInt = (n: number): number => Math.floor(rng() * n);

function genPositions(variant: VariantId, e: number, n: number): { board: Board; player: Player }[] {
  const rays = raysFor(variant);
  const out: { board: Board; player: Player }[] = [];
  let guard = 0;
  while (out.length < n && guard < n * 80) {
    guard++;
    let board = createInitialBoard(variant);
    let player: Player = BLACK;
    let cap: { board: Board; player: Player } | null = null;
    for (;;) {
      const empties = countEmpties(board);
      const moves = legalMoves(board, player, rays);
      if (empties === e && moves.length > 1) {
        cap = { board: board.slice(), player };
        break;
      }
      if (moves.length === 0) {
        if (!hasLegalMove(board, opponent(player), rays)) break;
        player = opponent(player);
        continue;
      }
      const nb = applyMove(board, moves[randInt(moves.length)], player, rays);
      if (!nb) break;
      board = nb;
      player = opponent(player);
    }
    if (cap) out.push(cap);
  }
  return out;
}

/** 与えた評価器での「手の評価値の広がり(最善-最悪)」の平均(現 DISC_SCALE 適用後の表示単位)。 */
function meanSpread(ev: Evaluator | undefined): number {
  let sum = 0;
  let cnt = 0;
  for (const variant of VARIANT_ORDER) {
    for (const pos of genPositionsCache.get(variant)!) {
      const res = evaluatePosition(pos.board, pos.player, {
        variant,
        evaluator: ev,
        maxDepth: D,
        endgameEmpties: 0,
        timeLimitMs: BIG,
      });
      if (res.moves.length < 2) continue;
      let hi = -Infinity;
      let lo = Infinity;
      for (const m of res.moves) {
        if (m.value > hi) hi = m.value;
        if (m.value < lo) lo = m.value;
      }
      sum += hi - lo;
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

// 局面は新旧で同一集合を使う(公平)。
const genPositionsCache = new Map<VariantId, { board: Board; player: Player }[]>();
for (const variant of VARIANT_ORDER) genPositionsCache.set(variant, genPositions(variant, E, N));

console.log(`=== 表示スケール較正(中盤 空き${E} / 盤面ごと${N}局面) ===`);
const newSpread = meanSpread(undefined);
const oldSpread = meanSpread(OLD);
console.log(`旧 平均spread(表示単位): ${oldSpread.toFixed(3)}`);
console.log(`新 平均spread(表示単位): ${newSpread.toFixed(3)}`);
const ratio = newSpread / oldSpread;
console.log(`比率(新/旧): ${ratio.toFixed(3)}`);
console.log(`→ 現 DISC_SCALE=1/6≈0.1667 のとき、新スケール候補 = 0.1667 / ${ratio.toFixed(3)} = ${(0.16667 / ratio).toFixed(4)}  (≈ 1/${(ratio / 0.16667).toFixed(1)})`);
console.log(`  (この値を search.ts の DISC_SCALE にすると、表示値の広がりが旧と同程度になり GOOD_THRESHOLD を流用できる)`);
for (const variant of VARIANT_ORDER) {
  console.log(`  [${BOARD_VARIANTS[variant].label}] 局面数 ${genPositionsCache.get(variant)!.length}`);
}
