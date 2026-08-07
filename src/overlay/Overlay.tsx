/**
 * DOM レイヤー。
 *
 * 縦書きの長文組版・サマリー・読み／梵語・読み上げボタン・現在位置インジケータ・左矢印。
 * 数百字級の縦組みを GPU で描くと品質・実装コスト・アクセシビリティのすべてで損をするため、
 * **組版は DOM、絵は GPU** に振り分ける（README「2 レイヤー合成」）。
 */

import { AnimatePresence, motion } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  currentNodeAtom,
  currentDocAtom,
  ancestryAtom,
  navAtom,
  isRootAtom,
  acceptsInputAtom,
} from '../nav/atoms.ts'
import { labelText } from '../content/schema.ts'
import { SpeakButton } from './SpeakButton.tsx'
import { AudioControls } from './AudioControls.tsx'
import { LeftArrow } from './LeftArrow.tsx'

/**
 * ノードが変わるたびにテキスト群を差し替える。
 * AnimatePresence は既定（sync）で使う。mode="wait" にすると退場の完了を待つぶん
 * 表示が遅れ、続けて潜ったときにブロックが出てこないことがある。
 */
export function Overlay() {
  const node = useAtomValue(currentNodeAtom)
  const doc = useAtomValue(currentDocAtom)
  const isRoot = useAtomValue(isRootAtom)

  return (
    <div className="overlay">
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
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45 }}
          >
            <p className="reading">{node.reading}</p>
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
            className="overlay__summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, delay: 0.08 }}
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
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, delay: 0.12 }}
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
