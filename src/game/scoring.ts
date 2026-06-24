/**
 * 採点ロジック(対局モードのプレイ評価)。
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

/**
 * 着手判定の接頭辞(ユーザー確定版)。
 * 表記は種別ごとに固定: Perfect は「!!」、Good は「!」、Bad は「...」。
 * 実際の表示は「接頭辞 + 半角スペース + サブメッセージ」(pickJudgeMessage が連結する)。
 * 接頭辞の色は UI 側(judge-feedback の種別クラス)で Perfect=アンバー / Good=ティール /
 * Bad=ダルレッド を維持する。
 */
export const JUDGE_PREFIX: Record<MoveJudgeKind, string> = {
  perfect: 'Perfect!!',
  good: 'Good!',
  bad: 'Bad...',
};

/**
 * 着手判定のサブメッセージ候補(ユーザー確定版 / 改善4)。
 * 同じ判定でも文言が変わるよう、種別ごとに複数パターン用意してランダムに 1 つ出す。
 * ここには接頭辞を含めない(pickJudgeMessage が JUDGE_PREFIX と連結する)。
 * 判定と逆の印象を与える両義表現は禁止(marketing/judge_messages.md の設計ルール準拠)。
 */
export const JUDGE_MESSAGES: Record<MoveJudgeKind, readonly string[]> = {
  perfect: [
    '最善手です！',
    'さすがです！',
    '最高の選択です！',
    'その調子！',
    '御見事！',
    '神業！',
    '文句なし！',
    '完璧に先が読めてます！',
  ],
  good: [
    'いい手です！',
    'いい感じです！',
    'なかなか良い判断です！',
    'いい視点です！',
    'これなら安心です！',
    '手堅い！',
    '有効な選択肢を取りました！',
    'この手なら問題ありません！',
    'いいところを選びました！',
  ],
  bad: [
    'ちょっと苦しくなりました。',
    '有力手を逃しました。',
    'ここは見送る手でした。',
    'これは痛い。',
    'そこを選んでしまいましたか。',
    '意外な選択です。',
    'これは苦い一手です。',
  ],
};

/**
 * 判定種別から表示メッセージ(接頭辞 + 半角スペース + サブメッセージ)を 1 つ作る。
 * サブメッセージは候補からランダムに選ぶ(1 戦で被りにくいように複数案を用意)。
 * rng は [0,1) を返す関数(既定 Math.random)。テスト時に注入できる。
 *
 * 例) 'Perfect!! 最善手です！' / 'Good! いい手です！' / 'Bad... これは痛い。'
 */
export function pickJudgeMessage(kind: MoveJudgeKind, rng: () => number = Math.random): string {
  const pool = JUDGE_MESSAGES[kind];
  const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return `${JUDGE_PREFIX[kind]} ${pool[i]}`;
}

/**
 * サブメッセージ(接頭辞なし)だけをランダムに 1 つ返す。
 * 接頭辞(JUDGE_PREFIX)とサブメッセージを別要素で描き分けたい UI 用
 * (接頭辞は太字・サブは細字、など)。
 */
export function pickJudgeSubMessage(kind: MoveJudgeKind, rng: () => number = Math.random): string {
  const pool = JUDGE_MESSAGES[kind];
  const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[i];
}

