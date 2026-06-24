/**
 * 評価 Worker。バックグラウンドで evaluatePosition を実行し、UI を固めない。
 * メインスレッドからの最新リクエストのみ処理(古い reqId の結果は UI 側で破棄)。
 */

import { evaluatePosition, evaluatorForMode } from '../engine/search';
import type { WorkerInbound, EvalResponse, EvalErrorResponse } from './protocol';

self.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  if (msg.type !== 'evaluate') return;

  // evaluatePosition は通常の時間切れを内部でフォールバックするが、
  // 万一の想定外例外(バグ等)でもメインスレッドが「評価中…」のまま
  // 固まらないよう、必ず result か error のどちらかを返す。
  try {
    const board = Int8Array.from(msg.board);
    const result = evaluatePosition(board, msg.player, {
      timeLimitMs: msg.timeLimitMs,
      variant: msg.variant,
      maxDepth: msg.maxDepth,
      endgameEmpties: msg.endgameEmpties,
      evaluator: evaluatorForMode(msg.evalMode ?? 'full'),
    });

    const response: EvalResponse = {
      type: 'result',
      reqId: msg.reqId,
      moves: result.moves,
      endgame: result.endgame,
      reachedDepth: result.reachedDepth,
      nodes: result.nodes,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut,
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: EvalErrorResponse = {
      type: 'error',
      reqId: msg.reqId,
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
