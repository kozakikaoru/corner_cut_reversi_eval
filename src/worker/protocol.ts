/**
 * メインスレッド ⇄ 評価 Worker のメッセージ protocol(型定義のみ)。
 */

import type { Player } from '../engine/types';
import type { MoveEval } from '../engine/search';

/** メイン → Worker: この局面を評価して。 */
export interface EvalRequest {
  type: 'evaluate';
  /** リクエスト識別子(古い結果を捨てるため)。 */
  reqId: number;
  /** 盤面(Int8Array(64) を通常配列にしたもの)。 */
  board: number[];
  /** 手番。 */
  player: Player;
  /** 思考時間上限(ms)。未指定なら Worker 側で段階判定。 */
  timeLimitMs?: number;
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
}

export type WorkerInbound = EvalRequest;
export type WorkerOutbound = EvalResponse;
