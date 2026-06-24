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
import type { MoveEval } from '../src/engine/search';
import { AI_LEVELS, aiLevelById, chooseAiMove } from '../src/game/ai';
import { judgeMove, summarizePlay, rankForScore } from '../src/game/scoring';
import { GOOD_THRESHOLD } from '../src/ui/evalColor';

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

// ===========================================================================
// H. 対局 AI のレベル定義 / 着手選択(フェーズ3) --------------------------
//    決定論的な乱数(rng)を注入して挙動を検証する。
// ===========================================================================
console.log('=== H. 対局AI(6段階・着手選択) ===');
{
  // H-1. レベル定義の健全性: 5 段階(初級/中級/上級/超級/バーサーカー)/ バーサーカーは特別・最善厳守。
  check('AI: レベルは5段階', AI_LEVELS.length === 5);
  check('AI: バーサーカーが1つだけ special', AI_LEVELS.filter((l) => l.special).length === 1);
  const berserker = aiLevelById('berserker');
  check('AI: バーサーカーは最善厳守(mistakeRate=0)', berserker.mistakeRate === 0);
  check('AI: バーサーカーは full 評価・終盤完全読みあり', berserker.evalMode === 'full' && berserker.endgameEmpties >= 16);

  // H-2. 強さの単調性: ミス率は単調減少 / 終盤完全読みしきい値は単調非減少 / 弱レベルの読み深さは単調増加。
  {
    let mistakeMonotonic = true;
    let endgameMonotonic = true;
    for (let i = 1; i < AI_LEVELS.length; i++) {
      if (!(AI_LEVELS[i].mistakeRate <= AI_LEVELS[i - 1].mistakeRate)) mistakeMonotonic = false;
      if (!(AI_LEVELS[i].endgameEmpties >= AI_LEVELS[i - 1].endgameEmpties)) endgameMonotonic = false;
    }
    check('AI: mistakeRate が単調減少(弱→強)', mistakeMonotonic);
    check('AI: endgameEmpties が単調非減少(弱→強)', endgameMonotonic);
    // Lv1〜5(非special)は固定読み深さ maxDepth が単調非減少(弱いほど浅い)。
    // バーサーカーは時間制で深さ無制限。同じ深さでも評価モード(greedy→full)で強さ差をつける。
    const nonSpecial = AI_LEVELS.filter((l) => !l.special);
    let depthMonotonic = true;
    for (let i = 1; i < nonSpecial.length; i++) {
      if (!((nonSpecial[i].maxDepth ?? 0) >= (nonSpecial[i - 1].maxDepth ?? 0))) depthMonotonic = false;
    }
    check('AI: 非special(初級〜超級)の読み深さが単調非減少', depthMonotonic);
    check('AI: 初級〜上級は終盤完全読みOFF', aiLevelById(1).endgameEmpties === 0 && aiLevelById(2).endgameEmpties === 0 && aiLevelById(3).endgameEmpties === 0);
    check('AI: 最弱(初級)は枚数貪欲・中級以上は精度評価', aiLevelById(1).evalMode === 'greedy' && aiLevelById(2).evalMode === 'full');
  }

  // H-3. 着手選択: テスト用の手集合(value 降順が明確)。
  const sample: MoveEval[] = [
    { cell: 10, value: 8, exact: false }, // 最善
    { cell: 20, value: 5, exact: false },
    { cell: 30, value: 2, exact: false },
    { cell: 40, value: -3, exact: false },
    { cell: 50, value: -9, exact: false }, // 最悪
  ];

  // 最善厳守(バーサーカー): rng がどうでも最善(cell=10)。
  check('AI: バーサーカーは常に最善を選ぶ', chooseAiMove(sample, berserker, () => 0.999) === 10);
  check('AI: バーサーカーは rng=0 でも最善', chooseAiMove(sample, berserker, () => 0) === 10);

  // 弱レベル(Lv1): rng>=mistakeRate なら最善、rng<mistakeRate なら候補から。
  const lv1 = aiLevelById(1);
  const lv3 = aiLevelById(3);
  check('AI: Lv1 も rng が大きければ最善', chooseAiMove(sample, lv1, () => 0.999) === 10);
  // Lv1 は pickFrom='all' → ミス時は全合法手が対象(最悪手も出うる=初心者の暴発)。
  // chooseAiMove は rng を2回使う: 1回目=ミス判定, 2回目=候補内 index。
  check('AI: Lv1 はミス時に全手対象(最悪手も出うる)', (() => {
    let calls = 0;
    const rng = () => (calls++ === 0 ? 0 : 0.999); // 1回目0(ミス発火), 2回目ほぼ1(候補末尾)
    return chooseAiMove(sample, lv1, rng) === 50; // 全5手の末尾 = 最悪手 cell 50
  })());
  // Lv3 は pickFrom='topK' → ミス時も上位手のみ。最悪手(cell 50)は選ばない。
  check('AI: Lv3 はミス時も上位手のみ(最悪手を選ばない)', (() => {
    let calls = 0;
    const rng = () => (calls++ === 0 ? 0 : 0.999); // ミス発火 + 候補末尾
    const picked = chooseAiMove(sample, lv3, rng);
    const topK = Math.max(2, Math.min(lv3.topK, sample.length));
    const allowed = sample.slice().sort((a, b) => b.value - a.value).slice(0, topK).map((m) => m.cell);
    return allowed.includes(picked) && picked !== 50;
  })());

  // 1手しかなければ必ずその手。
  check('AI: 合法手1つなら必ずそれ', chooseAiMove([{ cell: 42, value: 0, exact: false }], lv1, () => 0) === 42);
  check('AI: 空なら -1', chooseAiMove([], lv1, () => 0) === -1);

  // 統計的: Lv1 は最善以外を選ぶ頻度が高い / バーサーカーは 0。
  {
    let r = 12345;
    const seeded = () => {
      // 線形合同法(決定論)。
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      return r / 0x7fffffff;
    };
    let lv1NonBest = 0;
    let berserkerNonBest = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      if (chooseAiMove(sample, lv1, seeded) !== 10) lv1NonBest++;
      if (chooseAiMove(sample, berserker, seeded) !== 10) berserkerNonBest++;
    }
    check('AI: Lv1 は最善を外す頻度が高い(>20%)', lv1NonBest / N > 0.2);
    check('AI: バーサーカーは最善を外さない(0回)', berserkerNonBest === 0);
    console.log(`  [info] Lv1 非最善率=${Math.round((lv1NonBest / N) * 100)}% / バーサーカー非最善率=${Math.round((berserkerNonBest / N) * 100)}%`);
  }
}

