/**
 * 対戦 AI(6段階の強さ)。
 *
 * 設計(versus_mode.md):
 * - すべて既存の評価エンジン(EvalClient 経由の evaluatePosition)を流用する。
 *   AI の着手 = エンジンが返す各合法手の評価値を使って 1 手を選ぶこと。
 * - 強さは 3 つの軸で作る:
 *     (1) 思考時間上限(timeLimitMs)… 長いほど深く正確に読む。
 *     (2) 終盤完全読み(エンジンが空きマス数で自動判定。弱レベルは completeEndgame=false で
 *         完全読み相当の精度に頼らない=思考時間を短く絞ることで擬似的に弱くする)。
 *     (3) blunderRate / topK … 「わざと最善を外す確率」と「候補に含める上位手の数」。
 *         弱レベルほど高確率で次善以下を選び、初心者でも勝てるようにする。
 *
 * バーサーカー(Lv6)は特別扱い:
 *   - 思考時間フル + 最善厳守(blunderRate=0)。
 *   - エンジンの終盤完全読みがそのまま効く(timeLimit を長く取る)。
 *   - 「基本勝てない最強」を体感させる。
 */

import type { MoveEval } from '../engine/search';

/** AI 強さレベル ID。1..5 + 'berserker'。 */
export type AiLevelId = 1 | 2 | 3 | 4 | 5 | 'berserker';

/** UI 表示・選択に使う AI レベル定義。 */
export interface AiLevel {
  id: AiLevelId;
  /** 表示名。 */
  label: string;
  /** 一覧で出す短い説明。 */
  desc: string;
  /** バーサーカー(特別演出)か。 */
  special: boolean;
  // --- 強さパラメータ ---
  /** エンジンへ渡す思考時間上限(ms)。長いほど深く読む。 */
  timeLimitMs: number;
  /**
   * 「最善を外す」確率(0..1)。
   * この確率で、最善ではなく候補(topK 内)からゆるく選ぶ。
   */
  blunderRate: number;
  /**
   * blunder 時に候補とする「上位 K 手」。
   * 小さいほど致命的なミスはしにくい。Lv1 は大きめにして派手に外す。
   */
  topK: number;
  /**
   * 思考演出の「間」の目安レンジ(ms)。実際はこの範囲でランダム。
   * 弱いほど短め(サクサク)、強いほど長め(熟考感)。
   */
  thinkDelayMs: readonly [number, number];
}

/**
 * 6 段階の定義。
 * timeLimitMs は「弱=短い→強=長い」で段階差をつけ、blunderRate / topK で
 * 弱レベルの "わざと外す" 度合いを調整する。具体値は体感差が出るよう設定(後で微調整可)。
 */
export const AI_LEVELS: readonly AiLevel[] = [
  {
    id: 1,
    label: 'Lv.1 ビギナー',
    desc: 'ごく浅い読み・かなりミスする。初心者向け',
    special: false,
    timeLimitMs: 80,
    blunderRate: 0.75, // 高確率で次善以下
    topK: 6,
    thinkDelayMs: [350, 650],
  },
  {
    id: 2,
    label: 'Lv.2 かけだし',
    desc: '浅い読み・たまにミスする',
    special: false,
    timeLimitMs: 200,
    blunderRate: 0.5,
    topK: 4,
    thinkDelayMs: [450, 800],
  },
  {
    id: 3,
    label: 'Lv.3 中級',
    desc: 'そこそこ読む・ミスは控えめ',
    special: false,
    timeLimitMs: 500,
    blunderRate: 0.28,
    topK: 3,
    thinkDelayMs: [600, 1000],
  },
  {
    id: 4,
    label: 'Lv.4 上級',
    desc: 'よく読む・ほぼ最善に近い',
    special: false,
    timeLimitMs: 1000,
    blunderRate: 0.12,
    topK: 2,
    thinkDelayMs: [700, 1200],
  },
  {
    id: 5,
    label: 'Lv.5 エキスパート',
    desc: '深く読む・滅多にミスしない',
    special: false,
    timeLimitMs: 1800,
    blunderRate: 0.04,
    topK: 2,
    thinkDelayMs: [800, 1400],
  },
  {
    id: 'berserker',
    label: 'バーサーカー',
    desc: '全力・最善厳守・終盤完全読み。基本勝てない最強',
    special: true,
    timeLimitMs: 3000, // フル(終盤は完全読みが効く)
    blunderRate: 0, // 最善厳守
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
 * - 通常は最善手。
 * - blunderRate の確率で、最善との差が小さい「上位 topK 手」からゆるく選ぶ
 *   (完全なランダムにすると弱くなりすぎる・不自然になるため、上位手に限定)。
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
  if (level.blunderRate <= 0 || sorted.length === 1) return bestCell;

  // blunder 判定。最善を指すならそのまま。
  if (rng() >= level.blunderRate) return bestCell;

  // blunder: 上位 topK(最低でも 2 手)から選ぶ。
  // 候補が 1 手しかなければ最善になる。
  const k = Math.max(2, Math.min(level.topK, sorted.length));
  const candidates = sorted.slice(0, k);
  // 候補内でも完全一様にせず、弱レベルでも「最悪手ばかり」を選ばないよう
  // 候補からランダムに 1 つ(=次善以下を含む上位手のどれか)。
  const pick = Math.floor(rng() * candidates.length);
  return candidates[Math.min(pick, candidates.length - 1)].cell;
}
