/**
 * 対戦 AI(5段階の強さ)。
 *
 * 設計方針(オセロAIの定石 + 実機調査に基づく / 2026-06-24 リバランス):
 *   「ビギナーでも強すぎる」を解消するため、弱さを 1 つのレバーでなく複数の積で作る。
 *   調査結果(notes 参照)の要点:
 *     - 探索深さを削るだけでは弱く"見えて"妙に的確 → 人間は勝ちにくい。
 *     - オセロでは「枚数貪欲(greedy)評価」が最弱クラス。かつ初心者の思考そのもので
 *       人間らしい。弱レベルは evalMode='greedy' にするのが最も効く。
 *     - 終盤完全読みは弱〜中レベルでは必ず OFF(endgameEmpties=0)。
 *       これが入ると終盤だけ神になり、序盤リードした初心者が理不尽に逆転される。
 *     - ミス時は「全合法手から一様」だと角自爆など理不尽な大悪手が出る。
 *       Lv1 だけ 'all'(初心者の暴発再現)、Lv2 以上は上位手('topK')から選ぶ。
 *
 *   強さ = 「読み深さ(maxDepth) × 評価の質(evalMode) × 終盤完全読み(endgameEmpties)
 *           × ミス率(mistakeRate)/ミスの質(pickFrom)」の積。
 *
 * バーサーカー(Lv6)は特別: 時間いっぱい深く読み、最善厳守、終盤完全読みも全開。
 */

import type { MoveEval, EvalMode } from '../engine/search';

/** AI 強さレベル ID。1..4(初級〜超級)+ 'berserker'。 */
export type AiLevelId = 1 | 2 | 3 | 4 | 'berserker';

/** ミス時の候補の選び方。'all'=全合法手から / 'topK'=評価上位 K 手から。 */
export type AiPickFrom = 'all' | 'topK';

/** UI 表示・選択に使う AI レベル定義。 */
export interface AiLevel {
  id: AiLevelId;
  /** 表示名。 */
  label: string;
  /** 一覧で出す短い説明。 */
  desc: string;
  /** バーサーカー(特別演出)か。 */
  special: boolean;

  // --- エンジンの強さ(探索の効かせ方) ---
  /**
   * 中盤の固定読み深さ。小さいほど浅く弱い。
   * 未指定なら timeLimitMs まで反復深化(=深く読む。バーサーカー用)。
   */
  maxDepth?: number;
  /** 思考時間上限(ms)。maxDepth 未指定のレベル(バーサーカー)で深さを時間で決める。 */
  timeLimitMs?: number;
  /**
   * 終盤完全読みに入る空きマスしきい値。0 にすると完全読みを使わない(=終盤も弱いまま)。
   * 弱〜中レベルは 0、強レベルだけ大きくして終盤を正確に詰める。
   */
  endgameEmpties: number;
  /** 評価モード。'greedy'=枚数貪欲(弱・人間らしい)/ 'full'=本番の精度評価。 */
  evalMode: EvalMode;

  // --- 着手選択(人間らしいミス) ---
  /** 最善ではなく候補から選ぶ確率(0..1)。高いほどよくミスする。 */
  mistakeRate: number;
  /** ミス時に候補とする手の範囲。 */
  pickFrom: AiPickFrom;
  /** pickFrom='topK' のときの上位手数。 */
  topK: number;

  /** 思考演出の「間」の目安レンジ(ms)。実際はこの範囲でランダム。 */
  thinkDelayMs: readonly [number, number];
}

/**
 * 5 段階の定義(2026-06-24 リバランス)。初級 / 中級 / 上級 / 超級 / バーサーカー。
 * 弱: greedy 評価 + 浅い読み + 完全読みなし + 高ミス率 → 初心者が気持ちよく勝てる。
 * 強: full 評価 + 深い読み + 完全読み + 低ミス率 → 上達しないと勝てない。
 * 強さ間隔は自己対戦(scripts/ai-ladder.ts)で人間プロキシの勝率を見て較正。
 */
