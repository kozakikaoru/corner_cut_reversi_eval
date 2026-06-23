/**
 * 対戦モード画面(設定 → 対局 → 結果 の 3 サブ画面を内包)。
 *
 * versus_mode.md の流れ:
 *  1. 対戦前設定: 盤面(通常/クロス/八角/ホロー/ランダム)・AI 強さ(6段階)を選ぶ。
 *  2. 対局開始: 先手は黒固定。プレイヤーの色はランダム決定。
 *  3. 進行: プレイヤー手番はクリック着手 / AI 手番は AI が着手(思考演出つき)。
 *     パス自動・終局は GameState を流用。
 *  4. AI 思考演出: 0.6〜1.5 秒(強さで可変)の「間」+「AI思考中…」ドットアニメ。
 *     プレイヤー手番は「あなたの番です」。
 *  5. 対局後: 結果画面(勝敗 + プレイ採点)→ TOP / 対戦メニュー / もう1戦。
 *
 * 採点(全部入り):
 *  - 評価値表示トグル: 現手番の全合法手評価を 3色リングで盤面表示(検討盤と同じ見せ方)。
 *  - 着手判定: プレイヤー着手ごとに Perfect/Good/Bad をフィードバック。
 *  - 最終プレイ採点: 終局時に一致率/平均ロス/総合スコアを表示。
 *
 * すべての評価(AI 着手・採点・評価値表示)は EvalClient 経由でエンジンを非同期に使い、
 * UI をブロックしない。
 */

import {
  type Board,
  type Player,
  type VariantId,
  BLACK,
  WHITE,
  VARIANT_ORDER,
  BOARD_VARIANTS,
} from '../engine/types';
import { GameState } from '../game/gameState';
import { EvalClient } from '../worker/evalClient';
import { AI_LEVELS, type AiLevel, aiLevelById, chooseAiMove } from '../game/ai';
import {
  judgeMove,
  summarizePlay,
  type MoveScore,
  type MoveJudgeKind,
  type PlayScore,
} from '../game/scoring';
import type { VersusConfig, VersusVariantChoice } from '../game/versusConfig';
import { BoardView } from './boardView';
import { ICON_BACK, ICON_EVAL, ICON_SWORDS } from './icons';
import type { MoveEval } from '../engine/search';

/**
 * 着手判定(Perfect/Good/Bad)用の評価の時間上限(ms)。
 *
 * 採点は「すぐ出る」ことが最優先。時間上限を渡さないと Worker 側が中盤で
 * MIDGAME_TIME_MS(=2000ms)まで読み切ろうとし、その間ずっと判定も AI 応手も
 * 出ない(=盤面が固まって見える)。判定は手の優劣の概略で十分なので短く絞る。
 * これにより単一 Worker を AI 応手の評価から長く奪わない効果もある。
 */
const JUDGE_TIME_LIMIT_MS = 250;

/** 結果画面から呼ぶナビゲーション操作。 */
export interface VersusNav {
  /** TOP(メニュー)へ戻る。 */
  toMenu: () => void;
}

/** 設定画面の選択状態(まだ色は未決定)。 */
interface SetupChoice {
  variant: VersusVariantChoice;
  aiLevel: AiLevel;
}

export class VersusScreen {
  private container: HTMLElement;
  private nav: VersusNav;
  private client: EvalClient;

  // ---- 設定画面の選択状態 ----
  private setup: SetupChoice = {
    variant: 'random',
    aiLevel: AI_LEVELS[2], // 既定: Lv.3 中級
  };

  // ---- 対局状態 ----
  private config: VersusConfig | null = null;
  private game: GameState | null = null;
  private boardView: BoardView | null = null;
  /** 進行中の AI/評価処理を無効化する世代カウンタ(画面破棄・もう1戦で +1)。 */
  private generation = 0;

  /** 採点: プレイヤーの各手のスコア。 */
  private moveScores: MoveScore[] = [];
  /** 評価値表示トグルの状態。 */
  private showEvals = false;
  /** トグル ON 時に保持する現手番の評価結果。 */
  private currentEvals: MoveEval[] | null = null;
  /** UI ロック(AI 思考中・評価待ちはプレイヤー着手を受けない)。 */
  private busy = false;

