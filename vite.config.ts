import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { parse as parseYaml } from 'yaml'

/**
 * `*.yaml` をビルド時に JSON モジュールへ変換する。
 * README「コンテンツ: YAML（グラフ）+ Markdown（解説）／import.meta.glob + ビルド時パース」より。
 * ランタイムに YAML パーサを持ち込まないためのプラグイン。
 */
function yamlPlugin(): Plugin {
  return {
    name: 'jin-hannya:yaml',
    transform(code, id) {
      if (!/\.ya?ml$/.test(id.split('?')[0]!)) return null
      if (id.includes('?raw')) return null
      return {
        code: `export default ${JSON.stringify(parseYaml(code))}`,
        map: { mappings: '' },
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), yamlPlugin()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      '#content': fileURLToPath(new URL('./content', import.meta.url)),
      '#assets': fileURLToPath(new URL('./assets', import.meta.url)),
    },
  },
  assetsInclude: ['**/*.m4a', '**/*.bin'],
  build: {
    target: 'es2022',
    // three/webgpu は巨大なので分離しておく（Tier 3 では読まれない）
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
          return undefined
        },
      },
    },
  },
})
