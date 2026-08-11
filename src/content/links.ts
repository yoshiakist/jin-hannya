/**
 * 本文中のリンク（`[字面](URL)`）。
 *
 * 経文の解説では使わない —— 語から語へ渡る線はグラフ（`related` / `children`）が持っていて、
 * 本文に外向きの線を混ぜると「潜る」と「出る」が同じ見た目になる。使うのは
 * **独立ページ（`kind: page`）**のように、外の場所を指す必要がある原稿だけ。
 *
 * 行き先は外部なので新しいタブで開く（→ overlay/Overlay.tsx）。読んでいた場所を失わせない。
 * 通せるのは `https:` `http:` `mailto:` だけで、それ以外の書き方（`javascript:` 等）は
 * リンクにせず素の字として出す。原稿は自分たちのものだが、字面と行き先が食い違う書き方を
 * 通せる場所を作らない。
 */

/** `[字面](行き先)`。字面に `]`、行き先に空白と `)` は置けない */
const LINK = /\[([^\]]+)\]\(([^\s)]+)\)/gu

const ALLOWED_SCHEMES = ['https:', 'http:', 'mailto:']

export interface Link {
  text: string
  href: string
}

/** 通してよい行き先か。相対パス（`/goun/`）も許す */
function isAllowed(href: string): boolean {
  if (href.startsWith('/') || href.startsWith('#')) return true
  try {
    return ALLOWED_SCHEMES.includes(new URL(href).protocol)
  } catch {
    return false
  }
}

/** 1 段落をリンクとそれ以外に切り分ける */
export function parseLinks(text: string): (string | Link)[] {
  const parts: (string | Link)[] = []
  let at = 0
  for (const match of text.matchAll(LINK)) {
    const [whole, label, href] = match
    if (!label || !href || !isAllowed(href)) continue
    if (match.index > at) parts.push(text.slice(at, match.index))
    parts.push({ text: label, href })
    at = match.index + whole.length
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}
