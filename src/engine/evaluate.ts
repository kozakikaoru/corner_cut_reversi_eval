/**
 * 中盤評価関数(盤面非依存 = 全盤面で動く汎用ロジック)。
 *
 * 探索内では常に「手番側から見た値」を使う(negamax)。本関数は
 * evaluateForPlayer(board, player, rays, weights) で「player から見た評価値」を返す。
 *
 * 構成(オセロの定石的な評価項を、異形盤でも破綻しないよう一般化):
 *   1. マス重みテーブル(盤面ごとに手続き生成。角>辺>内部、X/C マスは負)
 *   2. 着手可能数(mobility)
 *   3. 開放度(フロンティア石 = 空きに接する石。少ないほど安定で良い)
 *   4. 石数(disc count) ※中盤は軽め(終盤完全読みでは本関数は使わない)
 *
 * マス重みの考え方(異形盤の一般化):
 *   「打てるマスのうち、8 近傍に占める “盤上(欠けでも盤外でもない)” の数が少ない=
 *    取られにくい安定マス」を角的とみなし高い重みを与える。通常盤の四隅・クロス盤の肩
 *    などが自然に高評価になる。角に隣接するマスは相手へ角を渡しうる危険マスとして負に:
 *     - 対角隣接(X マス)= 最も危険 → 強い負。
 *     - 直交隣接(C マス)= やや危険   → 軽い負。
 *
 * 係数はベンチ(scripts/eval-bench.ts:完全読みを正解とした着手 regret)で較正する。
 * 未実装(将来):確定石(stable discs)・パリティ。
 */

import {
  type Board,
  type Player,
  type VariantId,
  EMPTY,
  BLOCKED,
  CELLS,
  SIZE,
  idx,
  opponent,
  blockedMaskFor,
} from './types';
import { legalMoves } from './board';

// --- マス重み生成のヒューリスティック定数(ベンチで較正) --------------------
/** 角(取られにくい安定マス)の重み。 */
const WEIGHT_CORNER = 36;
/** 辺・準安定マスの重み。 */
const WEIGHT_EDGE = 8;
/** 中央寄りの内部マスの基準重み。 */
const WEIGHT_INNER = 2;
/** X マス(角に対角隣接=最も危険)の重み(負)。 */
const WEIGHT_X = -28;
/** C マス(角に直交隣接=やや危険)の重み(負)。 */
const WEIGHT_C = -8;

// --- 評価項の重み係数(ベンチで較正) ----------------------------------------
/** マス重みの寄与。 */
const W_POSITION = 1.0;
/** フロンティア石(空きに接する石)差の重み。少ない方が良いので符号は「相手-自分」。 */
const W_FRONTIER = 2.5;
/** mobility(着手可能数の差)1 手あたりの重み。 */
const W_MOBILITY = 4.0;
/** disc 差 1 個あたりの重み(中盤は軽め)。 */
const W_DISC = 1.0;

const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];
const DIRS_DIAG: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];
const DIRS_ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

/**
 * その盤面のマス重みテーブル(長さ 64)を手続き的に生成する。
 * 欠けマスは 0。VariantId でキャッシュする。
 *
 * 手順:
 *   1. 各プレイ可能マスの「盤上(=非壁)8 近傍数」で 角/辺/内部 を分類。
 *      近傍 <=3 → 角(WEIGHT_CORNER) / 4..5 → 辺(WEIGHT_EDGE) / それ以外 → 内部(WEIGHT_INNER)。
 *   2. 角でないマスのうち、角に対角隣接=X マス(WEIGHT_X)、直交隣接=C マス(WEIGHT_C)を上書き。
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

  // 2. 角に隣接するマスを危険マスに(角自身は維持)。対角=X(強い負)/ 直交=C(軽い負)。
  for (let cell = 0; cell < CELLS; cell++) {
    if (blocked[cell] || isCorner[cell]) continue;
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    let diagCorner = false;
    let orthoCorner = false;
    for (const [dr, dc] of DIRS_DIAG) {
      if (onBoard(r + dr, c + dc) && isCorner[idx(r + dr, c + dc)]) diagCorner = true;
    }
    for (const [dr, dc] of DIRS_ORTHO) {
      if (onBoard(r + dr, c + dc) && isCorner[idx(r + dr, c + dc)]) orthoCorner = true;
    }
    // X マス(対角隣接)を優先(より危険)。
    if (diagCorner) weights[cell] = WEIGHT_X;
    else if (orthoCorner) weights[cell] = WEIGHT_C;
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

  // 1 パスで「マス重み・石数・フロンティア石」をまとめて集計。
  let positionScore = 0;
  let myDiscs = 0;
  let oppDiscs = 0;
  let myFrontier = 0;
  let oppFrontier = 0;

  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === EMPTY || v === BLOCKED) continue;

    const mine = v === player;
    if (mine) {
      positionScore += weights[cell];
      myDiscs++;
    } else {
      positionScore -= weights[cell];
      oppDiscs++;
    }

    // フロンティア石: 8 近傍に空きマスがある石。少ないほど安定。
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    let frontier = false;
    for (const [dr, dc] of DIRS8) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[idx(nr, nc)] === EMPTY) {
        frontier = true;
        break;
      }
    }
    if (frontier) {
      if (mine) myFrontier++;
      else oppFrontier++;
    }
  }

  // 2. mobility(着手可能数の差)
  const mobilityScore = legalMoves(board, player, rays).length - legalMoves(board, opp, rays).length;

  // 3. フロンティア差(自分が少ない=有利なので「相手 - 自分」)
  const frontierScore = oppFrontier - myFrontier;

  // 4. 石数差
  const discScore = myDiscs - oppDiscs;

  return (
    W_POSITION * positionScore +
    W_MOBILITY * mobilityScore +
    W_FRONTIER * frontierScore +
    W_DISC * discScore
  );
}
