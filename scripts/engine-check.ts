/**
 * エンジンの自動検証(ビルドには含めない開発用スクリプト)。
 * 盤面ロジック(初期配置・合法手・反転・欠けマスの壁・パス・終局)と
 * 探索(終盤完全読みの妥当性・対称性)を、既知の性質でチェックする。
 *
 * 実行: esbuild でバンドルして node で走らせる(package には含めず scripts/ 配下)。
 */

import {
  createInitialBoard,
  legalMoves,
  applyMove,
  flippedBy,
  isLegalMove,
  countDiscs,
  countEmpties,
  isGameOver,
  createEmptyBoard,
} from '../src/engine/board';
import {
  BLACK,
  WHITE,
  EMPTY,
  BLOCKED,
  idx,
  isCornerCut,
  CELLS,
  PLAYABLE_CELLS,
} from '../src/engine/types';
import { evaluatePosition } from '../src/engine/search';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('  ✗ FAIL:', name);
  }
}

// --- 1. 盤面の基本構造 -------------------------------------------------------
{
  const b = createEmptyBoard();
  let blocked = 0;
  let empty = 0;
  for (let c = 0; c < CELLS; c++) {
    if (b[c] === BLOCKED) blocked++;
    else if (b[c] === EMPTY) empty++;
  }
  check('欠けマスは16個', blocked === 16);
  check('プレイ可能マスは48個', empty === PLAYABLE_CELLS);
  // 四隅2×2が BLOCKED
  check('左上(0,0)は欠け', b[idx(0, 0)] === BLOCKED);
  check('右下(7,7)は欠け', b[idx(7, 7)] === BLOCKED);
  check('左下(7,0)は欠け', b[idx(7, 0)] === BLOCKED);
  check('右上(0,7)は欠け', b[idx(0, 7)] === BLOCKED);
  check('(2,2)は欠けでない', !isCornerCut(2, 2));
  check('(1,1)は欠け', isCornerCut(1, 1));
}

// --- 2. 初期配置(本ツールは通常オセロと白黒を反転した配置) ------------------
{
  const b = createInitialBoard();
  const { black, white, empty } = countDiscs(b);
  check('初期: 黒2 白2', black === 2 && white === 2);
  check('初期: 空き44', empty === 44);
  // 反転後: 黒=(3,3),(4,4) / 白=(3,4),(4,3)
  check('初期(3,3)=黒', b[idx(3, 3)] === BLACK);
  check('初期(4,4)=黒', b[idx(4, 4)] === BLACK);
  check('初期(3,4)=白', b[idx(3, 4)] === WHITE);
  check('初期(4,3)=白', b[idx(4, 3)] === WHITE);
}

// --- 3. 合法手と反転(白黒反転配置での既知手) --------------------------------
{
  const b = createInitialBoard();
  const blackMoves = legalMoves(b, BLACK).sort((a, c) => a - c);
  // 白黒反転配置(黒 d4/e5・白 d5/e4)での黒の合法手は (2,4)(3,5)(4,2)(5,3)
  const expected = [idx(2, 4), idx(3, 5), idx(4, 2), idx(5, 3)].sort((a, c) => a - c);
  check('初期黒の合法手は4つ', blackMoves.length === 4);
  check('初期黒の合法手が反転配置と一致', JSON.stringify(blackMoves) === JSON.stringify(expected));

  // (2,4) に黒 → (3,4) の白が反転して黒が4個・白が1個
  const after = applyMove(b, idx(2, 4), BLACK)!;
  check('着手後 nullでない', after !== null);
  const c2 = countDiscs(after);
  check('(2,4)着手後 黒4 白1', c2.black === 4 && c2.white === 1);
  check('(3,4)が黒に反転', after[idx(3, 4)] === BLACK);
}

// --- 4. 非合法手 -------------------------------------------------------------
{
  const b = createInitialBoard();
  check('占有マスは非合法', !isLegalMove(b, idx(3, 3), BLACK));
  check('欠けマスは非合法', !isLegalMove(b, idx(0, 0), BLACK));
  check('挟めない空マスは非合法', !isLegalMove(b, idx(2, 2), BLACK));
  check('applyMove 非合法はnull', applyMove(b, idx(2, 2), BLACK) === null);
}

