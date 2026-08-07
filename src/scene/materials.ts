/**
 * 共有マテリアルと色。
 *
 * 値の出所は README「デザイントークン」。CSS 変数と二重管理になるため、
 * ここは**唯一の GPU 側の写し**とし、増やすときは styles.css と対で更新する。
 */

import { Color } from 'three'

export const INK = new Color('#f2f0ec')
export const TEXT_DIM = new Color('#8e8a84')
export const FOCUS = new Color('#ffd08a')
export const FOCUS_GLOW = new Color('#ffb85c')
export const STROKE = new Color('#f2f0ec')

/** 紙面の地の文字。フォーカスされていない字はここまで落とす */
export const INK_RESTING = INK.clone().multiplyScalar(0.55)
