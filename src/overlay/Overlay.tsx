/**
 * DOM レイヤー。
 *
 * 縦書きの長文組版・サマリー・読み／梵語・読み上げボタン・現在位置インジケータ・左矢印。
 * 数百字級の縦組みを GPU で描くと品質・実装コスト・アクセシビリティのすべてで損をするため、
 * **組版は DOM、絵は GPU** に振り分ける（README「2 レイヤー合成」）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  phaseAtom,
  leavingAtom,
  leavingToRootAtom,
} from '../nav/atoms.ts'
import { overlayInsets, DOC_EDGE_PX } from '../world/node-layout.ts'
import { nodePanXAtom, nodePanRangeAtom, settleNodePanAtom, unitsPerPixel } from '../world/pan.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import { labelText, splitColumns, type GraphNode } from '../content/schema.ts'
import { parseRuby } from '../content/ruby.ts'
import { parseBlocks, startsWithBracket } from '../content/blocks.ts'
import { APPEAR_DELAY_MS, RETURN_APPEAR_DELAY_MS, TRANSITION_MS } from '../scene/Transition.tsx'
import { SpeakButton } from './SpeakButton.tsx'
import { AudioControls } from './AudioControls.tsx'
import { LeftArrow } from './LeftArrow.tsx'

/**
 * ノードが変わるたびにテキスト群を差し替える。
 * AnimatePresence は既定（sync）で使う。mode="wait" にすると退場の完了を待つぶん
 * 表示が遅れ、続けて潜ったときにブロックが出てこないことがある。
 */
/**
 * テキストが現れ始めるまでの間（秒）。GPU レイヤーの字（`StageFade`）と同じだけ待たせる。
 * 向きで変わる：潜るときは持ち越しの字の着地を見せきってから、戻るときは待たずに出す
 * （凝集しきった光をそのまま字へ渡し、光はそのあとで引く）。
 * 退場には効かせない（退場は演出の開始と同時に引いてよい）。
 *
 * 相が `idle` に戻ってから中身が差し替わるので、直前の遷移の向きを覚えておいて引く。
 */
function useAppearDelay(): number {
  const phase = useAtomValue(phaseAtom)
  const delay = useRef(APPEAR_DELAY_MS)
  if (phase === 'zooming-out') delay.current = RETURN_APPEAR_DELAY_MS
  else if (phase === 'zooming-in') delay.current = APPEAR_DELAY_MS
  return delay.current / 1000
}

