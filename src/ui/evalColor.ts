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

/** 善手と判定する「最善との差」の上限(石差スケール)。これ以内なら good。 */
export const GOOD_THRESHOLD = 2.0;

export type EvalClass = 'best' | 'good' | 'bad';

/**
 * 各手に色クラスを割り当てる。
 * best は最大値の手(複数あれば最初の1つを best、同値の他手は good 扱い)。
 */
export function classifyMoves(moves: MoveEval[]): Map<number, EvalClass> {
  const result = new Map<number, EvalClass>();
  if (moves.length === 0) return result;

  // 最大値を求める。
  let bestValue = -Infinity;
  for (const m of moves) if (m.value > bestValue) bestValue = m.value;

  let bestAssigned = false;
  // value 降順に見て、最初の最大値の手だけ best にする。
  const sorted = [...moves].sort((a, b) => b.value - a.value);
  for (const m of sorted) {
    if (!bestAssigned && m.value === bestValue) {
      result.set(m.cell, 'best');
      bestAssigned = true;
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
