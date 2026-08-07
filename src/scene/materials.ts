/**
 * 共有マテリアルと色。
 *
 * 値の出所は README「デザイントークン」。CSS 変数と二重管理になるため、
 * ここは**唯一の GPU 側の写し**とし、増やすときは styles.css と対で更新する。
 */

import { Color } from 'three'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import {
  clamp,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionGeometry,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'

export const INK = new Color('#f2f0ec')
export const TEXT_DIM = new Color('#8e8a84')
export const FOCUS = new Color('#ffd08a')
export const FOCUS_GLOW = new Color('#ffb85c')
export const STROKE = new Color('#f2f0ec')

/** 紙面の地の文字。フォーカスされていない字はここまで落とす */
export const INK_RESTING = INK.clone().multiplyScalar(0.55)

/* ---- 墨の質感 -------------------------------------------------------------
 * グリフの塗りを均一な白ではなく、濃淡とかすれのある墨に見せる。
 * テクスチャは持たず全て手続き的（README「ランタイムで SVG を触らない」に抵触しない）。
 * 色は増やさない。既存トークンの明度と不透明度だけを揺らす。
 *
 * 模様の粗さは**ワールド単位で一定**にする。字面ローカル座標（`positionGeometry`、
 * 字面は [-0.5, 0.5]^2）にその字のワールドでの大きさを掛けてから引くので、
 * 紙の目も筆の毛も大書と L0 とで同じ細かさになる。字に比例させると、
 * 大書では筋が太くなりすぎて墨ではなく金属の光沢に見えてしまう。
 * 座標は字と一緒に動くので、ゆらぎで模様が泳ぐこともない。
 */

/** ムラの周波数（ワールド 1 単位 ≒ L0 の 1 字あたりの波数）。上げるほど細かい */
const BLOTCH_FREQ = 2.2 // にじみ・墨だまりの大づかみな濃淡
const GRAIN_FREQ = 5 // 紙の目
const KASURE_FREQ = 7 // かすれの筋。直交方向に引き伸ばして筆の流れにする
const KASURE_STRETCH = 0.1 // 筋を伸ばす比率。小さいほど長い筋になる

/** 濃淡の振れ幅。すべて 0 にすると従来どおりの均一な塗りに戻る */
const BLOTCH_AMOUNT = 0.34
const GRAIN_AMOUNT = 0.12
const KASURE_AMOUNT = 0.45

/** 墨が最も薄いところでも残す濃さ。0 にすると字が穴だらけになる */
const INK_FLOOR = 0.5

/**
 * 墨の濃さ。1 = のった墨、`INK_FLOOR` = かすれ。
 *
 * `seed` は字（またはインスタンス）ごとの種。同じジオメトリを共有していても
 * 種が違えばムラの出方が変わるので、同じ字が紙面に何度現れても刷り物に見えない。
 * `scale` はその字のワールドでの一辺（メッシュに掛けている scale と同じ値）。
 */
export function inkDensity(seed: Node<'float'>, scale: Node<'float'> | number = 1): Node<'float'> {
  const p = positionGeometry.xy.mul(scale)

  // かすれの筋の向きを字ごとに回す。全部同じ向きに流れると印刷の網点に見えてしまう
  const angle = seed.mul(2.399963)
  const ca = angle.cos()
  const sa = angle.sin()
  const qx = p.x.mul(ca).sub(p.y.mul(sa))
  const qy = p.x.mul(sa).add(p.y.mul(ca))

  // MaterialX ノイズは概ね [-1, 1]。0..1 に均してから重ねる
  const blotch = mx_fractal_noise_float(vec3(p.mul(BLOTCH_FREQ), seed), 3, 2, 0.6).mul(0.5).add(0.5)
  const grain = mx_noise_float(vec3(p.mul(GRAIN_FREQ), seed.add(17))).mul(0.5).add(0.5)
  // 筋の座標を低周波で歪ませる。真っすぐ引くと網掛けに見えるので、毛を蛇行させる
  const warp = mx_noise_float(vec3(p.mul(BLOTCH_FREQ * 1.6), seed.add(29))).mul(0.35)
  const kasure = mx_noise_float(
    vec3(qx.add(warp).mul(KASURE_FREQ), qy.mul(KASURE_FREQ * KASURE_STRETCH), seed.add(41)),
  )
    .mul(0.5)
    .add(0.5)

  // かすれは薄いところほど出る。筆が乾いてきた領域をまとめて掠らせるため blotch と連動させる。
  // しきい値を高めに取り、字面全体ではなく所々だけを掠らせる
  const dry = smoothstep(0.66, 1.02, kasure.add(blotch.oneMinus().mul(0.5)))

  const density = blotch
    .oneMinus()
    .mul(BLOTCH_AMOUNT)
    .add(grain.oneMinus().mul(GRAIN_AMOUNT))
    .add(dry.mul(KASURE_AMOUNT))
    .oneMinus()

  return clamp(density, INK_FLOOR, 1)
}

/** 濃さ → 明度。薄いところは沈むが、色相は変えない */
export function inkShade(density: Node<'float'>): Node<'float'> {
  return mix(0.42, 1, density)
}

/** 濃さ → 不透明度の係数。かすれた部分だけ地を透かす */
export function inkAlpha(density: Node<'float'>): Node<'float'> {
  return mix(0.3, 1, density)
}

/**
 * 墨の質感を持つ単体グリフ用マテリアル（インスタンス化しない大書・図・円相）。
 * 色と不透明度はユニフォームなので、hover での差し替えでシェーダを組み直さない。
 */
export function createInkMaterial(): {
  material: MeshBasicNodeMaterial
  color: { value: Color }
  opacity: { value: number }
  seed: { value: number }
  /** その字のワールドでの一辺。メッシュの scale と同じ値を入れる */
  scale: { value: number }
} {
  const color = uniform(INK.clone())
  const opacity = uniform(1)
  const seed = uniform(0)
  const scale = uniform(1)

  const material = new MeshBasicNodeMaterial({ transparent: true, toneMapped: false })
  const density = inkDensity(seed, scale)
  material.colorNode = color.mul(inkShade(density))
  material.opacityNode = opacity.mul(inkAlpha(density))

  return { material, color, opacity, seed, scale }
}
