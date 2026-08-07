/**
 * ドラッグによるカメラのパンと、ホイール／ピンチによる拡大。
 *
 * PC・スマホの区別なく同じ操作にする（README「ナビゲーション / 左矢印」）。
 * パン量と拡大率は 1 つずつの atom に集約し、WebGPU レイヤーのカメラと DOM オーバーレイの
 * transform が**同じ値**を読むことで両レイヤーの同期を保証する。
 *
 * 可動域はビューポート依存である。紙面は縦 16 升ぶんが画面高に収まるよう描かれるので、
 * 横がはみ出すかどうかは画面のアスペクト比で決まる（縦長のスマホでは必ずはみ出し、
 * 横長の PC では収まりきることがある）。だから範囲は定数にせず、実測から毎回引き直す。
 * 拡大すると視野が狭まるぶん可動域は広がり、縦にも送れるようになる。
 */

import { atom, useAtomValue, useSetAtom, useStore, type Setter } from 'jotai'
import { useEffect, useRef } from 'react'
import { CELL_X, PAPER_WIDTH, VIEW_HEIGHT } from './paper.ts'

export interface PanBounds {
  /** 最も左まで送った状態のカメラ x */
  min: number
  /** 読み始めの位置。紙面がはみ出すなら右端ぞろえ、収まるなら中央ぞろえのカメラ x */
  max: number
}

/** 画面端と紙面のあいだに残す余白（ワールド単位） */
const EDGE_MARGIN = CELL_X

/** 紙面の左右の余白が等しくなるカメラ x。第 1 列が x = 0、最終列が x = -PAPER_WIDTH にある */
const CENTERED = -PAPER_WIDTH / 2

/**
 * ビューポート半幅（ワールド単位）からパンの可動域を出す。
 * 第 1 列は x = 0、最終列は x = -PAPER_WIDTH にある。
 */
export function panBoundsFor(halfWidth: number): PanBounds {
  // 第 1 列を画面の右端へ寄せた位置が読み始め
  const max = -(halfWidth - EDGE_MARGIN)
  // 最終列を画面の左端へ寄せた位置が左端
  const min = -PAPER_WIDTH + halfWidth - EDGE_MARGIN
  // 紙面が余白ごと画面に収まるなら送る先が無い。中央ぞろえで固定する。
  // 収まらないなら右端ぞろえ（= max）から読み始め、左へ送っていく
  return min >= max ? { min: CENTERED, max: CENTERED } : { min, max }
}

/** ビューポートの寸法（px）からカメラのビューポート半幅（ワールド単位）を出す */
export function halfWidthFor(width: number, height: number): number {
  return height > 0 ? (width / height) * VIEW_HEIGHT * 0.5 : 0
}

/** 拡大率の下限（紙面全体が縦に収まる等倍）と上限 */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 4

/**
 * 拡大時の縦の可動域。等倍では縦 16 升ぶんがちょうど画面高に収まるので送り先が無く、
 * 拡大するとはみ出したぶんだけ上下へ送れる。上下対称なので片側の値だけ返す。
 */
export function panYLimitFor(zoom: number): number {
  return (VIEW_HEIGHT / 2) * (1 - 1 / zoom)
}

/**
 * 起動時のビューポート半幅。実測は Canvas のマウント後に Stage が引き直すが、
 * それを待つと最初の数フレームだけ紙面が中央に描かれ、右端寄せへ動いて見える。
 * 最初の 1 フレームから読み始めの位置で描くために窓の寸法から先に出しておく。
 */
function initialHalfWidth(): number {
  const width = globalThis.innerWidth || 0
  const height = globalThis.innerHeight || 0
  if (!width || !height) return 0
  return halfWidthFor(width, height)
}

const startHalfWidth = initialHalfWidth()
const startBounds = startHalfWidth ? panBoundsFor(startHalfWidth) : { min: 0, max: 0 }

const halfWidthRaw = atom(startHalfWidth)
const zoomRaw = atom(MIN_ZOOM)

/** 読み始めは紙面の右上、すなわち第 1 列の先頭。カメラの初期位置もこれに合わせる */
export const INITIAL_PAN_X = startBounds.max

const panXRaw = atom(INITIAL_PAN_X)
const panYRaw = atom(0)

/** 可動域は「等倍の半幅 ÷ 拡大率」から引く。拡大するほど視野が狭まり、送れる幅が広がる */
export const panBoundsAtom = atom<PanBounds>((get) =>
  get(halfWidthRaw) ? panBoundsFor(get(halfWidthRaw) / get(zoomRaw)) : { min: 0, max: 0 },
)

