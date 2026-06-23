/**
 * 中盤評価関数。
 *
 * 返す値は「黒から見たスコア(無次元、相対比較用)」ではなく、
 * 探索内では常に「手番側から見た値」を使う(negamax)。本関数は
 * evaluateForPlayer(board, player) で「player から見た評価値」を返す。
 *
 * 構成(feasibility_design §2(b) に沿う):
 *   1. マス重みテーブル(POSITION_WEIGHTS)
 *   2. 着手可能数(mobility)
 *   3. 石数(disc count) ※終盤に向けて比重を上げたいが MVP では軽め
 *
 * ⚠️ 後で精度調整する箇所:
 *   - POSITION_WEIGHTS は変則盤(四隅欠け)向けの「手置き」値。王道の角理論が
 *     そのまま使えないため、欠け2×2に隣接するセル(疑似的な角・辺)を厚めにしてある。
 *     実測・自己対戦でのチューニング対象。
 *   - 各項の重み係数(W_POSITION / W_MOBILITY / W_DISC)も暫定値。
 *   - 確定石・開放度・パリティ等の項は未実装(v2 で追加予定)。
 */

import {
  type Board,
  type Player,
  BLACK,
  WHITE,
  EMPTY,
  CELLS,
  opponent,
} from './types';
import { legalMoves } from './board';

/**
 * マス重みテーブル(8×8、欠けマスは 0)。
 * 四隅2×2が無い前提。欠け領域に接する「肩」のセルを安定マスとして高めに、
 * 欠けに斜め隣接する危険マス(通常オセロの X打ち的な位置)を低めに置く。
 *
 * レイアウト(row 0 が上):
 *   列:   0    1    2    3    4    5    6    7
 *   ------------------------------------------------
 *   r0   [  X    X   c3   v0   v0   c3    X    X ]   ← 隅2×2(0,1列/6,7列)は欠け
 *   r1   [  X    X   e1   v1   v1   e1    X    X ]
 *   r2   [ c3   e1   s    .    .    s    e1   c3 ]
 *   r3   [ v0   v1   .    .    .    .    v1   v0 ]
 *   r4   [ v0   v1   .    .    .    .    v1   v0 ]
 *   r5   [ c3   e1   s    .    .    s    e1   c3 ]
 *   r6   [  X    X   e1   v1   v1   e1    X    X ]
 *   r7   [  X    X   c3   v0   v0   c3    X    X ]
 *
 * 値の意図:
 *   X(欠け) = 0
 *   c3 = 欠けに接する辺端の安定寄りマス(疑似コーナー的) → 高め
 *   s  = 欠けの内側の角(2,2)など、複数方向に開けた要所 → 高め
 *   e1 = 欠けに斜め隣接する危険マス(取られると相手に好所を渡す) → 低め(負)
 *   v0/v1 = 中央寄りの辺・内部 → 中庸
 */
// prettier-ignore
const POSITION_WEIGHTS: ReadonlyArray<number> = [
  // r0
   0,   0,  30,  -3,  -3,  30,   0,   0,
  // r1
   0,   0, -12,  -2,  -2, -12,   0,   0,
  // r2
  30, -12,  16,   1,   1,  16, -12,  30,
  // r3
  -3,  -2,   1,   2,   2,   1,  -2,  -3,
  // r4
  -3,  -2,   1,   2,   2,   1,  -2,  -3,
  // r5
  30, -12,  16,   1,   1,  16, -12,  30,
  // r6
   0,   0, -12,  -2,  -2, -12,   0,   0,
  // r7
   0,   0,  30,  -3,  -3,  30,   0,   0,
];

// --- 各項の重み係数(暫定値 / 後で精度調整する箇所) -------------------------
/** マス重みの寄与。 */
const W_POSITION = 1.0;
/** 着手可能数(mobility)の差 1 手あたりのスコア。 */
const W_MOBILITY = 4.0;
/** 石数差 1 個あたりのスコア(中盤は小さめ。終盤完全読みでは本関数は使わない)。 */
const W_DISC = 1.0;

/**
 * player から見た中盤評価値を返す(大きいほど player に有利)。
 * negamax から呼ぶため「手番側視点」で符号を揃える。
 */
export function evaluateForPlayer(board: Board, player: Player): number {
  const opp = opponent(player);

  // 1. マス重み + 石数
  let positionScore = 0;
  let myDiscs = 0;
  let oppDiscs = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === EMPTY) continue;
    if (v === player) {
      positionScore += POSITION_WEIGHTS[cell];
      myDiscs++;
    } else {
      positionScore -= POSITION_WEIGHTS[cell];
      oppDiscs++;
    }
  }

  // 2. mobility(着手可能数の差)
  const myMob = legalMoves(board, player).length;
  const oppMob = legalMoves(board, opp).length;
  const mobilityScore = myMob - oppMob;

  // 3. 石数差(MVP では軽め)
  const discScore = myDiscs - oppDiscs;

  return (
    W_POSITION * positionScore +
    W_MOBILITY * mobilityScore +
    W_DISC * discScore
  );
}

/** デバッグ/表示用: 黒視点の素の評価値。 */
export function evaluateForBlack(board: Board): number {
  return evaluateForPlayer(board, BLACK);
}

export { POSITION_WEIGHTS, W_POSITION, W_MOBILITY, W_DISC, BLACK, WHITE };
