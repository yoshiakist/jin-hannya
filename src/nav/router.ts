/**
 * 実パスルーティング。`/goun/shiki` のようにノードパスを URL に載せる。
 *
 * history は Next（next/navigation）に任せ、自前の pushState / state.depth 管理はしない。
 * 潜る・戻るのどちらも「演出が idle に落ちたら router.push」で 1 段ずつ積む標準挙動。
 * ブラウザバック／フォワードは pathname の変化として受け、深度を比べて
 * ズームイン／アウトの演出付きで状態へ反映する。
 *
 * 初期表示のノードは atom の初期値が既に URL から引いている（src/nav/url.ts）。
 * ここが扱うのはマウント後の変化だけ。
 */

import { useAtomValue, useSetAtom } from 'jotai'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { navAtom, currentNodeAtom } from './atoms.ts'
import { root, nodeById, ancestryOf } from '../content/loader.ts'
import { acceptsInput } from './fsm.ts'
import { pathOf, normalizePath, idFromPath } from './url.ts'

export function useRouteSync(): void {
  const router = useRouter()
  const pathname = usePathname()
  const dispatch = useSetAtom(navAtom)
  const nav = useAtomValue(navAtom)
  const current = useAtomValue(currentNodeAtom)
  /** 取り込み済みの pathname（正規形） */
  const applied = useRef<string | null>(null)
  /** URL から取り込んだが、状態がまだ追いついていないノード id */
  const ingesting = useRef<string | null>(null)
  /**
   * 自分が push して、pathname への反映を待っているパス（正規形）。
   * router.push は非同期で、反映までの窓の間に hover 等で効果が再実行される。
   * この控えが無いと、その窓の古い pathname を「外部から URL が変わった」と誤認して
   * 出発点へ back を dispatch してしまう（遷移が逆再生で押し戻される。実際に踏んだ）。
   */
  const pushing = useRef<string | null>(null)

  // URL → 状態（ブラウザバック・フォワード）。深度を比べてズームの向きを決める
  useEffect(() => {
    const path = normalizePath(pathname)
    if (applied.current !== path) {
      applied.current = path
      if (pushing.current === path) {
        // 自分の push が反映されただけ。状態は既に行き先に居る
        pushing.current = null
      } else {
        // 外部からの変化。反映前に追い越された push があれば捨てる
        pushing.current = null
        ingesting.current = idFromPath(path)
      }
    }

    const target = ingesting.current
    if (target === null) return
    if (target === current.id) {
      ingesting.current = null
      return
    }
    // 遷移演出の最中に来た分は、idle に落ちたときこの効果が拾い直す
    if (!acceptsInput(nav.phase)) return

    const goingUp = ancestryOf(nodeById(target) ?? root).length < ancestryOf(current).length
    dispatch(goingUp ? { type: 'back', id: target } : { type: 'enter', id: target })
  }, [pathname, current, nav.phase, dispatch])

  // 状態 → URL。演出が終わって落ち着いたところで 1 度だけ積む
  useEffect(() => {
    if (!acceptsInput(nav.phase)) return
    // URL 側が先に変わっている（ブラウザバック直後）。上の効果が状態を追従させる
    if (ingesting.current !== null) return
    // 前の push がまだ pathname に反映されていない。反映されたら上の効果が拾い、ここが再評価される
    if (pushing.current !== null) return

    const next = pathOf(current.id)
    if (normalizePath(pathname) === normalizePath(next)) return

    pushing.current = normalizePath(next)
    router.push(next, { scroll: false })
  }, [nav.phase, current, pathname, router])
}
