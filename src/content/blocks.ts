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

/**
 * 大段落の切れ目。ハイフン 3 つ以上だけの行（Markdown の thematic break）。
 * 空白を伴わないので `BULLET` とは衝突しない。frontmatter の `---` は
 * ローダが先頭で切り落とした後なので本文には残らない。
 */
const SECTION_BREAK = /^[-*_]{3,}$/

/**
 * 小見出し。`##` で始まる行。
 *
 * 経文の解説（`content/docs/*.md`）では使わない —— 語の解説は 1 本の筋で読ませるものなので、
 * 途中で節に割ると読み下しが切れる。使うのは**独立ページ（`kind: page`）**のように、
 * 並列した話題を 1 枚に収める原稿だけ。
 */
const HEADING = /^#{2,3}\s+(.+)$/

/** 段落の行頭に来る括弧類。約物自身が 1 字ぶんの空きを持つので字下げは要らない */
const OPENING_BRACKET = /^[（｛〈《【「『［〔〝]/

/** 段落の頭が括弧類か（字下げを抑えるかどうか） */
export function startsWithBracket(text: string): boolean {
  return OPENING_BRACKET.test(text)
}

/**
 * 大段落の頭か。原稿の `---` は独立した要素にせず、**直後のブロックの目印**として持つ。
 * 縦組みで空の要素を挟むと、それ自体が組版の対象になって間合いが読めなくなる。
 */
interface SectionHead {
  section?: true
}

export interface Paragraph extends SectionHead {
  type: 'paragraph'
  text: string
}

export interface List extends SectionHead {
  type: 'list'
  items: string[]
}

export interface Heading extends SectionHead {
  type: 'heading'
  text: string
}

export type Block = Paragraph | List | Heading

/**
 * 本文をブロックの並びにする。
 *
 * 空行で区切ったうえで、ブロックの中でも箇条書きの行が続くところは `list` として切り出す。
 * 箇条書きの前後に空行が無い原稿でも同じ結果になるようにするため。
 * 段落の中の改行は原稿の折り返しなので、繋いで 1 つの文字列にする。
 * `---` の行は大段落の切れ目で、次に出るブロックへ `section` として渡す。
 */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = []
  /** 直前に `---` があったか。次のブロックに移し替えて降ろす */
  let pending = false

  /** 溜まっている大段落の目印を付けながらブロックを積む */
  const push = (block: Block) => {
    // 本文の頭の `---` は間合いの行き場が無いので捨てる
    if (pending && blocks.length) block.section = true
    pending = false
    blocks.push(block)
  }

  for (const chunk of body.split(/\n{2,}/)) {
    let lines: string[] = []
    let bullets: string[] = []

    /** 溜まっている行を段落・箇条書きとして送り出す */
    const flush = () => {
      if (bullets.length) push({ type: 'list', items: bullets })
      if (lines.length) push({ type: 'paragraph', text: lines.join('') })
      bullets = []
      lines = []
    }

    for (const line of chunk.split('\n')) {
      const text = line.trim()
      if (!text) continue
      const heading = HEADING.exec(text)
      if (SECTION_BREAK.test(text)) {
        flush()
        pending = true
      } else if (heading) {
        flush()
        push({ type: 'heading', text: heading[1]!.trim() })
      } else if (BULLET.test(text)) {
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
