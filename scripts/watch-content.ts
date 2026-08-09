/**
 * content/ の監視 → build-content.ts の再実行。
 *
 * dev サーバが見るのは `src/generated/content.json` だけなので、原稿（*.md）や
 * ノード（*.yaml）を直したときは、この JSON を作り直せば Next の HMR がそのまま乗る。
 * `npm run dev` が next dev と並べて起動する。
 *
 * 生成物の中身が変わらなかったときは build-content.ts 側が書き込みを省くので、
 * エディタの保存が空振りでも作り直しには入らない。
 */

import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WATCH_DIR = join(ROOT, 'content')
const SCRIPT = join(ROOT, 'scripts/build-content.ts')

/** 保存が複数イベントに割れる（エディタの書き方次第）ので、まとめてから走らせる */
const DEBOUNCE_MS = 80

let timer: NodeJS.Timeout | null = null
let running = false
let queued = false

function rebuild(): void {
  if (running) {
    queued = true
    return
  }
  running = true
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    running = false
    // YAML の書きかけなど、途中の状態では失敗して当たり前。監視は続ける。
    if (code !== 0) console.error('[watch-content] 作り直しに失敗（保存し直せば再試行します）')
    if (queued) {
      queued = false
      rebuild()
    }
  })
}

watch(WATCH_DIR, { recursive: true }, (_event, name) => {
  if (name && !/\.(ya?ml|md|txt)$/.test(name)) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(rebuild, DEBOUNCE_MS)
})

console.log('[watch-content] content/ を監視中')
