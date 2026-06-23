/**
 * 評価 Worker。バックグラウンドで evaluatePosition を実行し、UI を固めない。
 * メインスレッドからの最新リクエストのみ処理(古い reqId の結果は UI 側で破棄)。
 */

import { evaluatePosition } from '../engine/search';
import type { WorkerInbound, EvalResponse } from './protocol';

self.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  if (msg.type !== 'evaluate') return;

  const board = Int8Array.from(msg.board);
  const result = evaluatePosition(board, msg.player, {
    timeLimitMs: msg.timeLimitMs,
  });

  const response: EvalResponse = {
    type: 'result',
    reqId: msg.reqId,
    moves: result.moves,
    endgame: result.endgame,
    reachedDepth: result.reachedDepth,
    nodes: result.nodes,
    elapsedMs: result.elapsedMs,
  };
  (self as unknown as Worker).postMessage(response);
};
