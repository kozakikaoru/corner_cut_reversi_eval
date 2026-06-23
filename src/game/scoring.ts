/**
 * 採点ロジック(対戦モードのプレイ評価)。
 *
 * versus_mode.md の採点機能:
 *  2. 着手判定: プレイヤーの 1 手ごとに「Perfect!(最善手)/ Good!(善手)/ Bad!(悪手)」を判定。
 *     → 既存 evalColor の GOOD_THRESHOLD(最善との差)を流用して一貫性を持たせる。
 *  3. 最終プレイ採点: 対局終了時に「良い手を打てたか」を点数化。
 *     - 最善一致率(%): プレイヤーの手のうち最善手と一致した割合。
 *     - 平均ロス: 各手で「最善の評価値 - 選んだ手の評価値」の平均(石差スケール)。小さいほど良い。
 *     - 総合スコア(0..100): 平均ロスを基準に算出。Perfect/Good 比率も加味し、分かりやすい点数に。
 *
 * 設計: 評価はすべてエンジン(EvalClient)が出した「着手前局面の全合法手の value」を使う。
 *   採点モジュール自体はエンジンを呼ばず、与えられた評価から判定だけ行う(テスト容易・UI 非依存)。
 */

import type { MoveEval } from '../engine/search';
import { GOOD_THRESHOLD } from '../ui/evalColor';

/** 1 手の判定種別(着手判定フィードバック)。 */
export type MoveJudgeKind = 'perfect' | 'good' | 'bad';

/** 1 手の採点結果(平均ロス・一致率の集計に使う)。 */
export interface MoveScore {
  kind: MoveJudgeKind;
  /** 最善手の評価値。 */
  bestValue: number;
  /** プレイヤーが選んだ手の評価値。 */
  chosenValue: number;
  /** ロス(= bestValue - chosenValue、>= 0)。 */
  loss: number;
}

/**
 * 着手前局面の全合法手評価(evals)と、プレイヤーが選んだ手(chosenCell)から
 * その 1 手を採点する。
 *
 * 判定基準(evalColor と整合):
 *  - perfect: 選んだ手が最善値と同値(最善手の 1 つ)。
 *  - good   : 最善との差が GOOD_THRESHOLD 以内。
 *  - bad    : それより離れる。
 *
 * evals が空 or 選んだ手が含まれない(理論上は起きないが防御的に)場合は good 扱いの
 * ニュートラルな結果を返す(採点を壊さない)。
 */
export function judgeMove(evals: MoveEval[], chosenCell: number): MoveScore {
  if (evals.length === 0) {
    return { kind: 'good', bestValue: 0, chosenValue: 0, loss: 0 };
  }
  let bestValue = -Infinity;
  for (const m of evals) if (m.value > bestValue) bestValue = m.value;

  const chosen = evals.find((m) => m.cell === chosenCell);
  const chosenValue = chosen ? chosen.value : bestValue;
  const loss = Math.max(0, bestValue - chosenValue);

  let kind: MoveJudgeKind;
  // 最善との差で分類。浮動小数の評価値があるため微小誤差を吸収する。
  const EPS = 1e-6;
  if (loss <= EPS) kind = 'perfect';
  else if (loss <= GOOD_THRESHOLD) kind = 'good';
  else kind = 'bad';

  return { kind, bestValue, chosenValue, loss };
}

/** 最終プレイ採点の集計結果。 */
export interface PlayScore {
  /** 採点対象になったプレイヤーの着手数。 */
  totalMoves: number;
  /** 最善一致(perfect)数。 */
  perfectCount: number;
  /** 善手(good)数。 */
  goodCount: number;
  /** 悪手(bad)数。 */
  badCount: number;
  /** 最善一致率(%)。totalMoves=0 のとき 0。 */
  bestMatchRate: number;
  /** 平均ロス(石差スケール)。小さいほど良い。 */
  averageLoss: number;
  /** 総合スコア(0..100)。 */
  totalScore: number;
  /** 総合評価のランク(S/A/B/C/D)。 */
  rank: PlayRank;
}

export type PlayRank = 'S' | 'A' | 'B' | 'C' | 'D';

/**
 * 総合スコアの算出。
 * 「平均ロスの小ささ」を主軸に、最善一致率を加点する分かりやすい式にする。
 *   base   = 100 - averageLoss * LOSS_PENALTY   (ロス 0 で 100、ロスが増えるほど減点)
 *   bonus  = bestMatchRate * MATCH_BONUS        (最善を選べた割合で加点)
 *   total  = clamp(base * (1 - W) + bonus * W, 0, 100)
 * 係数は「Perfect 連発で高得点 / 大悪手で大きく減点」が体感に合うよう調整した暫定値。
 */
const LOSS_PENALTY = 12; // 平均ロス 1 につき約 12 点減点(ロス約8で 0 点付近)
const MATCH_WEIGHT = 0.35; // 一致率ボーナスの比重

/** 着手ごとの MoveScore 列から最終プレイ採点を集計する。 */
export function summarizePlay(scores: readonly MoveScore[]): PlayScore {
  const totalMoves = scores.length;
  if (totalMoves === 0) {
    return {
      totalMoves: 0,
      perfectCount: 0,
      goodCount: 0,
      badCount: 0,
      bestMatchRate: 0,
      averageLoss: 0,
      totalScore: 0,
      rank: 'D',
    };
  }

  let perfectCount = 0;
  let goodCount = 0;
  let badCount = 0;
  let lossSum = 0;
  for (const s of scores) {
    if (s.kind === 'perfect') perfectCount++;
    else if (s.kind === 'good') goodCount++;
    else badCount++;
    lossSum += s.loss;
  }

  const bestMatchRate = (perfectCount / totalMoves) * 100;
  const averageLoss = lossSum / totalMoves;

  const base = 100 - averageLoss * LOSS_PENALTY;
  const bonus = bestMatchRate; // 0..100
  const blended = base * (1 - MATCH_WEIGHT) + bonus * MATCH_WEIGHT;
  const totalScore = Math.round(clamp(blended, 0, 100));

  return {
    totalMoves,
    perfectCount,
    goodCount,
    badCount,
    bestMatchRate,
    averageLoss,
    totalScore,
    rank: rankForScore(totalScore),
  };
}

/** 総合スコアからランク(S/A/B/C/D)。 */
export function rankForScore(score: number): PlayRank {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 55) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
