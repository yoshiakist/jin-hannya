/**
 * 青空文庫式のルビ記法（`菩薩《ぼさつ》`）を段落から切り出す。
 *
 * `content/docs/*.md` は vivliostyle 用の原稿から持ち込んでいるので、記法もそのまま受ける。
 * 親文字の範囲は**直前の漢字の連なり**で決める（`菩薩《ぼさつ》` → 親「菩薩」）。
 * 漢字以外を親にしたいときや、連なりを途中で切りたいときだけ `｜` で開始位置を明示する
 * （`｜五蘊《ごうん》` / `観自在｜菩薩《ぼさつ》`）。
 */

/** 親文字に採る「漢字」。CJK 統合漢字に踊り字（々〆ヶ）を足す */
const KANJI = /[\p{Script=Han}々〆ヶ]/u

/** ルビの開始位置を明示する印。青空文庫と同じ全角縦棒 */
const RUBY_START = '｜'

export interface RubySegment {
  /** 親文字 */
  base: string
  /** 振り仮名 */
  ruby: string
}

/** ルビ無しの素の文字列と、ルビ付きの塊が交互に並ぶ */
export type RubyPart = string | RubySegment

/**
 * 段落を「素の文字列」と「ルビ付きの塊」に分解する。
 *
 * 親文字が見つからない `《…》`（直前が漢字でない、かつ `｜` も無い）は記法として扱わず、
 * 書かれたままの文字として残す。原稿の誤りを黙って消さないため。
 */
export function parseRuby(text: string): RubyPart[] {
  const parts: RubyPart[] = []
  let pending = ''
  let cursor = 0

  for (;;) {
    const open = text.indexOf('《', cursor)
    if (open < 0) break
    const close = text.indexOf('》', open + 1)
    if (close < 0) break

    const head = text.slice(cursor, open)
    const ruby = text.slice(open + 1, close)
    const start = ruby === '' ? null : baseStart(head)

    if (start === null) {
      // 記法として成立しない。`》` までを素の文字として送り、続きを見る
      pending += text.slice(cursor, close + 1)
    } else {
      pending += plain(head.slice(0, start))
      if (pending) parts.push(pending)
      pending = ''
      parts.push({ base: head.slice(start), ruby })
    }
    cursor = close + 1
  }

  pending += plain(text.slice(cursor))
  if (pending) parts.push(pending)
  return parts
}

/**
 * `《` の直前までの文字列から、親文字の開始位置を返す。無いときは null。
 *
 * `｜` があればそこから後ろが親。無ければ末尾から漢字を遡る。
 */
function baseStart(head: string): number | null {
  const marked = head.lastIndexOf(RUBY_START)
  if (marked >= 0) return marked + 1 < head.length ? marked + 1 : null

  // 末尾から 1 文字ずつ遡る。異体字（𠮟 など）はサロゲートペアなので 2 コード単位を見る
  let i = head.length
  for (;;) {
    if (i === 0) break
    const width = isLowSurrogate(head.charCodeAt(i - 1)) && i >= 2 ? 2 : 1
    if (!KANJI.test(head.slice(i - width, i))) break
    i -= width
  }
  return i < head.length ? i : null
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** ルビに使われなかった `｜` は組版上の印なので落とす */
function plain(text: string): string {
  return text.split(RUBY_START).join('')
}
