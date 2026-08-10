/**
 * 共有マテリアルと色。
 *
 * 値の出所は README「デザイントークン」。CSS 変数と二重管理になるため、
 * ここは**唯一の GPU 側の写し**とし、増やすときは styles.css と対で更新する。
 */

import { AdditiveBlending, Color } from 'three'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'
import {
  clamp,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionGeometry,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { SDF, ORDER, glyphSdfTexture, glyphOrderTexture } from './glyphs.ts'

export const INK = new Color('#f2f0ec')
export const TEXT_DIM = new Color('#8e8a84')
export const FOCUS = new Color('#ffd08a')
export const FOCUS_GLOW = new Color('#ffb85c')
export const STROKE = new Color('#f2f0ec')

/**
 * 読破の痕跡。**琥珀以外で唯一足した有彩色**で、役割は琥珀とはっきり分かれる。
 *   琥珀（FOCUS）… いま触れている＝一時的な状態
 *   青白（VISITED）… もう掘り切った＝残り続ける痕跡
 * 彩度を落として墨と地続きに見せる（→ skill: ink-visuals「読破の青白」）。
 */
export const VISITED = new Color('#9ec4f5')
export const VISITED_GLOW = new Color('#5b9bf2')

/** 紙面の地の文字。フォーカスされていない字はここまで落とす */
export const INK_RESTING = INK.clone().multiplyScalar(0.55)

/** 読破の青白も、他所を触っているあいだは墨と同じだけ沈む */
export const VISITED_RESTING = VISITED.clone().multiplyScalar(0.55)

/**
 * フォーカスの明滅にかける時間（秒）。光るのも、まわりが沈むのも同じ長さで動かす。
 * 瞬時に切り替えると紙面が点滅して見えるので、じわりと滲ませる。
 * 潜る／戻るの遷移（Transition.tsx）とは別系統で、hover にだけ効く。
 */
export const FOCUS_FADE = 0.4

/**
 * `current` を `target` へ一定速度で寄せる。`FOCUS_FADE` 秒で 0↔1 を渡り切る。
 * 指数補間だと最後がいつまでも詰まらず「0.4 秒で切り替わる」感覚にならないので線形にする。
 */
export function approach(current: number, target: number, delta: number, duration = FOCUS_FADE): number {
  const step = delta / duration
  const diff = target - current
  if (Math.abs(diff) <= step) return target
  return current + Math.sign(diff) * step
}

/* ---- 遷移中の濃さ ---------------------------------------------------------
 * 深度をまたぐあいだ、字のメッシュぜんたいに掛かる係数（0 = 消えている）。
 *
 * 字は粒子と違って 1 枚のメッシュなので、CPU 側で色を書き換えても
 * ノードマテリアルの不透明度には効かない。**シェーダの `opacityNode` に掛ける**必要があり、
 * かつ紙面の全インスタンスへ一斉に効かせたいので、ここにユニフォームを置いて
 * 墨・滲み・枠線のすべてがこれを読む。値を進めるのは Transition.tsx の `StageFade`。
 *
 * **深度ごとに 1 本ずつ**持つ。戻るときは出ていく大書と入ってくる紙面が同じ時間に画面へ
 * 居るので（Stage.tsx が紙面を先に置く）、1 本では片方を薄めながらもう片方を出せない。
 */
/** L0 の紙面が読む濃さ */
export const paperOpacity = uniform(1)
/** L1 以降（大書・図・描線）が読む濃さ */
export const nodeOpacity = uniform(1)

/**
 * **持ち越される字**（選んだ句 = 次の見出しになる字）だけが読むもう 1 本。
 * 遷移のあいだは 0 … その字は Transition が出発点から行き先へ動かしながら描いている。
 * 差し替わったあとは 1 … もう行き先の位置に置き換わっているので、改めて現れさせない。
 * 選んだ字だけは薄れも現れもせず、ひと続きに次の見出しへ渡る。
 */
export const carryOpacity = uniform(0)

/** `persist` が 1 の字は持ち越し側の濃さを読む。`layer` はその字が乗っている深度の濃さ */
export function transitionAlpha(
  persist: Node<'float'>,
  layer: Node<'float'> = nodeOpacity,
): Node<'float'> {
  return mix(layer, carryOpacity, persist)
}

/** 線・枠など、ノードマテリアルでないものが読む同じ値（L1 以降にしか無い） */
export function nodeOpacityValue(): number {
  return nodeOpacity.value as number
}

/* ---- 初出の滲み出し -------------------------------------------------------
 * 起動して紙面が出るときだけ、経文が頭の字から末尾の字へ順に滲み出す。
 * 紙面ぜんたいが一斉に点くと刷り上がった版面が差し出されただけに見えるので、
 * 「いま書かれている」側へ寄せる。**戻ってきたときは繰り返さない**（初出は 1 度きり）。
 *
 * 時計は紙面で 1 本（`revealTime`、秒）。字ごとの遅れはインスタンス属性 `aDelay` で持ち、
 * シェーダは字によらず同じまま（→ 紙面の墨は 1 本のマテリアルを共有する規約）。
 */

/** 頭の字と末尾の字の出はじめの差（秒） */
export const REVEAL_SPREAD = 3
/** 1 字が滲み切るまで（秒） */
export const REVEAL_DURATION = 0.9
/** 出し終わりまで（秒）。`revealTime` はここで止める */
export const REVEAL_TOTAL = REVEAL_SPREAD + REVEAL_DURATION

/** 滲みの縁の幅（字面座標）。狭いと紙を切る刃、広いと墨ではなく霧になる */
const REVEAL_EDGE = 0.34
/** 縁の蛇行の幅。まっすぐな対角線で拭くと払拭の演出に見えるので、字ごとに崩す */
const REVEAL_WOBBLE = 0.16
/** 蛇行の粗さ（字面 1 辺あたりの波数） */
const REVEAL_WOBBLE_FREQ = 3.4

/**
 * 初出の時計。**初期値は 0＝まだ 1 字も書かれていない。**
 *
 * ここを「出し終わり」から始めて、マウント後の `useEffect` で 0 へ落とすと、
 * その 1 フレームぶん全文が見えてしまう（グリフは読み込み済みなので、
 * 紙面は最初のフレームから完全な濃さで描ける）。**透明から始めて進める**のが順で、
 * 逆はできない。進めるのは `Paper` の `useFrame` だけで、`REVEAL_TOTAL` で止まる。
 */
export const revealTime = uniform(0)

/** その字がどこまで現れたか（0〜1）。`delay` は字ごとの出はじめ（秒） */
export function revealProgress(delay: Node<'float'>): Node<'float'> {
  return clamp(revealTime.sub(delay).div(REVEAL_DURATION), 0, 1)
}

/**
 * 字の中の滲み出し。筆で書くのと同じく**左上から右下へ**墨が回る。
 * 字面ローカル座標の対角 (x - y + 1)/2 を進行方向に取り、縁をノイズで蛇行させる。
 */
export function revealMask(delay: Node<'float'>): Node<'float'> {
  const p = revealProgress(delay)
  // 左上 = 0、右下 = 1
  const diagonal = positionGeometry.x.sub(positionGeometry.y).add(1).mul(0.5)
  // 字ごとに違う崩れ方にする。種は出はじめ（＝全文での位置）から引く
  const wobble = mx_noise_float(vec3(positionGeometry.xy.mul(REVEAL_WOBBLE_FREQ), delay))
    .mul(0.5)
    .add(0.5)
    .mul(REVEAL_WOBBLE)
  // 縁が字面を渡り切るまで進める（縁の幅と蛇行のぶんだけ余分に走らせる）
  const front = p.mul(1 + REVEAL_EDGE + REVEAL_WOBBLE)
  return clamp(front.sub(diagonal.add(wobble)).div(REVEAL_EDGE), 0, 1)
}

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

/* ---- 発光の滲み -----------------------------------------------------------
 * 光は字そのものから出る。板の中心から放射させると、どの字でも同じ丸い光になり
 * 「字が光っている」ではなく「字の裏に電球がある」絵になってしまう。
 * 前計算した符号付き距離場（scripts/sdf.ts）を引き、輪郭からの距離だけで減衰させると、
 * 滲みの縁が字形をなぞる。画のあいだの空きにも光が回り込まない。
 */

/** 滲みを載せる板の一辺（字面 = 1 に対する比）。距離場のセルと一致させる */
export const GLOW_PLANE = 2 * SDF.extent

/** 芯の届く距離（字面座標）。輪郭のすぐ外を強く光らせる */
const GLOW_NEAR = 0.08
/** 裾の届く距離。`SDF.spread` を超えると距離場が飽和して縁が切れる */
const GLOW_FAR = 0.26

/**
 * 距離場から滲みの強さを引く。`local` はセル内の 0..1 座標、`cell` はアトラスのセル番号。
 * 内側は 1 に飽和し、外へ向かって芯と裾の 2 段で落ちる。
 */
function glowFalloff(cell: Node<'float'>, local: Node<'vec2'>): Node<'float'> {
  const atlas = glyphSdfTexture()
  if (!atlas) return float(0)

  // グリフが無い字はセル番号を持たない（-1）。uv が壊れないよう 0 に丸め、最後に消す
  const valid = step(-0.5, cell)
  const safe = cell.max(0)
  const uv = vec2(
    safe.mod(SDF.columns).add(local.x).div(SDF.columns),
    safe.div(SDF.columns).floor().add(local.y).div(SDF.rows),
  )
  // 格納は 0.5 が輪郭・上が内側。外向きの距離（字面座標）へ戻す
  const distance = float(0.5).sub(texture(atlas, uv).r).mul(2 * SDF.spread)

  const band = (radius: number): Node<'float'> => {
    const t = clamp(distance.div(radius).oneMinus(), 0, 1)
    // 二乗して芯を締める。線形だと裾まで一様に明るく、滲みの範囲だけが広く見える
    return t.mul(t)
  }

  return band(GLOW_NEAR).mul(0.7).add(band(GLOW_FAR).mul(0.3)).mul(valid)
}

/**
 * 字形に沿った滲みのマテリアル。一辺 `GLOW_PLANE` の板（PlaneGeometry(1,1) を拡大）に貼る。
 *
 * `cell` はアトラスのセル番号（インスタンス属性でもユニフォームでもよい）、
 * `amount` は 0〜1 の濃さ。加算合成なので、字の墨そのものは白く飛ばない。
 */
export function createGlowMaterial(
  cell: Node<'float'>,
  amount: Node<'float'>,
  options: {
    color?: Color
    /** 1 なら持ち越される字。遷移中の濃さを字の墨と揃える */
    persist?: Node<'float'> | number
    /** この滲みが乗っている深度の濃さ。紙面なら `paperOpacity` */
    layer?: Node<'float'>
  } = {},
): MeshBasicNodeMaterial {
  const { color = FOCUS_GLOW, persist = 0, layer } = options
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: AdditiveBlending,
  })
  material.colorNode = vec3(color.r, color.g, color.b)
  // PlaneGeometry(1,1) の字面ローカル [-0.5, 0.5] を、セル内の 0..1 へ
  material.opacityNode = glowFalloff(cell, positionGeometry.xy.add(0.5))
    .mul(amount)
    .mul(transitionAlpha(typeof persist === 'number' ? float(persist) : persist, layer))
  return material
}

