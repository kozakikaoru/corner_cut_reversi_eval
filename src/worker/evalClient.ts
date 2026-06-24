/**
 * 評価 Worker の Promise ラッパー(対局モード / 採点 / 評価値表示で共用)。
 *
 * 既存の検討盤は「最新リクエストのみ反映、古い結果は破棄」という fire-and-forget
 * 方式で worker を直接叩いている。対局モードでは「AI の着手を待つ」「着手を採点する」
 * といった "結果を待ってから次に進む" 用途が増えるため、reqId を管理して
 * Promise で受け取れるクライアントを用意する。
 *
 * 設計方針:
 * - 1 つの Worker を共有し、reqId で呼び出しを多重化する(同時に複数 evaluate を
 *   投げても、対応する Promise にだけ結果を配る)。
 * - worker の onerror / onmessageerror / error 応答はすべて reject せず、
 *   呼び出し側が UI を固めないよう「失敗は呼び出し側で扱える形」で reject する。
 *   ただし致命的な onerror は保留中の全 Promise をまとめて reject する。
 * - UI スレッドはブロックしない(すべて非同期)。重い計算は worker 内で走る。
 */

import type { Board, Player, VariantId } from '../engine/types';
import type { MoveEval, EvalMode } from '../engine/search';
import type { EvalRequest, WorkerOutbound } from './protocol';

/** evaluate の結果(呼び出し側が必要とする最小限)。 */
export interface EvalResult {
  moves: MoveEval[];
  endgame: boolean;
  timedOut: boolean;
}

interface Pending {
  resolve: (r: EvalResult) => void;
  reject: (e: Error) => void;
}

export class EvalClient {
  private worker: Worker;
  private reqId = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    // 検討盤と同じ new URL 形式。Vite が worker をバンドルする。
    this.worker = new Worker(new URL('./eval.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOutbound>) => this.onMessage(e.data);
    // 致命的失敗: 保留中の全リクエストを reject(UI が永久に待たないように)。
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.rejectAll('評価ワーカーでエラーが発生しました');
    };
    this.worker.onmessageerror = () => {
      this.rejectAll('評価結果の受信に失敗しました');
    };
  }

  /**
   * 局面を評価して結果を Promise で返す。
   * opts で思考時間上限・固定読み深さ・終盤完全読みしきい値を指定できる(AI 強さの調整に使う)。
   */
  evaluate(
    board: Board,
    player: Player,
    variant: VariantId,
    opts: {
      timeLimitMs?: number;
      maxDepth?: number;
      endgameEmpties?: number;
      evalMode?: EvalMode;
    } = {},
  ): Promise<EvalResult> {
    const reqId = ++this.reqId;
    const req: EvalRequest = {
      type: 'evaluate',
      reqId,
      board: Array.from(board),
      player,
      variant,
      timeLimitMs: opts.timeLimitMs,
      maxDepth: opts.maxDepth,
      endgameEmpties: opts.endgameEmpties,
      evalMode: opts.evalMode,
    };
    return new Promise<EvalResult>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  /** Worker を破棄(画面遷移でクライアントを使い捨てる場合)。 */
  dispose(): void {
    this.rejectAll('評価クライアントを破棄しました');
    this.worker.terminate();
  }

  private onMessage(res: WorkerOutbound): void {
    const p = this.pending.get(res.reqId);
    if (!p) return; // 既に解決済み or 対象外。
    this.pending.delete(res.reqId);

    if (res.type === 'error') {
      p.reject(new Error(res.message));
      return;
    }
    if (res.type !== 'result') return;
    p.resolve({ moves: res.moves, endgame: res.endgame, timedOut: res.timedOut });
  }

  private rejectAll(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }
}