export function Overlay() {
  const appearDelay = useAppearDelay()
  const node = useAtomValue(currentNodeAtom)
  const doc = useAtomValue(currentDocAtom)
  const children = useAtomValue(childNodesAtom)
  const isRoot = useAtomValue(isRootAtom)
  // 戻り始めた時点で退場させる。`node` が入れ替わる（settled）のを待つと演出の終わりまで残る
  const leaving = useAtomValue(leavingAtom)
  const size = useViewportSize()
  const insets = useOverlayInsets(node, children, size)
  // サマリーの幅は字数と `max-height` が決める。本文はその左から始まるので実測して渡す
  const summary = useMeasuredElement()
  const body = useMeasuredElement()
  const nav = useAtomValue(navAtom)
  const nodePan = useNodePan(
    // 行き先が決まった時点でパンを戻す（遷移中は pendingId が行き先）
    nav.pendingId ?? nav.nodeId,
    [summary.element, body.element],
    [node, size, summary.width, body.width],
  )

  return (
    <div
      className="overlay"
      // 大書は WebGPU レイヤーにあり DOM からは測れない。カメラと同じ式で出した
      // 画面右端からの距離を渡し、読み・サマリー・本文の x はこの 3 つから CSS が組む。
      // パンのぶんはレイアウトを崩さないよう transform で足す（--node-pan-px）
      style={
        {
          '--headline-right': `${insets.headlineRight}px`,
          '--headline-left': `${insets.headlineLeft}px`,
          '--diagram-left': `${insets.diagramLeft}px`,
          '--summary-width': `${summary.width}px`,
          '--node-pan-px': `${nodePan}px`,
        } as React.CSSProperties
      }
    >
      <Breadcrumb />
      <div className="overlay__top">
        <SpeakButton />
        <AudioControls />
      </div>

      <AnimatePresence>
        {!isRoot && !leaving && (
          <motion.div
            key={node.id}
            className="overlay__reading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
            transition={{ duration: 0.45, delay: appearDelay }}
          >
            {/* 読みとサンスクリット音訳は別の箱。読みは帯の上、音訳は帯の下に置く。
                同じ箱に入れると `/` で読みが 2 列になったとき音訳が 3 列目に回る */}
            <div className="overlay__reading-kana">
              {/* 読みの列の切れ目は `/`。大書の label と同じ約束で、どこで折るかは
                  コンテンツ側（`content/graph/*.yaml` の reading）が決める。
                  列の中の空白はそのまま出す */}
              {splitColumns(node.reading).map((part, i) => (
                <p key={i} className="reading">
                  {part}
                </p>
              ))}
            </div>
            {node.sanskrit && (
              <div className="overlay__reading-sanskrit">
                <p className="sanskrit">
                  <span className="sanskrit__kana">{node.sanskrit.kana}</span>
                  <span className="sanskrit__latin">{node.sanskrit.text}</span>
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isRoot && !leaving && (
          <motion.div
            key={`summary-${node.id}`}
            ref={summary.measure}
            className="overlay__summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
            transition={{ duration: 0.45, delay: appearDelay + 0.08 }}
          >
            <p>{node.summary}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isRoot && !leaving && doc && (
          <motion.div
            key={`doc-${node.id}`}
            ref={body.measure}
            className="overlay__doc"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.5, delay: 0 } }}
            transition={{ duration: 0.5, delay: appearDelay + 0.12 }}
          >
            {parseBlocks(doc.body).map((block, i) =>
              block.type === 'list' ? (
                <ul key={i}>
                  {block.items.map((item, j) => (
                    <li key={j}>{renderRuby(item)}</li>
                  ))}
                </ul>
              ) : (
                <p
                  key={i}
                  className={
                    startsWithBracket(block.text) ? 'overlay__doc-flush' : undefined
                  }
                >
                  {renderRuby(block.text)}
                </p>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <LeftArrow />
    </div>
  )
}

/**
 * 段落の `菩薩《ぼさつ》` を `<ruby>` に組み替える。
 *
 * 縦組み（`writing-mode: vertical-rl`）でも `<ruby>` はブラウザが親文字の右に流してくれるので、
 * 位置合わせは CSS に任せて字面だけ渡す。
 */
function renderRuby(paragraph: string) {
  return parseRuby(paragraph).map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      <ruby key={i}>
        {part.base}
        <rt>{part.ruby}</rt>
      </ruby>
    ),
  )
}

/**
 * 大書と図の位置（画面右端からの px）。
 *
 * 可動域と同じで**ビューポート依存**なので定数にせず、リサイズのたびに引き直す。
 * カメラ（`nodePanX`）と同じ式から出すので、DOM と WebGPU の 2 層が同じ構図を見る。
 */
function useOverlayInsets(node: GraphNode, children: GraphNode[], size: ViewportSize) {
  return useMemo(
    () => overlayInsets(node, children, size.width, size.height),
    [node, children, size],
  )
}

interface ViewportSize {
  width: number
  height: number
}

function useViewportSize(): ViewportSize {
  const [size, setSize] = useState(viewportSize)
  useEffect(() => {
    const onResize = () => setSize(viewportSize())
    globalThis.addEventListener('resize', onResize)
    return () => globalThis.removeEventListener('resize', onResize)
  }, [])
  return size
}

function viewportSize(): ViewportSize {
  return { width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 }
}

interface Measured {
  element: HTMLElement | null
  /** そのまま要素へ渡す ref */
  measure: (element: HTMLElement | null) => void
  width: number
}

/** 要素とその幅を測り続ける。幅は組版の結果なので、字数・画面寸法・書体の確定で変わる */
function useMeasuredElement(): Measured {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return { element, measure: setElement, width }
}

/**
 * L1 以降のパン。可動域を実測して atom へ入れ、いまのパン量を px で返す。
 *
 * 本文は画面より広くなりうる（README「画面外へはみ出してよい」）。左へはみ出したぶんだけ
 * ドラッグで送れるようにするのがここの役目で、可動域は本文とサマリーの左端から決まる。
 *
 * 位置は `getBoundingClientRect` ではなく `offsetLeft` で読む。パンは transform で当てるので、
 * rect で測ると送った量が次の可動域に混ざり、測り直すたびに可動域が動いてしまう。
 */
function useNodePan(destinationId: string, elements: (HTMLElement | null)[], deps: unknown[]): number {
  const pan = useAtomValue(nodePanXAtom)
  const settle = useSetAtom(settleNodePanAtom)
  const setRange = useSetAtom(nodePanRangeAtom)

  // ノードが変わったら基準の構図へ戻す。行き先が決まった時点（遷移の始まり）で戻すので、
  // 演出中のカメラは最初から新しいノードの構図へ向かう。
  // 戻すのは演出と同じ尺で（`settle(TRANSITION_MS)`）。その場で 0 を書くと、GPU 側はカメラが
  // 滑らかに動くのに DOM の本文だけが遷移の頭で横へ飛び、同じ値を読む 2 層が別々に動いて見える
  useEffect(() => {
    settle(TRANSITION_MS)
  }, [destinationId, settle])

  useLayoutEffect(() => {
    const lefts = elements.filter((element) => element !== null).map((element) => element.offsetLeft)
    const left = lefts.length > 0 ? Math.min(...lefts) : 0
    // 画面に収まっているうちは送り先を作らない（数十 px のためにパンを示唆しない）。
    // はみ出しているときは、左端が余白ぶん入り込むところまで送れるようにする
    const overflow = left < 0 ? DOC_EDGE_PX - left : 0
    setRange(overflow * unitsPerPixel(1))
    // 測る対象そのものを条件に入れる。要素は ref コールバック経由の state なので、
    // マウントしたレンダーではまだ null で、入った次のレンダーで測り直す必要がある。
    // 同じノードへ 2 度目に入ると `deps`（ノード・画面寸法・幅）はどれも前回と同じ値に
    // なるため、要素の同一性を見ないと測り直しが起きず可動域が 0 のまま固まる。
    // 配列は毎回新しくなるので中身を並べる（要素の本数はレンダーによらず一定）
  }, [setRange, ...elements, ...deps])

  // ワールド単位のパン量を px へ直す。左へ送る（負）と本文は右へ動く
  return (-pan * (globalThis.innerHeight || 0)) / VIEW_HEIGHT
}

/**
 * 現在位置インジケータ。
 * 画面端に 1 本の白い縦線を引き、先祖ノードを縦に積む。字は横組み・通常書体。
 * 深さ = 潜水深度のメタファー。
 *
 * L0（先祖が根だけ）では出さない。L1 へ潜るときに他のテキストと同じ間を置いてふわりと現れ、
 * L0 へ戻るときは演出の始まりと同時に引く。潜り続けるあいだは key を固定して出しっぱなしにし、
 * 中身（先祖の増減）だけが差し替わるようにする。
 */
function Breadcrumb() {
  const appearDelay = useAppearDelay()
  const ancestry = useAtomValue(ancestryAtom)
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)
  const leavingToRoot = useAtomValue(leavingToRootAtom)

  return (
    <AnimatePresence>
      {ancestry.length > 1 && !leavingToRoot && (
        <motion.nav
          key="breadcrumb"
          className="breadcrumb"
          aria-label="現在位置"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
          transition={{ duration: 0.45, delay: appearDelay }}
        >
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
        </motion.nav>
      )}
    </AnimatePresence>
  )
}