/* ---- 筆順の運び -----------------------------------------------------------
 * ロゴ（深般若）だけは、字が一斉に滲み出すのではなく**画の順に書かれていく**。
 * 前計算した筆順パラメータ場（scripts/stroke-order.ts）を引くと、その画素が何番目に
 * 書かれるかが 0〜1 で分かるので、進行 `progress` を上げるだけで筆が運ばれる。
 * 滲み方（`inkDensity` のかすれ・`createGlowMaterial` の発光）は紙面の字とまったく同じ経路を通り、
 * その効き始めだけが運びに従う。
 */

/** 筆先の柔らかさ（運びのパラメータ単位）。狭いと刃、広いと筆ではなく霧になる */
const BRUSH_EDGE = 0.035
/** 筆先の縁の崩れ。等値線どおりに切ると拭き取りに見えるので、字ごとに崩す */
const BRUSH_WOBBLE = 0.008
/** 崩しの粗さ（セル 1 辺あたりの波数） */
const BRUSH_WOBBLE_FREQ = 9
/** 筆先に残る潤み（運びのパラメータ単位）。ここを過ぎた墨は乾いたものとして光らない */
const BRUSH_TIP = 0.07

/** 字面 [-0.5, 0.5]^2 のメッシュ上での、筆順アトラスのセル内座標（0〜1） */
export function glyphCellLocal(): Node<'vec2'> {
  return positionGeometry.xy.div(2 * ORDER.extent).add(0.5)
}

