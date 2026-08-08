/**
 * Web Audio。BGM は 1 トラックを常時ループし、階層で切り替えない。
 *
 * 音がノイズにならないことを最優先の制約とする（README「音声」）。
 *
 * 配信方式は**未決**（README「未決事項」）。ここでは両案を実装で分岐できる形にしてある。
 *   'gapless' … 案 A。短尺ループを全長デコードし AudioBufferSourceNode.loop。サンプル精度でギャップレス
 *   'stream'  … 案 B。<audio> を 2 つ交互にクロスフェード。長尺素材のままストリーミングできる
 * 現行の assets/bgm/sample_music_01.mp3 は約 8 分・7.7MB で、全長デコードすると
 * float32 ステレオで約 170MB になりモバイルで通らない。よって既定は 'stream'。
 * 60〜120 秒のループ素材が用意でき次第 'gapless' へ切り替える。
 */

const BGM_STRATEGY: 'gapless' | 'stream' = 'stream'

/** ループ境界のクロスフェード長（秒）。継ぎ目でクリックノイズを出さないため */
const LOOP_CROSSFADE_SEC = 4

/** 読み上げ中に BGM を絞る量（dB 相当のゲイン比） */
const DUCK_GAIN = 0.45

/**
 * BGM の上限ゲイン。音量スライダの 0〜1 はこの範囲へ写す。
 * 最大でもこれ以上は出さない（BGM が前に出ると読経の邪魔になる）。
 */
const BGM_CEILING = 1 / 4

// Vite に解決させる。new URL(..., import.meta.url) では dev と build で解決先がずれる
import BGM_URL from '#assets/bgm/sample_music_01.mp3?url'
import WOOSH_URL from '#assets/sfx/woosh.wav?url'

/** 読み上げ音源。ファイル名は YAML の audio フィールドが指す（未収録なら空） */
const VOICE_URLS = import.meta.glob<string>('#assets/voice/*', {
  eager: true,
  query: '?url',
  import: 'default',
})

let context: AudioContext | null = null
let master: GainNode | null = null
let bgmGain: GainNode | null = null
/** 読み上げ中のダッキング専用。音量設定（bgmGain）と混ぜると値が壊れるので分ける */
let duckGain: GainNode | null = null
let sfxGain: GainNode | null = null
let voiceGain: GainNode | null = null

let wooshBuffer: AudioBuffer | null = null
let activeWooshes = 0
let bgmStop: (() => void) | null = null
let currentVoice: AudioBufferSourceNode | null = null

function ensureContext(): AudioContext {
  if (context) return context
  context = new AudioContext()
  master = context.createGain()
  master.connect(context.destination)

  duckGain = context.createGain()
  duckGain.connect(master)
  bgmGain = context.createGain()
  bgmGain.connect(duckGain)
  sfxGain = context.createGain()
  sfxGain.gain.value = 0.5
  sfxGain.connect(master)
  voiceGain = context.createGain()
  voiceGain.connect(master)

  return context
}

/**
 * 読み込み直後にまず 1 度呼び、弾かれたら最初のユーザー操作でもう 1 度呼ぶ。
 * 自動再生を許す環境（既に触ったことのあるサイトなど）ではそのまま鳴り、
 * 制限が掛かっている環境では `false` を返すので、呼び出し側が操作待ちに切り替える。
 * 冪等なので何度呼んでもよい。
 */
export async function startAudio(volume: number, muted: boolean): Promise<boolean> {
  const ctx = ensureContext()
  if (ctx.state !== 'running') {
    // 自動再生制限下では reject する。ここで落とさず、状態を見て判断する
    await ctx.resume().catch(() => {})
  }
  setBgmVolume(volume)
  setMuted(muted)
  if (ctx.state !== 'running') return false

  if (!bgmStop) {
    if (BGM_STRATEGY === 'gapless') {
      bgmStop = await startGaplessBgm(ctx)
    } else {
      // <audio> の再生は AudioContext とは別に弾かれうる。
      // 弾かれたら要素ごと捨てて、次の呼び出しで作り直す
      const bgm = startStreamingBgm(ctx)
      bgmStop = bgm.stop
      try {
        await bgm.ready
      } catch {
        bgm.stop()
        bgmStop = null
        return false
      }
    }
  }
  if (!wooshBuffer) {
    void fetch(WOOSH_URL)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        wooshBuffer = buffer
      })
      .catch(() => {
        // 効果音が無くても本体は成立する。読み込み失敗は握りつぶす
      })
  }
  return true
}

