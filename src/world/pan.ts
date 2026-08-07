/**
 * ドラッグによるカメラのパン。
 *
 * PC・スマホの区別なく同じ操作にする（README「ナビゲーション / 左矢印」）。
 * パン量は 1 つの atom に集約し、WebGPU レイヤーのカメラと DOM オーバーレイの
 * transform が**同じ値**を読むことで両レイヤーの同期を保証する。
 *
 * 可動域はビューポート依存である。紙面は縦 16 升ぶんが画面高に収まるよう描かれるので、
 * 横がはみ出すかどうかは画面のアスペクト比で決まる（縦長のスマホでは必ずはみ出し、
 * 横長の PC では収まりきることがある）。だから範囲は定数にせず、実測から毎回引き直す。
 */

import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { CELL_X, PAPER_WIDTH, VIEW_HEIGHT } from './paper.ts'

export interface PanBounds {
  /** 最も左まで送った状態のカメラ x */
  min: number
  /** 読み始めの位置。紙面の右上に相当するカメラ x */
  max: number
}

/** 画面端と紙面のあいだに残す余白（ワールド単位） */
const EDGE_MARGIN = CELL_X

/**
 * ビューポート半幅（ワールド単位）からパンの可動域を出す。
 * 第 1 列は x = 0、最終列は x = -PAPER_WIDTH にある。
 */
export function panBoundsFor(halfWidth: number): PanBounds {
  // 第 1 列を画面の右端へ寄せた位置が読み始め
  const max = -(halfWidth - EDGE_MARGIN)
  // 最終列を画面の左端へ寄せた位置が左端
  const min = -PAPER_WIDTH + halfWidth - EDGE_MARGIN
  // 紙面が画面より狭ければ動かさない（右端寄せのまま固定）
  return min >= max ? { min: max, max } : { min, max }
}

/** ビューポートの寸法（px）からカメラのビューポート半幅（ワールド単位）を出す */
export function halfWidthFor(width: number, height: number): number {
  return height > 0 ? (width / height) * VIEW_HEIGHT * 0.5 : 0
}

/**
 * 起動時の可動域。実測は Canvas のマウント後に Stage が引き直すが、
 * それを待つと最初の数フレームだけ紙面が中央に描かれ、右端寄せへ動いて見える。
 * 最初の 1 フレームから読み始めの位置で描くために窓の寸法から先に出しておく。
 */
function initialBounds(): PanBounds {
  const width = globalThis.innerWidth || 0
  const height = globalThis.innerHeight || 0
  if (!width || !height) return { min: 0, max: 0 }
  return panBoundsFor(halfWidthFor(width, height))
}

const startBounds = initialBounds()

export const panBoundsAtom = atom<PanBounds>(startBounds)

/** 読み始めは紙面の右上、すなわち第 1 列の先頭。カメラの初期位置もこれに合わせる */
export const INITIAL_PAN_X = startBounds.max

const panXRaw = atom(INITIAL_PAN_X)

/** ワールド単位でのカメラ x。書き込みは常に可動域へクランプされる */
export const panXAtom = atom(
  (get) => get(panXRaw),
  (get, set, update: number | ((previous: number) => number)) => {
    const { min, max } = get(panBoundsAtom)
    const next = typeof update === 'function' ? update(get(panXRaw)) : update
    set(panXRaw, Math.min(max, Math.max(min, next)))
  },
)

/** 左へまだ紙面が残っているか。左矢印の明滅の可否 */
export const canPanLeftAtom = atom((get) => get(panXAtom) > get(panBoundsAtom).min + 1e-3)

/**
 * パン操作を要素に取り付ける。
 * `unitsPerPixel` は「画面 1px が何ワールド単位か」。カメラの視野から算出して渡す。
 */
export function usePanGesture(
  target: React.RefObject<HTMLElement | null>,
  unitsPerPixel: () => number,
  enabled = true,
): void {
  const setPan = useSetAtom(panXAtom)
  const dragging = useRef<{ pointerId: number; lastX: number; travelled: number } | null>(null)

  useEffect(() => {
    const element = target.current
    if (!element || !enabled) return

    const onPointerDown = (event: PointerEvent) => {
      if (dragging.current) return
      // ここではまだ捕捉しない。捕捉すると pointerup がキャンバスへ届かず、
      // r3f のクリック判定（down と up が同じ物体）が成立しなくなる
      dragging.current = { pointerId: event.pointerId, lastX: event.clientX, travelled: 0 }
    }

    const onPointerMove = (event: PointerEvent) => {
      const state = dragging.current
      if (!state || state.pointerId !== event.pointerId) return
      const dx = event.clientX - state.lastX
      state.lastX = event.clientX
      state.travelled += Math.abs(dx)
      // 明確にドラッグと判った時点で初めて捕捉する。それ未満はタップとして扱う
      if (state.travelled < CLICK_SLOP_PX) return
      if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId)
      // 紙面を掴んで動かす感覚にする。指の向きと紙面の向きを一致させる
      setPan((x) => x - dx * unitsPerPixel())
    }

    const onPointerUp = (event: PointerEvent) => {
      if (dragging.current?.pointerId !== event.pointerId) return
      dragging.current = null
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onPointerUp)
    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerUp)
    }
  }, [target, unitsPerPixel, enabled, setPan])
}

/** ドラッグ距離がこの px 未満ならクリックとして扱う（パンとタップの弁別） */
export const CLICK_SLOP_PX = 6

export function usePanX(): number {
  return useAtomValue(panXAtom)
}
