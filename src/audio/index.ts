/**
 * Web Audio。BGM は 1 トラックを常時ループし、階層で切り替えない。
 *
 * 音がノイズにならないことを最優先の制約とする（README「音声」）。
 *
 * 配信方式は**未決**（README「未決事項」）。ここでは両案を実装で分岐できる形にしてある。
 *   'gapless' … 案 A。短尺ループを全長デコードし AudioBufferSourceNode.loop。サンプル精度でギャップレス
 *   'stream'  … 案 B。<audio> を 2 つ交互にクロスフェード。長尺素材のままストリーミングできる
 * 現行の assets/bgm/sample_music_01.mp3 は約 6 分・7.7MB で、全長デコードすると
 * float32 ステレオで約 130MB になりモバイルで通らない。よって既定は 'stream'。
 * 60〜120 秒のループ素材が用意でき次第 'gapless' へ切り替える。
 *
 * **ループが二重に聞こえないための決め事**（案 B の要）:
 *   - クロスフェードは継ぎ目を覆うだけの長さに留める。長く取ると曲の尾と頭が同時に鳴る
 *   - 絞り切った側は必ず `pause()` する。鳴らしっぱなしにすると尺の見積もりが外れた分だけ重なる
 *   - 一式は globalThis に 1 つだけ持つ。dev の Fast Refresh で作り直すと古い音が生き残る
 */

const BGM_STRATEGY: 'gapless' | 'stream' = 'stream'

/**
 * ループ境界のクロスフェード長（秒）。
 * MP3 のエンコーダ遅延とパディング（数十 ms）を覆えればよく、それ以上は伸ばさない。
 * ここを秒単位に伸ばすと、繋ぎ目で**曲の尾と頭が同時に鳴り「二重に聞こえる」**。
 */
const LOOP_CROSSFADE_SEC = 0.25

/** 待機側を鳴らし始める前に取得を促しておく余裕（秒）。頭が途切れないだけの先行で足りる */
const PRIME_AHEAD_SEC = 30

/** 読み上げ中に BGM を絞る量（dB 相当のゲイン比） */
const DUCK_GAIN = 0.45

/**
 * BGM の上限ゲイン。音量スライダの 0〜1 はこの範囲へ写す。
 * 最大でもこれ以上は出さない（BGM が前に出ると読経の邪魔になる）。
 */
const BGM_CEILING = 1 / 4

// scripts/build-content.ts が assets/ から public/audio/ へコピーしたものを fetch する
import { contentSource } from '../content/source.ts'

const BGM_URL = '/audio/bgm/sample_music_01.mp3'
const WOOSH_URL = '/audio/sfx/woosh.wav'

/** 読み上げ音源の在庫。ファイル名は YAML の audio フィールドが指す（未収録なら空） */
const VOICE_FILES = new Set(contentSource.voiceFiles)

interface AudioState {
  context: AudioContext | null
  master: GainNode | null
  bgmGain: GainNode | null
  /** 読み上げ中のダッキング専用。音量設定（bgmGain）と混ぜると値が壊れるので分ける */
  duckGain: GainNode | null
  sfxGain: GainNode | null
  voiceGain: GainNode | null
  wooshBuffer: AudioBuffer | null
  wooshLoading: boolean
  activeWooshes: number
  bgmStop: (() => void) | null
  /** BGM を起こしている最中の約束。同時に呼ばれても一式しか作らせない */
  bgmStarting: Promise<boolean> | null
  currentVoice: AudioBufferSourceNode | null
}

/**
 * 可変な状態は globalThis に 1 つだけ置く。
 *
 * このモジュールは content.json（`src/content/source.ts` 経由）に依存していて、
 * dev で原稿を保存すると Fast Refresh の巻き添えで評価し直される。モジュール変数に
 * 持たせていると、そのたびに**古い AudioContext と <audio> が鳴ったまま**新しい一式が
 * 作られて音が二重になり、しかもミュートは新しい master にしか届かないので
 * 「押しても二重が一重になるだけ」という状態になる。
 */
const STATE_KEY = '__jinHannyaAudio__'
const store = globalThis as unknown as Record<string, AudioState | undefined>
const state: AudioState =
  store[STATE_KEY] ??
  (store[STATE_KEY] = {
    context: null,
    master: null,
    bgmGain: null,
    duckGain: null,
    sfxGain: null,
    voiceGain: null,
    wooshBuffer: null,
    wooshLoading: false,
    activeWooshes: 0,
    bgmStop: null,
    bgmStarting: null,
    currentVoice: null,
  })