/** 案 A: 全長デコード + AudioBufferSourceNode.loop。サンプル精度でギャップレス */
async function startGaplessBgm(ctx: AudioContext): Promise<() => void> {
  const data = await fetch(BGM_URL).then((r) => r.arrayBuffer())
  const buffer = await ctx.decodeAudioData(data)

  if (buffer.duration > 180) {
    console.warn(
      `[audio] BGM が ${Math.round(buffer.duration)} 秒ある。` +
        'gapless 方式は 60〜120 秒のループ素材を前提にしている（README「配信方式」）',
    )
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.connect(bgmGain!)
  source.start()
  return () => source.stop()
}

/**
 * 案 B: <audio> 2 本を末尾でクロスフェードする。
 * ストリーミングのまま繋げるが、同じ地点へ戻る感覚は案 A より薄い。
 */
function startStreamingBgm(ctx: AudioContext): { stop: () => void; ready: Promise<void> } {
  const elements = [new Audio(BGM_URL), new Audio(BGM_URL)]
  const gains = elements.map((element) => {
    element.crossOrigin = 'anonymous'
    element.preload = 'auto'
    const gain = ctx.createGain()
    gain.gain.value = 0
    ctx.createMediaElementSource(element).connect(gain)
    gain.connect(bgmGain!)
    return gain
  })

  let active = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let ready: Promise<void> = Promise.resolve()
  let first = true

  const play = (index: number) => {
    const element = elements[index]!
    const gain = gains[index]!
    element.currentTime = 0
    const playing = element.play()
    // 最初の 1 本だけ、再生が通ったかを呼び出し側へ渡す（自動再生の可否判定に使う）。
    // ループ後の切り替えは既に鳴っている以上、弾かれない
    if (first) {
      first = false
      ready = playing ?? Promise.resolve()
    }

    const now = ctx.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(1, now + LOOP_CROSSFADE_SEC)

    const schedule = () => {
      // duration はメタデータが届くまで NaN / 0。読み込み失敗時もここに留まる。
      // 判定できないうちは切り替えず、待ち直す（さもないと play → schedule が無限再帰する）
      const duration = element.duration
      if (!Number.isFinite(duration) || duration <= 0) {
        timer = globalThis.setTimeout(schedule, 500)
        return
      }
      const remaining = duration - element.currentTime
      if (remaining <= LOOP_CROSSFADE_SEC) {
        const at = ctx.currentTime
        gain.gain.cancelScheduledValues(at)
        gain.gain.setValueAtTime(gain.gain.value, at)
        gain.gain.linearRampToValueAtTime(0, at + LOOP_CROSSFADE_SEC)
        active = 1 - index
        play(active)
        return
      }
      timer = globalThis.setTimeout(schedule, Math.max(200, (remaining - LOOP_CROSSFADE_SEC) * 1000))
    }
    schedule()
  }

  play(active)

  return {
    ready,
    stop: () => {
      clearTimeout(timer)
      for (const element of elements) element.pause()
    },
  }
}

/** volume は UI の 0〜1。実ゲインは BGM_CEILING を上限に写した値になる */
export function setBgmVolume(volume: number): void {
  if (!bgmGain || !context) return
  const gain = Math.max(0, Math.min(1, volume)) * BGM_CEILING
  bgmGain.gain.setTargetAtTime(gain, context.currentTime, 0.08)
}

export function setMuted(muted: boolean): void {
  if (!master || !context) return
  master.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.05)
}

/** ズーム遷移に重ねる woosh。濁らないよう同時発音数を 2 に制限する */
export function playWoosh(): void {
  if (!context || !wooshBuffer || !sfxGain) return
  if (activeWooshes >= 2) return

  const source = context.createBufferSource()
  source.buffer = wooshBuffer
  source.connect(sfxGain)
  activeWooshes++
  source.onended = () => {
    activeWooshes--
  }
  source.start()
}

/**
 * 読み上げ音源の再生。再生中は BGM を数 dB 絞る（止めはしない）。
 * 同じノードを再度押すと停止する扱いは呼び出し側が持つ。
 */
export async function playVoice(file: string, onEnded: () => void): Promise<void> {
  const ctx = ensureContext()
  stopVoice()

  const url = Object.entries(VOICE_URLS).find(([path]) => path.endsWith(`/${file}`))?.[1]
  if (!url) throw new Error(`読み上げ音源が無い: assets/voice/${file}`)
  const buffer = await fetch(url)
    .then((r) => r.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(voiceGain!)
  source.onended = () => {
    if (currentVoice === source) {
      currentVoice = null
      duck(false)
      onEnded()
    }
  }
  currentVoice = source
  duck(true)
  source.start()
}

export function stopVoice(): void {
  if (!currentVoice) return
  const source = currentVoice
  currentVoice = null
  source.onended = null
  source.stop()
  duck(false)
}

function duck(on: boolean): void {
  if (!duckGain || !context) return
  duckGain.gain.setTargetAtTime(on ? DUCK_GAIN : 1, context.currentTime, 0.15)
}