// --- 5. 欠けマスが「壁」として機能する(挟みのラインを遮断) ------------------
{
  // 人工局面: (2,2)黒, (2,3)(2,4)(2,5)白 を置き、(2,2)の左側＝欠け(2,1)で遮断。
  // 黒が (2,6) に打つと (2,3)(2,4)(2,5) を挟んで反転できるはず(右からの挟み)。
  const b = createEmptyBoard();
  b[idx(2, 2)] = BLACK;
  b[idx(2, 3)] = WHITE;
  b[idx(2, 4)] = WHITE;
  b[idx(2, 5)] = WHITE;
  const flips = flippedBy(b, idx(2, 6), BLACK);
  check('壁テスト: (2,6)黒で3枚反転', flips.length === 3);

  // 一方、(2,1) は欠けマスなので置けない=非合法。
  check('壁テスト: 欠け(2,1)は非合法', !isLegalMove(b, idx(2, 1), BLACK));

  // 縦方向で欠けをまたぐ挟みは不成立:
  // (2,2)黒, (3,2)(4,2)(5,2)白 で (6,2) に黒 → 反転できる(これは欠けと無関係)。
  const b2 = createEmptyBoard();
  b2[idx(2, 2)] = BLACK;
  b2[idx(3, 2)] = WHITE;
  b2[idx(4, 2)] = WHITE;
  b2[idx(5, 2)] = WHITE;
  const flips2 = flippedBy(b2, idx(6, 2), BLACK);
  check('縦挟み: (6,2)黒で3枚反転', flips2.length === 3);
}

// --- 6. パス・終局 -----------------------------------------------------------
{
  // ほぼ埋まった終局直前を作るのは手間なので、空盤(石なし)は両者打てない=終局扱い。
  const empty = createEmptyBoard();
  check('石なし盤は終局', isGameOver(empty));
  check('初期盤は終局でない', !isGameOver(createInitialBoard()));
}

// --- 7. 探索: 評価値の符号対称性 ---------------------------------------------
{
  // 初期局面で黒番の評価と、同一局面で白番の評価は、最善手の値の符号がおおむね反転傾向。
  // ここでは「評価が返り、全合法手に値が付く」ことと「中盤モードであること」を確認。
  const b = createInitialBoard();
  const res = evaluatePosition(b, BLACK, { timeLimitMs: 300 });
  check('初期評価: 4手ぶん返る', res.moves.length === 4);
  check('初期評価: 中盤モード', res.endgame === false);
  check('初期評価: 全手に有限値', res.moves.every((m) => Number.isFinite(m.value)));
  check('初期評価: 反復深化で深さ>=1', res.reachedDepth >= 1);
  console.log(
    `  [info] 初期局面 黒番: 深さ${res.reachedDepth}, ${res.nodes}ノード, ${Math.round(res.elapsedMs)}ms`,
  );
  console.log(
    '  [info] 各手:',
    res.moves.map((m) => `${m.cell}:${m.value.toFixed(2)}`).join('  '),
  );
}

// --- 8. 探索: 終盤完全読みの確定性(同一局面で結果が一致) --------------------
{
  // 空きを十分減らした局面を作る: 初期局面からランダムに合法手を進めて
  // 空き <= 16 にし、完全読みが「確定値・exact=true」を返すことを確認。
  let b = createInitialBoard();
  let player: 1 | 2 = BLACK;
  let guard = 0;
  while (countEmpties(b) > 14 && guard < 200) {
    guard++;
    const moves = legalMoves(b, player);
    if (moves.length === 0) {
      // パス
      const opp = player === BLACK ? WHITE : BLACK;
      if (legalMoves(b, opp).length === 0) break; // 終局
      player = opp;
      continue;
    }
    // 決定論的に「最初の合法手」を選ぶ(再現性のため)。
    b = applyMove(b, moves[0], player)!;
    player = player === BLACK ? WHITE : BLACK;
  }
  const empties = countEmpties(b);
  console.log(`  [info] 終盤局面まで進めた: 空き${empties}, 手番${player === BLACK ? '黒' : '白'}`);

  if (!isGameOver(b)) {
    const r1 = evaluatePosition(b, player, { endgameEmpties: 16 });
    check('終盤: 完全読みモード', r1.endgame === true);
    check('終盤: 全手 exact', r1.moves.every((m) => m.exact === true));
    check('終盤: 値は整数(確定石差)', r1.moves.every((m) => Number.isInteger(m.value)));

    // 同一局面で2回呼んでも結論一致(確定性)。
    const r2 = evaluatePosition(b, player, { endgameEmpties: 16 });
    const v1 = r1.moves.map((m) => `${m.cell}:${m.value}`).sort().join(',');
    const v2 = r2.moves.map((m) => `${m.cell}:${m.value}`).sort().join(',');
    check('終盤: 再実行で同一結果(確定性)', v1 === v2);
    console.log(
      `  [info] 終盤完全読み(残り${r1.reachedDepth}): ${r1.nodes}ノード, ${Math.round(r1.elapsedMs)}ms`,
    );
    console.log('  [info] 終盤各手:', v1);
  } else {
    console.log('  [info] 偶然終局に到達したため終盤探索チェックはスキップ');
  }
}