function ensureContext(): AudioContext {
  if (state.context) return state.context
  const context = new AudioContext()
  state.context = context

  const master = context.createGain()
  master.connect(context.destination)
  state.master = master

  const duckGain = context.createGain()
  duckGain.connect(master)
  state.duckGain = duckGain
  const bgmGain = context.createGain()
  bgmGain.connect(duckGain)
  state.bgmGain = bgmGain
  const sfxGain = context.createGain()
  sfxGain.gain.value = 0.5
  sfxGain.connect(master)
  state.sfxGain = sfxGain
  const voiceGain = context.createGain()
  voiceGain.connect(master)
  state.voiceGain = voiceGain

  return context
}

/**
 * 読み込み直後にまず 1 度呼び、弾かれたら最初のユーザー操作でもう 1 度呼ぶ。
 * 自動再生を許す環境（既に触ったことのあるサイトなど）ではそのまま鳴り、
 * 制限が掛かっている環境では `false` を返すので、呼び出し側が操作待ちに切り替える。
 * 冪等なので何度呼んでもよい。**同時に呼ばれても BGM は一式しか起こさない。**
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

  loadWoosh(ctx)
  if (state.bgmStop) return true
  // await を挟んだあとの再入で二式目を作らせない。最初の呼びの結果を全員で待つ
  return (state.bgmStarting ??= startBgm(ctx).finally(() => {
    state.bgmStarting = null
  }))
}

async function startBgm(ctx: AudioContext): Promise<boolean> {
  if (BGM_STRATEGY === 'gapless') {
    try {
      state.bgmStop = await startGaplessBgm(ctx)
    } catch {
      return false
    }
    return true
  }
  // <audio> の再生は AudioContext とは別に弾かれうる。
  // 弾かれたら要素ごと捨てて、次の呼び出しで作り直す
  const bgm = startStreamingBgm(ctx)
  state.bgmStop = bgm.stop
  try {
    await bgm.ready
  } catch {
    bgm.stop()
    state.bgmStop = null
    return false
  }
  return true
}

function loadWoosh(ctx: AudioContext): void {
  if (state.wooshBuffer || state.wooshLoading) return
  state.wooshLoading = true
  void fetch(WOOSH_URL)
    .then((r) => r.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))
    .then((buffer) => {
      state.wooshBuffer = buffer
    })
    .catch(() => {
      // 効果音が無くても本体は成立する。読み込み失敗は握りつぶす
    })
    .finally(() => {
      state.wooshLoading = false
    })
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
  source.connect(state.bgmGain!)
  source.start()
  return () => source.stop()
}

interface Lane {
  element: HTMLAudioElement
  gain: GainNode
}

/**
 * 案 B: <audio> 2 本を末尾で交互に受け渡す。ストリーミングのまま繋ぐ。
 *
 * 重なるのは受け渡しの一瞬（`LOOP_CROSSFADE_SEC`）だけで、
 * 渡し終えた側は必ず止めて頭へ巻き戻し、次の順番まで黙らせる。
 */
