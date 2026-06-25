/**
 * 評価値の色分けロジック(3色)。
 *
 * 「その局面の最善手との差」を基準に分類する(feasibility_design の推奨どおり、
 * 絶対値ではなく相対差で色付けするのが頑健)。
 *
 *   - best : 最善手(最大評価値の手)。強調表示。
 *   - good : 最善との差が GOOD_THRESHOLD 以内 → 緑系。
 *   - bad  : それより離れる → 赤系。
 *
 * ⚠️ しきい値は仮置き(後で調整しやすいよう定数化)。
 *   中盤の評価値は石差スケールに変換済みだが精度は粗いので、しきい値も実測後に調整する。
 */

import type { MoveEval } from '../engine/search';
import type { VariantId } from '../engine/types';

/** 善手と判定する「最善との差」の上限(石差スケール)。これ以内なら good。 */
export const GOOD_THRESHOLD = 2.0;

export type EvalClass = 'best' | 'good' | 'bad';

/**
 * 中盤評価値の「表示専用」スケール(盤ごと)。
 *
 * 中盤の内部値は search.ts の DISC_SCALE(=1/9)で正規化されており、色分け
 * (GOOD_THRESHOLD)・採点(平均ロス等)はこの内部値のまま安定して使う。
 * 一方で表示は、終盤の確定石差(無スケール)と桁を揃えたい。盤ごとに「生評価値が
 * 最終石差をどれだけ予測するか」を自己対局で実測し(scripts/.scale-cal.ts)、その係数を
 * 内部値(=生÷9)に掛けて「予測石差っぽい整数」で見せる。
 * ※ 中盤評価はあくまで推定(実測の相関 R≈0.2〜0.64、特にクロスは弱い)なので、
 *   桁を揃える目的の概算。色・採点には影響しない(表示だけ)。
 */
export const MIDGAME_DISPLAY_SCALE: Record<VariantId, number> = {
  standard: 3,
  cross: 1.5,
  octagon: 3,
  hollow: 4,
};

/**
 * 各手に色クラスを割り当てる。
 * best は最大評価値の手。同値(=どれを打っても最善)の手が複数あれば、その全部を best
 * として強調する(同点最善を1つだけ特別扱いすると、対等な手が劣って見えるため)。
 * それ以外は最善との差で good / bad。
 */
export function classifyMoves(moves: MoveEval[]): Map<number, EvalClass> {
  const result = new Map<number, EvalClass>();
  if (moves.length === 0) return result;

  // 最大値を求める。
  let bestValue = -Infinity;
  for (const m of moves) if (m.value > bestValue) bestValue = m.value;

  for (const m of moves) {
    if (m.value === bestValue) {
      result.set(m.cell, 'best'); // 同点最善はすべて強調。
      continue;
    }
    const diff = bestValue - m.value;
    result.set(m.cell, diff <= GOOD_THRESHOLD ? 'good' : 'bad');
  }
  return result;
}

/** 表示用に評価値を整数寄りの符号付き文字列にする(例: +6 / -4 / 0)。 */
export function formatEvalValue(value: number, exact: boolean): string {
  // 完全読みは確定石差なので整数。中盤は四捨五入して目安表示。
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '' : '±';
  if (rounded === 0) return exact ? '0' : '±0';
  return `${sign}${rounded}`;
}
