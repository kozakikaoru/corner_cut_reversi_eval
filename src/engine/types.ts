/**
 * 共有の型・定数。
 *
 * 盤面表現の方針(ADR-001 / feasibility_design 1-1 を参照):
 * - 8×8 の 64 セルレイアウトをそのまま維持し、四隅 2×2(計16セル)を
 *   「常に盤外(BLOCKED)」として扱う。
 * - セルは row*8 + col のインデックス(0..63)で表す。
 * - 石の状態は Int8Array(64) で保持(EMPTY / BLACK / WHITE / BLOCKED)。
 *
 * 補足: JS のビット演算は 32bit までのため「48bit を 1 つの number に詰めて &」は
 * できない。設計メモの「32bit×2語」案も検討したが、MVP では正しさとテスト容易性を
 * 優先し、Int8Array(64) + 事前計算した方向レイテーブルで実装する。
 * 反復深化 + 時間制限により、生の探索速度に依存せず常に時間内の最善結果を返せる。
 */

/** 盤の一辺。通常オセロと同じ 8。 */
export const SIZE = 8;
/** セル総数(8×8)。四隅16は BLOCKED として除外し、実プレイ可能は 48。 */
export const CELLS = SIZE * SIZE;
/** 実際にプレイできるマス数(8×8 - 四隅16)。 */
export const PLAYABLE_CELLS = 48;

/** セルの状態。 */
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
/** 四隅2×2の欠けマス。石を置けず、反転にも関与しない「壁」。 */
export const BLOCKED = 3;

/** 手番(石の色)。 */
export type Player = typeof BLACK | typeof WHITE;
/** セルに入りうる値。 */
export type Cell = typeof EMPTY | typeof BLACK | typeof WHITE | typeof BLOCKED;

/** 盤面 = 64 セルの状態配列。 */
export type Board = Int8Array;

/** パスを表す着手インデックス。 */
export const PASS = -1;

/** 相手の色を返す。 */
export function opponent(p: Player): Player {
  return p === BLACK ? WHITE : BLACK;
}

/** (row, col) → セルインデックス。 */
export function idx(row: number, col: number): number {
  return row * SIZE + col;
}

/**
 * 四隅2×2が欠けマスかどうか。
 * 各隅: 行0-1×列0-1 / 行0-1×列6-7 / 行6-7×列0-1 / 行6-7×列6-7。
 */
export function isCornerCut(row: number, col: number): boolean {
  const inTop = row <= 1;
  const inBottom = row >= 6;
  const inLeft = col <= 1;
  const inRight = col >= 6;
  return (inTop || inBottom) && (inLeft || inRight);
}
