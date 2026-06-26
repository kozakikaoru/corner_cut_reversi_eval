/**
 * 盤面の描画(DOM)。
 * - 8×8 グリッド(全盤面共通)。欠けマスは "blocked"(盤外スタイル、クリック無効)。
 * - 石(黒/白)を描画。
 * - 合法手セルに評価値オーバーレイ(数値 + 3色)。最善手は強調。
 * - 合法手セルのクリックでコールバック。
 *
 * フェーズ2: 欠けマスは盤面(VariantId)ごとに違うため、外から欠けマスフラグ表
 * (blockedMask)を受け取って描画する。盤面を切り替えたら setVariant で作り直す。
 */

import {
  type Board,
  type VariantId,
  CELLS,
  BLACK,
  WHITE,
  EMPTY,
  BLOCKED,
  blockedMaskFor,
} from '../engine/types';
import type { MoveEval } from '../engine/search';
import { classifyMoves, formatEvalValue, MIDGAME_DISPLAY_SCALE, type EvalClass } from './evalColor';

/**
 * 複数枚返るときのスタガー(順次)間隔(ms)と上限枚数。
 * 1 枚あたりの反転時間そのものは CSS(.stone.flipping = 240ms)側で定義。
 */
const FLIP_STAGGER_MS = 45;
const FLIP_STAGGER_MAX = 6;

export class BoardView {
  private root: HTMLElement;
  private cells: HTMLElement[] = [];
  private onCellClick: (cell: number) => void;
  private blockedMask: ReadonlyArray<boolean>;
  /** 現在の盤種(評価値の表示スケールを盤ごとに切り替えるため保持)。 */
  private variant: VariantId;
  /**
   * 編集モード(評価値計算の盤面編集)。
   * true の間は合法手判定を無視し、欠けマス以外のどのセルもクリックできる
   * (石の自由配置)。差分アニメも止める(連続ペイントを軽快に保つ)。
   */
  private editing = false;
  /**
   * 直前に描画した盤面(石の反転アニメ用の差分検出)。
   * null = まだ一度も描画していない / グリッドを作り直した直後(=初期描画は無アニメ)。
   */
  private prevBoard: Board | null = null;
  /** アニメ無効(prefers-reduced-motion)。一度だけ判定してキャッシュ。 */
  private readonly reduceMotion: boolean;

  constructor(root: HTMLElement, variant: VariantId, onCellClick: (cell: number) => void) {
    this.root = root;
    this.onCellClick = onCellClick;
    this.variant = variant;
    this.blockedMask = blockedMaskFor(variant);
    this.reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build();
  }

  /** 盤面の種類を切り替えてグリッドを作り直す(欠けマスの位置が変わるため)。 */
  setVariant(variant: VariantId): void {
    this.variant = variant;
    this.blockedMask = blockedMaskFor(variant);
    this.build();
  }

  /**
   * 編集モードの ON/OFF。ON にすると欠けマス以外を自由にクリックできる。
   * モードを切り替えた直後の描画はアニメさせない(差分の基準をリセット)。
   */
  setEditing(on: boolean): void {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    this.prevBoard = null;
  }

  private build(): void {
    this.root.innerHTML = '';
    this.root.classList.add('board');
    this.cells = [];
    // グリッドを作り直したら差分の基準は無し(次の描画はアニメしない)。
    this.prevBoard = null;
    for (let cell = 0; cell < CELLS; cell++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.cell = String(cell);
      if (this.blockedMask[cell]) {
        el.classList.add('blocked');
      } else {
        el.addEventListener('click', () => this.handleClick(cell));
      }
      this.cells.push(el);
      this.root.appendChild(el);
    }
  }

  private handleClick(cell: number): void {
    // 編集モードでは合法手判定を無視(クリックリスナは欠けマス以外にだけ付くので、
    // ここに来る時点で対象は配置可能なセル)。
    if (this.editing) {
      this.onCellClick(cell);
      return;
    }
    // 通常時は合法手のみ反応(legal クラスが付いているセル)。
    if (this.cells[cell].classList.contains('legal')) {
      this.onCellClick(cell);
    }
  }

