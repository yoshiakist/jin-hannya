/**
 * 本文 Markdown をブロックに切り分ける。
 *
 * 扱うのは段落と、ハイフンで始まる箇条書きの 2 つだけ。
 * `content/docs/*.md` は vivliostyle 用の原稿を持ち込んだもので、記法もそれに揃える
 * （見出し・強調・リンクは原稿側で使っていないので、素の文字として残す）。
 * ルビ（`菩薩《ぼさつ》`）の解釈は行の中身の話なので `ruby.ts` に任せる。
 */

/** 箇条書きの行頭。半角ハイフン + 空白 */
const BULLET = /^[-*]\s+/

/** 段落の行頭に来る括弧類。約物自身が 1 字ぶんの空きを持つので字下げは要らない */
const OPENING_BRACKET = /^[（｛〈《【「『［〔〝]/

/** 段落の頭が括弧類か（字下げを抑えるかどうか） */
export function startsWithBracket(text: string): boolean {
  return OPENING_BRACKET.test(text)
}

export interface Paragraph {
  type: 'paragraph'
  text: string
}

export interface List {
  type: 'list'
  items: string[]
}

export type Block = Paragraph | List

/**
 * 本文をブロックの並びにする。
 *
 * 空行で区切ったうえで、ブロックの中でも箇条書きの行が続くところは `list` として切り出す。
 * 箇条書きの前後に空行が無い原稿でも同じ結果になるようにするため。
 * 段落の中の改行は原稿の折り返しなので、繋いで 1 つの文字列にする。
 */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = []

  for (const chunk of body.split(/\n{2,}/)) {
    let lines: string[] = []
    let bullets: string[] = []

    /** 溜まっている行を段落・箇条書きとして送り出す */
    const flush = () => {
      if (bullets.length) blocks.push({ type: 'list', items: bullets })
      if (lines.length) blocks.push({ type: 'paragraph', text: lines.join('') })
      bullets = []
      lines = []
    }

    for (const line of chunk.split('\n')) {
      const text = line.trim()
      if (!text) continue
      if (BULLET.test(text)) {
        if (lines.length) flush()
        bullets.push(text.replace(BULLET, ''))
      } else {
        if (bullets.length) flush()
        lines.push(text)
      }
    }
    flush()
  }

  return blocks
}
