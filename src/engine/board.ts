/**
 * 盤面ロジック(純粋関数中心)。
 * - 初期配置 / 合法手生成 / 反転(着手適用) / パス・終局判定 / 石数カウント。
 *
 * 異形盤対応の肝(全盤面共通の仕組み):
 *   欠けマス(BLOCKED)と盤外は、挟みのライン上で「壁」として扱う。
 *   そのため各セルの「方向ごとのレイ(直線上のセル列)」を事前計算し、
 *   ライン生成の時点で盤外・欠けマスを除外しておく(= ライン上に BLOCKED は現れない)。
 *
 *   フェーズ2: 欠けマス集合は盤面(VariantId)ごとに異なるため、RAYS テーブルも
 *   盤面ごとに用意し、VariantId でキャッシュする。ロジック自体は盤面に依存せず、
 *   「その盤面の RAYS」を渡せばどの盤面でも同じコードで動く。
 *
 *   ⚠️ Board(Int8Array)は欠けマスの位置情報を BLOCKED として自身に持つので、
 *   関数に Board を渡す限り flippedBy/legalMoves 等は RAYS 無しでも EMPTY/BLOCKED を
 *   見て正しく動く。ただし RAYS による「壁の手前で打ち切り」は高速化と明示性のため
 *   盤面に整合した RAYS を使う。Board と RAYS の盤面は必ず一致させること。
 */

import {
  type Board,
  type Player,
  type VariantId,
  BLACK,
  WHITE,
  EMPTY,
  BLOCKED,
  CELLS,
  SIZE,
  PASS,
  idx,
  opponent,
  blockedMaskFor,
} from './types';

/** 8方向(dr, dc)。 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

/**
 * RAYS[cell] = 各方向のレイ(そのセルから外側へ向かうセルインデックスの列)。
 * 盤外・欠けマスに当たった時点でそのレイは打ち切る(= 壁の手前まで)。
 * 欠けマス自身を起点とするレイは空(そこには石を置けないので使われない)。
 *
 * 盤面ごとに欠けマスが違うので VariantId でキャッシュする。
 */
const RAYS_CACHE = new Map<VariantId, number[][][]>();

function raysFor(variant: VariantId): number[][][] {
  const cached = RAYS_CACHE.get(variant);
  if (cached) return cached;
  const rays = buildRays(variant);
  RAYS_CACHE.set(variant, rays);
  return rays;
}

function buildRays(variant: VariantId): number[][][] {
  const blocked = blockedMaskFor(variant);
  const rays: number[][][] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;
    const perDir: number[][] = [];
    for (const [dr, dc] of DIRECTIONS) {
      const ray: number[] = [];
      // 起点が欠けマスならレイ無し。
      if (!blocked[cell]) {
        let r = row + dr;
        let c = col + dc;
        // 盤外 or 欠けマスに当たるまで進む(壁の手前まで)。
        while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && !blocked[idx(r, c)]) {
          ray.push(idx(r, c));
          r += dr;
          c += dc;
        }
      }
      perDir.push(ray);
    }
    rays.push(perDir);
  }
  return rays;
}

/** 空の盤(欠けマスは BLOCKED、それ以外は EMPTY)を作る。 */
export function createEmptyBoard(variant: VariantId): Board {
  const blocked = blockedMaskFor(variant);
  const b = new Int8Array(CELLS);
  for (let cell = 0; cell < CELLS; cell++) {
    b[cell] = blocked[cell] ? BLOCKED : EMPTY;
  }
  return b;
}

/**
 * 初期盤面。中央4マスの交差配置(全盤面共通)。
 *   通常オセロとは白黒を反転させた配置(本ツールの仕様 / フェーズ1で反転済み)。
 * 0-index の (row,col) では:
 *   黒: (3,3),(4,4) / 白: (3,4),(4,3)
 * 中央4マスはどの盤面でも欠けないため、全盤面で同じ初期配置になる。
 */
export function createInitialBoard(variant: VariantId): Board {
  const b = createEmptyBoard(variant);
  b[idx(3, 3)] = BLACK;
  b[idx(4, 4)] = BLACK;
  b[idx(3, 4)] = WHITE;
  b[idx(4, 3)] = WHITE;
  return b;
}

/** 盤面のコピー。 */
export function cloneBoard(board: Board): Board {
  return board.slice();
}

