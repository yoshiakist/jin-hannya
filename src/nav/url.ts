/**
 * ノード id ⇄ 実パスの純粋な写像。
 *
 * router.ts（同期の効果）と atoms.ts（初期値の決定）の両方が使うので、
 * 循環 import を作らないよう独立させてある。
 */

import { root, nodeById, ancestryOf } from '../content/loader.ts'

export function pathOf(id: string): string {
  const node = nodeById(id)
  if (!node) return '/'
  const trail = ancestryOf(node)
    .filter((n) => n.id !== root.id)
    .map((n) => n.id)
  return trail.length > 0 ? `/${trail.join('/')}/` : '/'
}

/** trailingSlash の有無で比較がぶれないよう、末尾の `/` を落とした形で扱う */
export function normalizePath(pathname: string): string {
  return pathname !== '/' && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') : pathname
}

export function idFromPath(pathname: string): string {
  const segments = normalizePath(pathname).split('/').filter(Boolean).map(decodeURIComponent)
  const last = segments[segments.length - 1]
  return last && nodeById(last) ? last : root.id
}

/**
 * 初期表示のノード。URL のパスから引く。
 *
 * effect でマウント後に sync すると、「状態 → URL」の効果が同期前の根を見て
 * `router.push('/')` してしまう競合が起きる。アプリはクライアント専用
 * （AppShell が ssr: false で読む）なので、atom の初期値の段階で URL を反映する。
 */
export function initialNodeId(): string {
  return typeof location === 'undefined' ? root.id : idFromPath(location.pathname)
}
