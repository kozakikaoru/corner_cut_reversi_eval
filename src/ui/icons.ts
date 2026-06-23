/**
 * コントロール用のラインアイコン(Tabler 相当)。inline SVG・currentColor 追従。
 * webfont を足さずにビルド完結させるため、ボタン文字色に同調する SVG を直接埋め込む。
 *
 * フェーズ3でメニュー/対戦の各画面から共用するため、app.ts から切り出した。
 */

const ICON_ATTRS =
  'class="ctrl-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** 1手戻る: ti-arrow-back-up 相当。 */
export const ICON_UNDO =
  `<svg ${ICON_ATTRS}><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`;

/** リセット: ti-refresh 相当。 */
export const ICON_RESET =
  `<svg ${ICON_ATTRS}><path d="M20 11A8 8 0 1 0 18.6 15"/><path d="M20 5v6h-6"/></svg>`;

/** 戻る(メニュー/前画面へ): ti-chevron-left 相当。 */
export const ICON_BACK =
  `<svg ${ICON_ATTRS}><path d="M15 6l-6 6 6 6"/></svg>`;

/** 採点トグル(評価値表示): ti-bulb 相当(電球=ヒント)。 */
export const ICON_EVAL =
  `<svg ${ICON_ATTRS}><path d="M9 18h6"/><path d="M10 21h4"/>` +
  `<path d="M7 11a5 5 0 1 1 10 0c0 2-1.5 3-2 4.5h-6C8.5 14 7 13 7 11z"/></svg>`;

/** 対戦モード: ti-swords 相当(交差する剣)。 */
export const ICON_SWORDS =
  `<svg class="menu-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M14.5 17.5 21 11V4h-7l-6.5 6.5"/><path d="M3 21l3-3"/>` +
  `<path d="M9.5 17.5 3 11V4h7l6.5 6.5"/><path d="M21 21l-3-3"/></svg>`;

/** 評価値計算モード: ti-chart-dots / ヒント解析 相当(虫眼鏡+目盛)。 */
export const ICON_ANALYZE =
  `<svg class="menu-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>` +
  `<path d="M8 12v-1"/><path d="M11 12V9"/><path d="M14 12v-2"/></svg>`;
