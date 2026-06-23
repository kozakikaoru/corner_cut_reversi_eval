/**
 * アプリ全体のコントローラ。
 * 画面遷移(先手色選択 → 検討盤)、ゲーム進行、Worker 連携、補助機能をまとめる。
 */

import { type Player, BLACK, WHITE } from '../engine/types';
import { GameState } from '../game/gameState';
import { BoardView } from './boardView';
import type { MoveEval } from '../engine/search';
import type { EvalRequest, EvalResponse } from '../worker/protocol';

export class App {
  private container: HTMLElement;

  private game: GameState | null = null;
  private boardView: BoardView | null = null;

  private worker: Worker;
  /** 最新リクエスト ID。古い結果は破棄する。 */
  private reqId = 0;
  /** 現在評価中の手の結果(描画用キャッシュ)。 */
  private currentEvals: MoveEval[] | null = null;

  // 画面要素の参照(board 画面)。
  private boardEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private engineInfoEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    // Vite の Worker インポート(?worker ではなく new URL 形式で型安全に)。
    this.worker = new Worker(new URL('../worker/eval.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<EvalResponse>) => this.onWorkerResult(e.data);
    this.renderSelectScreen();
  }

  // ---- 画面: 先手色選択 -----------------------------------------------------

  private renderSelectScreen(): void {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'screen select-screen';

    wrap.innerHTML = `
      <h1>変則オセロ 検討盤</h1>
      <p class="subtitle">四隅が欠けた48マス盤。黒も白も自分で進める研究用ツールです。</p>
      <p class="prompt">先手はどちらにしますか?</p>
    `;

    const btns = document.createElement('div');
    btns.className = 'select-buttons';

    const blackBtn = document.createElement('button');
    blackBtn.className = 'big-btn select-black';
    blackBtn.innerHTML = '<span class="disc black"></span> 先手 = 黒';
    blackBtn.addEventListener('click', () => this.startGame(BLACK));

    const whiteBtn = document.createElement('button');
    whiteBtn.className = 'big-btn select-white';
    whiteBtn.innerHTML = '<span class="disc white"></span> 先手 = 白';
    whiteBtn.addEventListener('click', () => this.startGame(WHITE));

    btns.appendChild(blackBtn);
    btns.appendChild(whiteBtn);
    wrap.appendChild(btns);
    this.container.appendChild(wrap);
  }

  // ---- 画面: 検討盤 ---------------------------------------------------------

  private startGame(firstPlayer: Player): void {
    this.game = new GameState(firstPlayer);
    this.currentEvals = null;
    this.renderBoardScreen();
    this.refresh();
  }

  private renderBoardScreen(): void {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'screen board-screen';

    // ステータスバー(手番・石数)。
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';

    // 盤面。
    this.boardEl = document.createElement('div');

    // エンジン情報(思考状況・深さ・ノード数)。
    this.engineInfoEl = document.createElement('div');
    this.engineInfoEl.className = 'engine-info';

    // コントロール群。
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.appendChild(this.makeButton('⏪ 1手戻る', 'btn-undo', () => this.handleUndo()));
    controls.appendChild(this.makeButton('🔄 リセット', 'btn-reset', () => this.handleReset()));

    // トースト(パス通知・終局通知)。
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast hidden';

    wrap.appendChild(this.statusEl);
    wrap.appendChild(this.boardEl);
    wrap.appendChild(this.engineInfoEl);
    wrap.appendChild(controls);
    wrap.appendChild(this.toastEl);
    this.container.appendChild(wrap);

    this.boardView = new BoardView(this.boardEl, (cell) => this.handleCellClick(cell));
  }

  private makeButton(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'ctrl-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- 進行ロジック ---------------------------------------------------------

  /**
   * 局面が変わるたびに呼ぶ。
   * パス自動処理 → 終局判定 → 再描画 → 評価リクエスト の順。
   */
  private refresh(): void {
    if (!this.game) return;

    // パス自動処理(⏭️)。打てない手番は自動でパスして通知。
    const pass = this.game.autoPassIfNeeded();
    if (pass) {
      const who = pass.passedPlayer === BLACK ? '黒' : '白';
      this.showToast(`${who} は打てる手がないためパスしました ⏭️`);
    }

    // 終局(🏁)。
    if (this.game.isOver()) {
      this.currentEvals = null;
      this.draw();
      this.showEndgame();
      return;
    }

    // 通常局面: まず合法手ハイライトのみ描画 → 評価を非同期で開始。
    this.currentEvals = null;
    this.draw();
    this.requestEvaluation();
  }

  private requestEvaluation(): void {
    if (!this.game) return;
    const board = this.game.getBoard();
    const player = this.game.getCurrentPlayer();

    this.reqId++;
    this.updateEngineInfo('🧠 評価中…');

    const req: EvalRequest = {
      type: 'evaluate',
      reqId: this.reqId,
      board: Array.from(board),
      player,
      // timeLimitMs は未指定 → Worker 側で段階(中盤2秒/終盤3秒)を自動判定。
    };
    this.worker.postMessage(req);
  }

  private onWorkerResult(res: EvalResponse): void {
    if (res.type !== 'result') return;
    // 古いリクエストの結果は無視。
    if (res.reqId !== this.reqId) return;

    this.currentEvals = res.moves;
    this.draw();

    const modeLabel = res.endgame
      ? `🏁 終盤完全読み(残り${res.reachedDepth}手)`
      : `深さ ${res.reachedDepth}`;
    this.updateEngineInfo(
      `${modeLabel} / ${res.nodes.toLocaleString()} ノード / ${Math.round(res.elapsedMs)}ms`,
    );
  }

  private handleCellClick(cell: number): void {
    if (!this.game) return;
    // 評価中でも合法手は打てる(現状の合法手集合に基づく)。
    const moved = this.game.play(cell);
    if (!moved) return; // 非合法はクリック無効
    // 進行中の評価は reqId 更新で自然に破棄される。
    this.refresh();
  }

  private handleUndo(): void {
    if (!this.game) return;
    if (this.game.undo()) {
      this.hideToast();
      this.refresh();
    }
  }

  private handleReset(): void {
    // 先手色選択に戻る。
    this.reqId++; // 進行中の評価を破棄。
    this.game = null;
    this.boardView = null;
    this.currentEvals = null;
    this.renderSelectScreen();
  }

  // ---- 描画ヘルパ -----------------------------------------------------------

  private draw(): void {
    if (!this.game || !this.boardView) return;
    const board = this.game.getBoard();
    const legal = this.game.getLegalMoves();
    this.boardView.render(board, legal, this.currentEvals);
    this.updateStatus();
    this.updateControls();
  }

  private updateStatus(): void {
    if (!this.game || !this.statusEl) return;
    const { black, white } = this.game.getCounts();
    const turn = this.game.getCurrentPlayer();
    const turnLabel = turn === BLACK ? '黒' : '白';
    const over = this.game.isOver();
    this.statusEl.innerHTML = `
      <div class="score">
        <span class="score-item"><span class="disc black"></span> ${black}</span>
        <span class="score-item"><span class="disc white"></span> ${white}</span>
      </div>
      <div class="turn">${over ? '終局' : `手番: <strong>${turnLabel}</strong>`}</div>
    `;
  }

  private updateControls(): void {
    const undoBtn = this.container.querySelector('.btn-undo') as HTMLButtonElement | null;
    if (undoBtn && this.game) undoBtn.disabled = !this.game.canUndo();
  }

  private updateEngineInfo(text: string): void {
    if (this.engineInfoEl) this.engineInfoEl.textContent = text;
  }

  private showEndgame(): void {
    if (!this.game) return;
    const { black, white, winner } = this.game.getResult();
    let msg: string;
    if (winner === BLACK) msg = `🏁 終局! 黒の勝ち(${black} 対 ${white})`;
    else if (winner === WHITE) msg = `🏁 終局! 白の勝ち(${white} 対 ${black})`;
    else msg = `🏁 終局! 引き分け(${black} 対 ${white})`;
    this.updateEngineInfo('対局終了');
    this.showToast(msg, true);
  }

  private showToast(message: string, sticky = false): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('hidden');
    if (!sticky) {
      window.setTimeout(() => this.hideToast(), 2600);
    }
  }

  private hideToast(): void {
    if (this.toastEl) this.toastEl.classList.add('hidden');
  }
}
