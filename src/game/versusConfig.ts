/**
 * 対戦モードの設定型(対戦前設定 → 対局 → 結果 で共有)。
 */

import type { Player, VariantId } from '../engine/types';
import type { AiLevelId } from './ai';

/** 対戦前設定で選ぶ盤面候補(ランダムは選択時に実盤面へ解決する)。 */
export type VersusVariantChoice = VariantId | 'random';

/** 対戦の確定設定(対局開始時に解決済み)。 */
export interface VersusConfig {
  /** 実際にプレイする盤面(random は開始時に解決済み)。 */
  variant: VariantId;
  /** ユーザーが選んだ盤面の選択肢(「もう1戦」で random を再解決するため保持)。 */
  variantChoice: VersusVariantChoice;
  /** AI 強さ。 */
  aiLevel: AiLevelId;
  /** プレイヤーの色(先後ランダム決定の結果)。先手は常に黒。 */
  playerColor: Player;
}
