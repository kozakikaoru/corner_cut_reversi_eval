/**
 * Zobrist ハッシュ(置換表のキー生成用)。
 *
 * JS のビット演算は 32bit なので、ハッシュを 32bit×2語(hi/lo)で保持する。
 * 盤面ごとに全 64 セルを走査してハッシュを計算する(本 MVP では各ノードで再計算)。
 * セル状態 BLACK/WHITE と「手番」だけを混ぜる(EMPTY/BLOCKED は寄与しない)。
 *
 * フェーズ2(盤面バリエーション)での安全性:
 *   キーは「物理セルインデックス(0..63)× 石色」で引く。欠けマス(BLOCKED)はそこに
 *   石が乗らないため決して XOR されず、盤面サイズや欠けマス集合が変わってもキー空間は
 *   一貫している。つまり置換表は盤面ごとに作り直さなくても破綻しない(実際には探索
 *   呼び出しごとに新しい Map を使うため、盤面が混ざることもない)。
 *
 * キー文字列化: `hi.toString(36) + ':' + lo.toString(36)`。
 * 64bit を 1 つの number に詰めると 2^53 を超えて精度が落ちるため、衝突回避目的で
 * 文字列キーにする(MVP では十分。反復深化が常に時間内の結果を返すため速度依存が低い)。
 */

import { type Board, type Player, CELLS, BLACK } from './types';

// セル × 状態(BLACK=1, WHITE=2 の2種; EMPTY は寄与しない)ごとの乱数キー。
// インデックス: cell * 3 + state(state: 1=BLACK, 2=WHITE)。0(EMPTY)は未使用。
const KEYS_LO = new Int32Array(CELLS * 3);
const KEYS_HI = new Int32Array(CELLS * 3);
let SIDE_LO = 0;
let SIDE_HI = 0;

// 決定論的な擬似乱数(再現性のため固定シード）。
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

(function initKeys() {
  const rng = makeRng(0x9e3779b9);
  for (let i = 0; i < KEYS_LO.length; i++) {
    KEYS_LO[i] = rng() | 0;
    KEYS_HI[i] = rng() | 0;
  }
  SIDE_LO = rng() | 0;
  SIDE_HI = rng() | 0;
})();

/** 盤面 + 手番から置換表キー文字列を計算する。 */
export function hashKey(board: Board, player: Player): string {
  let lo = 0;
  let hi = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const v = board[cell];
    if (v === 1 || v === 2) {
      const k = cell * 3 + v;
      lo ^= KEYS_LO[k];
      hi ^= KEYS_HI[k];
    }
  }
  if (player === BLACK) {
    lo ^= SIDE_LO;
    hi ^= SIDE_HI;
  }
  // >>>0 で符号無し化してから 36 進文字列に。
  return (hi >>> 0).toString(36) + ':' + (lo >>> 0).toString(36);
}