  // ---- 対局画面の DOM 参照 ----
  private boardEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private turnBannerEl: HTMLElement | null = null;
  private judgeEl: HTMLElement | null = null;
  private evalToggleBtn: HTMLButtonElement | null = null;
  private toastEl: HTMLElement | null = null;
  private judgeTimer: number | null = null;

  constructor(container: HTMLElement, nav: VersusNav) {
    this.container = container;
    this.nav = nav;
    this.client = new EvalClient();
    this.renderSetup();
  }

  /** 画面破棄。進行中の AI 処理を無効化し worker を止める。 */
  dispose(): void {
    this.generation++;
    if (this.judgeTimer !== null) window.clearTimeout(this.judgeTimer);
    this.client.dispose();
  }

  // =========================================================================
  // 1) 対戦前設定画面
  // =========================================================================

  private renderSetup(): void {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'screen versus-setup';

    // 上部バー(戻る + タイトル)。
    wrap.appendChild(this.buildTopbar('対戦モード', () => this.nav.toMenu()));

    // --- 盤面選択 ---
    const boardSection = document.createElement('section');
    boardSection.className = 'setup-section';
    boardSection.appendChild(this.sectionTitle('盤面を選ぶ'));
    const boardGrid = document.createElement('div');
    boardGrid.className = 'choice-grid';
    const variantChoices: VersusVariantChoice[] = [...VARIANT_ORDER, 'random'];
    const variantBtns = new Map<VersusVariantChoice, HTMLButtonElement>();
    for (const choice of variantChoices) {
      const label = choice === 'random' ? 'ランダム' : BOARD_VARIANTS[choice].label;
      const sub =
        choice === 'random' ? '開始時に決定' : `${BOARD_VARIANTS[choice].blocked.length === 0 ? '64' : 64 - BOARD_VARIANTS[choice].blocked.length}マス`;
      const btn = this.choiceButton(label, sub, () => {
        this.setup.variant = choice;
        for (const [c, b] of variantBtns) {
          const on = c === choice;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', String(on));
        }
      });
      variantBtns.set(choice, btn);
      boardGrid.appendChild(btn);
    }
    // 初期選択を反映。
    {
      const init = variantBtns.get(this.setup.variant);
      if (init) {
        init.classList.add('selected');
        init.setAttribute('aria-pressed', 'true');
      }
    }
    boardSection.appendChild(boardGrid);

    // --- AI 強さ選択 ---
    const aiSection = document.createElement('section');
    aiSection.className = 'setup-section';
    aiSection.appendChild(this.sectionTitle('AIの強さを選ぶ'));
    const aiGrid = document.createElement('div');
    aiGrid.className = 'choice-grid ai-grid';
    const aiBtns = new Map<AiLevel, HTMLButtonElement>();
    for (const lv of AI_LEVELS) {
      const btn = this.choiceButton(lv.label, lv.desc, () => {
        this.setup.aiLevel = lv;
        for (const [l, b] of aiBtns) {
          const on = l === lv;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', String(on));
        }
      });
      if (lv.special) btn.classList.add('berserker');
      aiBtns.set(lv, btn);
      aiGrid.appendChild(btn);
    }
    {
      const init = aiBtns.get(this.setup.aiLevel);
      if (init) {
        init.classList.add('selected');
        init.setAttribute('aria-pressed', 'true');
      }
    }
    aiSection.appendChild(aiGrid);

    // --- 開始ボタン ---
    const startWrap = document.createElement('div');
    startWrap.className = 'setup-start';
    const startBtn = document.createElement('button');
    startBtn.className = 'primary-btn start-btn';
    startBtn.type = 'button';
    startBtn.innerHTML = `${ICON_SWORDS}<span>対局開始</span>`;
    startBtn.addEventListener('click', () => this.startMatch());
    startWrap.appendChild(startBtn);

    wrap.appendChild(boardSection);
    wrap.appendChild(aiSection);
    wrap.appendChild(startWrap);
    this.container.appendChild(wrap);
  }

