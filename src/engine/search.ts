/**
 * 探索エンジン: ネガマックス + αβ枝刈り + move ordering + 置換表 + 反復深化。
 *
 * 公開 API:
 *   evaluatePosition(board, player, options) →
 *     ルート直下の各合法手それぞれの評価値(石差ベース)を返す。
 *
 * 評価値の意味(spec 準拠):
 *   - 石差ベース(+6 = 6石勝ち見込み / -4 = 4石負け見込み)。
 *   - 中盤: 評価関数は無次元スコアなので、表示用に「石差スケール」へ変換する
 *     (DISC_SCALE)。あくまで目安(後で精度調整する箇所)。
 *   - 終盤完全読み: 探索が最後まで読み切れた手は、確定の最終石差(整数)を返す。
 *
 * 各手の評価値 = 「その手を打った後の局面を相手番から探索した値の符号反転」。
 * = ルートで各合法手をそれぞれ negamax 探索(αβ は手ごとに full window で回し、
 *   全手に厳密値を出す。ADR-002: 全手に厳密値が要る場合はルートの枝刈りを弱める)。
 */

import {
  type Board,
  type Player,
  type VariantId,
  BLACK,
  opponent,
} from './types';
import {
  legalMoves,
  flippedBy,
  makeMoveInPlace,
  undoMoveInPlace,
  hasLegalMove,
  countDiscs,
  countEmpties,
  raysFor,
} from './board';
import { evaluateForPlayer, positionWeightsFor } from './evaluate';
import { hashKey } from './zobrist';

// --- 調整用定数(ADR-002 / perf-estimate に基づく暫定値) --------------------

/** 中盤の 1 手あたり思考時間上限(ms)。 */
export const MIDGAME_TIME_MS = 2000;
/** 終盤の 1 手あたり思考時間上限(ms)。 */
export const ENDGAME_TIME_MS = 3000;
/** 終盤完全読みに切り替える空きマス数のしきい値(これ以下で完全読み)。 */
export const ENDGAME_EMPTIES = 16;
/** 反復深化の最大深さ(中盤の安全上限。時間制限が先に効くのが普通)。 */
const MAX_MIDGAME_DEPTH = 12;

/**
 * 中盤評価(無次元スコア)→ 表示用「石差スケール」への変換係数。
 * 評価関数の W_* 係数に対するおおまかな正規化。
 * ⚠️ 後で精度調整する箇所(実測してスケールを合わせる)。
 */
const DISC_SCALE = 1 / 6;

/** 置換表エントリの種別。 */
const enum Flag {
  Exact = 0,
  Lower = 1, // 下界(βカット)
  Upper = 2, // 上界(αで更新されず)
}

interface TTEntry {
  depth: number;
  value: number;
  flag: Flag;
  best: number; // 最善手セル(move ordering 用)。無ければ -1。
}

/** 1 手分の評価結果。 */
export interface MoveEval {
  /** 着手セル(0..63)。 */
  cell: number;
  /** 評価値(石差ベース、表示用に丸め前の数値)。 */
  value: number;
  /** この手が完全読み(確定の最終石差)かどうか。 */
  exact: boolean;
}

/** evaluatePosition の結果。 */
export interface PositionEval {
  /** 手番。 */
  player: Player;
  /** 各合法手の評価値(value 降順)。 */
  moves: MoveEval[];
  /** 完全読みモードだったか。 */
  endgame: boolean;
  /** 反復深化で到達できた探索深さ(中盤時)。完全読み時は残り空き数。 */
  reachedDepth: number;
  /** 実測の探索ノード数(性能計測用)。 */
  nodes: number;
  /** 実測の計算時間(ms)。 */
  elapsedMs: number;
  /**
   * 思考時間上限に達して探索を途中で打ち切ったか。
   * 終盤完全読みが時間内に終わらず、中盤探索へフォールバックした場合も true。
   * このとき moves は完全読みではない(exact=false / endgame=false 扱い)。
   */
  timedOut: boolean;
}

