/**
 * 新旧評価関数の「強さ」A/B 自己対局(開発用 / ビルド外)。
 *
 * 評価関数の良し悪しは最終的に「強いかどうか」。そこで新評価(本番既定)と旧評価を
 * 同じ探索エンジンに差し込み、全局面(中盤含む)を打たせて直接対局させ勝率を測る。
 *
 * 公平化:
 *   - 各対局は同じ序盤(ランダム K 手)から、色を入れ替えて 2 局打つ(先手有利を相殺)。
 *   - 中盤は固定深さ(maxDepth=D)で両者同条件。終盤(空き<=EE)は両者とも完全読み=互角。
 *     つまり勝敗差は「中盤評価の質」だけで決まる。
 *   - 序盤ランダムはシード固定=再現可能。
 *
 * 実行: `npm run bench:ab [pairs] [depth] [endgameEmpties]`  (既定 15 / 6 / 8)
 */

import {
  createInitialBoard,
  legalMoves,
  applyMove,
  hasLegalMove,
  countEmpties,
  countDiscs,
  raysFor,
} from '../src/engine/board';
import type { Board } from '../src/engine/types';
import {
  type Player,
  type VariantId,
  BLACK,
  WHITE,
  opponent,
  BOARD_VARIANTS,
  VARIANT_ORDER,
} from '../src/engine/types';
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

const SEED = 0x1234abcd;
const PAIRS = Number.parseInt(process.argv[2] ?? '15', 10); // 盤面ごとの対局ペア数(×2局)
const DEPTH = Number.parseInt(process.argv[3] ?? '6', 10); // 中盤の固定探索深さ
const EE = Number.parseInt(process.argv[4] ?? '8', 10); // 終盤完全読みの空きしきい値
const OPENING_PLIES = 6; // 序盤ランダム手数
const BIG = 600000;

const rng = mulberry32(SEED);
const randInt = (n: number): number => Math.floor(rng() * n);

// 旧評価器(新評価は既定なので undefined で渡す)。
const OLD: Evaluator = { weights: oldPositionWeightsFor, score: oldEvaluateForPlayer };

/** 指定評価器で 1 手選ぶ。合法手が無ければ -1。 */
function pickMove(board: Board, player: Player, variant: VariantId, ev: Evaluator | undefined): number {
  const res = evaluatePosition(board, player, {
    variant,
    evaluator: ev,
    maxDepth: DEPTH,
    endgameEmpties: EE,
    timeLimitMs: BIG,
  });
  return res.moves.length ? res.moves[0].cell : -1;
}

/** 序盤(openingBoard/openingPlayer)から終局まで打ち切り、最終盤面を返す。 */
function playOut(
  startBoard: Board,
  startPlayer: Player,
  variant: VariantId,
  evalBlack: Evaluator | undefined,
  evalWhite: Evaluator | undefined,
): Board {
  const rays = raysFor(variant);
  let board = startBoard.slice();
  let player = startPlayer;
  for (;;) {
    const moves = legalMoves(board, player, rays);
    if (moves.length === 0) {
      if (!hasLegalMove(board, opponent(player), rays)) break; // 終局
      player = opponent(player);
      continue;
    }
    const ev = player === BLACK ? evalBlack : evalWhite;
    const cell = pickMove(board, player, variant, ev);
    if (cell < 0) break;
    const nb = applyMove(board, cell, player, rays);
    if (!nb) break;
    board = nb;
    player = opponent(player);
  }
  return board;
}

/** ランダム序盤を作る(K 手)。終局してしまったら null。 */
function makeOpening(variant: VariantId, plies: number): { board: Board; player: Player } | null {
  const rays = raysFor(variant);
  let board = createInitialBoard(variant);
  let player: Player = BLACK;
  for (let i = 0; i < plies; i++) {
    const moves = legalMoves(board, player, rays);
    if (moves.length === 0) {
      if (!hasLegalMove(board, opponent(player), rays)) return null;
      player = opponent(player);
      continue;
    }
    const cell = moves[randInt(moves.length)];
    const nb = applyMove(board, cell, player, rays);
    if (!nb) return null;
    board = nb;
    player = opponent(player);
  }
  return { board, player };
}

interface Tally {
  win: number;
  loss: number;
  draw: number;
}
const newTally = (): Tally => ({ win: 0, loss: 0, draw: 0 });

/** 1 局打って NEW 側の勝敗を tally に加算。newColor=NEW が持つ色。 */
function scoreGame(finalBoard: Board, newColor: Player, t: Tally): void {
  const { black, white } = countDiscs(finalBoard);
  const newDiscs = newColor === BLACK ? black : white;
  const oppDiscs = newColor === BLACK ? white : black;
  if (newDiscs > oppDiscs) t.win++;
  else if (newDiscs < oppDiscs) t.loss++;
  else t.draw++;
}

console.log(
  `=== 新旧評価 自己対局 A/B(盤面ごと${PAIRS}ペア×2局 / 中盤深さ${DEPTH} / 終盤完全読み<=${EE} / seed=${SEED.toString(16)}) ===`,
);
console.log('NEW=精度改善版(既定) vs OLD=改善前。勝率 = (勝+0.5*分)/局数。50%超で NEW が強い。\n');

const overall = newTally();
for (const variant of VARIANT_ORDER) {
  const t = newTally();
  let pairs = 0;
  let guard = 0;
  while (pairs < PAIRS && guard < PAIRS * 40) {
    guard++;
    const op = makeOpening(variant, OPENING_PLIES);
    if (!op) continue;
    // 同じ序盤で色を入れ替えて 2 局(先手有利を相殺)。
    scoreGame(playOut(op.board, op.player, variant, undefined, OLD), BLACK, t); // NEW=黒
    scoreGame(playOut(op.board, op.player, variant, OLD, undefined), WHITE, t); // NEW=白
    pairs++;
  }
  overall.win += t.win;
  overall.loss += t.loss;
  overall.draw += t.draw;
  const games = t.win + t.loss + t.draw;
  const winRate = games ? (((t.win + 0.5 * t.draw) / games) * 100).toFixed(1) : '0.0';
  const label = BOARD_VARIANTS[variant].label.padEnd(5, '　');
  console.log(
    `  ${label} NEW勝率 ${winRate.padStart(5)}%  (${t.win}勝 ${t.loss}敗 ${t.draw}分 / ${games}局)`,
  );
}
const games = overall.win + overall.loss + overall.draw;
const winRate = games ? (((overall.win + 0.5 * overall.draw) / games) * 100).toFixed(1) : '0.0';
console.log(
  `  ${'全体'.padEnd(5, '　')} NEW勝率 ${winRate.padStart(5)}%  (${overall.win}勝 ${overall.loss}敗 ${overall.draw}分 / ${games}局)`,
);