/**
 * あるセルに player が着手したとき、反転する石のセル列を返す。
 * 1つも返らない(= 反転0)なら、その手は非合法。
 */
export function flippedBy(board: Board, cell: number, player: Player, rays: number[][][]): number[] {
  if (board[cell] !== EMPTY) return [];
  const opp = opponent(player);
  const flips: number[] = [];
  const dirs = rays[cell];
  for (let d = 0; d < dirs.length; d++) {
    const ray = dirs[d];
    const lineFlips: number[] = [];
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i];
      const v = board[s];
      if (v === opp) {
        // 相手石が続く間は反転候補として溜める。
        lineFlips.push(s);
      } else if (v === player) {
        // 自分の石で挟めた → この方向の候補を確定。
        if (lineFlips.length > 0) {
          for (const f of lineFlips) flips.push(f);
        }
        break;
      } else {
        // EMPTY に当たった → 挟めない(壁/欠けマスはレイに含まれないのでここは EMPTY のみ)。
        break;
      }
    }
  }
  return flips;
}

/** その手が合法か(1つ以上反転できるか)。 */
export function isLegalMove(board: Board, cell: number, player: Player, rays: number[][][]): boolean {
  if (board[cell] !== EMPTY) return false;
  const opp = opponent(player);
  const dirs = rays[cell];
  for (let d = 0; d < dirs.length; d++) {
    const ray = dirs[d];
    let sawOpp = false;
    for (let i = 0; i < ray.length; i++) {
      const v = board[ray[i]];
      if (v === opp) {
        sawOpp = true;
      } else if (v === player) {
        if (sawOpp) return true; // 1方向でも挟めれば合法
        break;
      } else {
        break; // EMPTY
      }
    }
  }
  return false;
}

/** player の全合法手(セルインデックスの配列)。 */
export function legalMoves(board: Board, player: Player, rays: number[][][]): number[] {
  const moves: number[] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (board[cell] === EMPTY && isLegalMove(board, cell, player, rays)) {
      moves.push(cell);
    }
  }
  return moves;
}

/** player に合法手があるか(legalMoves より軽い早期 return 版)。 */
export function hasLegalMove(board: Board, player: Player, rays: number[][][]): boolean {
  for (let cell = 0; cell < CELLS; cell++) {
    if (board[cell] === EMPTY && isLegalMove(board, cell, player, rays)) {
      return true;
    }
  }
  return false;
}

/**
 * 着手を適用した「新しい盤面」を返す(元盤面は破壊しない)。
 * 非合法手の場合は null。
 */
export function applyMove(board: Board, cell: number, player: Player, rays: number[][][]): Board | null {
  const flips = flippedBy(board, cell, player, rays);
  if (flips.length === 0) return null;
  const next = cloneBoard(board);
  next[cell] = player;
  for (const f of flips) next[f] = player;
  return next;
}

/**
 * 探索用のインプレース着手。呼び出し側で flips を保持し、undoMove で戻す。
 * (探索の高速化のため、盤面コピーを避ける。)
 * 事前条件: cell は player の合法手(flips.length > 0)であること。
 */
export function makeMoveInPlace(board: Board, cell: number, player: Player, flips: number[]): void {
  board[cell] = player;
  for (let i = 0; i < flips.length; i++) board[flips[i]] = player;
}

/** makeMoveInPlace の取り消し。 */
export function undoMoveInPlace(board: Board, cell: number, _player: Player, flips: number[]): void {
  const opp = opponent(_player);
  board[cell] = EMPTY;
  for (let i = 0; i < flips.length; i++) board[flips[i]] = opp;
}

/** 石数を数える。 */
export function countDiscs(board: Board): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === BLACK) black++;
    else if (v === WHITE) white++;
    else if (v === EMPTY) empty++;
  }
  return { black, white, empty };
}

/** 空きマス数(終盤完全読みの切替判定に使う)。 */
export function countEmpties(board: Board): number {
  let empty = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    if (board[cell] === EMPTY) empty++;
  }
  return empty;
}

/** 終局か(両者とも合法手が無い)。 */
export function isGameOver(board: Board, rays: number[][][]): boolean {
  return !hasLegalMove(board, BLACK, rays) && !hasLegalMove(board, WHITE, rays);
}

export { PASS, raysFor };