export const AI_LEVELS: readonly AiLevel[] = [
  {
    id: 1,
    label: '初級',
    desc: '枚数を取るだけ・浅い読み。気軽に勝てる',
    special: false,
    maxDepth: 1,
    endgameEmpties: 0,
    evalMode: 'greedy',
    mistakeRate: 0.35,
    pickFrom: 'all',
    topK: 6,
    thinkDelayMs: [350, 650],
  },
  {
    id: 2,
    label: '中級',
    desc: '角や辺を意識する・たまにミスする',
    special: false,
    maxDepth: 2,
    endgameEmpties: 0,
    evalMode: 'full',
    mistakeRate: 0.26,
    pickFrom: 'topK',
    topK: 4,
    thinkDelayMs: [550, 950],
  },
  {
    id: 3,
    label: '上級',
    desc: 'しっかり読む・好手で対抗しないと勝てない',
    special: false,
    maxDepth: 3,
    endgameEmpties: 0,
    evalMode: 'full',
    mistakeRate: 0.20,
    pickFrom: 'topK',
    topK: 3,
    thinkDelayMs: [700, 1150],
  },
  {
    id: 4,
    label: '超級',
    desc: '深く読む・滅多にミスしない',
    special: false,
    maxDepth: 4,
    endgameEmpties: 6,
    evalMode: 'full',
    mistakeRate: 0.12,
    pickFrom: 'topK',
    topK: 2,
    thinkDelayMs: [800, 1300],
  },
  {
    id: 'berserker',
    label: 'バーサーカー',
    desc: '全力・最善厳守・終盤完全読み。基本勝てない最強',
    special: true,
    timeLimitMs: 3000, // 時間いっぱい深く読む(maxDepth 指定なし)。
    endgameEmpties: 18,
    evalMode: 'full',
    mistakeRate: 0, // 最善厳守。
    pickFrom: 'topK',
    topK: 1,
    thinkDelayMs: [900, 1500],
  },
];

/** id から AiLevel を引く。 */
export function aiLevelById(id: AiLevelId): AiLevel {
  const lv = AI_LEVELS.find((l) => l.id === id);
  if (!lv) throw new Error(`未知の AI レベル: ${String(id)}`);
  return lv;
}

/**
 * エンジンの評価結果(各合法手の value)から AI が指す 1 手を選ぶ。
 *
 * モデル(2 段構え):
 *   - 確率 (1 - mistakeRate) で最善手。
 *   - 確率 mistakeRate で「候補」から 1 つ抽選(=人間らしいブレ)。候補は:
 *       pickFrom='all'  → 全合法手から一様(最弱=初級のみ。初心者の暴発を再現)。
 *       pickFrom='topK' → 評価上位 K 手から一様(「正しい方向だが最善でない」ミス)。
 *   ※ 評価の弱さ(evalMode='greedy' 等)・読みの浅さは別途エンジン側で効かせる。
 *     ここはあくまで「与えられた評価の中でどうブレるか」を担う。
 *
 * @param moves エンジンが返した各手の評価(順不同でもよい。内部で降順化する)。
 * @param level AI 強さ。
 * @param rng 0..1 の乱数生成器(テスト用に差し替え可能。既定は Math.random)。
 * @returns 着手セル(0..63)。moves が空なら -1。
 */
export function chooseAiMove(
  moves: MoveEval[],
  level: AiLevel,
  rng: () => number = Math.random,
): number {
  if (moves.length === 0) return -1;

  // value 降順(最善が先頭)。元配列を壊さないようコピー。
  const sorted = [...moves].sort((a, b) => b.value - a.value);
  const bestCell = sorted[0].cell;

  // 最善厳守 or 1 手しかない → 最善。
  if (level.mistakeRate <= 0 || sorted.length === 1) return bestCell;

  // ミス判定。発火しなければ最善。
  if (rng() >= level.mistakeRate) return bestCell;

  // ミス: 候補から 1 つ抽選。
  const pool =
    level.pickFrom === 'all'
      ? sorted
      : sorted.slice(0, Math.max(2, Math.min(level.topK, sorted.length)));
  const pick = Math.floor(rng() * pool.length);
  return pool[Math.min(pick, pool.length - 1)].cell;
}
