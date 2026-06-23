/**
 * 共有の型・定数 + 盤面バリエーション定義(データ駆動)。
 *
 * 盤面表現の方針:
 * - どの盤面でも物理レイアウトは 8×8 の 64 セル(row*8 + col、0..63)で固定。
 * - 「欠けマス(BLOCKED)」の集合だけが盤面ごとに違う。欠けマスは石を置けず、
 *   挟みのライン上では「壁」として扱う(盤外と同じ)。
 * - 石の状態は Int8Array(64) で保持(EMPTY / BLACK / WHITE / BLOCKED)。
 *
 * フェーズ2(board_variants.md): 盤面を 4 種に拡張。欠けマス集合をプリセットとして
 * 持ち、盤面ロジック・評価・置換表が「欠けマス集合に依存して」動くようにした。
 * クロス盤専用だったハードコード(isCornerCut)は異形盤の1プリセットへ一般化。
 *
 * 補足: JS のビット演算は 32bit までのため「64bit を 1 つの number に詰めて &」は
 * できない。MVP では正しさとテスト容易性を優先し、Int8Array(64) + 事前計算した
 * 方向レイテーブル(盤面ごと)で実装する。
 */

/** 盤の一辺。全盤面共通で 8。 */
export const SIZE = 8;
/** 物理セル総数(8×8 = 64)。盤面ごとに一部が BLOCKED になる。 */
export const CELLS = SIZE * SIZE;

/** セルの状態。 */
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
/** 欠けマス。石を置けず、反転にも関与しない「壁」。 */
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

// ===========================================================================
// 盤面バリエーション(データ駆動)
// ===========================================================================

/** 盤面の種類 ID。 */
export type VariantId = 'standard' | 'cross' | 'octagon' | 'hollow';

/** 盤面プリセット定義。 */
export interface BoardVariant {
  /** 内部 ID。 */
  id: VariantId;
  /** 表示名(日本語)。 */
  label: string;
  /**
   * 欠けマス = (row, col) のリスト。石を置けない/反転対象外の壁。
   * 中央4マス(row3–4, col3–4)は全盤面で欠けない(初期4石が置かれる)。
   */
  blocked: ReadonlyArray<readonly [number, number]>;
}

/**
 * 4つの盤面プリセット(board_variants.md の定義どおり)。
 * 座標規約: row 0–7 = 上→下、col 0–7 = 左→右。A1 = (0,0) = 左上。
 */
export const BOARD_VARIANTS: Readonly<Record<VariantId, BoardVariant>> = {
  // ① 通常盤(64マス): 欠けなし。
  standard: {
    id: 'standard',
    label: '通常',
    blocked: [],
  },
  // ② クロス盤(48マス): 四隅の 2×2 を欠く。
  cross: {
    id: 'cross',
    label: 'クロス',
    blocked: [
      [0, 0], [0, 1], [1, 0], [1, 1], // 左上
      [0, 6], [0, 7], [1, 6], [1, 7], // 右上
      [6, 0], [6, 1], [7, 0], [7, 1], // 左下
      [6, 6], [6, 7], [7, 6], [7, 7], // 右下
    ],
  },
  // ③ 八角盤(52マス): 四隅を各3マス斜めカットして八角形に。
  octagon: {
    id: 'octagon',
    label: '八角',
    blocked: [
      [0, 0], [0, 1], [1, 0], // 左上
      [0, 6], [0, 7], [1, 7], // 右上
      [6, 0], [7, 0], [7, 1], // 左下
      [6, 7], [7, 6], [7, 7], // 右下
    ],
  },
  // ④ ホロー盤(60マス): B2・G2・B7・G7 の4マスのみ欠く。
  hollow: {
    id: 'hollow',
    label: 'ホロー',
    blocked: [
      [1, 1], // B2
      [1, 6], // G2
      [6, 1], // B7
      [6, 6], // G7
    ],
  },
};

/** UI 表示順(通常 → クロス → 八角 → ホロー)。 */
export const VARIANT_ORDER: ReadonlyArray<VariantId> = [
  'standard',
  'cross',
  'octagon',
  'hollow',
];

/** デフォルト盤面(従来挙動と互換: クロス盤)。 */
export const DEFAULT_VARIANT: VariantId = 'cross';

/**
 * 盤面の「欠けマスフラグ表」(長さ 64、true=欠け)を返す。
 * 同一 variant に対してはキャッシュした同一配列を返す(再計算を避ける)。
 */
const BLOCKED_MASK_CACHE = new Map<VariantId, ReadonlyArray<boolean>>();
export function blockedMaskFor(variant: VariantId): ReadonlyArray<boolean> {
  const cached = BLOCKED_MASK_CACHE.get(variant);
  if (cached) return cached;
  const mask = new Array<boolean>(CELLS).fill(false);
  for (const [r, c] of BOARD_VARIANTS[variant].blocked) {
    mask[idx(r, c)] = true;
  }
  BLOCKED_MASK_CACHE.set(variant, mask);
  return mask;
}

/** その盤面で (row, col) が欠けマスか。 */
export function isBlockedAt(variant: VariantId, row: number, col: number): boolean {
  return blockedMaskFor(variant)[idx(row, col)];
}

/** その盤面の実プレイ可能マス数(64 - 欠けマス数)。 */
export function playableCellsFor(variant: VariantId): number {
  return CELLS - BOARD_VARIANTS[variant].blocked.length;
}
