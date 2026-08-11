/**
 * L0 の左上に据える「このサイトについて」。
 *
 * 出すのは紙面（L0）のあいだだけ。潜ったら引く —— 潜った先の左上は現在位置インジケータの
 * 場所で、深さを示す線と外向きのリンクが同じ角で競合する。L0 ではインジケータが出ないので、
 * この角は空いている。
 *
 * 実体は素の `<a>`（next/link）にしておく。クリックは URL の変化として `useRouteSync` が
 * 拾い、ブラウザバックと同じ経路で演出付きの遷移になる（自前で dispatch しない）。
 * クローラと読み上げにも、隠しテキストを増やさずそのまま行き先が渡る。
 */

import Link from 'next/link'
import { AnimatePresence, motion } from 'motion/react'
import { useAtomValue } from 'jotai'
import { isRootAtom, leavingAtom, acceptsInputAtom } from '../nav/atoms.ts'
import { isGestureClick } from '../world/pan.ts'
import { ABOUT_PATH, hasAboutPage } from '../nav/about.ts'

export function AboutLink() {
  const isRoot = useAtomValue(isRootAtom)
  const leaving = useAtomValue(leavingAtom)
  const accepts = useAtomValue(acceptsInputAtom)

  return (
    <AnimatePresence>
      {hasAboutPage && isRoot && !leaving && (
        <motion.nav
          key="about-link"
          className="about-link"
          aria-label="サイト情報"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45 } }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Link
            href={ABOUT_PATH}
            onClick={(event) => {
              // 紙面のドラッグの離しぎわに届くクリックは捨てる（→ world/pan.ts）。
              // 演出の最中も同じく、入口を開けない
              if (isGestureClick() || !accepts) event.preventDefault()
            }}
          >
            このサイトについて
          </Link>
        </motion.nav>
      )}
    </AnimatePresence>
  )
}
