/**
 * 旧・中盤評価関数(精度改善前)のスナップショット。A/B 自己対戦の対戦相手としてのみ使う。
 * ※ 本番ビルドには含めない(scripts 配下・dev 専用)。中身は改善前 evaluate.ts と同等。
 */

import {
  type Board,
  type Player,
  type VariantId,
  EMPTY,
  CELLS,
  SIZE,
  idx,
  opponent,
  blockedMaskFor,
} from '../src/engine/types';
import { legalMoves } from '../src/engine/board';

const W_POSITION = 1.0;
const W_MOBILITY = 4.0;
const W_DISC = 1.0;
const WEIGHT_CORNER = 30;
const WEIGHT_EDGE = 6;
const WEIGHT_X_DANGER = -12;
const WEIGHT_INNER = 1;

const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

const WEIGHTS_CACHE = new Map<VariantId, ReadonlyArray<number>>();

export function oldPositionWeightsFor(variant: VariantId): ReadonlyArray<number> {
  const cached = WEIGHTS_CACHE.get(variant);
  if (cached) return cached;
  const blocked = blockedMaskFor(variant);
  const onBoard = (r: number, c: number): boolean =>
    r >= 0 && r < SIZE && c >= 0 && c < SIZE && !blocked[idx(r, c)];

  const weights = new Array<number>(CELLS).fill(0);
  const isCorner = new Array<boolean>(CELLS).fill(false);
  for (let cell = 0; cell < CELLS; cell++) {
    if (blocked[cell]) continue;
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    let neighbors = 0;
    for (const [dr, dc] of DIRS8) if (onBoard(r + dr, c + dc)) neighbors++;
    if (neighbors <= 3) {
      weights[cell] = WEIGHT_CORNER;
      isCorner[cell] = true;
    } else if (neighbors <= 5) {
      weights[cell] = WEIGHT_EDGE;
    } else {
      weights[cell] = WEIGHT_INNER;
    }
  }
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

export function oldEvaluateForPlayer(
  board: Board,
  player: Player,
  rays: number[][][],
  weights: ReadonlyArray<number>,
): number {
  const opp = opponent(player);
  let positionScore = 0;
  let myDiscs = 0;
  let oppDiscs = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === EMPTY || v === 3) continue;
    if (v === player) {
      positionScore += weights[cell];
      myDiscs++;
    } else {
      positionScore -= weights[cell];
      oppDiscs++;
    }
  }
  const mobilityScore =
    legalMoves(board, player, rays).length - legalMoves(board, opp, rays).length;
  const discScore = myDiscs - oppDiscs;
  return W_POSITION * positionScore + W_MOBILITY * mobilityScore + W_DISC * discScore;
}