function startStreamingBgm(ctx: AudioContext): { stop: () => void; ready: Promise<void> } {
  const lanes: Lane[] = [0, 1].map((index) => {
    const element = new Audio()
    // 待機側まで先読みすると素材を 2 回落とすことになる。順番が回る手前で促す
    element.preload = index === 0 ? 'auto' : 'none'
    element.src = BGM_URL
    const gain = ctx.createGain()
    gain.gain.value = 0
    ctx.createMediaElementSource(element).connect(gain)
    gain.connect(state.bgmGain!)
    return { element, gain }
  })

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 受け渡しの世代。古い連鎖が生き残っていても、これを見て黙って降りる */
  let generation = 0
  let ready: Promise<void> = Promise.resolve()
  let first = true

  /** 絞って止める。止めるところまでやらないと、尺の見積もりが外れた分だけ次の周と重なる */
  const release = (lane: Lane, gen: number) => {
    const at = ctx.currentTime
    lane.gain.gain.cancelScheduledValues(at)
    lane.gain.gain.setValueAtTime(lane.gain.gain.value, at)
    lane.gain.gain.linearRampToValueAtTime(0, at + LOOP_CROSSFADE_SEC)
    globalThis.setTimeout(
      () => {
        // 世代が進んでいたら、この lane は既に次の順番で鳴っている。触らない
        if (gen !== generation) return
        lane.element.pause()
        lane.element.currentTime = 0
      },
      LOOP_CROSSFADE_SEC * 1000 + 100,
    )
  }

  const play = (index: number) => {
    if (stopped) return
    const gen = ++generation
    const lane = lanes[index]!
    const standby = lanes[1 - index]!

    // 前の周で止め切れていない場合に備えて、鳴っていた側は必ず引き取る
    release(standby, gen)

    lane.element.currentTime = 0
    const playing = lane.element.play()
    // 最初の 1 本だけ、再生が通ったかを呼び出し側へ渡す（自動再生の可否判定に使う）。
    // ループ後の切り替えは既に鳴っている以上、弾かれない
    if (first) {
      first = false
      ready = playing ?? Promise.resolve()
    } else {
      void playing?.catch(() => {})
    }

    const now = ctx.currentTime
    lane.gain.gain.cancelScheduledValues(now)
    lane.gain.gain.setValueAtTime(0, now)
    lane.gain.gain.linearRampToValueAtTime(1, now + LOOP_CROSSFADE_SEC)

    // 尺の見積もりが外れても、タブが背面でタイマーが間引かれても、
    // 終端まで行ってしまったら必ず次へ渡す（無音を残さない）
    lane.element.onended = () => {
      if (stopped || gen !== generation) return
      play(1 - index)
    }

    let primed = standby.element.preload === 'auto'
    const arm = () => {
      if (stopped || gen !== generation) return
      // duration はメタデータが届くまで NaN / 0。読み込み失敗時もここに留まる。
      // 判定できないうちは渡さず、待ち直す（さもないと play → arm が無限再帰する）
      const duration = lane.element.duration
      if (!Number.isFinite(duration) || duration <= 0) {
        timer = globalThis.setTimeout(arm, 250)
        return
      }
      const remaining = duration - lane.element.currentTime - LOOP_CROSSFADE_SEC
      if (remaining <= 0) {
        play(1 - index)
        return
      }
      if (!primed && remaining <= PRIME_AHEAD_SEC) {
        primed = true
        standby.element.preload = 'auto'
        standby.element.load()
      }
      const wait = primed ? remaining : remaining - PRIME_AHEAD_SEC
      timer = globalThis.setTimeout(arm, Math.max(50, wait * 1000))
    }
    clearTimeout(timer)
    arm()
  }

  play(0)

  return {
    ready,
    stop: () => {
      stopped = true
      clearTimeout(timer)
      for (const lane of lanes) {
        lane.element.onended = null
        lane.element.pause()
        // 取得ごと止める。src を外したままにしないと裏で読み込みが続く
        lane.element.removeAttribute('src')
        lane.element.load()
        lane.gain.disconnect()
      }
    },
  }
}

/** volume は UI の 0〜1。実ゲインは BGM_CEILING を上限に写した値になる */
export function setBgmVolume(volume: number): void {
  const { bgmGain, context } = state
  if (!bgmGain || !context) return
  const gain = Math.max(0, Math.min(1, volume)) * BGM_CEILING
  bgmGain.gain.setTargetAtTime(gain, context.currentTime, 0.08)
}

export function setMuted(muted: boolean): void {
  const { master, context } = state
  if (!master || !context) return
  master.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.05)
}

/** ズーム遷移に重ねる woosh。濁らないよう同時発音数を 2 に制限する */
export function playWoosh(): void {
  const { context, wooshBuffer, sfxGain } = state
  if (!context || !wooshBuffer || !sfxGain) return
  if (state.activeWooshes >= 2) return

  const source = context.createBufferSource()
  source.buffer = wooshBuffer
  source.connect(sfxGain)
  state.activeWooshes++
  source.onended = () => {
    state.activeWooshes--
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

  if (!VOICE_FILES.has(file)) throw new Error(`読み上げ音源が無い: assets/voice/${file}`)
  const url = `/audio/voice/${encodeURIComponent(file)}`
  const buffer = await fetch(url)
    .then((r) => r.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(state.voiceGain!)
  source.onended = () => {
    if (state.currentVoice === source) {
      state.currentVoice = null
      duck(false)
      onEnded()
    }
  }
  state.currentVoice = source
  duck(true)
  source.start()
}

export function stopVoice(): void {
  const source = state.currentVoice
  if (!source) return
  state.currentVoice = null
  source.onended = null
  source.stop()
  duck(false)
}

function duck(on: boolean): void {
  const { duckGain, context } = state
  if (!duckGain || !context) return
  duckGain.gain.setTargetAtTime(on ? DUCK_GAIN : 1, context.currentTime, 0.15)
}