export interface EvalOptions {
  /** 思考時間上限(ms)。未指定なら段階に応じて自動。 */
  timeLimitMs?: number;
  /** 完全読み切替の空きマスしきい値(テスト用に上書き可)。 */
  endgameEmpties?: number;
  /** 盤面の種類。盤面ごとのレイ/マス重みを選ぶ。未指定はクロス盤(従来互換)。 */
  variant?: VariantId;
}

/** 時間切れを伝える例外(反復深化の途中打ち切り用)。 */
class TimeUp extends Error {}

/**
 * ルート局面の全合法手の評価値を計算する(メインの公開関数)。
 * Web Worker から呼ぶ想定だが、純粋ロジックなのでメインスレッドでも動く。
 */
export function evaluatePosition(
  rootBoard: Board,
  player: Player,
  options: EvalOptions = {},
): PositionEval {
  const start = now();
  const board = rootBoard.slice(); // 破壊しないようコピーして使う
  const variant: VariantId = options.variant ?? 'cross';
  const rays = raysFor(variant);
  const weights = positionWeightsFor(variant);
  const empties = countEmpties(board);
  const endgameThreshold = options.endgameEmpties ?? ENDGAME_EMPTIES;
  const isEndgame = empties <= endgameThreshold;

  const timeLimit =
    options.timeLimitMs ??
    (isEndgame ? ENDGAME_TIME_MS : MIDGAME_TIME_MS);
  const deadline = start + timeLimit;

  const moves = legalMoves(board, player, rays);
  const ctx: SearchCtx = {
    board,
    tt: new Map<string, TTEntry>(),
    nodes: 0,
    deadline,
    rays,
    weights,
  };

  // 合法手なし(パス局面)。呼び出し側で扱うが、念のため空で返す。
  if (moves.length === 0) {
    return {
      player,
      moves: [],
      endgame: isEndgame,
      reachedDepth: 0,
      nodes: ctx.nodes,
      elapsedMs: now() - start,
      timedOut: false,
    };
  }

  let result: MoveEval[];
  let reachedDepth: number;
  // 終盤完全読みを時間内に終えられたか。時間切れでフォールバックしたら false。
  let endgameCompleted = isEndgame;
  let timedOut = false;

  if (isEndgame) {
    // --- 終盤完全読み: 残り空き数ぶんの深さで読み切る ---
    // 各手を打った後の局面を相手番から完全読みし、符号反転。
    // 重い局面や低速端末で deadline を超えると negamax が TimeUp を投げる。
    // 完全読みの「途中値」は確定石差ではない(exact=true で返すと誤情報)ため、
    // ここで捕捉し、中盤と同じ反復深化(残り時間で到達できた深さの近似値)へ
    // フォールバックする。これにより呼び出し側へ必ず結果が返り、UI が固まらない。
    try {
      result = rootSearchAllMoves(ctx, player, moves, empties /*=full depth*/, true);
      reachedDepth = empties;
    } catch (e) {
      if (!(e instanceof TimeUp)) throw e;
      // 完全読みが間に合わなかった → 反復深化の近似値にフォールバック。
      // tt は完全読み(depth=MAX_SAFE_INTEGER)エントリが混在し depth ゲートを
      // 乱すため、中盤探索を汚染しないようクリアしてから回す。
      ctx.tt.clear();
      endgameCompleted = false;
      timedOut = true;
      const id = iterativeDeepening(ctx, player, moves);
      result = id.moves;
      reachedDepth = id.depth;
    }
  } else {
    // --- 中盤: 反復深化。時間内に到達できた最深の結果を採用 ---
    const id = iterativeDeepening(ctx, player, moves);
    result = id.moves;
    reachedDepth = id.depth;
    // 反復深化が深さ1すら完了できないほど時間が厳しかった場合も時間切れ扱い。
    timedOut = id.depth === 0;
  }

  // value 降順に並べる(最善手が先頭)。
  result.sort((a, b) => b.value - a.value);

  return {
    player,
    // 完全読みを最後までやり切れた場合のみ endgame(=確定値)とみなす。
    endgame: endgameCompleted,
    moves: result,
    reachedDepth,
    nodes: ctx.nodes,
    elapsedMs: now() - start,
    timedOut,
  };
}