// --- 9. 探索: 終盤完全読みの時間切れフォールバック(QA①の回帰テスト) ----------
{
  // 空き<=16 の終盤局面を作り、timeLimitMs を極小化して
  // 「完全読みが間に合わない」状況を強制する。
  // 修正前: negamax が投げる TimeUp が evaluatePosition を貫通し、Worker→UI が
  //         ハングし得た(QAレポート 問題①)。
  // 修正後: 例外を内部で捕捉し、中盤探索の暫定値へフォールバックして必ず返る。
  //
  // 空き数の目標を 14 にする理由:
  //   後半サブブロックで「時間制限なしなら完全読みが必ず終わる(endgame=true)」を
  //   確認するため、完全読みがデフォルト時間(ENDGAME_TIME_MS=3秒)内に終わる
  //   軽さの局面が必要。空き16はこの決定論的プレイアウトだと約10秒/400万ノード級に
  //   なり3秒で打ち切られてしまう(=正しいフォールバック挙動だが完全読みの確認には
  //   不向き)。空き14なら数十msで読み切れ、かつ timeLimitMs:1 では確実に時間切れ
  //   になるので、フォールバック経路・完全読み経路の両方を1局面で検証できる。
  let b = createInitialBoard();
  let player: 1 | 2 = BLACK;
  let guard = 0;
  while (countEmpties(b) > 14 && guard < 300) {
    guard++;
    const moves = legalMoves(b, player);
    if (moves.length === 0) {
      const opp = player === BLACK ? WHITE : BLACK;
      if (legalMoves(b, opp).length === 0) break;
      player = opp;
      continue;
    }
    b = applyMove(b, moves[0], player)!;
    player = player === BLACK ? WHITE : BLACK;
  }

  if (!isGameOver(b) && countEmpties(b) <= 16) {
    console.log(`  [info] 時間切れテスト: 空き${countEmpties(b)}で timeLimitMs=1 を強制`);
    let threw = false;
    let r: ReturnType<typeof evaluatePosition> | null = null;
    try {
      // 完全読み(endgameEmpties:16)+ 極小 deadline。
      r = evaluatePosition(b, player, { endgameEmpties: 16, timeLimitMs: 1 });
    } catch {
      threw = true;
    }
    check('時間切れ: 例外を貫通させず必ず返る(ハング防止)', threw === false && r !== null);
    if (r) {
      check('時間切れ: 合法手ぶんの結果が返る', r.moves.length > 0);
      check('時間切れ: timedOut フラグが立つ', r.timedOut === true);
      // 完全読みが間に合っていない以上、確定値(exact/endgame)として返してはならない。
      check('時間切れ: 完全読み(endgame)としては返さない', r.endgame === false);
      check('時間切れ: 確定値(exact)として返さない', r.moves.every((m) => m.exact === false));
      check('時間切れ: 全手の評価値が有限', r.moves.every((m) => Number.isFinite(m.value)));
      console.log(
        `  [info] フォールバック結果: 深さ${r.reachedDepth}, ${r.nodes}ノード, ${Math.round(r.elapsedMs)}ms`,
      );
    }
  } else {
    console.log('  [info] 局面準備に失敗したため時間切れテストはスキップ');
  }

  // 念のため: 同じ局面を時間制限なし(=完全読み)で呼べば従来どおり確定値が返る
  // (フォールバック追加で通常動作が壊れていないことの確認)。
  if (!isGameOver(b) && countEmpties(b) <= 16) {
    const full = evaluatePosition(b, player, { endgameEmpties: 16 });
    check('時間制限なし: 通常どおり完全読み(endgame=true)', full.endgame === true);
    check('時間制限なし: timedOut は false', full.timedOut === false);
    check('時間制限なし: 全手 exact', full.moves.every((m) => m.exact === true));
  }
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