  // =========================================================================
  // 対局の開始 / 進行
  // =========================================================================

  /** 設定を確定して対局を開始。盤面 random / 先後ランダムをここで解決する。 */
  private startMatch(): void {
    const variant = this.resolveVariant(this.setup.variant);
    // 先手は常に黒。プレイヤーの色はランダム決定。
    const playerColor: Player = Math.random() < 0.5 ? BLACK : WHITE;
    this.config = {
      variant,
      variantChoice: this.setup.variant,
      aiLevel: this.setup.aiLevel.id,
      playerColor,
    };
    this.beginGameFromConfig();
  }

  /** 「もう1戦」: 同設定でリスタート。random 盤面・先後は再抽選。 */
  private rematch(): void {
    if (!this.config) {
      this.renderSetup();
      return;
    }
    const variant = this.resolveVariant(this.config.variantChoice);
    const playerColor: Player = Math.random() < 0.5 ? BLACK : WHITE;
    this.config = { ...this.config, variant, playerColor };
    this.beginGameFromConfig();
  }

  private resolveVariant(choice: VersusVariantChoice): VariantId {
    if (choice !== 'random') return choice;
    const i = Math.floor(Math.random() * VARIANT_ORDER.length);
    return VARIANT_ORDER[Math.min(i, VARIANT_ORDER.length - 1)];
  }

  /** config を元に GameState を作り、対局画面を描画して進行を始める。 */
  private beginGameFromConfig(): void {
    if (!this.config) return;
    this.generation++; // 旧世代の AI 処理を無効化。
    // 先手は黒固定。
    this.game = new GameState(BLACK, this.config.variant);
    this.moveScores = [];
    this.showEvals = false;
    this.currentEvals = null;
    this.busy = false;
    this.renderGame();
    this.advance();
  }

  private renderGame(): void {
    if (!this.config) return;
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'screen versus-game';

    // 上部バー(投了=メニューへ + 対戦情報)。
    const lv = aiLevelById(this.config.aiLevel);
    const topbar = document.createElement('div');
    topbar.className = 'screen-topbar versus-topbar';
    const backBtn = document.createElement('button');
    backBtn.className = 'ctrl-btn btn-back';
    backBtn.type = 'button';
    backBtn.innerHTML = `${ICON_BACK}<span>やめる</span>`;
    backBtn.addEventListener('click', () => this.confirmQuit());
    const info = document.createElement('div');
    info.className = 'versus-info';
    const youLabel = this.config.playerColor === BLACK ? '黒' : '白';
    info.innerHTML =
      `<span class="vs-board">${BOARD_VARIANTS[this.config.variant].label}盤</span>` +
      `<span class="vs-sep">·</span>` +
      `<span class="vs-ai${lv.special ? ' berserker' : ''}">${lv.label}</span>` +
      `<span class="vs-sep">·</span>` +
      `<span class="vs-you">あなた: <span class="disc ${this.config.playerColor === BLACK ? 'black' : 'white'}"></span>${youLabel}</span>`;
    topbar.appendChild(backBtn);
    topbar.appendChild(info);

    // 手番バナー(あなたの番 / AI思考中…)。
    this.turnBannerEl = document.createElement('div');
    this.turnBannerEl.className = 'turn-banner';

    // ステータス(石数)。
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';

    // 盤面。
    this.boardEl = document.createElement('div');

    // 着手判定フィードバック(Perfect/Good/Bad)。レイアウトシフト防止に高さ固定。
    this.judgeEl = document.createElement('div');
    this.judgeEl.className = 'judge-feedback';

    // コントロール(評価値表示トグル)。
    const controls = document.createElement('div');
    controls.className = 'controls';
    this.evalToggleBtn = document.createElement('button');
    this.evalToggleBtn.className = 'ctrl-btn btn-eval-toggle';
    this.evalToggleBtn.type = 'button';
    this.evalToggleBtn.addEventListener('click', () => this.toggleEvals());
    this.syncEvalToggleLabel();
    controls.appendChild(this.evalToggleBtn);

    // トースト(パス・終局通知)。
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast hidden';

    wrap.appendChild(topbar);
    wrap.appendChild(this.turnBannerEl);
    wrap.appendChild(this.statusEl);
    wrap.appendChild(this.boardEl);
    wrap.appendChild(this.judgeEl);
    wrap.appendChild(controls);
    wrap.appendChild(this.toastEl);
    this.container.appendChild(wrap);

    this.boardView = new BoardView(this.boardEl, this.config.variant, (cell) =>
      this.handlePlayerClick(cell),
    );
    this.draw();
  }

