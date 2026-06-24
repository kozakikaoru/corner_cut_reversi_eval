/**
 * 対戦モード画面(設定 → 対局 → 結果 の 3 サブ画面を内包)。
 *
 * versus_mode.md の流れ:
 *  1. 対戦前設定: 盤面(通常/クロス/八角/ホロー/ランダム)・AI 強さ(5段階)を選ぶ。
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
import { EvalClient, type EvalResult } from '../worker/evalClient';
import { AI_LEVELS, type AiLevel, aiLevelById, chooseAiMove } from '../game/ai';
import {
  judgeMove,
  summarizePlay,
  pickJudgeSubMessage,
  JUDGE_PREFIX,
  type MoveScore,
  type MoveJudgeKind,
  type PlayScore,
} from '../game/scoring';
import type { VersusConfig, VersusVariantChoice } from '../game/versusConfig';
import { BoardView } from './boardView';
import { ICON_BACK, ICON_EVAL, ICON_RESET, ICON_SWORDS } from './icons';
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
    aiLevel: AI_LEVELS[1], // 既定: 中級
  };

  // ---- 対局状態 ----
  private config: VersusConfig | null = null;
  private game: GameState | null = null;
  private boardView: BoardView | null = null;
  /** 進行中の AI/評価処理を無効化する世代カウンタ(画面破棄・もう1戦で +1)。 */
  private generation = 0;

  /** 採点: プレイヤーの各手のスコア。 */
  private moveScores: MoveScore[] = [];
  /** 対局全体の着手数(両者合計の ply 数)。1手目(=0)の判定抑制に使う。 */
  private plyCount = 0;
  /**
   * 進行中の「直近のプレイヤー着手の採点」Promise。
   * 採点は手番進行と並行で走らせるが、最終手で着手直後に終局した場合は、
   * 結果集計(summarizePlay)の前にこれを待たないと最後の1手が採点に含まれない。
   * 終局時のみ advance がこれを await する(通常進行はブロックしない)。
   */
  private pendingScore: Promise<void> | null = null;
  /** 評価値表示トグルの状態。 */
  private showEvals = false;
  /** トグル ON 時に保持する現手番の評価結果。 */
  private currentEvals: MoveEval[] | null = null;
  /** UI ロック(AI 思考中・評価待ちはプレイヤー着手を受けない)。 */
  private busy = false;

  // ---- 改善1: 評価値プリフェッチ ----
  // プレイヤー手番になった時点で、トグルの ON/OFF に関わらず裏で全合法手を評価し、
  // この Promise にキャッシュしておく。トグル ON で即表示でき、採点にも流用する。
  // 手番が変わったら破棄(prefetchKey で局面の同一性を判定)。
  /** プリフェッチ中/完了の評価(局面が変わるまで保持)。null=未起動。 */
  private prefetchEvals: Promise<EvalResult | null> | null = null;
  /** プリフェッチ対象の局面キー(盤面文字列+手番+盤種)。一致しなければ流用しない。 */
  private prefetchKey: string | null = null;

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
    window.scrollTo(0, 0);
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
    this.plyCount = 0;
    this.pendingScore = null;
    this.showEvals = false;
    this.currentEvals = null;
    this.prefetchEvals = null;
    this.prefetchKey = null;
    this.busy = false;
    this.renderGame();
    this.advance();
  }

  /** 「やり直す」: 今の対局を同じ設定(盤面・手番の色)のまま初めから。 */
  private restartGame(): void {
    if (!this.config) return;
    if (!window.confirm('今の対局を初めからやり直しますか?')) return;
    this.beginGameFromConfig();
  }

  private renderGame(): void {
    if (!this.config) return;
    this.container.innerHTML = '';
    // 対局開始時はトップへスクロール(設定画面のスクロール位置が残って盤面が見切れないように)。
    window.scrollTo(0, 0);
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

    // 初めからやり直す(同じ設定=盤面・手番の色のまま盤面をリセット)。
    const restartBtn = document.createElement('button');
    restartBtn.className = 'ctrl-btn btn-restart';
    restartBtn.type = 'button';
    restartBtn.innerHTML = `${ICON_RESET}<span>やり直す</span>`;
    restartBtn.addEventListener('click', () => this.restartGame());
    controls.appendChild(restartBtn);

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

    // パス自動処理(パスも 1 ply として数える)。
    const pass = this.game.autoPassIfNeeded();
    if (pass) {
      this.plyCount++;
      const who = pass.passedPlayer === this.config.playerColor ? 'あなた' : 'AI';
      this.showToast(`${who} は打てる手がないためパスしました ⏭️`);
    }

    // 終局。
    if (this.game.isOver()) {
      this.busy = false;
      this.currentEvals = null;
      this.clearPrefetch();
      this.draw();
      // 最終手の採点が走っていれば、結果集計の前に完了を待つ(最後の1手を取りこぼさない)。
      const pending = this.pendingScore;
      if (pending) {
        const gen = this.generation;
        void pending.then(() => {
          if (gen === this.generation) this.showResult();
        });
      } else {
        this.showResult();
      }
      return;
    }

    const turn = this.game.getCurrentPlayer();
    if (turn === this.config.playerColor) {
      // プレイヤー手番。
      this.busy = false;
      this.setBanner('あなたの番です', 'you');
      // 改善1: トグルの ON/OFF に関わらず、この手番の評価を裏で先読み(プリフェッチ)。
      // ON で即表示でき、採点にも流用する。
      this.startPrefetch();
      // 評価値表示が ON なら(プリフェッチ結果を使って)表示する。
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
      this.clearPrefetch();
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
      .evaluate(board, aiColor, this.config.variant, {
        timeLimitMs: lv.timeLimitMs,
        maxDepth: lv.maxDepth,
        endgameEmpties: lv.endgameEmpties,
        evalMode: lv.evalMode,
      })
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

    if (cell >= 0) {
      this.game.play(cell);
      this.plyCount++;
    }
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
    const legalBefore = this.game.getLegalMoves();
    if (!legalBefore.includes(cell)) return;

    const gen = this.generation;
    const board = this.game.getBoard();
    const player = this.config.playerColor;
    const variant = this.config.variant;

    // この手が対局全体で何手目か(0 始まり)。1手目(=0)は判定を出さない。
    const plyIndex = this.plyCount;
    // 着手前の合法手数(= 選択肢の多さ)。1 個以下なら判定を出さない。
    const legalCount = legalBefore.length;

    // 採点用に「着手前の盤面・色」をコピーで確保(play で変わる前に)。
    const preBoard = board.slice();
    // プレイヤー手番開始時に走らせたプリフェッチ(同一局面の評価)を採点に流用する。
    const prefetched = this.takePrefetchFor(preBoard, player, variant);
    // 着手をすぐ反映。
    this.game.play(cell);
    this.plyCount++;
    this.currentEvals = null;
    // 採点(着手判定)を並行で開始。手番進行はブロックしない。
    // 最終手で即終局した場合に集計が取りこぼさないよう Promise を保持しておく
    // (終局時のみ advance が await する)。
    this.pendingScore = this.scorePlayerMove(
      preBoard, player, variant, cell, plyIndex, legalCount, prefetched, gen,
    );
    // すぐ次の手番へ(AI なら思考演出+応手がここから始まる)。
    this.advance();
  }

  /**
   * プレイヤーの 1 手を採点(着手前局面の全合法手評価と比較)し、判定を表示する。
   *
   * 手番進行とは独立(busy も advance も触らない)。判定の精度より「すぐ出る」
   * ことを優先する。プレイヤー手番開始時のプリフェッチ(prefetched)があれば
   * それを使い、Worker への二重リクエストを避ける(プリフェッチは時間上限なしの
   * 通常評価なので精度も十分)。無ければ短い時間上限で評価する。
   *
   * 判定表示(改善4)は「選択の余地がある手」かつ「1手目でない」ときだけ。
   * ただし採点(moveScores への蓄積)自体は常に行い、強制手の除外は最終集計
   * (summarizePlay)が legalCount を見て担う。
   */
  private async scorePlayerMove(
    preBoard: Board,
    player: Player,
    variant: VariantId,
    cell: number,
    plyIndex: number,
    legalCount: number,
    prefetched: Promise<EvalResult | null> | null,
    gen: number,
  ): Promise<void> {
    const result = await (prefetched ??
      this.client
        .evaluate(preBoard, player, variant, { timeLimitMs: JUDGE_TIME_LIMIT_MS })
        .catch(() => null));
    if (gen !== this.generation || !this.game) return;

    if (result && result.moves.length > 0) {
      const score = judgeMove(result.moves, cell);
      this.moveScores.push(score);
      // 判定バーは「選択の余地あり(合法手2個以上)」かつ「1手目でない」ときだけ表示。
      if (legalCount >= 2 && plyIndex >= 1) {
        this.showJudge(score.kind);
      }
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
      this.setEvalPending(false); // 計算中表示を消す。
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

  /**
   * 現手番の全合法手評価を盤に表示する(改善1)。
   *
   * プレイヤー手番開始時のプリフェッチ結果を再利用する。完了済みなら即時表示
   * (ラグなし)。計算中なら「計算中…」を出し、完了次第そのまま表示する。
   * プリフェッチが無い/別局面なら念のため新規に起動して待つ。
   */
  private async loadEvalsForDisplay(gen: number): Promise<void> {
    if (!this.game || !this.config) return;
    const player = this.game.getCurrentPlayer();

    // プリフェッチが現局面と一致していなければ起動(通常は advance で起動済み)。
    const key = this.positionKey(this.game.getBoard(), player, this.config.variant);
    if (this.prefetchKey !== key || !this.prefetchEvals) {
      this.startPrefetch();
    }
    const promise = this.prefetchEvals;

    // 結果待ちの間は「計算中…」を表示(押下から表示までの空白を埋める)。
    this.setEvalPending(true);

    const result = await (promise ?? Promise.resolve<EvalResult | null>(null));
    if (gen !== this.generation || !this.game) return;
    // 表示中に手番が進んでいたら捨てる。
    if (this.game.getCurrentPlayer() !== player) return;
    // 待っている間にトグルが OFF された場合も表示しない。
    this.setEvalPending(false);
    this.currentEvals = this.showEvals && result ? result.moves : null;
    this.draw();
  }

  // =========================================================================
  // 改善1: 評価値プリフェッチのヘルパ
  // =========================================================================

  /** 局面の同一性キー(盤面+手番+盤種)。プリフェッチ流用の判定に使う。 */
  private positionKey(board: Board, player: Player, variant: VariantId): string {
    return `${variant}|${player}|${board.join('')}`;
  }

  /**
   * 現在のプレイヤー手番の局面を裏で評価開始しキャッシュする。
   * 既に同一局面のプリフェッチがあれば二重に投げない。トグル OFF でも起動しておく。
   * 世代(generation)管理は結果の **消費側**(loadEvalsForDisplay / scorePlayerMove)が
   * 行うため、ここでは gen を受け取らない(キャッシュは clearPrefetch / 局面キーで管理)。
   */
  private startPrefetch(): void {
    if (!this.game || !this.config) return;
    const board = this.game.getBoard();
    const player = this.game.getCurrentPlayer();
    const variant = this.config.variant;
    const key = this.positionKey(board, player, variant);
    if (this.prefetchKey === key && this.prefetchEvals) return; // 既に先読み中。
    this.prefetchKey = key;
    // 表示・採点の両方で使うため時間上限なしの通常評価(検討盤と同じ精度)。
    // 盤面はコピーを渡す(以降の play で変わるため)。
    this.prefetchEvals = this.client
      .evaluate(board.slice(), player, variant)
      .catch(() => null);
  }

  /**
   * 着手時に、その着手前局面に対するプリフェッチを採点へ引き渡す。
   * 局面キーが一致すれば Promise を返し(scorePlayerMove が await)、
   * 一致しなければ null(scorePlayerMove は自前で短時間評価する)。
   * いずれにせよプリフェッチ状態はここでクリアする(手番が変わるため)。
   */
  private takePrefetchFor(
    preBoard: Board,
    player: Player,
    variant: VariantId,
  ): Promise<EvalResult | null> | null {
    const key = this.positionKey(preBoard, player, variant);
    const match = this.prefetchKey === key ? this.prefetchEvals : null;
    this.clearPrefetch();
    return match;
  }

  /** プリフェッチのキャッシュを破棄(手番が変わる/終局/画面破棄時)。 */
  private clearPrefetch(): void {
    this.prefetchEvals = null;
    this.prefetchKey = null;
  }

  /** 評価値の「計算中…」表示の ON/OFF(プリフェッチ未完了でトグル ON のとき)。 */
  private setEvalPending(on: boolean): void {
    if (!this.turnBannerEl) return;
    this.turnBannerEl.classList.toggle('eval-pending-note', on);
    const existing = this.turnBannerEl.querySelector('.eval-pending-text');
    if (on) {
      if (!existing) {
        const span = document.createElement('span');
        span.className = 'eval-pending-text';
        span.textContent = '評価値を計算中…';
        this.turnBannerEl.appendChild(span);
      }
    } else if (existing) {
      existing.remove();
    }
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
    window.scrollTo(0, 0);
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
      // 強制手しか無かった等で「選択を伴う着手」が無かったケース。
      empty.textContent =
        play.forcedCount > 0
          ? '選択を伴う着手がなく(強制手のみ)採点できませんでした'
          : '採点対象の着手がありませんでした';
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
    // 採点対象手数。強制手を除外している場合はその旨も併記。
    const movesValue =
      play.forcedCount > 0
        ? `${play.totalMoves}手 <span class="ps-note">(強制手${play.forcedCount}手は除外)</span>`
        : `${play.totalMoves}手`;
    stats.appendChild(this.statRow('採点手数', movesValue, true));

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

  /**
   * 着手判定フィードバック(Perfect/Good/Bad)を一定時間表示(改善4)。
   * 文言は種別ごとの候補からランダムに 1 つ選ぶ(同じ判定でも毎回変わる)。
   * 表示するかどうかの条件判定(強制手・1手目の除外)は呼び出し側で済ませる。
   */
  private showJudge(kind: MoveJudgeKind): void {
    if (!this.judgeEl) return;
    if (this.judgeTimer !== null) window.clearTimeout(this.judgeTimer);
    const clsMap: Record<MoveJudgeKind, string> = {
      perfect: 'judge-perfect',
      good: 'judge-good',
      bad: 'judge-bad',
    };
    this.judgeEl.className = 'judge-feedback show ' + clsMap[kind];
    this.judgeEl.textContent = '';
    const prefixEl = document.createElement('span');
    prefixEl.className = 'judge-prefix';
    prefixEl.textContent = JUDGE_PREFIX[kind];
    const subEl = document.createElement('span');
    subEl.className = 'judge-sub';
    subEl.textContent = pickJudgeSubMessage(kind);
    this.judgeEl.append(prefixEl, subEl);
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
    backBtn.innerHTML = `${ICON_BACK}<span>TOP</span>`;
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
