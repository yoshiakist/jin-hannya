/**
 * コンテンツ（YAML / Markdown / sutra.txt）→ 1 本の JSON への前計算。
 *
 * Vite 時代は import.meta.glob + yamlPlugin がビルド時に束ねていた仕事を、
 * Next 移行後はこのスクリプトが担う。ランタイム（src/content/loader.ts）は
 * `src/generated/content.json` を import するだけで、YAML パーサを持ち込まない。
 *
 * あわせて、`?url` import で参照していた静的アセットを public/ へコピーする。
 *   assets/svg/*.svg   → public/glyph-svg/   … DOM レイヤーの筆文字（mask-image）
 *   assets/bgm, sfx, voice → public/audio/   … Web Audio が fetch する音源
 *
 * 出力
 *   src/generated/content.json
 *     sutra      … content/sutra.txt の生テキスト（改行 = L0 の列の切れ目なので保持）
 *     graph      … ファイル名 → YAML をパースした素の値（zod 検証はローダ側の仕事）
 *     docs       … ファイル名 → frontmatter 込みの生 Markdown
 *     svgChars   … DOM 用筆文字の在庫（public/glyph-svg/ に置いた字）
 *     voiceFiles … 読み上げ音源の在庫（public/audio/voice/ に置いたファイル名）
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_TS = join(ROOT, 'src/generated')

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
}

/** ディレクトリを丸ごとコピーし、コピー元に無いファイルが残らないよう作り直す */
function syncDir(fromDir: string, toDir: string, pattern: RegExp): string[] {
  rmSync(toDir, { recursive: true, force: true })
  const files = listFiles(fromDir, pattern)
  if (files.length === 0) return []
  mkdirSync(toDir, { recursive: true })
  for (const name of files) copyFileSync(join(fromDir, name), join(toDir, name))
  return files
}

const sutra = readFileSync(join(ROOT, 'content/sutra.txt'), 'utf8')

const graph: Record<string, unknown> = {}
for (const name of listFiles(join(ROOT, 'content/graph'), /\.ya?ml$/)) {
  graph[name] = parseYaml(readFileSync(join(ROOT, 'content/graph', name), 'utf8'))
}

const docs: Record<string, string> = {}
for (const name of listFiles(join(ROOT, 'content/docs'), /\.md$/)) {
  docs[name] = readFileSync(join(ROOT, 'content/docs', name), 'utf8')
}

const svgChars = syncDir(join(ROOT, 'assets/svg'), join(ROOT, 'public/glyph-svg'), /\.svg$/).map(
  (name) => basename(name, '.svg'),
)
syncDir(join(ROOT, 'assets/bgm'), join(ROOT, 'public/audio/bgm'), /\.(mp3|m4a|ogg|wav)$/)
syncDir(join(ROOT, 'assets/sfx'), join(ROOT, 'public/audio/sfx'), /\.(mp3|m4a|ogg|wav)$/)
const voiceFiles = syncDir(join(ROOT, 'assets/voice'), join(ROOT, 'public/audio/voice'), /\.(mp3|m4a|ogg|wav)$/)

mkdirSync(OUT_TS, { recursive: true })
writeFileSync(
  join(OUT_TS, 'content.json'),
  JSON.stringify({ sutra, graph, docs, svgChars, voiceFiles }),
)

console.log(
  `[build-content] graph ${Object.keys(graph).length} / docs ${Object.keys(docs).length} / ` +
    `svg ${svgChars.length} 字 / voice ${voiceFiles.length} 本 → src/generated/content.json`,
)