/** ワールド単位でのカメラ x。書き込みは常に可動域へクランプされる */
export const panXAtom = atom(
  (get) => get(panXRaw),
  (get, set, update: number | ((previous: number) => number)) => {
    const { min, max } = get(panBoundsAtom)
    const next = typeof update === 'function' ? update(get(panXRaw)) : update
    set(panXRaw, Math.min(max, Math.max(min, next)))
  },
)

/** ワールド単位でのカメラ y。等倍では常に 0 にクランプされる */
export const panYAtom = atom(
  (get) => get(panYRaw),
  (get, set, update: number | ((previous: number) => number)) => {
    const limit = panYLimitFor(get(zoomRaw))
    const next = typeof update === 'function' ? update(get(panYRaw)) : update
    set(panYRaw, Math.min(limit, Math.max(-limit, next)))
  },
)

/** 拡大率。書き込みのたびにパン量を新しい可動域へ入れ直す */
export const zoomAtom = atom(
  (get) => get(zoomRaw),
  (get, set, update: number | ((previous: number) => number)) => {
    const next = typeof update === 'function' ? update(get(zoomRaw)) : update
    set(zoomRaw, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)))
    reclamp(set)
  },
)

/** ビューポート半幅（等倍・ワールド単位）。Canvas の実測から Stage が入れる */
export const viewHalfWidthAtom = atom(
  (get) => get(halfWidthRaw),
  (_get, set, halfWidth: number) => {
    set(halfWidthRaw, halfWidth)
    reclamp(set)
  },
)

/** 可動域が変わったら現在のパン量を新しい範囲へ入れ直す（恒等写像を書けばクランプが走る） */
function reclamp(set: Setter): void {
  set(panXAtom, (x) => x)
  set(panYAtom, (y) => y)
}

/** 左へまだ紙面が残っているか。左矢印の明滅の可否 */
export const canPanLeftAtom = atom((get) => get(panXAtom) > get(panBoundsAtom).min + 1e-3)

// --- L1 以降のパン ----------------------------------------------------------

/**
 * L1 以降は**左右にだけ**送る。拡大も縦送りも持たない（大書は紙面ではない）。
 * 値は `nodePanX()` が出す基準の構図からのずれ（ワールド単位）。
 *
 * 大書と図は基準の構図に必ず収まっているので、送る先があるのは左だけ。
 * 可動域は本文が画面の左へどれだけはみ出しているかで決まり、それは DOM の組版の結果なので、
 * 実測した値を `nodePanRangeAtom` へ Overlay が入れる。
 *
 * **ばねは atom が持つ。** ドラッグは行き先（target）だけを動かし、実際のパン量（current）は
 * `useNodePanSpring` がそこへ向かって補間する。カメラ側でも補間すると 2 度掛かって
 * GPU レイヤーが DOM に遅れ、2 つの層がずれて見える（→ Stage.tsx の CameraRig）。
 */
const nodePanRaw = atom(0)
const nodePanTargetRaw = atom(0)
const nodePanRangeRaw = atom(0)

/** ドラッグの行き先。書き込みは常に `[-range, 0]` へクランプされる */
export const nodePanTargetAtom = atom(
  (get) => get(nodePanTargetRaw),
  (get, set, update: number | ((previous: number) => number)) => {
    const next = typeof update === 'function' ? update(get(nodePanTargetRaw)) : update
    set(nodePanTargetRaw, Math.min(0, Math.max(-get(nodePanRangeRaw), next)))
  },
)

/** いま描くべきパン量（ワールド単位）。カメラも DOM もこの 1 つだけを読む */
export const nodePanXAtom = atom((get) => get(nodePanRaw))

/** ばねを挟まずその場で基準の構図へ戻す。ノードが変わったときに使う */
export const resetNodePanAtom = atom(null, (_get, set) => {
  set(nodePanTargetRaw, 0)
  set(nodePanRaw, 0)
})

/** 左へ送れる幅（ワールド単位・0 以上）。ノードや画面寸法が変わるたび Overlay が入れ直す */
export const nodePanRangeAtom = atom(
  (get) => get(nodePanRangeRaw),
  (_get, set, range: number) => {
    set(nodePanRangeRaw, Math.max(0, range))
    // 可動域が縮んだら行き先を新しい範囲へ入れ直す（ばねが現在位置を連れてくる）
    set(nodePanTargetAtom, (x) => x)
  },
)