/** 1 手の採点結果(平均ロス・一致率の集計に使う)。 */
export interface MoveScore {
  kind: MoveJudgeKind;
  /** 最善手の評価値。 */
  bestValue: number;
  /** プレイヤーが選んだ手の評価値。 */
  chosenValue: number;
  /** ロス(= bestValue - chosenValue、>= 0)。 */
  loss: number;
  /**
   * この局面の合法手数(= 選択肢の多さ)。
   * 1 なら「強制手」= 選ぶ余地がないため最終採点の対象外にする。
   * 2 以上なら、多いほど「難しい選択」として最終採点で重く扱う(difficultyWeight)。
   */
  legalCount: number;
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
 * legalCount には evals.length(= その局面の合法手数)が入る。最終集計
 * (summarizePlay)で「強制手の除外」「選択肢の多さによる重み付け」に使う。
 *
 * evals が空 or 選んだ手が含まれない(理論上は起きないが防御的に)場合は good 扱いの
 * ニュートラルな結果を返す(採点を壊さない)。
 */
export function judgeMove(evals: MoveEval[], chosenCell: number): MoveScore {
  if (evals.length === 0) {
    return { kind: 'good', bestValue: 0, chosenValue: 0, loss: 0, legalCount: 0 };
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

  return { kind, bestValue, chosenValue, loss, legalCount: evals.length };
}

/** 最終プレイ採点の集計結果。 */
export interface PlayScore {
  /**
   * 採点対象になった着手数(= 強制手を除いた、選択肢が 2 つ以上あった手の数)。
   * 内訳(perfect/good/bad)・各指標はすべてこの対象手のみで集計する。
   */
  totalMoves: number;
  /** プレイヤーの全着手数(強制手も含む。表示の参考用)。 */
  totalPlayed: number;
  /** 強制手(合法手 1 個)として採点から除外した手の数。 */
  forcedCount: number;
  /** 最善一致(perfect)数。採点対象内。 */
  perfectCount: number;
  /** 善手(good)数。採点対象内。 */
  goodCount: number;
  /** 悪手(bad)数。採点対象内。 */
  badCount: number;
  /** 最善一致率(%)。重み付き。採点対象が無いとき 0。 */
  bestMatchRate: number;
  /** 平均ロス(石差スケール)。重み付き。小さいほど良い。 */
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

/**
 * 選択肢の多さ(合法手数)に応じた「その手の重み」。
 *
 * 設計意図(改善3):
 *  - 合法手 1 個(強制手)は呼び出し側で除外済みのため、ここに来るのは legalCount>=2。
 *  - 選択肢が多い局面で良い手を選べたほど価値が高い ⇒ 合法手数が多いほど重みを増やす。
 *  - ただし線形に増やすと「合法手 15 個の 1 手」が他を圧倒してしまう。難易度差は
 *    “選択肢が増えるほど 1 つあたりの判断が難しくなる” という逓増・逓減の感覚に近いので、
 *    対数で滑らかに効かせる。
 *
 *      weight = 1 + log2(legalCount)      (legalCount>=2)
 *
 *    例) 2手→2.00 / 3手→2.58 / 4手→3.00 / 8手→4.00 / 16手→5.00。
 *    2手の局面を基準(1+1=2)に、選択肢が倍になるごとに +1 ずつ重みが増える。
 *  - 強制手・防御的に来た legalCount<=1 は重み 0(集計に寄与しない)。
 */
function difficultyWeight(legalCount: number): number {
  if (legalCount <= 1) return 0;
  return 1 + Math.log2(legalCount);
}

/**
 * 着手ごとの MoveScore 列から最終プレイ採点を集計する。
 *
 * 改善3:
 *  - 強制手(legalCount<=1)は採点対象から除外(選ぶ余地がないため実力ではない)。
 *  - 残る手は difficultyWeight(legalCount) で重み付けし、一致率・平均ロスを
 *    「重み付き平均」で算出する。選択肢が多い局面の好手ほど評価に効く。
 *  - 内訳カウント(perfect/good/bad)も採点対象(強制手以外)で数える。
 */
export function summarizePlay(scores: readonly MoveScore[]): PlayScore {
  const totalPlayed = scores.length;

  // 強制手(legalCount<=1)を除外した採点対象。
  const scored = scores.filter((s) => s.legalCount >= 2);
  const forcedCount = totalPlayed - scored.length;
  const totalMoves = scored.length;

  if (totalMoves === 0) {
    return {
      totalMoves: 0,
      totalPlayed,
      forcedCount,
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
  // 重み付き集計用のアキュムレータ。
  let weightSum = 0;
  let weightedPerfect = 0; // perfect の重み合計(= 重み付き一致数)
  let weightedLoss = 0; // loss * weight の合計
  for (const s of scored) {
    if (s.kind === 'perfect') perfectCount++;
    else if (s.kind === 'good') goodCount++;
    else badCount++;

    const w = difficultyWeight(s.legalCount);
    weightSum += w;
    if (s.kind === 'perfect') weightedPerfect += w;
    weightedLoss += s.loss * w;
  }

  // weightSum は legalCount>=2 のみなので必ず正(>= 2)。0除算は起きない。
  const bestMatchRate = (weightedPerfect / weightSum) * 100;
  const averageLoss = weightedLoss / weightSum;

  const base = 100 - averageLoss * LOSS_PENALTY;
  const bonus = bestMatchRate; // 0..100
  const blended = base * (1 - MATCH_WEIGHT) + bonus * MATCH_WEIGHT;
  const totalScore = Math.round(clamp(blended, 0, 100));

  return {
    totalMoves,
    totalPlayed,
    forcedCount,
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