/** `GLOW_PLANE` の板（PlaneGeometry(1,1)）上での、同じセル内座標 */
export function planeCellLocal(): Node<'vec2'> {
  return positionGeometry.xy.add(0.5)
}

/**
 * その画素が書かれる順（0〜1）。中心線を持たない字（`cell` < 0）では 0 を返し、
 * 「もう書かれている」＝運びの判定を素通りさせる。
 */
function strokeOrderAt(cell: Node<'float'>, local: Node<'vec2'>): Node<'float'> {
  const atlas = glyphOrderTexture()
  if (!atlas) return float(0)

  const valid = step(-0.5, cell)
  const safe = cell.max(0)
  const uv = vec2(
    safe.mod(ORDER.columns).add(local.x).div(ORDER.columns),
    safe.div(ORDER.columns).floor().add(local.y).div(ORDER.rows),
  )
  return texture(atlas, uv).r.mul(valid)
}

/** 筆先から見た進み具合。負 = まだ筆が来ていない、正 = 通り過ぎた（運びのパラメータ単位） */
function brushLead(cell: Node<'float'>, progress: Node<'float'>, local: Node<'vec2'>): Node<'float'> {
  const order = strokeOrderAt(cell, local)
  const wobble = mx_noise_float(vec3(local.mul(BRUSH_WOBBLE_FREQ), cell)).mul(BRUSH_WOBBLE)
  // 筆先が字面を渡り切るまで進める（縁の幅ぶんだけ余分に走らせる）
  return progress.mul(1 + BRUSH_EDGE).sub(order.add(wobble))
}

