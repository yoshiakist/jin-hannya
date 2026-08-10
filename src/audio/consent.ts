/**
 * 音の断りへの答えの記憶。
 *
 * BGM が流れることは一度断れば足りるので、答えは localStorage に残して
 * 二度目からは聞かない。**ただしロゴを出す入り方（根を直接開いたとき）では毎回出す。**
 * ロゴを書き上げてから断りを出す流れで断りだけ抜けると、筆を置いたところで宙に浮く
 * （→ src/nav/atoms.ts の `initialConsent`）。
 *
 * 読破の記録（src/nav/progress.ts）と同じく、localStorage は必ず投げうるものとして扱う。
 * 記録できない環境では今回のセッションぶんだけ効く。
 */

const STORAGE_KEY = 'jin-hannya:audio-consent:v1'

/**
 *   accepted … 承知。BGM を鳴らして始める
 *   silent   … 静寂。音を一切起こさない（`AudioContext` も `<audio>` も作らない）
 */
export type AudioConsent = 'accepted' | 'silent'

export function loadConsent(): AudioConsent | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return raw === 'accepted' || raw === 'silent' ? raw : null
  } catch {
    return null
  }
}

export function saveConsent(value: AudioConsent): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value)
  } catch {
    // 覚えられない環境では黙って諦める。次に開いたときにもう一度断るだけ
  }
}
