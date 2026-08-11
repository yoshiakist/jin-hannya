/**
 * DOM レイヤー。
 *
 * 縦書きの長文組版・サマリー・読み／梵語・読み上げボタン・現在位置インジケータ・左矢印。
 * 数百字級の縦組みを GPU で描くと品質・実装コスト・アクセシビリティのすべてで損をするため、
 * **組版は DOM、絵は GPU** に振り分ける（README「2 レイヤー合成」）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  currentNodeAtom,
  currentDocAtom,
  childNodesAtom,
  relatedNodesAtom,
  ancestryAtom,
  navAtom,
  isRootAtom,
  acceptsInputAtom,
  phaseAtom,
  leavingAtom,
  leavingToRootAtom,
} from '../nav/atoms.ts'
import { overlayInsets, DOC_EDGE_PX } from '../world/node-layout.ts'
import {
  nodePanXAtom,
  nodePanRangeAtom,
  settleNodePanAtom,
  unitsPerPixel,
  isGestureClick,
} from '../world/pan.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import { labelText, splitColumns, type GraphNode } from '../content/schema.ts'
import { parseRuby } from '../content/ruby.ts'
import { glyphUrl } from '../content/glyph-svg.ts'
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
  // 関連語句は本文のさらに左。本文の幅も組版の結果なので実測して渡す
  const related = useMeasuredElement()
  const nav = useAtomValue(navAtom)
  const rootRef = useRef<HTMLDivElement>(null)
  useNodePan(
    rootRef,
    // 行き先が決まった時点でパンを戻す（遷移中は pendingId が行き先）
    nav.pendingId ?? nav.nodeId,
    [summary.element, body.element, related.element],
    [node, size, summary.width, body.width],
  )
  // 本文の組み立ては原稿が変わったときだけ。オーバーレイは hover や相の変化でも
  // 再レンダーされるので、そのたびに数千字を読み直すと重い
  const blocks = useMemo(() => (doc ? parseBlocks(doc.body) : []), [doc])

  return (
    <div
      ref={rootRef}
      className="overlay"
      // 大書は WebGPU レイヤーにあり DOM からは測れない。カメラと同じ式で出した
      // 画面右端からの距離を渡し、読み・サマリー・本文の x はこの 3 つから CSS が組む。
      // パンのぶん（--node-pan-px）はここに書かない。毎フレーム変わる値なので、
      // React を通さず `useNodePan` が rootRef へ直に当てる
      style={
        {
          '--headline-right': `${insets.headlineRight}px`,
          '--headline-left': `${insets.headlineLeft}px`,
          '--diagram-left': `${insets.diagramLeft}px`,
          '--summary-width': `${summary.width}px`,
          '--doc-width': `${body.width}px`,
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
            {/* 監修の断り。本文の頭（右上）に置く。読み方を調整するための情報なので、
                読み終えてからでは遅い。記号ではなく字で言う（アイコンは新しい記号の系列を
                作ってしまい、琥珀＝いまの操作・青白＝痕跡の 2 色の約束の外に出る）。
                無印が既定で、印が付くのは例外の側 —— 監修が済めば YAML の行ごと消える */}
            {node.ai_generated && (
              <p className="overlay__doc-note">
                この解説は <span className="tcy">AI</span> が下書きしたまま、人手の監修を経ていない。
              </p>
            )}
            {blocks.map((block, i) =>
              block.type === 'list' ? (
                <ul key={i} className={blockClass(block.section && 'overlay__doc-section')}>
                  {block.items.map((item, j) => (
                    <li key={j}>{renderRuby(item)}</li>
                  ))}
                </ul>
              ) : (
                <p
                  key={i}
                  className={blockClass(
                    block.section && 'overlay__doc-section',
                    startsWithBracket(block.text) && 'overlay__doc-flush',
                  )}
                >
                  {renderRuby(block.text)}
                </p>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <RelatedTerms measure={related.measure} appearDelay={appearDelay} />

      <LeftArrow />
    </div>
  )
}

/** 本文のブロックに付くクラス。大段落の頭と、字下げを抑える段落を重ねる */
function blockClass(...names: (string | false | undefined)[]): string | undefined {
  const list = names.filter((name): name is string => Boolean(name))
  return list.length ? list.join(' ') : undefined
}

/**
 * 関連語句。木の子ではない隣接語を、本文のさらに左に散らして浮かべる。
 *
 * 並べない。子の図（円相・縦連結）が関係の**構造**を見せる場所であるのに対し、ここは
 * 「気になったものへ行ってよい」という誘いなので、整列させると順序や優劣を主張してしまう。
 * 位置は id から決まる擬似乱数で散らし、ゆっくり漂わせる（紙面の字のゆらぎと同じ考え方）。
 *
 * 位置が毎回同じであることは大事で、戻ってきたときに同じ語が同じ所に居ないと、
 * 「さっき見たあれ」を掴み直せない。乱数は必ず id から引き、実行のたびに振り直さない。
 */
function RelatedTerms({
  measure,
  appearDelay,
}: {
  measure: (element: HTMLElement | null) => void
  appearDelay: number
}) {
  const related = useAtomValue(relatedNodesAtom)
  const leaving = useAtomValue(leavingAtom)
  const accepts = useAtomValue(acceptsInputAtom)
  const dispatch = useSetAtom(navAtom)

  return (
    <AnimatePresence>
      {related.length > 0 && !leaving && (
        <motion.aside
          key={`related-${related.map((n) => n.id).join('-')}`}
          ref={measure}
          className="overlay__related"
          aria-label="関連語句"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45, delay: 0 } }}
          transition={{ duration: 0.6, delay: appearDelay + 0.18 }}
        >
          <p className="overlay__related-heading" aria-hidden>
            関連語句
          </p>
          <div className="overlay__related-cloud">
            {related.map((term, i) => {
              const spot = scatter(term.id, i, related.length)
              return (
                <button
                  key={term.id}
                  type="button"
                  className="related-term"
                  disabled={!accepts}
                  style={
                    {
                      '--x': `${spot.x}%`,
                      '--y': `${spot.y}%`,
                      '--drift-x': `${spot.driftX}px`,
                      '--drift-y': `${spot.driftY}px`,
                      '--drift-duration': `${spot.duration}s`,
                      '--drift-delay': `${spot.delay}s`,
                    } as React.CSSProperties
                  }
                  // パン・ピンチの離しぎわに届くクリックは捨てる（→ world/pan.ts）
                  onClick={() => !isGestureClick() && dispatch({ type: 'enter', id: term.id })}
                >
                  <RelatedLabel text={labelText(term.label)} />
                </button>
              )
            })}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/**
 * 関連語句の字面。大書や紙面と同じ筆文字の SVG を 1 字ずつ縦に積む。
 *
 * ここだけ書体で出すと、同じ画面の中で「行ける語」の見た目が 2 種類になる。字は型紙
 * （`mask-image`）として敷き、塗りは CSS のトークンから引くので、hover の琥珀も他と揃う。
 *
 * 在庫が無い字は素の文字のまま出す。`label` の在庫はビルド時に検証されているので通常は起きない
 * が、ここで落ちると語ごと消えて行き先が失われるため、字面が変わるだけに留める。
 */
function RelatedLabel({ text }: { text: string }) {
  return (
    <>
      {Array.from(text).map((char, i) => {
        const url = glyphUrl(char)
        return url ? (
          <span
            key={i}
            className="related-term__glyph"
            style={{ '--glyph': `url(${JSON.stringify(url)})` } as React.CSSProperties}
            // 字面は装飾。読み上げ・検索には素の文字を渡す
            aria-hidden
          />
        ) : (
          <span key={i} className="related-term__char">
            {char}
          </span>
        )
      })}
      <span className="visually-hidden">{text}</span>
    </>
  )
}

/**
 * 散らし配置。id から引いた擬似乱数で、雲の中の位置と漂い方を決める。
 *
 * 縦（`y`）だけは語ごとの帯に分ける。完全な乱数だと重なる組み合わせが出て、
 * 2 つの語が読めなくなる。帯の中で揺らせば、整列しては見えないまま重なりだけが避けられる。
 */
function scatter(id: string, index: number, count: number) {
  const seed = hash(id)
  const pick = (shift: number, min: number, max: number) =>
    min + (((seed >>> shift) & 0xff) / 0xff) * (max - min)

  const band = 100 / count
  return {
    // 右端（本文側）に寄りすぎない範囲で左右に散らす
    x: pick(0, 3, 72),
    y: index * band + pick(8, 0.12, 0.62) * band,
    driftX: pick(16, -7, 7),
    driftY: pick(20, -9, 9),
    duration: pick(24, 7, 13),
    // 位相をずらす。負の delay で最初から途中の状態にする（一斉に動き出さない）
    delay: -pick(12, 0, 12),
  }
}

/** 文字列から 32bit の種を作る（FNV-1a）。実行のたびに同じ値になることだけが要件 */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
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
 * L1 以降のパン。可動域を実測して atom へ入れ、いまのパン量を CSS 変数として当てる。
 *
 * 本文は画面より広くなりうる（README「画面外へはみ出してよい」）。左へはみ出したぶんだけ
 * ドラッグで送れるようにするのがここの役目で、可動域は本文とサマリーの左端から決まる。
 *
 * 位置は `getBoundingClientRect` ではなく `offsetLeft` で読む。パンは transform で当てるので、
 * rect で測ると送った量が次の可動域に混ざり、測り直すたびに可動域が動いてしまう。
 *
 * **パン量は React を通さない。** `useAtomValue` で受けるとばねの 1 フレームごとに
 * オーバーレイ全体（縦組みの本文・motion・関連語句）が作り直され、原稿が長いノードほど
 * ドラッグが重くなる。GPU 側のカメラと同じく store を直に購読し、
 * 根の要素の `--node-pan-px` へ書くだけにする（読む値は同じ 1 つの atom のまま）。
 */
function useNodePan(
  root: React.RefObject<HTMLElement | null>,
  destinationId: string,
  elements: (HTMLElement | null)[],
  deps: unknown[],
): void {
  const store = useStore()
  const settle = useSetAtom(settleNodePanAtom)
  const setRange = useSetAtom(nodePanRangeAtom)

  // ワールド単位のパン量を px へ直して当てる。左へ送る（負）と本文は右へ動く
  useLayoutEffect(() => {
    const apply = () => {
      const element = root.current
      if (!element) return
      const px = (-store.get(nodePanXAtom) * (globalThis.innerHeight || 0)) / VIEW_HEIGHT
      element.style.setProperty('--node-pan-px', `${px}px`)
    }
    apply()
    return store.sub(nodePanXAtom, apply)
  }, [store, root])

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
                    onClick={() => !isGestureClick() && dispatch({ type: 'back', id: node.id })}
                  >
                    {text.length > 7 ? `${text.slice(0, 3)}～${text.slice(-3)}` : text}
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
