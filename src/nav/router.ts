/**
 * ハッシュルーティング。`/#/goun/shiki` のようにノードパスを URL に載せる。
 *
 * ブラウザバック = ズームアウト（README「URL 同期」）。
 * これを成立させるため、潜るときだけ history に積み、戻るときは積まない。
 */

import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { navAtom, currentNodeAtom } from './atoms.ts'
import { root, nodeById, ancestryOf } from '../content/loader.ts'

function pathOf(id: string): string {
  const node = nodeById(id)
  if (!node) return '#/'
  const trail = ancestryOf(node)
    .filter((n) => n.id !== root.id)
    .map((n) => n.id)
  return `#/${trail.join('/')}`
}

function idFromHash(): string {
  const segments = globalThis.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  return last && nodeById(last) ? last : root.id
}

export function useHashRouting(): void {
  const dispatch = useSetAtom(navAtom)
  const nav = useAtomValue(navAtom)
  const current = useAtomValue(currentNodeAtom)
  /** 自分が書いた hash かどうか。自作の変更で popstate 相当の処理を走らせないための番人 */
  const writing = useRef(false)

  // 初期表示: URL のノードへ演出なしで合わせる
  useEffect(() => {
    const id = idFromHash()
    if (id !== root.id) dispatch({ type: 'sync', id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 状態 → URL。演出が終わって idle に落ちたところで 1 度だけ書く
  useEffect(() => {
    if (nav.phase !== 'idle') return
    const next = pathOf(current.id)
    if (globalThis.location.hash === next) return

    writing.current = true
    const depth = ancestryOf(current).length
    const previousDepth = Number(globalThis.history.state?.depth ?? 1)
    if (depth > previousDepth) {
      globalThis.history.pushState({ depth }, '', next)
    } else {
      // 戻りは既に history が巻き戻っているので積まない
      globalThis.history.replaceState({ depth }, '', next)
    }
    writing.current = false
  }, [nav.phase, current])

  // URL → 状態。ブラウザバックはズームアウトとして扱う
  useEffect(() => {
    const onPopState = () => {
      if (writing.current) return
      const id = idFromHash()
      if (id === current.id) return
      const goingUp = ancestryOf(nodeById(id) ?? root).length < ancestryOf(current).length
      dispatch(goingUp ? { type: 'back', id } : { type: 'enter', id })
    }
    globalThis.addEventListener('popstate', onPopState)
    globalThis.addEventListener('hashchange', onPopState)
    return () => {
      globalThis.removeEventListener('popstate', onPopState)
      globalThis.removeEventListener('hashchange', onPopState)
    }
  }, [current, dispatch])
}
