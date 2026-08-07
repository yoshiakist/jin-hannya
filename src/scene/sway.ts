/**
 * 字のゆらぎ。
 *
 * 紙面（L0）も大書と図（L1 以降）も、遷移で持ち越される字も、同じ規則で揺れる。
 * どの深度でも「同じ場に浮かんでいる」と見えることが要点なので、規則はここ 1 箇所だけが持つ。
 *
 * 振れ幅は**字の大きさに対する比**で持つ。絶対値で持つと、大書のように 5 倍大きい字では
 * 揺れが相対的に消えてしまい、潜った先で字が固まって見える。
 */

/** 基準位置からの振れ幅（字の大きさに対する比） */
const SWAY_RATIO = 0.037

/** 傾きの振れ幅（ラジアン）。大きさに依らず一定 */
const TILT = 0.012

/**
 * ゆらぎの位相。字ごとにずらす（同じ周期で揃うと紙面が波打って見える）。
 * 種は呼び手が決める（紙面は全文インデックス、大書と図は字のコードポイント）。
 * 墨と発光の滲みが別のメッシュに分かれても同じ場所に居るよう、位相は種から引き直す。
 */
export function swayPhase(seed: number): number {
  return (Math.sin(seed * 12.9898) * 43758.5453) % (Math.PI * 2)
}

export interface Sway {
  x: number
  y: number
  rotation: number
}

/** 基準位置からのずれ。周期は x / y / 傾きでわずかにずらし、往復に見えないようにする */
export function swayAt(phase: number, size: number, t: number): Sway {
  const amplitude = size * SWAY_RATIO
  return {
    x: Math.sin(t * 0.55 + phase) * amplitude,
    y: Math.cos(t * 0.41 + phase * 1.7) * amplitude,
    rotation: Math.sin(t * 0.3 + phase) * TILT,
  }
}
