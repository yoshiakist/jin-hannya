/**
 * 左下の `←`。
 *
 * 「左にまだ紙面がある」ことの示唆であり、ボタンではない。
 * パン可能な方向を明滅で示し、左端に到達したら明滅を止める（README「左矢印」）。
 */

import { useAtomValue } from 'jotai'
import { canPanLeftAtom, canNodePanLeftAtom, nodePanRangeAtom } from '../world/pan.ts'
import { isRootAtom } from '../nav/atoms.ts'

export function LeftArrow() {
  const canPanLeft = useAtomValue(canPanLeftAtom)
  const canNodePanLeft = useAtomValue(canNodePanLeftAtom)
  const nodePanRange = useAtomValue(nodePanRangeAtom)
  const isRoot = useAtomValue(isRootAtom)

  // 潜った先では本文が画面より広いときだけ出す（送り先が無いのに示唆しない）
  if (!isRoot && nodePanRange <= 0) return null

  const blinking = isRoot ? canPanLeft : canNodePanLeft

  return (
    <div className={`left-arrow${blinking ? ' is-blinking' : ''}`} aria-hidden>
      <svg viewBox="0 0 48 16" width="48" height="16" focusable="false">
        <path
          d="M46 8H2m0 0 6-5M2 8l6 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
