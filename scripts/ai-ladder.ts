/**
 * AI 難易度ラダーの検証(開発用 / ビルド外)。
 *
 * 「人間プロキシ(=最善手を約 H% で選ぶ程度のカジュアルプレイヤー)」を各 AI レベルと
 * 対局させ、人間側の勝率を測る。狙い:
 *   - 下位レベル(ビギナー等)は人間が気持ちよく勝てる(高勝率)。
 *   - 上位(バーサーカー)はほぼ勝てない(低勝率)。
 *   - レベルが上がるほど人間勝率が単調に下がる(滑らかな勾配)。
 *
 * 公平化: 同じ序盤(ランダム)から色を入れ替えて 2 局。序盤・ミスはシード固定で再現可能。
 *
 * 実行: npm run bench:ladder [pairs] [humanMistakeRate]   (既定 20 / 0.45)
 *   humanMistakeRate=0.45 → 最善を約55%で選ぶ人間(中級下位の実測に近い)。
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
import { evaluatePosition, evaluatorForMode } from '../src/engine/search';
import { AI_LEVELS, chooseAiMove, type AiLevel } from '../src/game/ai';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x0dba11ad;
const PAIRS = Number.parseInt(process.argv[2] ?? '20', 10);
const HUMAN_MISTAKE = Number.parseFloat(process.argv[3] ?? '0.45');
const OPENING_PLIES = 4;
// バーサーカー等の時間制レベルはハーネスでは固定深さに置換(高速化。強さは十分高い)。
const HARNESS_MAX_DEPTH = 9;
const BIG = 600000;

const rng = mulberry32(SEED);
const randInt = (n: number): number => Math.floor(rng() * n);

// 人間プロキシ: 最善を (1-HUMAN_MISTAKE) で選び、ミス時は上位手から(=もっともらしい凡ミス)。
// 数手先は見る(maxDepth=3)・角等は分かる(full)・終盤完全読みはしない(endgameEmpties=0)。
const HUMAN: AiLevel = {
  id: 1,
  label: '人間プロキシ',
  desc: '',
  special: false,
  maxDepth: 3,
  endgameEmpties: 0,
  evalMode: 'full',
  mistakeRate: HUMAN_MISTAKE,
  pickFrom: 'topK',
  topK: 4,
  thinkDelayMs: [0, 0],
};

/** level の設定で 1 手選ぶ(時間制レベルはハーネス用に固定深さへ置換)。 */
function pickMove(board: Board, player: Player, variant: VariantId, level: AiLevel): number {
  const res = evaluatePosition(board, player, {
    variant,
    maxDepth: level.maxDepth ?? HARNESS_MAX_DEPTH,
    endgameEmpties: level.endgameEmpties,
    evaluator: evaluatorForMode(level.evalMode),
    timeLimitMs: BIG,
  });
  return chooseAiMove(res.moves, level, rng);
}

function playOut(
  startBoard: Board,
  startPlayer: Player,
  variant: VariantId,
  black: AiLevel,
  white: AiLevel,
): Board {
  const rays = raysFor(variant);
  let board = startBoard.slice();
  let player = startPlayer;
  for (;;) {
    const moves = legalMoves(board, player, rays);
    if (moves.length === 0) {
      if (!hasLegalMove(board, opponent(player), rays)) break;
      player = opponent(player);
      continue;
    }
    const cell = pickMove(board, player, variant, player === BLACK ? black : white);
    const nb = cell >= 0 ? applyMove(board, cell, player, rays) : null;
    if (!nb) break;
    board = nb;
    player = opponent(player);
  }
  return board;
}

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
    const nb = applyMove(board, moves[randInt(moves.length)], player, rays);
    if (!nb) return null;
    board = nb;
    player = opponent(player);
  }
  return { board, player };
}

/** 人間視点の勝敗を加算。 */
function score(finalBoard: Board, humanColor: Player, t: { w: number; l: number; d: number }): void {
  const { black, white } = countDiscs(finalBoard);
  const h = humanColor === BLACK ? black : white;
  const o = humanColor === BLACK ? white : black;
  if (h > o) t.w++;
  else if (h < o) t.l++;
  else t.d++;
}

console.log(
  `=== AI難易度ラダー検証(人間プロキシ: 最善約${Math.round((1 - HUMAN_MISTAKE) * 100)}%で選ぶ / 各レベル ${PAIRS}ペア×2局×4盤面) ===`,
);
console.log('各レベルに対する「人間の勝率」。下位ほど高く、上位ほど低いのが理想。\n');

for (const level of AI_LEVELS) {
  const t = { w: 0, l: 0, d: 0 };
  for (const variant of VARIANT_ORDER) {
    let pairs = 0;
    let guard = 0;
    while (pairs < PAIRS && guard < PAIRS * 40) {
      guard++;
      const op = makeOpening(variant, OPENING_PLIES);
      if (!op) continue;
      score(playOut(op.board, op.player, variant, HUMAN, level), BLACK, t); // 人間=黒
      score(playOut(op.board, op.player, variant, level, HUMAN), WHITE, t); // 人間=白
      pairs++;
    }
  }
  const games = t.w + t.l + t.d;
  const winRate = games ? (((t.w + 0.5 * t.d) / games) * 100).toFixed(1) : '0.0';
  const label = level.label.padEnd(16, ' ');
  console.log(`  ${label} 人間勝率 ${winRate.padStart(5)}%  (${t.w}勝 ${t.l}敗 ${t.d}分 / ${games}局)`);
}