  /**
   * 局面を 1 ステップ進める中核。
   * パス自動 → 終局判定 → 手番に応じて「プレイヤー入力待ち」or「AI 着手」へ分岐。
   */
  private advance(): void {
    if (!this.game || !this.config) return;
    const gen = this.generation;

    // パス自動処理。
    const pass = this.game.autoPassIfNeeded();
    if (pass) {
      const who = pass.passedPlayer === this.config.playerColor ? 'あなた' : 'AI';
      this.showToast(`${who} は打てる手がないためパスしました ⏭️`);
    }

    // 終局。
    if (this.game.isOver()) {
      this.busy = false;
      this.currentEvals = null;
      this.draw();
      this.showResult();
      return;
    }

    const turn = this.game.getCurrentPlayer();
    if (turn === this.config.playerColor) {
      // プレイヤー手番。
      this.busy = false;
      this.setBanner('あなたの番です', 'you');
      // 評価値表示が ON ならこの手番の評価を取得して表示。
      if (this.showEvals) {
        void this.loadEvalsForDisplay(gen);
      } else {
        this.currentEvals = null;
        this.draw();
      }
    } else {
      // AI 手番。
      this.busy = true;
      this.currentEvals = null;
      this.setBanner('AI思考中', 'ai-thinking');
      this.draw();
      void this.runAiTurn(gen);
    }
  }

  /** AI の手番: エンジンで評価 → 思考演出の「間」を置いて着手。 */
  private async runAiTurn(gen: number): Promise<void> {
    if (!this.game || !this.config) return;
    const lv = aiLevelById(this.config.aiLevel);
    const aiColor = this.game.getCurrentPlayer();
    const board = this.game.getBoard();

    // 評価と「考えてる風の間」を並行で進め、両方そろってから着手する。
    const evalPromise = this.client
      .evaluate(board, aiColor, this.config.variant, lv.timeLimitMs)
      .catch(() => null);
    const [lo, hi] = lv.thinkDelayMs;
    const delay = lo + Math.random() * (hi - lo);
    const delayPromise = new Promise<void>((r) => window.setTimeout(r, delay));

    const [result] = await Promise.all([evalPromise, delayPromise]);

    // この間に画面が変わっていたら破棄。
    if (gen !== this.generation || !this.game) return;

    let cell = -1;
    if (result && result.moves.length > 0) {
      cell = chooseAiMove(result.moves, lv);
    } else {
      // 評価失敗時のフォールバック: 合法手の先頭を打つ(UI を止めない)。
      const legal = this.game.getLegalMoves();
      cell = legal.length > 0 ? legal[0] : -1;
    }

    if (cell >= 0) this.game.play(cell);
    this.busy = false;
    this.advance();
  }

