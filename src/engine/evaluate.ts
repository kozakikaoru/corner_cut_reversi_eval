/**
 * 中盤評価関数(盤面非依存 = 全盤面で動く汎用ロジック)。
 *
 * 探索内では常に「手番側から見た値」を使う(negamax)。本関数は
 * evaluateForPlayer(board, player, rays, weights) で「player から見た評価値」を返す。
 *
 * 構成(feasibility_design §2(b) に沿う):
 *   1. マス重みテーブル(盤面ごとに手続き的に生成。下記 positionWeightsFor)
 *   2. 着手可能数(mobility)
 *   3. 石数(disc count) ※終盤に向けて比重を上げたいが MVP では軽め
 *
 * フェーズ2の方針 — マス重みを盤面ごとに自動生成する:
 *   従来は 8×8(四隅2×2欠け)前提の固定テーブルをハードコードしていた。盤面が4種に
 *   増えたため、欠けマス集合から「角・辺・危険マス」を判定して重みを手続き的に作る。
 *   各盤面で破綻しない汎用ロジックを最優先(精度チューニングは後追い)。
 *
 *   角(コーナー)の定義(異形盤の一般化):
 *     「打てるマスのうち、8近傍に占める “盤上(欠けでも盤外でもない)” の数が少ない=
 *      取られにくい安定マス」を角的とみなし高い重みを与える。
 *     通常盤の四隅(近傍3)・クロス盤の肩(近傍が壁で削られる)などが自然に高評価になる。
 *     角に隣接する空き(=相手に角を渡しうる危険マス)は負の重みにする。
 *
 *   ⚠️ 後で精度調整する箇所:
 *     - 重み生成のヒューリスティック(NEIGHBOR ベース)は MVP の手置き。盤面ごとの
 *       本格チューニングは自己対戦で行う(各盤面の定数を別途持てる設計余地は残す)。
 *     - 各項の係数(W_POSITION / W_MOBILITY / W_DISC)も暫定値。
 *     - 確定石・開放度・パリティ等の項は未実装(v2 で追加予定)。
 */

import {
  type Board,
  type Player,
  type VariantId,
  BLACK,
  EMPTY,
  CELLS,
  SIZE,
  idx,
  opponent,
  blockedMaskFor,
} from './types';
import { legalMoves } from './board';

// --- 各項の重み係数(暫定値 / 後で精度調整する箇所) -------------------------
/** マス重みの寄与。 */
const W_POSITION = 1.0;
/** 着手可能数(mobility)の差 1 手あたりのスコア。 */
const W_MOBILITY = 4.0;
/** 石数差 1 個あたりのスコア(中盤は小さめ。終盤完全読みでは本関数は使わない)。 */
const W_DISC = 1.0;

// --- マス重み生成のヒューリスティック定数(後で精度調整する箇所) ------------
/** 角(取られにくい安定マス)の重み。 */
const WEIGHT_CORNER = 30;
/** 辺・準安定マスの重み。 */
const WEIGHT_EDGE = 6;
/** 角に隣接する危険マス(相手に角を渡しうる)の重み(負)。 */
const WEIGHT_X_DANGER = -12;
/** 中央寄りの内部マスの基準重み。 */
const WEIGHT_INNER = 1;

const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

/**
 * その盤面のマス重みテーブル(長さ 64)を手続き的に生成する。
 * 欠けマスは 0。VariantId でキャッシュする。
 *
 * 手順:
 *   1. 各プレイ可能マスの「盤上(=非壁)8近傍数」を数える。少ないほど安定(角的)。
 *      - 近傍数 <= 3 → 角(WEIGHT_CORNER)
 *      - 近傍数 4..5 → 辺(WEIGHT_EDGE)
 *      - それ以外    → 内部(WEIGHT_INNER)
 *   2. 角マスに隣接するプレイ可能マスは危険マス(WEIGHT_X_DANGER)で上書き。
 *      ただしそれ自身が角なら角のまま(角>危険)。
 */
const WEIGHTS_CACHE = new Map<VariantId, ReadonlyArray<number>>();

export function positionWeightsFor(variant: VariantId): ReadonlyArray<number> {
  const cached = WEIGHTS_CACHE.get(variant);
  if (cached) return cached;

  const blocked = blockedMaskFor(variant);
  const onBoard = (r: number, c: number): boolean =>
    r >= 0 && r < SIZE && c >= 0 && c < SIZE && !blocked[idx(r, c)];

  // 1. 近傍数で角/辺/内部を分類。
  const weights = new Array<number>(CELLS).fill(0);
  const isCorner = new Array<boolean>(CELLS).fill(false);
  for (let cell = 0; cell < CELLS; cell++) {
    if (blocked[cell]) continue; // 欠けマスは 0。
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    let neighbors = 0;
    for (const [dr, dc] of DIRS8) {
      if (onBoard(r + dr, c + dc)) neighbors++;
    }
    if (neighbors <= 3) {
      weights[cell] = WEIGHT_CORNER;
      isCorner[cell] = true;
    } else if (neighbors <= 5) {
      weights[cell] = WEIGHT_EDGE;
    } else {
      weights[cell] = WEIGHT_INNER;
    }
  }

  // 2. 角に隣接するマスを危険マスに(角自身は維持)。
  for (let cell = 0; cell < CELLS; cell++) {
    if (blocked[cell] || isCorner[cell]) continue;
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    let adjacentToCorner = false;
    for (const [dr, dc] of DIRS8) {
      const nr = r + dr;
      const nc = c + dc;
      if (onBoard(nr, nc) && isCorner[idx(nr, nc)]) {
        adjacentToCorner = true;
        break;
      }
    }
    if (adjacentToCorner) weights[cell] = WEIGHT_X_DANGER;
  }

  WEIGHTS_CACHE.set(variant, weights);
  return weights;
}

/**
 * player から見た中盤評価値を返す(大きいほど player に有利)。
 * negamax から呼ぶため「手番側視点」で符号を揃える。
 *
 * @param rays    その盤面の方向レイ(legalMoves 用)。盤面と一致させること。
 * @param weights その盤面のマス重み(positionWeightsFor)。盤面と一致させること。
 */
export function evaluateForPlayer(
  board: Board,
  player: Player,
  rays: number[][][],
  weights: ReadonlyArray<number>,
): number {
  const opp = opponent(player);

  // 1. マス重み + 石数
  let positionScore = 0;
  let myDiscs = 0;
  let oppDiscs = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === EMPTY || v === 3 /* BLOCKED */) continue;
    if (v === player) {
      positionScore += weights[cell];
      myDiscs++;
    } else {
      positionScore -= weights[cell];
      oppDiscs++;
    }
  }

  // 2. mobility(着手可能数の差)
  const myMob = legalMoves(board, player, rays).length;
  const oppMob = legalMoves(board, opp, rays).length;
  const mobilityScore = myMob - oppMob;

  // 3. 石数差(MVP では軽め)
  const discScore = myDiscs - oppDiscs;

  return (
    W_POSITION * positionScore +
    W_MOBILITY * mobilityScore +
    W_DISC * discScore
  );
}

export { W_POSITION, W_MOBILITY, W_DISC, BLACK };
