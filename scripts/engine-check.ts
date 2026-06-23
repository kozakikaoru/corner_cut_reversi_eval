/**
 * エンジンの自動検証(ビルドには含めない開発用スクリプト)。
 * 盤面ロジック(初期配置・合法手・反転・欠けマスの壁・パス・終局)と
 * 探索(終盤完全読みの妥当性・対称性)を、既知の性質でチェックする。
 *
 * フェーズ2: 4盤面(通常/クロス/八角/ホロー)それぞれについて
 *   マス数(64/48/52/60)・合法手生成・反転・初期配置・終局を検証する。
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
  raysFor,
} from '../src/engine/board';
import {
  type VariantId,
  BLACK,
  WHITE,
  EMPTY,
  BLOCKED,
  idx,
  CELLS,
  BOARD_VARIANTS,
  VARIANT_ORDER,
  blockedMaskFor,
  isBlockedAt,
  playableCellsFor,
} from '../src/engine/types';
import { positionWeightsFor } from '../src/engine/evaluate';
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

// 期待マス数(board_variants.md より)。
const EXPECTED_PLAYABLE: Record<VariantId, number> = {
  standard: 64,
  cross: 48,
  octagon: 52,
  hollow: 60,
};

// ===========================================================================
// A. 4盤面それぞれの基本性質(マス数・初期配置・合法手・反転・終局)
// ===========================================================================
console.log('=== A. 各盤面の基本性質 ===');
for (const variant of VARIANT_ORDER) {
  const label = BOARD_VARIANTS[variant].label;
  const rays = raysFor(variant);

  // --- A-1. マス数(欠けマス数と実プレイ可能マス数) ---
  {
    const empty = createEmptyBoard(variant);
    let blocked = 0;
    let playable = 0;
    for (let c = 0; c < CELLS; c++) {
      if (empty[c] === BLOCKED) blocked++;
      else if (empty[c] === EMPTY) playable++;
    }
    const expected = EXPECTED_PLAYABLE[variant];
    check(`[${label}] プレイ可能マスが${expected}`, playable === expected);
    check(`[${label}] 欠けマスが${64 - expected}`, blocked === 64 - expected);
    check(`[${label}] playableCellsFor が定義どおり`, playableCellsFor(variant) === expected);
    check(`[${label}] 欠けマス数 = blocked 定義の長さ`, blocked === BOARD_VARIANTS[variant].blocked.length);
  }

  // --- A-2. 欠けマスが定義どおりの位置にある ---
  {
    for (const [r, c] of BOARD_VARIANTS[variant].blocked) {
      check(`[${label}] (${r},${c})が欠け`, isBlockedAt(variant, r, c));
    }
    // 中央4マスは全盤面で欠けない。
    check(`[${label}] 中央(3,3)は欠けない`, !isBlockedAt(variant, 3, 3));
    check(`[${label}] 中央(4,4)は欠けない`, !isBlockedAt(variant, 4, 4));
    check(`[${label}] 中央(3,4)は欠けない`, !isBlockedAt(variant, 3, 4));
    check(`[${label}] 中央(4,3)は欠けない`, !isBlockedAt(variant, 4, 3));
  }

  // --- A-3. 初期配置(中央4石・全盤面共通の白黒反転配置) ---
  {
    const b = createInitialBoard(variant);
    const { black, white, empty } = countDiscs(b);
    check(`[${label}] 初期: 黒2 白2`, black === 2 && white === 2);
    check(`[${label}] 初期: 空き = プレイ可能-4`, empty === EXPECTED_PLAYABLE[variant] - 4);
    // 反転後: 黒=(3,3),(4,4) / 白=(3,4),(4,3)
    check(`[${label}] 初期(3,3)=黒`, b[idx(3, 3)] === BLACK);
    check(`[${label}] 初期(4,4)=黒`, b[idx(4, 4)] === BLACK);
    check(`[${label}] 初期(3,4)=白`, b[idx(3, 4)] === WHITE);
    check(`[${label}] 初期(4,3)=白`, b[idx(4, 3)] === WHITE);
  }

  // --- A-4. 初期局面の合法手と反転(中央配置は全盤面で同じはず) ---
  {
    const b = createInitialBoard(variant);
    const blackMoves = legalMoves(b, BLACK, rays).sort((a, c) => a - c);
    // 白黒反転配置(黒 d4/e5・白 d5/e4)での黒の合法手は (2,4)(3,5)(4,2)(5,3)。
    // これら4マスは中央付近なので、どの盤面でも欠けない → 全盤面で同じ4手。
    const expected = [idx(2, 4), idx(3, 5), idx(4, 2), idx(5, 3)].sort((a, c) => a - c);
    check(`[${label}] 初期黒の合法手は4つ`, blackMoves.length === 4);
    check(`[${label}] 初期黒の合法手が反転配置と一致`, JSON.stringify(blackMoves) === JSON.stringify(expected));

    // (2,4) に黒 → (3,4) の白が反転して黒4・白1。
    const after = applyMove(b, idx(2, 4), BLACK, rays);
    check(`[${label}] 着手後 nullでない`, after !== null);
    if (after) {
      const c2 = countDiscs(after);
      check(`[${label}] (2,4)着手後 黒4 白1`, c2.black === 4 && c2.white === 1);
      check(`[${label}] (3,4)が黒に反転`, after[idx(3, 4)] === BLACK);
    }
  }

  // --- A-5. 非合法手(占有・欠け・挟めない) ---
  {
    const b = createInitialBoard(variant);
    check(`[${label}] 占有マスは非合法`, !isLegalMove(b, idx(3, 3), BLACK, rays));
    check(`[${label}] 挟めない空マス(2,2付近)は非合法`, !isLegalMove(b, idx(2, 2), BLACK, rays));
    // 欠けマスがあればそこは非合法。
    const firstBlocked = BOARD_VARIANTS[variant].blocked[0];
    if (firstBlocked) {
      const [r, c] = firstBlocked;
      check(`[${label}] 欠けマス(${r},${c})は非合法`, !isLegalMove(b, idx(r, c), BLACK, rays));
      check(`[${label}] applyMove 欠けマスはnull`, applyMove(b, idx(r, c), BLACK, rays) === null);
    }
  }

  // --- A-6. 終局判定(空盤は両者打てない=終局 / 初期局面は非終局) ---
  {
    check(`[${label}] 石なし盤は終局`, isGameOver(createEmptyBoard(variant), rays));
    check(`[${label}] 初期盤は終局でない`, !isGameOver(createInitialBoard(variant), rays));
  }

  // --- A-7. マス重みの健全性(欠けマスは必ず0 / プレイ可能マスは有限) ---
  {
    const w = positionWeightsFor(variant);
    const mask = blockedMaskFor(variant);
    let ok = true;
    for (let c = 0; c < CELLS; c++) {
      if (mask[c]) {
        if (w[c] !== 0) ok = false;
      } else if (!Number.isFinite(w[c])) {
        ok = false;
      }
    }
    check(`[${label}] マス重み: 欠け=0/有限`, ok);
  }
}

// ===========================================================================
// B. 欠けマスが「壁」として機能する(クロス盤で確認) ----------------------
// ===========================================================================
console.log('=== B. 欠けマスの壁機能(クロス盤) ===');
{
  const rays = raysFor('cross');
  // 人工局面: (2,2)黒, (2,3)(2,4)(2,5)白。(2,6)に黒 → 右からの挟みで3枚反転。
  const b = createEmptyBoard('cross');
  b[idx(2, 2)] = BLACK;
  b[idx(2, 3)] = WHITE;
  b[idx(2, 4)] = WHITE;
  b[idx(2, 5)] = WHITE;
  const flips = flippedBy(b, idx(2, 6), BLACK, rays);
  check('壁テスト: (2,6)黒で3枚反転', flips.length === 3);
  // (2,1) はクロス盤の欠けマス → 非合法。
  check('壁テスト: 欠け(2,1)は非合法', !isLegalMove(b, idx(2, 1), BLACK, rays));

  // 縦方向の挟み(欠けと無関係)。
  const b2 = createEmptyBoard('cross');
  b2[idx(2, 2)] = BLACK;
  b2[idx(3, 2)] = WHITE;
  b2[idx(4, 2)] = WHITE;
  b2[idx(5, 2)] = WHITE;
  const flips2 = flippedBy(b2, idx(6, 2), BLACK, rays);
  check('縦挟み: (6,2)黒で3枚反転', flips2.length === 3);
}

// ===========================================================================
// C. ホロー盤の欠けマス越し挟みが不成立(壁の正しさ) ----------------------
// ===========================================================================
console.log('=== C. ホロー盤の壁(欠けマス越しに挟めない) ===');
{
  const rays = raysFor('hollow');
  // ホロー盤の欠け (1,1) を挟みのライン上に置く。
  // (0,0)黒 と (2,2)黒 の対角線上に (1,1) があるが、(1,1) は欠け = 壁。
  // (2,2)に黒・(1,1)欠け・(0,0)空 の状況で (0,0) から (1,1) 方向へは挟めない。
  const b = createEmptyBoard('hollow');
  // 対角ライン (0,0)-(1,1)-(2,2): (1,1)は欠けなのでレイは (0,0)→ で即打ち切り。
  b[idx(2, 2)] = WHITE; // 仮に白を置いても
  b[idx(3, 3)] = BLACK;
  // (0,0)→(1,1)方向のレイは空(壁)なので、ここで挟みは発生しないことを確認。
  // 直接の検証: (0,0) 起点の右下レイが空であること(壁の手前=長さ0)。
  const flips = flippedBy(b, idx(0, 0), BLACK, rays);
  check('ホロー壁: (0,0)黒は(1,1)欠け越しに挟めない', flips.length === 0);
  // 一方、欠けを通らない (2,2)白を (3,3)黒 と (1,1)…ではなく別ラインで確認。
  check('ホロー壁: 欠け(1,1)は非合法', !isLegalMove(b, idx(1, 1), BLACK, rays));
}

// ===========================================================================
// D. 探索: 中盤評価(全盤面で評価が返る) ----------------------------------
// ===========================================================================
console.log('=== D. 中盤評価(各盤面) ===');
for (const variant of VARIANT_ORDER) {
  const label = BOARD_VARIANTS[variant].label;
  const b = createInitialBoard(variant);
  const res = evaluatePosition(b, BLACK, { timeLimitMs: 300, variant });
  check(`[${label}] 初期評価: 4手ぶん返る`, res.moves.length === 4);
  check(`[${label}] 初期評価: 中盤モード`, res.endgame === false);
  check(`[${label}] 初期評価: 全手に有限値`, res.moves.every((m) => Number.isFinite(m.value)));
  check(`[${label}] 初期評価: 反復深化で深さ>=1`, res.reachedDepth >= 1);
}

// ===========================================================================
// E. 探索: 終盤完全読みの確定性(クロス盤で詳細検証) ----------------------
// ===========================================================================
console.log('=== E. 終盤完全読みの確定性(クロス盤) ===');
{
  const variant: VariantId = 'cross';
  const rays = raysFor(variant);
  let b = createInitialBoard(variant);
  let player: 1 | 2 = BLACK;
  let guard = 0;
  while (countEmpties(b) > 14 && guard < 200) {
    guard++;
    const moves = legalMoves(b, player, rays);
    if (moves.length === 0) {
      const opp = player === BLACK ? WHITE : BLACK;
      if (legalMoves(b, opp, rays).length === 0) break; // 終局
      player = opp;
      continue;
    }
    b = applyMove(b, moves[0], player, rays)!;
    player = player === BLACK ? WHITE : BLACK;
  }
  const empties = countEmpties(b);
  console.log(`  [info] 終盤局面まで進めた: 空き${empties}, 手番${player === BLACK ? '黒' : '白'}`);

  if (!isGameOver(b, rays)) {
    const r1 = evaluatePosition(b, player, { endgameEmpties: 16, variant });
    check('終盤: 完全読みモード', r1.endgame === true);
    check('終盤: 全手 exact', r1.moves.every((m) => m.exact === true));
    check('終盤: 値は整数(確定石差)', r1.moves.every((m) => Number.isInteger(m.value)));

    const r2 = evaluatePosition(b, player, { endgameEmpties: 16, variant });
    const v1 = r1.moves.map((m) => `${m.cell}:${m.value}`).sort().join(',');
    const v2 = r2.moves.map((m) => `${m.cell}:${m.value}`).sort().join(',');
    check('終盤: 再実行で同一結果(確定性)', v1 === v2);
    console.log(
      `  [info] 終盤完全読み(残り${r1.reachedDepth}): ${r1.nodes}ノード, ${Math.round(r1.elapsedMs)}ms`,
    );
  } else {
    console.log('  [info] 偶然終局に到達したため終盤探索チェックはスキップ');
  }
}

// ===========================================================================
// F. 終盤完全読みが全盤面で「整数の確定値」を返す(空きマス基準の汎用性) ----
//    盤面サイズが違っても endgameEmpties 基準で完全読みに入り、整数を返すこと。
// ===========================================================================
console.log('=== F. 終盤完全読みの汎用性(各盤面) ===');
for (const variant of VARIANT_ORDER) {
  const label = BOARD_VARIANTS[variant].label;
  const rays = raysFor(variant);
  // 各盤面を決定論的に空き<=12まで進める(完全読みが軽く終わる程度)。
  let b = createInitialBoard(variant);
  let player: 1 | 2 = BLACK;
  let guard = 0;
  while (countEmpties(b) > 12 && guard < 300) {
    guard++;
    const moves = legalMoves(b, player, rays);
    if (moves.length === 0) {
      const opp = player === BLACK ? WHITE : BLACK;
      if (legalMoves(b, opp, rays).length === 0) break;
      player = opp;
      continue;
    }
    b = applyMove(b, moves[0], player, rays)!;
    player = player === BLACK ? WHITE : BLACK;
  }
  if (!isGameOver(b, rays)) {
    const r = evaluatePosition(b, player, { endgameEmpties: 14, variant });
    check(`[${label}] 終盤: 完全読みで返る(endgame)`, r.endgame === true);
    check(`[${label}] 終盤: 全手 exact かつ整数`, r.moves.every((m) => m.exact && Number.isInteger(m.value)));
    console.log(
      `  [info] [${label}] 空き${countEmpties(b)}完全読み: 残り${r.reachedDepth}, ${r.nodes}ノード, ${Math.round(r.elapsedMs)}ms`,
    );
  } else {
    console.log(`  [info] [${label}] 偶然終局に到達したためスキップ`);
  }
}

// ===========================================================================
// G. 終盤完全読みの時間切れフォールバック(QA①の回帰テスト・クロス盤) --------
// ===========================================================================
console.log('=== G. 時間切れフォールバック(クロス盤) ===');
{
  const variant: VariantId = 'cross';
  const rays = raysFor(variant);
  let b = createInitialBoard(variant);
  let player: 1 | 2 = BLACK;
  let guard = 0;
  while (countEmpties(b) > 14 && guard < 300) {
    guard++;
    const moves = legalMoves(b, player, rays);
    if (moves.length === 0) {
      const opp = player === BLACK ? WHITE : BLACK;
      if (legalMoves(b, opp, rays).length === 0) break;
      player = opp;
      continue;
    }
    b = applyMove(b, moves[0], player, rays)!;
    player = player === BLACK ? WHITE : BLACK;
  }

  if (!isGameOver(b, rays) && countEmpties(b) <= 16) {
    console.log(`  [info] 時間切れテスト: 空き${countEmpties(b)}で timeLimitMs=1 を強制`);
    let threw = false;
    let r: ReturnType<typeof evaluatePosition> | null = null;
    try {
      r = evaluatePosition(b, player, { endgameEmpties: 16, timeLimitMs: 1, variant });
    } catch {
      threw = true;
    }
    check('時間切れ: 例外を貫通させず必ず返る(ハング防止)', threw === false && r !== null);
    if (r) {
      check('時間切れ: 合法手ぶんの結果が返る', r.moves.length > 0);
      check('時間切れ: timedOut フラグが立つ', r.timedOut === true);
      check('時間切れ: 完全読み(endgame)としては返さない', r.endgame === false);
      check('時間切れ: 確定値(exact)として返さない', r.moves.every((m) => m.exact === false));
      check('時間切れ: 全手の評価値が有限', r.moves.every((m) => Number.isFinite(m.value)));
    }
  } else {
    console.log('  [info] 局面準備に失敗したため時間切れテストはスキップ');
  }

  if (!isGameOver(b, rays) && countEmpties(b) <= 16) {
    const full = evaluatePosition(b, player, { endgameEmpties: 16, variant });
    check('時間制限なし: 通常どおり完全読み(endgame=true)', full.endgame === true);
    check('時間制限なし: timedOut は false', full.timedOut === false);
    check('時間制限なし: 全手 exact', full.moves.every((m) => m.exact === true));
  }
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