  /**
   * プレイヤーのクリック着手。
   *
   * 重要(UX 上の要):
   *  - 着手はすぐ反映し、その場で **手番を進める(advance)**。これにより
   *    「AI思考中…」バナー・思考演出の「間」がクリック直後に始まり、AI 応手まで
   *    途切れない。
   *  - 採点(着手判定)は **手番進行とは独立に並行**で走らせる(短時間で評価して
   *    Perfect/Good/Bad を表示)。採点完了を待ってから進めると、評価に数百ms〜
   *    数秒かかる間ずっと盤面が無反応に見える(=「AIが応手しない」ように見える)
   *    ため、ここでは絶対に await して進行をブロックしない。
   */
  private handlePlayerClick(cell: number): void {
    if (!this.game || !this.config) return;
    if (this.busy) return; // AI 思考中・評価待ちは無視。
    if (this.game.getCurrentPlayer() !== this.config.playerColor) return;

    // 合法手チェック(BoardView 側でも弾くが二重防御)。
    if (!this.game.getLegalMoves().includes(cell)) return;

    const gen = this.generation;
    const board = this.game.getBoard();
    const player = this.config.playerColor;
    const variant = this.config.variant;

    // 採点用に「着手前の盤面・色」をコピーで確保(play で変わる前に)。
    const preBoard = board.slice();
    // 着手をすぐ反映。
    this.game.play(cell);
    this.currentEvals = null;
    // 採点(着手判定)を並行で開始。手番進行はブロックしない。
    void this.scorePlayerMove(preBoard, player, variant, cell, gen);
    // すぐ次の手番へ(AI なら思考演出+応手がここから始まる)。
    this.advance();
  }

  /**
   * プレイヤーの 1 手を採点(着手前局面の全合法手評価と比較)し、判定を表示する。
   *
   * 手番進行とは独立(busy も advance も触らない)。判定の精度より「すぐ出る」
   * ことを優先し、短い時間上限で評価する(Perfect/Good/Bad は手の優劣の概略で
   * 十分。深掘りすると Worker を占有して AI 応手まで遅れる)。
   */
  private async scorePlayerMove(
    preBoard: Board,
    player: Player,
    variant: VariantId,
    cell: number,
    gen: number,
  ): Promise<void> {
    const result = await this.client
      .evaluate(preBoard, player, variant, JUDGE_TIME_LIMIT_MS)
      .catch(() => null);
    if (gen !== this.generation || !this.game) return;

    if (result && result.moves.length > 0) {
      const score = judgeMove(result.moves, cell);
      this.moveScores.push(score);
      this.showJudge(score.kind);
    }
  }

  // =========================================================================
  // 評価値表示トグル(採点①)
  // =========================================================================

  private toggleEvals(): void {
    this.showEvals = !this.showEvals;
    this.syncEvalToggleLabel();
    if (!this.game || !this.config) return;
    // プレイヤー手番のときだけ表示(AI 手番はバナー優先・盤は触れない)。
    if (!this.showEvals) {
      this.currentEvals = null;
      this.draw();
      return;
    }
    if (
      !this.busy &&
      this.game.getCurrentPlayer() === this.config.playerColor &&
      !this.game.isOver()
    ) {
      void this.loadEvalsForDisplay(this.generation);
    }
  }

  /** 現手番の全合法手評価を取得して盤に表示する。 */
  private async loadEvalsForDisplay(gen: number): Promise<void> {
    if (!this.game || !this.config) return;
    const board = this.game.getBoard();
    const player = this.game.getCurrentPlayer();
    const variant = this.config.variant;
    const result = await this.client.evaluate(board, player, variant).catch(() => null);
    if (gen !== this.generation || !this.game) return;
    // 表示中に手番が進んでいたら捨てる。
    if (this.game.getCurrentPlayer() !== player) return;
    this.currentEvals = this.showEvals && result ? result.moves : null;
    this.draw();
  }

  private syncEvalToggleLabel(): void {
    if (!this.evalToggleBtn) return;
    const on = this.showEvals;
    this.evalToggleBtn.classList.toggle('active', on);
    this.evalToggleBtn.setAttribute('aria-pressed', String(on));
    this.evalToggleBtn.innerHTML = `${ICON_EVAL}<span>評価値表示: ${on ? 'ON' : 'OFF'}</span>`;
  }

  // =========================================================================
  // 3) 結果画面(勝敗 + プレイ採点)
  // =========================================================================