interface SearchCtx {
  board: Board;
  tt: Map<string, TTEntry>;
  nodes: number;
  deadline: number;
  /** この盤面の方向レイ(legalMoves/flippedBy 用)。 */
  rays: number[][][];
  /** この盤面のマス重み(評価・move ordering 用)。 */
  weights: ReadonlyArray<number>;
}

/**
 * 反復深化。深さ 1, 2, 3 … と増やし、時間切れになったら直前の完了結果を返す。
 * 浅い結果は move ordering(前回の最善手を先頭に）にも使う。
 */
function iterativeDeepening(
  ctx: SearchCtx,
  player: Player,
  moves: number[],
): { moves: MoveEval[]; depth: number } {
  let lastCompleted: MoveEval[] = moves.map((cell) => ({ cell, value: 0, exact: false }));
  let completedDepth = 0;

  for (let depth = 1; depth <= MAX_MIDGAME_DEPTH; depth++) {
    try {
      const evals = rootSearchAllMoves(ctx, player, moves, depth, false);
      // 完了 → 採用。次深さの ordering のため value 降順に。
      evals.sort((a, b) => b.value - a.value);
      lastCompleted = evals;
      completedDepth = depth;
      // 並べ替えた順を次の深さの探索順に反映。
      moves = evals.map((e) => e.cell);
    } catch (e) {
      if (e instanceof TimeUp) break;
      throw e;
    }
    // 既に時間ギリギリなら次の深さには入らない。
    if (now() >= ctx.deadline) break;
  }

  return { moves: lastCompleted, depth: completedDepth };
}

/**
 * ルート直下の各合法手を個別に評価する。
 * 各手: 適用 → 相手番から negamax(depth-1 or 完全読み) → 符号反転。
 * full window (-∞, +∞) で各手を回すので、全手に厳密値が出る(ADR-002)。
 */
function rootSearchAllMoves(
  ctx: SearchCtx,
  player: Player,
  moves: number[],
  depth: number,
  endgame: boolean,
): MoveEval[] {
  const opp = opponent(player);
  const out: MoveEval[] = [];

  for (let i = 0; i < moves.length; i++) {
    const cell = moves[i];
    const flips = flippedBy(ctx.board, cell, player, ctx.rays);
    makeMoveInPlace(ctx.board, cell, player, flips);

    // 相手番から見た値 → 符号反転で player から見た値。
    const childValue = negamax(
      ctx,
      opp,
      endgame ? Number.MAX_SAFE_INTEGER : depth - 1,
      -Infinity,
      Infinity,
      endgame,
    );
    const value = -childValue;

    undoMoveInPlace(ctx.board, cell, player, flips);

    out.push({
      cell,
      value: endgame ? value : value * DISC_SCALE,
      exact: endgame,
    });
  }

  return out;
}

/**
 * ネガマックス + αβ + 置換表。
 * player から見た手番の局面の評価値を返す。
 * endgame=true のときは深さ無視で「空きが尽きるまで」読み切り、最終石差を返す。
 */
