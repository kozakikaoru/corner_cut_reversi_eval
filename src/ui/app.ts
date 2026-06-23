/**
 * アプリ全体のルーター。
 *
 * フェーズ3: アプリを「異形オセロシミュレーター」とし、メニュー画面を新設。
 *   メニュー → 「対戦モード」/「評価値計算モード」の 2 択。
 *   - 評価値計算モード = 既存の検討盤(EvalScreen として切り出し。挙動は不変)。
 *   - 対戦モード = 新規(VersusScreen)。
 *
 * 各画面は「自分の DOM を container に描画し、dispose() で後始末する」コンポーネント。
 * App は現在の画面を 1 つ保持し、遷移時に古い画面を dispose してから次を生成する。
 * これにより Worker(評価エンジン)が画面ごとに確実に止まり、リークしない。
 */

import { MenuScreen } from './menuScreen';
import { EvalScreen } from './evalScreen';
import { VersusScreen } from './versusScreen';

/** 画面コンポーネントの共通インタフェース。 */
interface Screen {
  dispose(): void;
}

type ScreenId = 'menu' | 'eval' | 'versus';

export class App {
  private container: HTMLElement;
  private current: Screen | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.goto('menu');
  }

  /** 画面遷移。古い画面を後始末してから新しい画面を生成する。 */
  private goto(screen: ScreenId): void {
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
    this.container.innerHTML = '';

    switch (screen) {
      case 'menu':
        this.current = new MenuScreen(
          this.container,
          () => this.goto('versus'),
          () => this.goto('eval'),
        );
        break;
      case 'eval':
        this.current = new EvalScreen(this.container, () => this.goto('menu'));
        break;
      case 'versus':
        this.current = new VersusScreen(this.container, {
          toMenu: () => this.goto('menu'),
        });
        break;
    }
  }
}