  private showResult(): void {
    if (!this.game || !this.config) return;
    const { black, white, winner } = this.game.getResult();
    const playerColor = this.config.playerColor;
    const playerCount = playerColor === BLACK ? black : white;
    const aiCount = playerColor === BLACK ? white : black;

    let outcome: 'win' | 'lose' | 'draw';
    if (winner === null) outcome = 'draw';
    else outcome = winner === playerColor ? 'win' : 'lose';

    const play = summarizePlay(this.moveScores);

    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'screen versus-result';

    // 勝敗ヘッダ。
    const header = document.createElement('div');
    header.className = 'result-header result-' + outcome;
    const headline =
      outcome === 'win' ? 'あなたの勝ち！' : outcome === 'lose' ? 'あなたの負け…' : '引き分け';
    header.innerHTML = `
      <div class="result-headline">${headline}</div>
      <div class="result-score">
        <span class="rs-you">あなた <span class="disc ${playerColor === BLACK ? 'black' : 'white'}"></span> ${playerCount}</span>
        <span class="rs-sep">—</span>
        <span class="rs-ai">${aiCount} <span class="disc ${playerColor === BLACK ? 'white' : 'black'}"></span> AI</span>
      </div>
    `;

    // プレイ採点カード。
    const scoreCard = this.buildScoreCard(play);

    // 導線(TOP / 対戦メニュー / もう1戦)。
    const actions = document.createElement('div');
    actions.className = 'result-actions';
    actions.appendChild(
      this.actionButton('もう1戦', 'primary-btn', () => this.rematch()),
    );
    actions.appendChild(
      this.actionButton('対戦メニュー', 'ghost-btn', () => this.renderSetup()),
    );
    actions.appendChild(
      this.actionButton('TOPに戻る', 'ghost-btn', () => this.nav.toMenu()),
    );

    wrap.appendChild(header);
    wrap.appendChild(scoreCard);
    wrap.appendChild(actions);
    this.container.appendChild(wrap);
  }

  /** 「あなたのプレイ評価」カードを組み立てる。 */
  private buildScoreCard(play: PlayScore): HTMLElement {
    const card = document.createElement('div');
    card.className = 'play-score-card';

    const title = document.createElement('div');
    title.className = 'ps-title';
    title.textContent = 'あなたのプレイ評価';

    if (play.totalMoves === 0) {
      const empty = document.createElement('div');
      empty.className = 'ps-empty';
      empty.textContent = '採点対象の着手がありませんでした';
      card.appendChild(title);
      card.appendChild(empty);
      return card;
    }

    // 大きなランク + 総合スコア。
    const big = document.createElement('div');
    big.className = 'ps-big';
    big.innerHTML = `
      <span class="ps-rank ps-rank-${play.rank}">${play.rank}</span>
      <span class="ps-total"><strong>${play.totalScore}</strong><span class="ps-total-max">/100</span></span>
    `;

    // 指標一覧。
    const stats = document.createElement('div');
    stats.className = 'ps-stats';
    stats.appendChild(this.statRow('最善一致率', `${play.bestMatchRate.toFixed(0)}%`));
    stats.appendChild(this.statRow('平均ロス', play.averageLoss.toFixed(2)));
    stats.appendChild(
      this.statRow(
        '内訳',
        `<span class="tag tag-perfect">Perfect ${play.perfectCount}</span>` +
          `<span class="tag tag-good">Good ${play.goodCount}</span>` +
          `<span class="tag tag-bad">Bad ${play.badCount}</span>`,
        true,
      ),
    );
    stats.appendChild(this.statRow('総手数', `${play.totalMoves}手`));

    card.appendChild(title);
    card.appendChild(big);
    card.appendChild(stats);
    return card;
  }

  private statRow(label: string, valueHtml: string, isHtml = false): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ps-row';
    const l = document.createElement('span');
    l.className = 'ps-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'ps-value';
    if (isHtml) v.innerHTML = valueHtml;
    else v.textContent = valueHtml;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  // =========================================================================
  // 描画ヘルパ
  // =========================================================================

