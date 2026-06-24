/**
 * 中盤評価関数の「精度」ベンチマーク(開発用 / ビルドには含めない)。
 *
 * 考え方:
 *   評価関数の良し悪しを客観的・再現可能に測りたい。そこで「終盤完全読み(厳密解)」を
 *   正解とみなし、浅い探索(=評価関数が支配的)が選ぶ手が、厳密解と比べて何石損するか
 *   (regret)を測る。厳密解は評価関数に依存しないため、評価関数を変えても比較が公平。
 *
 *   - regret = (厳密解での最善手の最終石差) − (浅い探索が選んだ手の厳密最終石差)  (>=0)
 *   - 一致率 = regret==0 の割合(=最善手を選べた割合)
 *   小さい平均 regret / 高い一致率ほど、評価関数が「良い手」を選べている。
 *
 * 手順:
 *   1. 各盤面で、ランダム自己対戦を回して「空き E マス」の局面を N 個生成(シード固定=再現可能)。
 *   2. 各局面を完全読み(endgameEmpties を大きくして強制)→ 各手の確定石差(正解)を得る。
 *   3. 同じ局面を中盤評価の固定深さ探索(endgameEmpties=0, maxDepth=D)で解かせ、選んだ手の
 *      regret を厳密解から引く。D=1(ほぼ評価関数そのもの)と D=2 で測る。
 *   4. 盤面別/全体で 一致率・平均 regret を集計。
 *
 * 実行: esbuild でバンドルして node。 `npm run bench:eval [E] [N]`
 *   既定 E=12(完全読みが速い), N=30。評価関数を変える前後で実行して数値を比較する。
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
import {
  type Player,
  type VariantId,
  BLACK,
  opponent,
  BOARD_VARIANTS,
  VARIANT_ORDER,
} from '../src/engine/types';
import { evaluatePosition } from '../src/engine/search';

// --- 再現可能な乱数(mulberry32) ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x9e3779b9;
const E = Number.parseInt(process.argv[2] ?? '12', 10); // 対象の空きマス数
const N = Number.parseInt(process.argv[3] ?? '30', 10); // 盤面ごとの局面数
const DEPTHS = [1, 2]; // 浅い探索の固定深さ(小さいほど評価関数が支配的)
const BIG_TIME = 600000; // 完全読み/固定深さが時間切れしないよう十分大きく

const rng = mulberry32(SEED);
const randInt = (n: number): number => Math.floor(rng() * n);

interface Pos {
  board: Board;
  player: Player;
}

/** ランダム自己対戦で「空き E・手番側に合法手あり」の局面を N 個作る。 */
function genPositions(variant: VariantId, e: number, n: number): Pos[] {
  const rays = raysFor(variant);
  const out: Pos[] = [];
  let guard = 0;
  while (out.length < n && guard < n * 80) {
    guard++;
    let board = createInitialBoard(variant);
    let player: Player = BLACK;
    let captured: Pos | null = null;
    // 1 手ごとに空きが 1 減る。空き==e で手番側に手があれば採用。
    for (;;) {
      const empties = countEmpties(board);
      const moves = legalMoves(board, player, rays);
      if (empties === e && moves.length > 0) {
        captured = { board: board.slice(), player };
        break;
      }
      if (moves.length === 0) {
        if (!hasLegalMove(board, opponent(player), rays)) break; // 終局(e に届かず)
        player = opponent(player); // パス
        continue;
      }
      const cell = moves[randInt(moves.length)];
      const nb = applyMove(board, cell, player, rays);
      if (!nb) break;
      board = nb;
      player = opponent(player);
    }
    if (captured) out.push(captured);
  }
  return out;
}

interface Acc {
  count: number;
  agree: number;
  regretSum: number;
}
const newAcc = (): Acc => ({ count: 0, agree: 0, regretSum: 0 });

console.log(`=== 評価関数ベンチ(空き${E} / 盤面ごと${N}局面 / seed=${SEED.toString(16)}) ===`);
console.log('regret = 厳密解(完全読み)に対する着手の損失石差。小さいほど良い。\n');

// depth -> variant -> Acc
const perDepth = new Map<number, Map<VariantId, Acc>>();
for (const d of DEPTHS) {
  const m = new Map<VariantId, Acc>();
  for (const v of VARIANT_ORDER) m.set(v, newAcc());
  perDepth.set(d, m);
}

let skipped = 0;
for (const variant of VARIANT_ORDER) {
  const positions = genPositions(variant, E, N);
  for (const pos of positions) {
    // 正解: 完全読み(endgameEmpties を大きくして強制)。
    const exact = evaluatePosition(pos.board, pos.player, {
      variant,
      endgameEmpties: 64,
      timeLimitMs: BIG_TIME,
    });
    if (!exact.endgame || exact.timedOut || exact.moves.length === 0) {
      skipped++;
      continue;
    }
    const exactVal = new Map<number, number>();
    let exactBest = -Infinity;
    for (const m of exact.moves) {
      exactVal.set(m.cell, m.value);
      if (m.value > exactBest) exactBest = m.value;
    }

    for (const d of DEPTHS) {
      const shallow = evaluatePosition(pos.board, pos.player, {
        variant,
        endgameEmpties: 0, // 中盤評価を強制(完全読みさせない)
        maxDepth: d,
        timeLimitMs: BIG_TIME,
      });
      if (shallow.moves.length === 0) continue;
      const pick = shallow.moves[0].cell; // value 降順の先頭=評価関数の最善
      const regret = exactBest - (exactVal.get(pick) ?? exactBest);
      const acc = perDepth.get(d)!.get(variant)!;
      acc.count++;
      acc.regretSum += regret;
      if (regret <= 1e-9) acc.agree++;
    }
  }
}

for (const d of DEPTHS) {
  console.log(`--- 固定深さ D=${d} ---`);
  const m = perDepth.get(d)!;
  let tCount = 0;
  let tAgree = 0;
  let tRegret = 0;
  for (const variant of VARIANT_ORDER) {
    const a = m.get(variant)!;
    tCount += a.count;
    tAgree += a.agree;
    tRegret += a.regretSum;
    const label = BOARD_VARIANTS[variant].label.padEnd(5, '　');
    const agreePct = a.count ? ((a.agree / a.count) * 100).toFixed(1) : '0.0';
    const meanReg = a.count ? (a.regretSum / a.count).toFixed(3) : '0.000';
    console.log(`  ${label} 一致率 ${agreePct.padStart(5)}%  平均regret ${meanReg.padStart(7)}  (n=${a.count})`);
  }
  const agreePct = tCount ? ((tAgree / tCount) * 100).toFixed(1) : '0.0';
  const meanReg = tCount ? (tRegret / tCount).toFixed(3) : '0.000';
  console.log(`  ${'全体'.padEnd(5, '　')} 一致率 ${agreePct.padStart(5)}%  平均regret ${meanReg.padStart(7)}  (n=${tCount})`);
  console.log('');
}
if (skipped > 0) console.log(`(注: 完全読み未完了でスキップ ${skipped} 局面)`);