/** L1 以降で左にまだ本文が残っているか。左矢印の明滅の可否 */
export const canNodePanLeftAtom = atom(
  (get) => get(nodePanTargetRaw) > -get(nodePanRangeRaw) + 1e-3,
)

/** 行き先への追従の速さ（1/秒）。L0 のカメラ補間と同じ係数で、指を離しても同じ手触りになる */
const NODE_PAN_FOLLOW = 9
/** これ以下の差は動きとして見えない。ワールド単位（1px の 1/100 未満） */
const NODE_PAN_EPSILON = 1e-4

/**
 * L1 以降のパンのばね。行き先へ向かって毎フレーム詰める。
 *
 * カメラではなく atom を動かすのが要点で、GPU レイヤーの大書と DOM の本文が
 * **同じ値**を読む以上、両者に速度差が生まれない。App が 1 度だけ取り付ける。
 */
export function useNodePanSpring(): void {
  const store = useStore()
  // 行き先が動いたらばねを起こす。値そのものはフレームごとに store から読む
  const target = useAtomValue(nodePanTargetAtom)

  useEffect(() => {
    const settled = () =>
      Math.abs(store.get(nodePanTargetAtom) - store.get(nodePanXAtom)) < NODE_PAN_EPSILON
    if (settled()) return

    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      // 行き先も現在位置も毎フレーム読み直す。ノードが変わったときの即時リセット
      // （`resetNodePanAtom`）と競っても、取り残された 1 フレームが古い値を書き戻さない
      if (settled()) return
      // タブが戻ったときの巨大な delta で飛ばさないよう頭を抑える。
      // 下も抑える: rAF の時刻はフレームの開始時刻なので、直前に読んだ performance.now() より
      // 前になることがある。負の delta は補間係数を負にし、行き先と逆へ弾く
      const delta = Math.max(0, Math.min(0.05, (now - last) / 1000))
      last = now
      const goal = store.get(nodePanTargetAtom)
      const current = store.get(nodePanXAtom)
      const next = current + (goal - current) * (1 - Math.exp(-delta * NODE_PAN_FOLLOW))
      store.set(nodePanRaw, Math.abs(goal - next) < NODE_PAN_EPSILON ? goal : next)
      if (settled()) return
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [store, target])
}

/** 画面 1px が何ワールド単位か。視野高が VIEW_HEIGHT / zoom に固定されているので高さから決まる */
export function unitsPerPixel(zoom: number): number {
  return VIEW_HEIGHT / ((globalThis.innerHeight || 1) * zoom)
}

/** ホイールの 1 ノッチ・ピンチの 1px あたりの拡大率の底 */
const WHEEL_SENSITIVITY = 0.0015
/** トラックパッドのピンチは ctrlKey 付きの小さな delta で来るので係数を分ける */
const PINCH_WHEEL_SENSITIVITY = 0.01

/** 操作の効き方。`paper` は L0 の紙面、`node` は L1 以降の大書（左右のパンだけ） */
export type PanMode = 'paper' | 'node'

/**
 * パン・拡大操作を要素に取り付ける。
 *
 * - 1 本指（マウス）のドラッグでパン。拡大しているときは縦にも送る
 * - 2 本指のピンチで拡大。同時に中点の移動ぶんをパンする
 * - ホイールで拡大（トラックパッドのピンチは ctrlKey 付きのホイールとして届く）
 *
 * 拡大はカーソル（ピンチなら 2 点の中点）の下にあるワールド座標を動かさない。
 * `allowZoom` を落とすとパンだけになる（拡大に追従できない Tier 3 の紙面向け）。
 *
 * `mode = 'node'` では拡大も縦送りも行わず、`nodePanXAtom` を左右に動かすだけになる。
 * L1 以降に拡大の概念が無いのと、上下は大書の高さで決め打たれているため。
 */
export function usePanZoomGesture(
  target: React.RefObject<HTMLElement | null>,
  mode: PanMode = 'paper',
  allowZoom = true,
): void {
  const setPan = useSetAtom(panXAtom)
  const setNodePan = useSetAtom(nodePanTargetAtom)
  const setPanY = useSetAtom(panYAtom)
  const setZoom = useSetAtom(zoomAtom)
  const zoom = useAtomValue(zoomAtom)
  // イベントハンドラからは常に最新の拡大率を見る（listener を貼り直さずに済ませる）
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const element = target.current
    if (!element) return
    const nodeMode = mode === 'node'

    /** いま接触している指。ピンチの判定に使う */
    const pointers = new Map<number, { x: number; y: number }>()
    let drag: { pointerId: number; travelled: number } | null = null
    /** 直前のピンチの 2 点間距離。null ならピンチ中でない */
    let pinchDistance: number | null = null

    /** 画面座標を視野中心からのオフセット（px）へ直す */
    const offsetFromCenter = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect()
      return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) }
    }

    /**
     * 指定した画面座標を固定したまま拡大率を factor 倍する。
     * その点のワールド座標は camera + offset * unitsPerPixel なので、
     * 拡大の前後で一致させるにはカメラを offset * (前 - 後) だけずらせばよい。
     */
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      if (!allowZoom || nodeMode) return
      const before = zoomRef.current
      const after = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, before * factor))
      if (after === before) return
      const offset = offsetFromCenter(clientX, clientY)
      const shift = unitsPerPixel(before) - unitsPerPixel(after)
      zoomRef.current = after
      setZoom(after)
      setPan((x) => x + offset.x * shift)
      // 画面の y は下向き、ワールドの y は上向き
      setPanY((y) => y - offset.y * shift)
    }

    /** 紙面を掴んで動かす感覚にする。指の向きと紙面の向きを一致させる */
    const panBy = (dx: number, dy: number) => {
      if (nodeMode) {
        // L1 以降は等倍固定。左右だけ送る
        setNodePan((x) => x - dx * unitsPerPixel(1))
        return
      }
      const units = unitsPerPixel(zoomRef.current)
      setPan((x) => x - dx * units)
      setPanY((y) => y + dy * units)
    }

    const onPointerDown = (event: PointerEvent) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        // 2 本目が触れた時点でドラッグを畳み、ピンチへ切り替える
        drag = null
        const pair = pinchPair(pointers)
        pinchDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : null
        return
      }
      if (pointers.size > 2 || drag) return
      // ここではまだ捕捉しない。捕捉すると pointerup がキャンバスへ届かず、
      // r3f のクリック判定（down と up が同じ物体）が成立しなくなる
      drag = { pointerId: event.pointerId, travelled: 0 }
    }

    const onPointerMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId)
      if (!previous) return
      const dx = event.clientX - previous.x
      const dy = event.clientY - previous.y
      previous.x = event.clientX
      previous.y = event.clientY

      const pair = pinchPair(pointers)
      if (pair) {
        const [a, b] = pair
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDistance && distance > 0) {
          zoomAt(distance / pinchDistance, (a.x + b.x) / 2, (a.y + b.y) / 2)
        }
        pinchDistance = distance
        // 2 点の中点が動いたぶんは平行移動として扱う。片方だけ動かしたときの移動量は半分になる
        panBy(dx / 2, dy / 2)
        return
      }

      const state = drag
      if (!state || state.pointerId !== event.pointerId) return
      state.travelled += Math.abs(dx) + Math.abs(dy)
      // 明確にドラッグと判った時点で初めて捕捉する。それ未満はタップとして扱う
      if (state.travelled < CLICK_SLOP_PX) return
      if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId)
      panBy(dx, dy)
    }

    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinchDistance = null
      if (drag?.pointerId === event.pointerId) drag = null
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }

    const onWheel = (event: WheelEvent) => {
      if (!allowZoom || nodeMode) return
      // ページ全体のスクロール・ブラウザのピンチズームへ流さない
      event.preventDefault()
      const sensitivity = event.ctrlKey ? PINCH_WHEEL_SENSITIVITY : WHEEL_SENSITIVITY
      zoomAt(Math.exp(-event.deltaY * sensitivity), event.clientX, event.clientY)
    }

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onPointerUp)
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerUp)
      element.removeEventListener('wheel', onWheel)
    }
  }, [target, mode, allowZoom, setPan, setNodePan, setPanY, setZoom])
}

type Point = { x: number; y: number }

/** 接触中の指のうち先の 2 本。2 本に満たなければ null（＝ピンチではない） */
function pinchPair(pointers: Map<number, Point>): [Point, Point] | null {
  const [a, b] = [...pointers.values()]
  return a && b ? [a, b] : null
}

/** ドラッグ距離がこの px 未満ならクリックとして扱う（パンとタップの弁別） */
export const CLICK_SLOP_PX = 6

export function usePanX(): number {
  return useAtomValue(panXAtom)
}