  private draw(): void {
    if (!this.game || !this.boardView) return;
    const board = this.game.getBoard();
    const legal = this.game.getLegalMoves();
    // 評価値表示が ON でプレイヤー手番なら評価オーバーレイ、それ以外は null。
    const evals =
      this.showEvals && this.currentEvals && !this.busy ? this.currentEvals : null;
    this.boardView.render(board, legal, evals);
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.game || !this.statusEl || !this.config) return;
    const { black, white } = this.game.getCounts();
    const playerColor = this.config.playerColor;
    const youCount = playerColor === BLACK ? black : white;
    const aiCount = playerColor === BLACK ? white : black;
    this.statusEl.innerHTML = `
      <div class="score">
        <span class="score-item"><span class="disc ${playerColor === BLACK ? 'black' : 'white'}"></span> ${youCount}<span class="score-tag">あなた</span></span>
        <span class="score-item"><span class="disc ${playerColor === BLACK ? 'white' : 'black'}"></span> ${aiCount}<span class="score-tag">AI</span></span>
      </div>
    `;
  }

  /** 手番バナー。kind=ai-thinking のときドットアニメ用の markup を入れる。 */
  private setBanner(text: string, kind: 'you' | 'ai-thinking'): void {
    if (!this.turnBannerEl) return;
    this.turnBannerEl.className = 'turn-banner banner-' + kind;
    if (kind === 'ai-thinking') {
      // 「AI思考中」+ アニメするドット 3 つ(CSS でフェード)。
      this.turnBannerEl.innerHTML =
        `<span class="thinking-text">${text}</span>` +
        `<span class="thinking-dots"><i></i><i></i><i></i></span>`;
    } else {
      this.turnBannerEl.innerHTML = `<span class="your-turn-text">${text}</span>`;
    }
  }

  /** 着手判定フィードバック(Perfect/Good/Bad)を一定時間表示。 */
  private showJudge(kind: MoveJudgeKind): void {
    if (!this.judgeEl) return;
    if (this.judgeTimer !== null) window.clearTimeout(this.judgeTimer);
    const map: Record<MoveJudgeKind, { text: string; cls: string }> = {
      perfect: { text: 'Perfect! 最善手です', cls: 'judge-perfect' },
      good: { text: 'Good! 善手です', cls: 'judge-good' },
      bad: { text: 'Bad! 悪手です', cls: 'judge-bad' },
    };
    const { text, cls } = map[kind];
    this.judgeEl.className = 'judge-feedback show ' + cls;
    this.judgeEl.textContent = text;
    this.judgeTimer = window.setTimeout(() => {
      if (this.judgeEl) this.judgeEl.className = 'judge-feedback';
    }, 1800);
  }

  private showToast(message: string, sticky = false): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('hidden');
    if (!sticky) window.setTimeout(() => this.hideToast(), 2600);
  }

  private hideToast(): void {
    if (this.toastEl) this.toastEl.classList.add('hidden');
  }

  private confirmQuit(): void {
    // 対局途中。確認して TOP へ(window.confirm はブロッキングだが軽量で十分)。
    if (window.confirm('対局をやめてメニューに戻りますか?')) {
      this.nav.toMenu();
    }
  }

  // =========================================================================
  // 小さな DOM ファクトリ
  // =========================================================================

  private buildTopbar(titleText: string, onBack: () => void): HTMLElement {
    const topbar = document.createElement('div');
    topbar.className = 'screen-topbar';
    const backBtn = document.createElement('button');
    backBtn.className = 'ctrl-btn btn-back';
    backBtn.type = 'button';
    backBtn.innerHTML = `${ICON_BACK}<span>メニュー</span>`;
    backBtn.addEventListener('click', onBack);
    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = titleText;
    topbar.appendChild(backBtn);
    topbar.appendChild(title);
    return topbar;
  }

  private sectionTitle(text: string): HTMLElement {
    const h = document.createElement('h2');
    h.className = 'setup-section-title';
    h.textContent = text;
    return h;
  }

  private choiceButton(title: string, sub: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.type = 'button';
    btn.innerHTML = `<span class="choice-title">${title}</span><span class="choice-sub">${sub}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private actionButton(text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