// ===========================================================================
// I. 採点ロジック(着手判定 / 最終プレイ採点)(フェーズ3) ----------------
// ===========================================================================
console.log('=== I. 採点(着手判定・プレイ採点) ===');
{
  const evals: MoveEval[] = [
    { cell: 10, value: 8, exact: false }, // 最善
    { cell: 20, value: 8 - GOOD_THRESHOLD, exact: false }, // ちょうど善手の境界
    { cell: 30, value: 8 - GOOD_THRESHOLD - 0.5, exact: false }, // 悪手
    { cell: 40, value: -2, exact: false }, // 悪手
  ];

  // I-1. 着手判定(perfect / good / bad)。
  check('採点: 最善手=perfect', judgeMove(evals, 10).kind === 'perfect');
  check('採点: 境界内=good', judgeMove(evals, 20).kind === 'good');
  check('採点: 境界外=bad', judgeMove(evals, 30).kind === 'bad');
  check('採点: 大きく劣る=bad', judgeMove(evals, 40).kind === 'bad');
  // ロスの値。
  check('採点: perfect の loss=0', judgeMove(evals, 10).loss === 0);
  check('採点: good の loss=GOOD_THRESHOLD', Math.abs(judgeMove(evals, 20).loss - GOOD_THRESHOLD) < 1e-9);
  check('採点: bad の loss>GOOD_THRESHOLD', judgeMove(evals, 30).loss > GOOD_THRESHOLD);
  // 含まれない手・空でも壊れない。
  check('採点: 未知cellでも例外なく返る', judgeMove(evals, 99).kind !== undefined);
  check('採点: 空evalsでも neutral', judgeMove([], 10).kind === 'good');
  // legalCount は合法手数(= evals.length)。
  check('採点: legalCount=合法手数', judgeMove(evals, 10).legalCount === 4);
  check('採点: 空evalsの legalCount=0', judgeMove([], 10).legalCount === 0);

  // I-2. 最終プレイ採点の集計。
  {
    const allPerfect = summarizePlay([
      judgeMove(evals, 10), judgeMove(evals, 10), judgeMove(evals, 10),
    ]);
    check('採点: 全perfectで一致率100%', allPerfect.bestMatchRate === 100);
    check('採点: 全perfectで平均ロス0', allPerfect.averageLoss === 0);
    check('採点: 全perfectで総合100点', allPerfect.totalScore === 100);
    check('採点: 全perfectでランクS', allPerfect.rank === 'S');

    const allBad = summarizePlay([
      judgeMove(evals, 40), judgeMove(evals, 40), judgeMove(evals, 40),
    ]);
    check('採点: 全badで一致率0%', allBad.bestMatchRate === 0);
    check('採点: 全badは総合<全perfect', allBad.totalScore < allPerfect.totalScore);
    check('採点: スコアは0..100に収まる', allBad.totalScore >= 0 && allBad.totalScore <= 100);

    const mixed = summarizePlay([
      judgeMove(evals, 10), judgeMove(evals, 20), judgeMove(evals, 30), judgeMove(evals, 40),
    ]);
    check('採点: 混在で内訳が合う(P1/G1/B2)', mixed.perfectCount === 1 && mixed.goodCount === 1 && mixed.badCount === 2);
    check('採点: 混在で総手数=4', mixed.totalMoves === 4);
    check('採点: 混在スコアは中間(0<score<100)', mixed.totalScore > 0 && mixed.totalScore < 100);

    // 空(着手なし)。
    const none = summarizePlay([]);
    check('採点: 着手0件はランクD・0点', none.totalScore === 0 && none.rank === 'D' && none.totalMoves === 0);
  }

  // I-4. 改善3: 強制手(合法手1個)の除外 と 選択肢の多さによる重み付け。
  {
    // ヘルパ: 任意の legalCount・kind の MoveScore を直接組み立てる
    //(judgeMove 経由だと evals を毎回作る必要があるため、集計ロジックの検証は手組みで)。
    const mk = (kind: 'perfect' | 'good' | 'bad', legalCount: number, loss = kind === 'perfect' ? 0 : kind === 'good' ? 1 : 4): MoveScore => ({
      kind,
      bestValue: 8,
      chosenValue: 8 - loss,
      loss,
      legalCount,
    });

    // --- 強制手の除外 ---
    // 合法手1個の局面は、たとえ「最善(=唯一手)」でも採点に含めない。
    const forcedOnly = summarizePlay([mk('perfect', 1), mk('perfect', 1)]);
    check('採点(改善3): 強制手のみは採点対象0', forcedOnly.totalMoves === 0);
    check('採点(改善3): 強制手は forcedCount に計上', forcedOnly.forcedCount === 2);
    check('採点(改善3): 強制手のみは totalPlayed=2', forcedOnly.totalPlayed === 2);
    check('採点(改善3): 強制手のみはランクD・0点(高評価にしない)', forcedOnly.totalScore === 0 && forcedOnly.rank === 'D');

    // 強制手 perfect を混ぜても、選択を伴う bad の評価が薄まらない(=強制手でスコアが上がらない)。
    const badPlusForced = summarizePlay([mk('bad', 4), mk('perfect', 1), mk('perfect', 1), mk('perfect', 1)]);
    const badOnly = summarizePlay([mk('bad', 4)]);
    check('採点(改善3): 強制perfectを足してもスコアが上がらない', badPlusForced.totalScore === badOnly.totalScore);
    check('採点(改善3): 強制手は内訳(perfect)に数えない', badPlusForced.perfectCount === 0 && badPlusForced.badCount === 1);
    check('採点(改善3): 除外後の採点手数=1 / 強制3', badPlusForced.totalMoves === 1 && badPlusForced.forcedCount === 3);

    // --- 選択肢の多さによる重み付け ---
    // 「合法手の多い局面での好手」「少ない局面での悪手」の組み合わせは、
    // 重みなしなら一致率50%だが、重み付きでは perfect 側(選択肢多)が重く出る。
    const weighted = summarizePlay([mk('perfect', 16), mk('bad', 2)]);
    const unweightedRate = 50; // 2手中1手 perfect = 50%(重みなし基準)
    check('採点(改善3): 選択肢多のperfectは一致率を押し上げる(>50%)', weighted.bestMatchRate > unweightedRate);

    // 逆向き: 「合法手の多い局面での悪手」「少ない局面での好手」だと一致率は下がる。
    const weightedDown = summarizePlay([mk('bad', 16), mk('perfect', 2)]);
    check('採点(改善3): 選択肢多のbadは一致率を押し下げる(<50%)', weightedDown.bestMatchRate < unweightedRate);

    // 重み付き平均ロス: 同じ「perfect1・bad1」でも、bad の局面の選択肢が多いほどロスが重く出る。
    const lossHardBad = summarizePlay([mk('perfect', 2), mk('bad', 16, 5)]);
    const lossEasyBad = summarizePlay([mk('perfect', 16), mk('bad', 2, 5)]);
    check('採点(改善3): 難所での悪手ほど平均ロスが大きい', lossHardBad.averageLoss > lossEasyBad.averageLoss);
    check('採点(改善3): よって難所悪手の方が総合スコアは低い', lossHardBad.totalScore < lossEasyBad.totalScore);

    // 全 perfect(選択肢ありの局面)はやはり満点・S(従来の体験を壊さない)。
    const allPerfectChoices = summarizePlay([mk('perfect', 4), mk('perfect', 8), mk('perfect', 3)]);
    check('採点(改善3): 選択肢ありの全perfectは100点・S', allPerfectChoices.totalScore === 100 && allPerfectChoices.rank === 'S');
    check('採点(改善3): 全perfectで一致率100%(重み付きでも)', allPerfectChoices.bestMatchRate === 100);
  }

  // I-3. ランク境界。
  check('採点: 90=S', rankForScore(90) === 'S');
  check('採点: 89=A', rankForScore(89) === 'A');
  check('採点: 75=A', rankForScore(75) === 'A');
  check('採点: 74=B', rankForScore(74) === 'B');
  check('採点: 55=B', rankForScore(55) === 'B');
  check('採点: 54=C', rankForScore(54) === 'C');
  check('採点: 35=C', rankForScore(35) === 'C');
  check('採点: 34=D', rankForScore(34) === 'D');
  check('採点: 0=D', rankForScore(0) === 'D');
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
