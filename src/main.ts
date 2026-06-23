/**
 * エントリポイント。#app に App をマウントする。
 */

import './style.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app が見つかりません');
}
new App(root);