  /**
   * 盤面を再描画する。
   * @param board 現在の盤面
   * @param legalMoves 合法手のセル一覧(評価待ちでも先にハイライトできる)
   * @param evals 各合法手の評価値(未計算なら null)
   * @param answerCell 「答え合わせ」で薄く示す最善手のマス(対局モード用 / 無ければ null)
   */
  render(
    board: Board,
    legalMoves: number[],
    evals: MoveEval[] | null,
    answerCell: number | null = null,
  ): void {
    const legalSet = new Set(legalMoves);
    const classes: Map<number, EvalClass> = evals ? classifyMoves(evals) : new Map();
    const evalByCell = new Map<number, MoveEval>();
    if (evals) for (const e of evals) evalByCell.set(e.cell, e);

    // 改善2: 前回盤面との差分から「反転した石」「新たに置かれた石」を割り出し、
    // それらにだけ控えめなアニメを当てる(全石の再描画でアニメが暴発しないように)。
    const prev = this.prevBoard;
    const animate = prev !== null && !this.reduceMotion && !this.editing;
    // 反転枚数に応じたスタガー用に、反転セルへ 0,1,2,... の順番を割り当てる。
    const flipOrder = new Map<number, number>();
    if (animate && prev) {
      let n = 0;
      for (let cell = 0; cell < CELLS; cell++) {
        const before = prev[cell];
        const after = board[cell];
        const flipped =
          (before === BLACK && after === WHITE) || (before === WHITE && after === BLACK);
        if (flipped) flipOrder.set(cell, n++);
      }
    }

    for (let cell = 0; cell < CELLS; cell++) {
      const el = this.cells[cell];
      const v = board[cell];

      // クラスをリセット(blocked は保持)。
      const blocked = el.classList.contains('blocked');
      el.className = 'cell' + (blocked ? ' blocked' : '');
      el.textContent = '';
      el.removeAttribute('title');

      // 答え合わせ: 最善手だったマスを薄く示す。空マスのときだけ(相手がそこに
      // 打って石で埋まったら自然に消える / 石の上にリングが重ならない)。
      if (cell === answerCell && v === EMPTY) el.classList.add('answer-hint');

      if (v === BLOCKED) continue;

      if (v === BLACK || v === WHITE) {
        const stone = document.createElement('div');
        stone.className = 'stone ' + (v === BLACK ? 'black' : 'white');
        if (animate && prev) {
          const before = prev[cell];
          if (flipOrder.has(cell)) {
            // 反転(相手色→自色): フリップ + フェード。スタガーで順次。
            stone.classList.add('flipping');
            const order = Math.min(flipOrder.get(cell) ?? 0, FLIP_STAGGER_MAX);
            const delay = order * FLIP_STAGGER_MS;
            if (delay > 0) stone.style.animationDelay = `${delay}ms`;
          } else if (before === EMPTY) {
            // 新規着手(空→石): 軽いスケールイン。
            stone.classList.add('placing');
          }
        }
        el.appendChild(stone);
        continue;
      }

      // EMPTY: 合法手なら評価値オーバーレイ。
      if (legalSet.has(cell)) {
        el.classList.add('legal');
        const ev = evalByCell.get(cell);
        if (ev) {
          const cls = classes.get(cell) ?? 'good';
          el.classList.add('eval-' + cls);
          // 表示だけ盤ごとの表示スケールを掛けて「予測石差」の桁に揃える。
          // (内部値 ev.value は色分け・採点用にそのまま。終盤の確定値は無スケール)
          const shown = ev.exact ? ev.value : ev.value * MIDGAME_DISPLAY_SCALE[this.variant];
          const label = document.createElement('span');
          label.className = 'eval-label';
          label.textContent = formatEvalValue(shown, ev.exact);
          el.appendChild(label);
          el.title = ev.exact
            ? `確定最終石差 ${formatEvalValue(ev.value, true)}`
            : `評価値(目安) ${formatEvalValue(shown, false)}`;
        } else {
          // 評価待ち: ハイライトのみ。
          el.classList.add('eval-pending');
        }
      }
    }

    // 次回の差分用に現在の盤面を控える(コピー)。
    this.prevBoard = board.slice();
  }
}