/** 墨が置かれたか（0〜1）。`progress` が 1 で字がすべて書き上がる */
export function brushWet(cell: Node<'float'>, progress: Node<'float'>, local: Node<'vec2'>): Node<'float'> {
  return clamp(brushLead(cell, progress, local).div(BRUSH_EDGE), 0, 1)
}

/**
 * 筆先の潤み（0〜1）。いま筆が置かれているところだけが 1 で、後ろへ向かって乾いていく。
 * 発光（`createGlowMaterial` の `amount`）へ渡すと、光が筆を追って走る。
 */
export function brushTip(cell: Node<'float'>, progress: Node<'float'>, local: Node<'vec2'>): Node<'float'> {
  const lead = brushLead(cell, progress, local)
  // 筆の前は光らせない。後ろは BRUSH_TIP で乾く
  return clamp(lead.div(BRUSH_EDGE), 0, 1).mul(clamp(lead.div(BRUSH_TIP).oneMinus(), 0, 1))
}

/**
 * 筆順どおりに書かれていく単体グリフ用マテリアル。
 * 墨の質感は `createInkMaterial` と同じで、現れ方だけが運びに従う。
 * `cell` は筆順アトラスのセル番号（`orderCellOf`）、`progress` は 0→1 で進める。
 */
export function createBrushMaterial(
  cell: number,
  progress: Node<'float'>,
): {
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
  material.opacityNode = opacity.mul(inkAlpha(density)).mul(brushWet(float(cell), progress, glyphCellLocal()))

  return { material, color, opacity, seed, scale }
}

/**
 * 図の連結線・区切りなど、字ではない細い描線のマテリアル。
 * 遷移では字と同じ濃さで出入りさせたいので、`nodeOpacity` を通すためだけに
 * `meshBasicMaterial` ではなくノードマテリアルで持つ。
 */
export function createStrokeMaterial(opacity = 0.55, color: Color = STROKE): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false })
  material.colorNode = vec3(color.r, color.g, color.b)
  material.opacityNode = nodeOpacity.mul(opacity)
  return material
}

/**
 * 墨の質感を持つ単体グリフ用マテリアル（インスタンス化しない大書・図・円相）。
 * 色と不透明度はユニフォームなので、hover での差し替えでシェーダを組み直さない。
 */
export function createInkMaterial(
  /**
   * false にすると遷移の濃さ（`nodeOpacity` / `carryOpacity`）に従わない。
   * 遷移中に持ち越しの字を自前で動かしながら描く Transition だけが使う。
   */
  followsTransition = true,
): {
  material: MeshBasicNodeMaterial
  color: { value: Color }
  opacity: { value: number }
  seed: { value: number }
  /** その字のワールドでの一辺。メッシュの scale と同じ値を入れる */
  scale: { value: number }
  /** 1 = 次の見出しへ持ち越される字。遷移で薄れず、`carryOpacity` に従う */
  persist: { value: number }
} {
  const color = uniform(INK.clone())
  const opacity = uniform(1)
  const seed = uniform(0)
  const scale = uniform(1)
  const persist = uniform(0)

  const material = new MeshBasicNodeMaterial({ transparent: true, toneMapped: false })
  const density = inkDensity(seed, scale)
  material.colorNode = color.mul(inkShade(density))
  const alpha = opacity.mul(inkAlpha(density))
  material.opacityNode = followsTransition ? alpha.mul(transitionAlpha(persist)) : alpha

  return { material, color, opacity, seed, scale, persist }
}
