/**
 * 縦中横（たてちゅうよこ）。縦組みの中の短いラテン字・数字を立てる。
 *
 * 縦組みでは半角の並びは 90 度倒れて組まれる。これは長い語（`CC BY-NC-ND 4.0` のような）では
 * 正しいが、`AI` `MIT` のような 1〜2 字の略語まで倒れると、行の中でそこだけ寝た字が現れて
 * 読みが止まる。2 字までは `text-combine-upright`（`.tcy`）で立て、3 字以上は倒したままにする。
 *
 * 判定は字数だけで行う。語の種類（略語か単位か）を見分けようとすると原稿側に規則が生まれる。
 */

/** 立てる上限の字数。これを超える並びは倒したまま組む */
const MAX_UPRIGHT = 2

/**
 * ラテン字・数字の並び。1 語を 1 つの並びとして掴むため、ダイアクリティカルマーク付きの
 * ラテン字（`vijñāna` の `ñ` `ā`）と、語の中の `.` `-`（`Next.js` `BY-NC-ND`）も並びに含める。
 * ASCII だけで掴むと語がそこで切れ、`vijñāna` の末尾 `na` のような断片だけが立ってしまう。
 */
const LATIN_RUN = /[\p{sc=Latin}\p{Nd}\p{M}]+(?:[.-][\p{sc=Latin}\p{Nd}\p{M}]+)*/gu

/** 立てる並び。長い語の判定は LATIN_RUN が担うので、ここは素の英数字だけ見ればよい */
const UPRIGHT_RUN = /^[A-Za-z0-9]+$/

export interface TcyRun {
  text: string
  /** 立てる（`.tcy` を当てる）か */
  upright: boolean
}

/** 1 つの文字列を、縦中横にする断片とそれ以外に切り分ける */
export function splitTcy(text: string): TcyRun[] {
  const runs: TcyRun[] = []
  let at = 0
  for (const match of text.matchAll(LATIN_RUN)) {
    if (match[0].length > MAX_UPRIGHT || !UPRIGHT_RUN.test(match[0])) continue
    if (match.index > at) runs.push({ text: text.slice(at, match.index), upright: false })
    runs.push({ text: match[0], upright: true })
    at = match.index + match[0].length
  }
  if (at < text.length) runs.push({ text: text.slice(at), upright: false })
  return runs
}
