/**
 * メニュー画面(アプリのトップ)。
 *
 * versus_mode.md: アプリ名「異形オセロシミュレーター」。
 * 「対局モード」「評価値計算モード」の 2 択を大きなカードで提示する。案B(ネオンダーク)トーン。
 */

import { ICON_SWORDS, ICON_ANALYZE } from './icons';

export class MenuScreen {
  private container: HTMLElement;

  constructor(
    container: HTMLElement,
    onVersus: () => void,
    onEval: () => void,
  ) {
    this.container = container;
    this.render(onVersus, onEval);
  }

  dispose(): void {
    // メニューは状態を持たない。何もしない。
  }

  private render(onVersus: () => void, onEval: () => void): void {
    this.container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'screen menu-screen';

    const header = document.createElement('div');
    header.className = 'menu-header';
    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = '異形オセロシミュレーター';
    const sub = document.createElement('p');
    sub.className = 'menu-subtitle';
    sub.textContent = '通常・クロス・八角・ホロー — 4つの異形盤で遊ぶ / 解析する';
    header.appendChild(title);
    header.appendChild(sub);

    const cards = document.createElement('div');
    cards.className = 'menu-cards';
    cards.appendChild(
      this.makeCard(
        'menu-card-versus',
        ICON_SWORDS,
        '対局モード',
        'AIと対局。5段階の強さ + あなたのプレイを採点',
        onVersus,
      ),
    );
    cards.appendChild(
      this.makeCard(
        'menu-card-eval',
        ICON_ANALYZE,
        '評価値計算モード',
        '検討盤。全合法手の評価値を3色リングで表示',
        onEval,
      ),
    );

    wrap.appendChild(header);
    wrap.appendChild(cards);
    this.container.appendChild(wrap);
  }

  private makeCard(
    cls: string,
    icon: string,
    title: string,
    desc: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const card = document.createElement('button');
    card.className = 'menu-card ' + cls;
    card.type = 'button';
    card.innerHTML = `
      <span class="menu-card-icon">${icon}</span>
      <span class="menu-card-body">
        <span class="menu-card-title">${title}</span>
        <span class="menu-card-desc">${desc}</span>
      </span>
    `;
    card.addEventListener('click', onClick);
    return card;
  }
}
