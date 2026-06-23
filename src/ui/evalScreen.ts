/**
 * 評価値計算モード(検討盤)。
 *
 * フェーズ3でアプリをメニュー化したのに伴い、従来 App が持っていた検討盤の実装を
 * この EvalScreen クラスへそのまま移設した(機能・挙動は不変)。
 * メニューから出入りできるよう、コンストラクタで「メニューへ戻る」コールバックを受け取り、
 * 上部に戻るボタンを置くだけが新規差分。
 *
 * 既存機能は維持: 盤面種類/先手色のツールバー・評価値表示・3色色分け・1手戻る・リセット・
 * パス自動・終局表示・時間切れ復帰・レイアウトシフト対策。
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
import { EvalClient } from '../worker/evalClient';
import { ICON_UNDO, ICON_RESET, ICON_BACK } from './icons';
import type { MoveEval } from '../engine/search';

export class EvalScreen {
  private container: HTMLElement;
  private onBack: () => void;

  private game: GameState | null = null;
  private boardView: BoardView | null = null;

  /** 現在の設定。切り替えで局面をリセットする。 */
  private variant: VariantId = DEFAULT_VARIANT;
  private firstPlayer: Player = BLACK;

  private client: EvalClient;
  /** 最新リクエストの世代。古い Promise の結果はこれと突き合わせて破棄する。 */
  private reqId = 0;
  /** 現在評価中の手の結果(描画用キャッシュ)。 */
  private currentEvals: MoveEval[] | null = null;

  // 画面要素の参照。
  private boardEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private variantBtns = new Map<VariantId, HTMLButtonElement>();
  private colorBtns = new Map<Player, HTMLButtonElement>();

  constructor(container: HTMLElement, onBack: () => void) {
    this.container = container;
    this.onBack = onBack;

    // 対戦モードと同じ EvalClient(reqId 多重化 + Promise ラッパー + onerror/
    // onmessageerror での reject)を共用する。検討盤は「最新リクエストのみ反映」
    // なので、世代カウンタ(this.reqId)で古い Promise の結果を破棄する。
    this.client = new EvalClient();

    this.renderBoardScreen();
    this.startGame();
  }

  /** 画面破棄(メニューへ戻るとき worker を止める)。 */
  dispose(): void {
    // 先に世代を進めておく。client.dispose() は保留中の Promise を reject するが、
    // その catch は世代不一致で弾かれ、破棄後に draw() しない。
    this.reqId++;
    this.client.dispose();
  }

  // ---- 画面: 検討盤(1画面) -------------------------------------------------

  private renderBoardScreen(): void {
    this.container.innerHTML = '';
    this.variantBtns.clear();
    this.colorBtns.clear();

    const wrap = document.createElement('div');
    wrap.className = 'screen board-screen';

    // 上部バー: 戻る + タイトル。
    const topbar = document.createElement('div');
    topbar.className = 'screen-topbar';
    const backBtn = document.createElement('button');
    backBtn.className = 'ctrl-btn btn-back';
    backBtn.type = 'button';
    backBtn.innerHTML = `${ICON_BACK}<span>メニュー</span>`;
    backBtn.addEventListener('click', () => this.onBack());
    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = '評価値計算モード';
    topbar.appendChild(backBtn);
    topbar.appendChild(title);

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

    wrap.appendChild(topbar);
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
    if (variant === this.variant) return;
    this.variant = variant;
    this.boardView?.setVariant(variant);
    this.startGame();
  }

  private handleColorChange(player: Player): void {
    if (player === this.firstPlayer) return;
    this.firstPlayer = player;
    this.startGame();
  }

  // ---- ゲーム開始 / 進行ロジック ---------------------------------------------

  private startGame(): void {
    this.reqId++;
    this.game = new GameState(this.firstPlayer, this.variant);
    this.currentEvals = null;
    this.hideToast();
    this.syncToolbar();
    this.refresh();
  }

  private refresh(): void {
    if (!this.game) return;

    const pass = this.game.autoPassIfNeeded();
    if (pass) {
      const who = pass.passedPlayer === BLACK ? '黒' : '白';
      this.showToast(`${who} は打てる手がないためパスしました ⏭️`);
    }

    if (this.game.isOver()) {
      this.currentEvals = null;
      this.draw();
      this.showEndgame();
      return;
    }

    this.currentEvals = null;
    this.draw();
    this.requestEvaluation();
  }

  private requestEvaluation(): void {
    if (!this.game) return;
    const board = this.game.getBoard();
    const player = this.game.getCurrentPlayer();

    // この評価の世代を採番。await から戻った時点で this.reqId と一致しなければ
    // (盤面切替/着手/1手戻る/リセット/破棄で世代が進んだ後なので)結果を捨てる。
    const reqId = ++this.reqId;

    void this.client
      .evaluate(board, player, this.variant)
      .then((result) => {
        if (reqId !== this.reqId) return; // 古い結果は破棄。
        this.currentEvals = result.moves;
        this.draw();
      })
      .catch(() => {
        // 失敗(worker の error 応答 / onerror / onmessageerror / 破棄)。
        // 最新世代のときだけ評価表示を消す(古い失敗は無視)。
        if (reqId !== this.reqId) return;
        this.currentEvals = null;
        this.draw();
      });
  }

  private handleCellClick(cell: number): void {
    if (!this.game) return;
    const moved = this.game.play(cell);
    if (!moved) return;
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
