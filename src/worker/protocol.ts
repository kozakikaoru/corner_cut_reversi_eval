/**
 * メインスレッド ⇄ 評価 Worker のメッセージ protocol(型定義のみ)。
 */

import type { Player, VariantId } from '../engine/types';
import type { MoveEval, EvalMode } from '../engine/search';

/** メイン → Worker: この局面を評価して。 */
export interface EvalRequest {
  type: 'evaluate';
  /** リクエスト識別子(古い結果を捨てるため)。 */
  reqId: number;
  /** 盤面(Int8Array(64) を通常配列にしたもの)。 */
  board: number[];
  /** 手番。 */
  player: Player;
  /** 盤面の種類(盤面ごとのレイ/マス重みを選ぶ)。 */
  variant: VariantId;
  /** 思考時間上限(ms)。未指定なら Worker 側で段階判定。 */
  timeLimitMs?: number;
  /** 中盤の固定読み深さ(AI 弱レベルの強さ調整用)。未指定なら時間上限まで深くする。 */
  maxDepth?: number;
  /** 終盤完全読みに入る空きマスしきい値(弱レベルは小さくして完璧に読ませない)。 */
  endgameEmpties?: number;
  /** 評価モード(弱レベルは 'greedy' で枚数貪欲=弱く人間らしく)。未指定は 'full'。 */
  evalMode?: EvalMode;
}

/** Worker → メイン: 評価結果。 */
export interface EvalResponse {
  type: 'result';
  reqId: number;
  moves: MoveEval[];
  endgame: boolean;
  reachedDepth: number;
  nodes: number;
  elapsedMs: number;
  /**
   * 思考時間上限に達して探索を打ち切ったか。
   * true のとき moves は「その時点で得られた最善の結果」(終盤なら完全読みではない)。
   */
  timedOut: boolean;
}

/**
 * Worker → メイン: 評価中に想定外の例外が発生した。
 * UI が「評価中…」のまま固まらないよう、必ずこの応答を返してハングを防ぐ。
 */
export interface EvalErrorResponse {
  type: 'error';
  reqId: number;
  message: string;
}

export type WorkerInbound = EvalRequest;
export type WorkerOutbound = EvalResponse | EvalErrorResponse;
