/**
 * ゲーム進行の状態管理(UI 非依存)。
 * - 着手 / パス / 終局の遷移
 * - 履歴(待った=1手戻る)
 * - 現在の手番・盤面の保持
 * - 盤面の種類(VariantId)を保持し、盤面ロジックに必要なレイを供給する
 *
 * 「パス自動処理」「終局表示」のための判定もここに集約する。
 */

import { type Board, type Player, type VariantId, BLACK, opponent } from '../engine/types';
import {
  createInitialBoard,
  cloneBoard,
  applyMove,
  hasLegalMove,
  legalMoves,
  countDiscs,
  isGameOver,
  raysFor,
} from '../engine/board';

/** 履歴 1 ステップ。 */
interface HistoryEntry {
  board: Board;
  player: Player;
}

/** 直前に起きたパスの情報(UI 通知用)。 */
export interface PassInfo {
  passedPlayer: Player;
}

export class GameState {
  private board: Board;
  private current: Player;
  /** 盤面の種類。レイ(壁の手前で打ち切る方向テーブル)を選ぶのに使う。 */
  private readonly variant: VariantId;
  /** この盤面の方向レイ(毎回引かずに保持)。 */
  private readonly rays: number[][][];
  /** 直前の盤面/手番を積むスタック(待った用)。 */
  private history: HistoryEntry[] = [];

  constructor(firstPlayer: Player, variant: VariantId) {
    this.variant = variant;
    this.rays = raysFor(variant);
    this.board = createInitialBoard(variant);
    this.current = firstPlayer;
    this.history = [];
  }

  getVariant(): VariantId {
    return this.variant;
  }

  getBoard(): Board {
    return this.board;
  }

  getCurrentPlayer(): Player {
    return this.current;
  }

  getLegalMoves(): number[] {
    return legalMoves(this.board, this.current, this.rays);
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  isOver(): boolean {
    return isGameOver(this.board, this.rays);
  }

  /** 現在の手番が打てるか。 */
  currentHasMove(): boolean {
    return hasLegalMove(this.board, this.current, this.rays);
  }

  getCounts(): { black: number; white: number; empty: number } {
    return countDiscs(this.board);
  }

  /**
   * 着手を試みる。合法なら盤面を進めて手番交代し true。
   * 非合法なら何もせず false。
   * 注意: 手番交代後のパス自動処理は呼ばない(UI 側が evaluate 前に
   * autoPassIfNeeded を呼ぶ設計)。
   */
  play(cell: number): boolean {
    const next = applyMove(this.board, cell, this.current, this.rays);
    if (!next) return false;
    this.history.push({ board: this.board, player: this.current });
    this.board = next;
    this.current = opponent(this.current);
    return true;
  }

  /**
   * 現在の手番が打てない場合、自動でパスして相手番へ。
   * パスが発生したら PassInfo を返す。打てるなら null。
   * (両者打てない=終局の場合もパスはせず null を返し、isOver() が true になる。)
   */
  autoPassIfNeeded(): PassInfo | null {
    if (this.isOver()) return null;
    if (this.currentHasMove()) return null;
    // 自分は打てないが相手は打てる → パス。
    const passed = this.current;
    this.history.push({ board: this.board, player: this.current });
    this.current = opponent(this.current);
    return { passedPlayer: passed };
  }

  /**
   * 任意の盤面・手番から再開する(盤面編集モード用)。
   * 盤面はコピーして保持し(呼び出し側の編集バッファと分離)、履歴はクリアする
   * (編集後の局面が新たな起点になり、そこより前へは戻せない)。
   */
  loadPosition(board: Board, current: Player): void {
    this.board = cloneBoard(board);
    this.current = current;
    this.history = [];
  }

  /** 1手戻る(待った)。戻せたら true。 */
  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.board = cloneBoard(prev.board);
    this.current = prev.player;
    return true;
  }

  /** 最終結果(終局時)。勝者: BLACK / WHITE / null(引き分け)。 */
  getResult(): { black: number; white: number; winner: Player | null } {
    const { black, white } = this.getCounts();
    let winner: Player | null = null;
    if (black > white) winner = BLACK;
    else if (white > black) winner = opponent(BLACK);
    return { black, white, winner };
  }
}
