/**
 * DOM レイヤー。
 *
 * 縦書きの長文組版・サマリー・読み／梵語・読み上げボタン・現在位置インジケータ・左矢印。
 * 数百字級の縦組みを GPU で描くと品質・実装コスト・アクセシビリティのすべてで損をするため、
 * **組版は DOM、絵は GPU** に振り分ける（README「2 レイヤー合成」）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  currentNodeAtom,
  currentDocAtom,
  childNodesAtom,
  ancestryAtom,
  navAtom,
  isRootAtom,
  acceptsInputAtom,
} from '../nav/atoms.ts'
import { overlayInsets } from '../world/node-layout.ts'
import { labelText, type GraphNode } from '../content/schema.ts'
import { APPEAR_DELAY_MS } from '../scene/Transition.tsx'
import { SpeakButton } from './SpeakButton.tsx'
import { AudioControls } from './AudioControls.tsx'
import { LeftArrow } from './LeftArrow.tsx'

/**
 * ノードが変わるたびにテキスト群を差し替える。
 * AnimatePresence は既定（sync）で使う。mode="wait" にすると退場の完了を待つぶん
 * 表示が遅れ、続けて潜ったときにブロックが出てこないことがある。
 */
/**
 * テキストが現れ始めるまでの間（秒）。GPU レイヤーの字と同じだけ待たせる。
 * 退場には効かせない（退場は演出の開始と同時に引いてよい）。
 */
const APPEAR_DELAY_S = APPEAR_DELAY_MS / 1000

export function Overlay() {
  const node = useAtomValue(currentNodeAtom)
  const doc = useAtomValue(currentDocAtom)
  const children = useAtomValue(childNodesAtom)
  const isRoot = useAtomValue(isRootAtom)
  const insets = useOverlayInsets(node, children)
  // サマリーの幅は字数と `max-height` が決める。本文はその左から始まるので実測して渡す
  const [summaryWidth, measureSummary] = useMeasuredWidth()

  return (
    <div
      className="overlay"
      // 大書は WebGPU レイヤーにあり DOM からは測れない。カメラと同じ式で出した
      // 画面右端からの距離を渡し、読み・サマリー・本文の x はこの 3 つから CSS が組む
      style={
        {
          '--headline-right': `${insets.headlineRight}px`,
          '--headline-left': `${insets.headlineLeft}px`,
          '--diagram-left': `${insets.diagramLeft}px`,
          '--summary-width': `${summaryWidth}px`,
        } as React.CSSProperties
      }
    >
      <Breadcrumb />
      <div className="overlay__top">
        <SpeakButton />
        <AudioControls />
      </div>

      <AnimatePresence>
        {!isRoot && (
          <motion.div
            key={node.id}
            className="overlay__reading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
            transition={{ duration: 0.45, delay: APPEAR_DELAY_S }}
          >
            {/* 読みの空白は列の切れ目。大書の label と同じ約束で、どこで折るかは
                コンテンツ側（`content/graph/*.yaml` の reading）が決める */}
            {node.reading
              .split(/\s+/u)
              .filter((part) => part.length > 0)
              .map((part, i) => (
                <p key={i} className="reading">
                  {part}
                </p>
              ))}
            {node.sanskrit && (
              <p className="sanskrit">
                <span className="sanskrit__kana">{node.sanskrit.kana}</span>
                <span className="sanskrit__latin">{node.sanskrit.text}</span>
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isRoot && (
          <motion.div
            key={`summary-${node.id}`}
            ref={measureSummary}
            className="overlay__summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
            transition={{ duration: 0.45, delay: APPEAR_DELAY_S + 0.08 }}
          >
            <p>{node.summary}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isRoot && doc && (
          <motion.div
            key={`doc-${node.id}`}
            className="overlay__doc"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5, delay: 0 } }}
            transition={{ duration: 0.5, delay: APPEAR_DELAY_S + 0.12 }}
          >
            {doc.body.split(/\n{2,}/).map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <LeftArrow />
    </div>
  )
}

/**
 * 大書と図の位置（画面右端からの px）。
 *
 * 可動域と同じで**ビューポート依存**なので定数にせず、リサイズのたびに引き直す。
 * カメラ（`nodePanX`）と同じ式から出すので、DOM と WebGPU の 2 層が同じ構図を見る。
 */
function useOverlayInsets(node: GraphNode, children: GraphNode[]) {
  const [size, setSize] = useState(viewportSize)
  useEffect(() => {
    const onResize = () => setSize(viewportSize())
    globalThis.addEventListener('resize', onResize)
    return () => globalThis.removeEventListener('resize', onResize)
  }, [])
  return useMemo(
    () => overlayInsets(node, children, size.width, size.height),
    [node, children, size],
  )
}

function viewportSize(): { width: number; height: number } {
  return { width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 }
}

/** 要素の幅を測り続けるコールバック ref。返り値の ref はそのまま要素へ渡す */
function useMeasuredWidth(): [number, (element: HTMLElement | null) => void] {
  const [width, setWidth] = useState(0)
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [width, ref]
}

/**
 * 現在位置インジケータ。
 * 画面端に 1 本の白い縦線を引き、先祖ノードを縦に積む。筆文字にせず通常書体で組む。
 * 深さ = 潜水深度のメタファー。
 */
function Breadcrumb() {
  const ancestry = useAtomValue(ancestryAtom)
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)

  if (ancestry.length <= 1) return null

  return (
    <nav className="breadcrumb" aria-label="現在位置">
      <span className="breadcrumb__rule" aria-hidden />
      <ol>
        {ancestry.map((node, depth) => {
          const current = depth === ancestry.length - 1
          // 列の切れ目は大書だけのもの。ここは 1 行の見出しとして詰めて出す
          const text = labelText(node.label)
          return (
            <li key={node.id}>
              <button
                type="button"
                className={current ? 'is-current' : undefined}
                aria-current={current ? 'true' : undefined}
                disabled={current || !accepts}
                onClick={() => dispatch({ type: 'back', id: node.id })}
              >
                {text.length > 6 ? `${text.slice(0, 5)}…` : text}
              </button>
            </li>
          )
        })}
      </ol>
      <span className="breadcrumb__depth" aria-hidden />
    </nav>
  )
}