function negamax(
  ctx: SearchCtx,
  player: Player,
  depth: number,
  alpha: number,
  beta: number,
  endgame: boolean,
): number {
  // 時間チェック(終盤の読み切りは原則最後まで行くが、安全弁として deadline も見る)。
  ctx.nodes++;
  if ((ctx.nodes & 0x3ff) === 0 && now() >= ctx.deadline) {
    throw new TimeUp();
  }

  const opp = opponent(player);

  // 葉条件: 中盤は深さ0、終盤は空きが尽きる(=どちらも打てない)まで。
  if (!endgame && depth <= 0) {
    return evaluateForPlayer(ctx.board, player, ctx.rays, ctx.weights);
  }

  // 置換表参照。
  const key = hashKey(ctx.board, player);
  const tt = ctx.tt.get(key);
  let ttBest = -1;
  if (tt && tt.depth >= depth) {
    if (tt.flag === Flag.Exact) return tt.value;
    if (tt.flag === Flag.Lower && tt.value > alpha) alpha = tt.value;
    else if (tt.flag === Flag.Upper && tt.value < beta) beta = tt.value;
    if (alpha >= beta) return tt.value;
  }
  if (tt) ttBest = tt.best;

  const moves = legalMoves(ctx.board, player, ctx.rays);

  // パス処理: 自分が打てない場合。
  if (moves.length === 0) {
    if (!hasLegalMove(ctx.board, opp, ctx.rays)) {
      // 両者打てない = 終局 → 最終石差を player 視点で返す。
      return finalScoreFor(ctx.board, player);
    }
    // パスして相手番へ(深さは消費しない方が自然だが、中盤は1段消費して停止性を確保)。
    const passValue = -negamax(
      ctx,
      opp,
      endgame ? depth : depth - 1,
      -beta,
      -alpha,
      endgame,
    );
    return passValue;
  }

  // move ordering: 置換表の最善手 → マス重み的な簡易順序。
  orderMoves(moves, ttBest, ctx.weights);

  const origAlpha = alpha;
  let best = -Infinity;
  let bestMove = -1;

  for (let i = 0; i < moves.length; i++) {
    const cell = moves[i];
    const flips = flippedBy(ctx.board, cell, player, ctx.rays);
    makeMoveInPlace(ctx.board, cell, player, flips);
    const value = -negamax(
      ctx,
      opp,
      endgame ? depth : depth - 1,
      -beta,
      -alpha,
      endgame,
    );
    undoMoveInPlace(ctx.board, cell, player, flips);

    if (value > best) {
      best = value;
      bestMove = cell;
    }
    if (value > alpha) alpha = value;
    if (alpha >= beta) break; // βカット
  }

  // 置換表へ格納。
  let flag: Flag;
  if (best <= origAlpha) flag = Flag.Upper;
  else if (best >= beta) flag = Flag.Lower;
  else flag = Flag.Exact;
  storeTT(ctx, key, depth, best, flag, bestMove);

  return best;
}

/**
 * 終局(または完全読みの末端)での最終石差を player 視点で返す。
 * 石差をそのまま値にする(+ なら player の勝ち)。
 * 完全読みでは中間ノードでもこの値が backup される(αβ で正しく比較される)。
 */
function finalScoreFor(board: Board, player: Player): number {
  const score = discDiffFor(board, player);
  // 完全読みの値域を中盤評価と分離するため WIN_BASE は使わず、
  // 石差そのもの(±64)を返す。勝敗の符号と大小がそのまま意味を持つ。
  return score;
}

/** player 視点の石差(自分の石数 - 相手の石数)。空きは勝者に加算しない素の石差。 */
function discDiffFor(board: Board, player: Player): number {
  const { black, white } = countDiscs(board);
  const diff = black - white;
  return player === BLACK ? diff : -diff;
}

/**
 * move ordering: ttBest を先頭に、その後はマス重みの高い順の簡易ヒューリスティック。
 * 盤面ごとのマス重み(positionWeightsFor)をそのまま流用する。
 */
function orderMoves(moves: number[], ttBest: number, weights: ReadonlyArray<number>): void {
  if (ttBest >= 0) {
    const i = moves.indexOf(ttBest);
    if (i > 0) {
      // ttBest を先頭へ。
      const t = moves[i];
      moves[i] = moves[0];
      moves[0] = t;
    }
  }
  // 残り(先頭の ttBest 以外)をマス重み降順で安定ソート。
  const startIdx = ttBest >= 0 && moves[0] === ttBest ? 1 : 0;
  if (moves.length - startIdx > 1) {
    const rest = moves.slice(startIdx);
    rest.sort((a, b) => weights[b] - weights[a]);
    for (let i = 0; i < rest.length; i++) moves[startIdx + i] = rest[i];
  }
}

const TT_MAX = 200000; // 置換表の上限(メモリ暴走防止)。
function storeTT(ctx: SearchCtx, key: string, depth: number, value: number, flag: Flag, best: number): void {
  if (ctx.tt.size >= TT_MAX) {
    // 単純戦略: 上限到達でクリア(LRU 等は MVP では省略)。
    ctx.tt.clear();
  }
  ctx.tt.set(key, { depth, value, flag, best });
}

/** パフォーマンス計時(Worker/メイン両対応)。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
