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
import { type VariantId, playableCellsFor } from '../engine/types';

/** 善手と判定する「最善との差」の上限(石差スケール)。これ以内なら good。 */
export const GOOD_THRESHOLD = 2.0;

export type EvalClass = 'best' | 'good' | 'bad';

/**
 * 中盤評価値の「表示専用」変換。
 *
 * 中盤の内部値(MoveEval.value)は search.ts の DISC_SCALE(=1/9)で正規化されており、
 * 色分け(GOOD_THRESHOLD)・採点(平均ロス等)はこの内部値のまま安定して使う。
 * 表示は「おおよそ何石差で勝つか」の目安にしたいので、生評価値(= 内部値 ÷ DISC_SCALE)を
 * 一律 MIDGAME_DISPLAY_DIVISOR で割って見せる(盤ごとの個別係数はやめ、シンプルに統一)。
 *
 * さらに「その盤で物理的にありえる石差(= 置けるマス数)」を超えないようクランプする。
 * これで表示が 3 桁(±100 超)になってプレートからあふれるレイアウト崩れを防ぎ、
 * 値そのものも「盤の石数を超えない現実的な勝ち差」に収まる。
 * ※ 中盤評価はあくまで推定(実測の相関は弱め)なので、桁合わせ目的の概算。色・採点には不影響。
 */
const MIDGAME_DISPLAY_DIVISOR = 7;
/** 内部値 → 生評価値に戻す係数(= 1 / DISC_SCALE)。DISC_SCALE を変えたらここも合わせる。 */
const DISC_SCALE_INV = 9;
/** 内部値に掛けると「生評価値 ÷ DIVISOR」になる表示倍率。 */
const MIDGAME_DISPLAY_FACTOR = DISC_SCALE_INV / MIDGAME_DISPLAY_DIVISOR;

/**
 * 中盤の内部評価値を「表示用の石差目安」に変換する。
 * 生評価値 ÷ DIVISOR にしたうえで、その盤の置けるマス数で上下クランプする。
 */
export function midgameDisplayValue(internalValue: number, variant: VariantId): number {
  const scaled = internalValue * MIDGAME_DISPLAY_FACTOR;
  const bound = playableCellsFor(variant);
  return Math.max(-bound, Math.min(bound, scaled));
}

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
