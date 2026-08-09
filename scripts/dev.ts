/**
 * 開発サーバの起動（next dev ＋ content/ の監視）。
 *
 * 原稿・ノードを直したら `src/generated/content.json` を作り直す必要があるので、
 * next dev と watch-content.ts を並べて面倒を見る。片方が落ちたらもう片方も畳む
 * （シェルの `&` で並べると、next dev を止めたあと監視だけが残ることがある）。
 *
 * 引数はそのまま next dev へ渡す。例: `tsx scripts/dev.ts -H 0.0.0.0`
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const children: ChildProcess[] = []
let shuttingDown = false

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  process.exit(code)
}

const watcher = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/watch-content.ts')], {
  cwd: ROOT,
  stdio: 'inherit',
})
const next = spawn(join(ROOT, 'node_modules/.bin/next'), ['dev', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
})
children.push(watcher, next)

for (const child of children) child.on('exit', (code) => shutdown(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(0))
