/**
 * アプリ全体のコントローラ(1画面完結)。
 *
 * フェーズ2: 専用の先手色選択画面を廃止し、起動時から検討盤を表示する。
 * 盤面上部のツールバーで「盤面の種類(通常/クロス/八角/ホロー)」と「先手の色(黒/白)」を
 * いつでも切り替え可能。切り替えると、その設定で局面を最初からリセットする。
 *
 * 既存機能は維持: 評価値表示・3色色分け・1手戻る・リセット・パス自動・終局表示・
 * 時間切れ復帰・レイアウトシフト対策。
 */

import {
  type Player,
  type VariantId,
  BLACK,
  WHITE,
  VARIANT_ORDER,
  BOARD_VARIANTS,
  DEFAULT_VARIANT,
  playableCellsFor,
} from '../engine/types';
import { GameState } from '../game/gameState';
import { BoardView } from './boardView';
import type { MoveEval } from '../engine/search';
import type { EvalRequest, WorkerOutbound } from '../worker/protocol';

/**
 * コントロールボタン用のラインアイコン(Tabler 相当)。inline SVG・currentColor 追従。
 * webfont を足さずにビルド完結させるため、ボタン文字色に同調する SVG を直接埋め込む。
 */
// 1手戻る: ti-arrow-back-up 相当
const ICON_UNDO =
  '<svg class="ctrl-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>';
// リセット: ti-refresh 相当
const ICON_RESET =
  '<svg class="ctrl-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 11A8 8 0 1 0 18.6 15"/><path d="M20 5v6h-6"/></svg>';

export class App {
  private container: HTMLElement;

  private game: GameState | null = null;
  private boardView: BoardView | null = null;

  /** 現在の設定。切り替えで局面をリセットする。 */
  private variant: VariantId = DEFAULT_VARIANT;
  private firstPlayer: Player = BLACK;

  private worker: Worker;
  /** 最新リクエスト ID。古い結果は破棄する。 */
  private reqId = 0;
  /** 現在評価中の手の結果(描画用キャッシュ)。 */
  private currentEvals: MoveEval[] | null = null;

  // 画面要素の参照(board 画面)。
  private boardEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private variantBtns = new Map<VariantId, HTMLButtonElement>();
  private colorBtns = new Map<Player, HTMLButtonElement>();

  constructor(container: HTMLElement) {
    this.container = container;
    // Vite の Worker インポート(?worker ではなく new URL 形式で型安全に)。
    this.worker = new Worker(new URL('../worker/eval.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOutbound>) => this.onWorkerResult(e.data);
    // Worker が異常終了 / メッセージ復元失敗した場合の最終防衛線。
    // ここで「評価中…」を解除しないと UI が永久に固まってしまう。
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.onWorkerFailure('評価ワーカーでエラーが発生しました');
    };
    this.worker.onmessageerror = () => {
      this.onWorkerFailure('評価結果の受信に失敗しました');
    };

    // 起動時から検討盤を表示(選択画面なし)。
    this.renderBoardScreen();
    this.startGame();
  }

  // ---- 画面: 検討盤(1画面) -------------------------------------------------

  private renderBoardScreen(): void {
    this.container.innerHTML = '';
    this.variantBtns.clear();
    this.colorBtns.clear();

    const wrap = document.createElement('div');
    wrap.className = 'screen board-screen';

    // タイトル(コンパクト)。
    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = '異形オセロ評価値計算';

    // 設定ツールバー(盤面の種類 / 先手の色)。
    const toolbar = this.buildToolbar();

    // ステータスバー(手番・石数)。
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';

    // 盤面。
    this.boardEl = document.createElement('div');

    // コントロール群(ラインアイコン + テキスト)。
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.appendChild(
      this.makeButton(`${ICON_UNDO}<span>1手戻る</span>`, 'btn-undo', () => this.handleUndo()),
    );
    controls.appendChild(
      this.makeButton(`${ICON_RESET}<span>リセット</span>`, 'btn-reset', () => this.handleReset()),
    );

    // トースト(パス通知・終局通知)。
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast hidden';

    wrap.appendChild(title);
    wrap.appendChild(toolbar);
    wrap.appendChild(this.statusEl);
    wrap.appendChild(this.boardEl);
    wrap.appendChild(controls);
    wrap.appendChild(this.toastEl);
    this.container.appendChild(wrap);

    this.boardView = new BoardView(this.boardEl, this.variant, (cell) => this.handleCellClick(cell));
  }

  /** 設定ツールバー(盤面の種類トグル + 先手色トグル)を組み立てる。 */
  private buildToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    // --- 盤面の種類 ---
    const variantGroup = document.createElement('div');
    variantGroup.className = 'toolbar-group';
    const variantLabel = document.createElement('span');
    variantLabel.className = 'toolbar-label';
    variantLabel.textContent = '盤面';
    variantGroup.appendChild(variantLabel);

    const variantSeg = document.createElement('div');
    variantSeg.className = 'segmented';
    variantSeg.setAttribute('role', 'group');
    variantSeg.setAttribute('aria-label', '盤面の種類');
    for (const id of VARIANT_ORDER) {
      const btn = document.createElement('button');
      btn.className = 'seg-btn';
      btn.type = 'button';
      btn.textContent = BOARD_VARIANTS[id].label;
      btn.title = `${BOARD_VARIANTS[id].label}盤(${playableCellsFor(id)}マス)`;
      btn.addEventListener('click', () => this.handleVariantChange(id));
      this.variantBtns.set(id, btn);
      variantSeg.appendChild(btn);
    }
    variantGroup.appendChild(variantSeg);

    // --- 先手の色 ---
    const colorGroup = document.createElement('div');
    colorGroup.className = 'toolbar-group';
    const colorLabel = document.createElement('span');
    colorLabel.className = 'toolbar-label';
    colorLabel.textContent = '先手';
    colorGroup.appendChild(colorLabel);

    const colorSeg = document.createElement('div');
    colorSeg.className = 'segmented';
    colorSeg.setAttribute('role', 'group');
    colorSeg.setAttribute('aria-label', '先手の色');
    const colorDefs: ReadonlyArray<[Player, string]> = [
      [BLACK, '黒'],
      [WHITE, '白'],
    ];
    for (const [player, label] of colorDefs) {
      const btn = document.createElement('button');
      btn.className = 'seg-btn seg-color';
      btn.type = 'button';
      btn.innerHTML = `<span class="disc ${player === BLACK ? 'black' : 'white'}"></span>${label}`;
      btn.addEventListener('click', () => this.handleColorChange(player));
      this.colorBtns.set(player, btn);
      colorSeg.appendChild(btn);
    }
    colorGroup.appendChild(colorSeg);

    toolbar.appendChild(variantGroup);
    toolbar.appendChild(colorGroup);
    return toolbar;
  }

  /** ツールバーの選択状態(アクティブ表示)を現在の設定に同期。 */
  private syncToolbar(): void {
    for (const [id, btn] of this.variantBtns) {
      btn.classList.toggle('active', id === this.variant);
      btn.setAttribute('aria-pressed', String(id === this.variant));
    }
    for (const [player, btn] of this.colorBtns) {
      btn.classList.toggle('active', player === this.firstPlayer);
      btn.setAttribute('aria-pressed', String(player === this.firstPlayer));
    }
  }

  /**
   * コントロールボタンを作る。アイコン(inline SVG)+ テキストを横並びにするため
   * innerHTML を受け取る。html はこちらで組み立てた信頼できる固定文字列のみ渡す。
   */
  private makeButton(html: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'ctrl-btn ' + cls;
    b.type = 'button';
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- 設定変更ハンドラ -----------------------------------------------------

  private handleVariantChange(variant: VariantId): void {
    if (variant === this.variant) return; // 同じなら何もしない(リセットしない)。
    this.variant = variant;
    // 盤面の欠けマスが変わるのでグリッドを作り直す。
    this.boardView?.setVariant(variant);
    this.startGame();
  }

  private handleColorChange(player: Player): void {
    if (player === this.firstPlayer) return;
    this.firstPlayer = player;
    this.startGame();
  }

  // ---- ゲーム開始 / 進行ロジック ---------------------------------------------

  /** 現在の設定(variant / firstPlayer)で局面を最初から始める。 */
  private startGame(): void {
    this.reqId++; // 進行中の評価を破棄。
    this.game = new GameState(this.firstPlayer, this.variant);
    this.currentEvals = null;
    this.hideToast();
    this.syncToolbar();
    this.refresh();
  }

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

    const req: EvalRequest = {
      type: 'evaluate',
      reqId: this.reqId,
      board: Array.from(board),
      player,
      variant: this.variant,
      // timeLimitMs は未指定 → Worker 側で段階(中盤2秒/終盤3秒)を自動判定。
    };
    this.worker.postMessage(req);
  }

  private onWorkerResult(res: WorkerOutbound): void {
    // 古いリクエストの結果は無視(result / error 共通)。
    if (res.reqId !== this.reqId) return;

    // 想定外例外: Worker から error 応答。UI を必ず復帰させる。
    if (res.type === 'error') {
      this.currentEvals = null;
      this.draw();
      return;
    }

    if (res.type !== 'result') return;

    // エンジンの計算自体は継続しているが、深さ/ノード/ms の表示行は廃止したため
    // 結果(評価値)を盤面に反映するだけにとどめる。
    this.currentEvals = res.moves;
    this.draw();
  }

  /**
   * Worker の致命的失敗(onerror / onmessageerror)時のフォールバック。
   * 評価なしで合法手のクリックは引き続き可能にする(UI が固まらないようにする)。
   * エンジン情報の表示行は廃止したため、盤面の再描画(評価なし)のみ行う。
   */
  private onWorkerFailure(_message: string): void {
    this.currentEvals = null;
    this.draw();
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
    // 現在の設定のまま最初からやり直す(1画面なので選択画面には戻らない)。
    this.startGame();
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

  private showEndgame(): void {
    if (!this.game) return;
    const { black, white, winner } = this.game.getResult();
    let msg: string;
    if (winner === BLACK) msg = `🏁 終局! 黒の勝ち(${black} 対 ${white})`;
    else if (winner === WHITE) msg = `🏁 終局! 白の勝ち(${white} 対 ${black})`;
    else msg = `🏁 終局! 引き分け(${black} 対 ${white})`;
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
