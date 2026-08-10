/**
 * 起動のロゴ — 暗闇に「深般若」を筆順どおりに書く。
 *
 * 紙面（L0）を出す前に一度だけ通る面で、**根を直接開いたときにしか出ない**。
 * L1 以降から戻ってきた読者にはロゴは要らない（→ `splashAtom`）。
 *
 * 字は紙面と同じ塗りのグリフをそのまま使い、現れ方だけを
 * 前計算した筆順パラメータ場（scripts/stroke-order.ts）に従わせる。
 * かすれも滲みも `materials.ts` の同じ経路なので、ロゴだけ質感が別物にならない。
 *
 * 幕は張らない。紙面は描いたまま濃さだけ 0 に伏せてあり（Paper.tsx が `paperOpacity` を落とす）、
 * ロゴが薄れ始めるのと入れ替わりに経文が滲み出す。
 *
 * 書き上がったところで一旦止まり、音の断り（overlay/AudioConsent.tsx）に答えが出るまで待つ。
 * 薄れ始めるのはそのあと。答えを待つあいだもロゴは出したままにする（→ `splashAtom` の 'asking'）。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import { PlaneGeometry, type Group, type OrthographicCamera } from 'three'
import { float, uniform } from 'three/tsl'
import { glyphGeometry, orderCellOf, sdfCellOf, strokeSpansOf } from './glyphs.ts'
import {
  GLOW_PLANE,
  approach,
  brushTip,
  createBrushMaterial,
  createGlowMaterial,
  planeCellLocal,
} from './materials.ts'
import { ease } from '../world/ease.ts'
import { audioConsentAtom, splashAtom, type SplashPhase } from '../nav/atoms.ts'

/** 縦に書く 3 字。上から順に運ぶ */
const CHARS = ['深', '般', '若'] as const

/** 1 字を書き終えるまで（ミリ秒）。画の間もこの中に含む */
const WRITE_MS = 2000
/** 一画と一画のあいだ、筆を上げている間（ミリ秒）。運びの時間から差し引く */
const STROKE_GAP_MS = 50
/** 画の間に食われて運びが慌ただしくならないための下限（`WRITE_MS` に対する比） */
const MIN_WRITE_RATIO = 0.5
/** 字と字のあいだ、筆を継ぐ間（ミリ秒） */
const CHAR_GAP_MS = 400
/** 書き上がってから音の断りを出すまで（ミリ秒）。筆を置いた余韻 */
const HOLD_MS = 520
/** 薄れ切るまで（ミリ秒）。このあいだに経文が滲み出してくる */
const FADE_MS = 900

/** 字の一辺（見えている高さに対する比） */
const GLYPH = 0.17
/** 字の中心どうしの間隔（同上） */
const PITCH = 0.215
/** 字を画面幅のここまでに収める。極端に細い画面で溢れさせない */
const MAX_WIDTH = 0.42
/** 滲みの濃さ。紙面の hover（0.5）と同じあたりに置く */
const GLOW_STRENGTH = 0.55
/** ロゴを置く奥行き。紙面（z ≒ 0）より手前 */
const SPLASH_Z = 5
/** 音の断りを出すとき、ロゴを持ち上げる高さ（見えている高さに対する比）。字と断りを重ねない */
const ASK_LIFT = 0.08
/** 持ち上がるまで（秒）。筆を置いてから断りが浮かぶのと同じ間合いで動かす */
const ASK_LIFT_SEC = 0.7

/**
 * 1 字ぶんの運びの尺。画の区間（`spans`）ごとに使う時間を長さで按分し、
 * 区間と区間の隙間（筆を上げている間）に `STROKE_GAP_MS` を挟む。
 */
interface Timeline {
  spans: [number, number][]
  /** 運びに使う時間の合計（ミリ秒）。画の間はここに含まない */
  writeMs: number
  /** 画の長さの合計（運びのパラメータ単位） */
  drawn: number
  /** 書き始めから書き上がりまで（ミリ秒） */
  duration: number
}

function timelineOf(spans: [number, number][] | null): Timeline {
  // 中心線が無い字は、運びを 1 本の画として等速に進める
  if (!spans || spans.length === 0) {
    return { spans: [[0, 1]], writeMs: WRITE_MS, drawn: 1, duration: WRITE_MS }
  }
  const drawn = spans.reduce((n, [s, e]) => n + Math.max(0, e - s), 0)
  const gaps = (spans.length - 1) * STROKE_GAP_MS
  const writeMs = Math.max(WRITE_MS - gaps, WRITE_MS * MIN_WRITE_RATIO)
  return { spans, writeMs, drawn: drawn || 1, duration: writeMs + gaps }
}

/** 字の書き始めからの経過（ミリ秒）→ 運びの進み具合（0〜1） */
function progressAt(timeline: Timeline, elapsed: number): number {
  if (elapsed <= 0) return 0
  const { spans, writeMs, drawn } = timeline
  let cursor = 0
  for (const [i, [start, end]] of spans.entries()) {
    const span = ((end - start) / drawn) * writeMs
    if (span > 0) {
      if (elapsed < cursor + span) return start + (end - start) * ((elapsed - cursor) / span)
      cursor += span
    }
    if (i === spans.length - 1) break
    // 筆を上げている間。次の画の起筆まで、書き終えた画の終筆で止めておく
    cursor += STROKE_GAP_MS
    if (elapsed < cursor) return end
  }
  return 1
}

export function Splash() {
  const setPhase = useSetAtom(splashAtom)
  /** 音の断りへの答え。出るまでロゴは薄れない */
  const consent = useAtomValue(audioConsentAtom)
  const groupRef = useRef<Group>(null)
  const camera = useThree((state) => state.camera) as OrthographicCamera
  const size = useThree((state) => state.size)

  /** 薄れ具合。墨と滲みの両方がこれを読む */
  const fade = useMemo(() => uniform(1), [])
  const plane = useMemo(() => new PlaneGeometry(1, 1), [])

  const items = useMemo(() => {
    let begin = 0
    return CHARS.map((char, i) => {
      const progress = uniform(0)
      const timeline = timelineOf(strokeSpansOf(char))
      // 前の字を書き上げてから筆を継ぐ。字ごとに画数が違うので順に積む
      const start = begin
      begin += timeline.duration + CHAR_GAP_MS
      const orderCell = orderCellOf(char) ?? -1
      const brush = createBrushMaterial(orderCell, progress)
      // ムラの種は字ごとに変える。3 字が同じ掠れ方をすると版で刷ったように見える
      brush.seed.value = i * 2.7 + 0.4
      const glow = createGlowMaterial(
        float(sdfCellOf(char) ?? -1),
        // 滲みは筆先にだけ残る。書き終えたところから順に乾いていく
        brushTip(float(orderCell), progress, planeCellLocal()).mul(GLOW_STRENGTH),
        { layer: fade },
      )
      return { char, progress, brush, glow, geometry: glyphGeometry(char), timeline, start }
    })
  }, [fade])

  /** 3 字を書き上げて間を置き、音の断りを出す時刻（演出の始まりから、ミリ秒） */
  const askAt = useMemo(() => {
    const last = items[items.length - 1]!
    return last.start + last.timeline.duration + HOLD_MS
  }, [items])

  useEffect(() => {
    return () => {
      plane.dispose()
      for (const item of items) {
        item.brush.material.dispose()
        item.glow.dispose()
      }
    }
  }, [items, plane])

  /**
   * 演出の始まり（`performance.now()`）。最初のフレームで入れる。
   * まだ始まっていない目印は `null`。負数を目印にすると、起動直後のスキップで
   * 始まりが負に振れたときに未開始と見分けが付かず、書き直しになる
   */
  const started = useRef<number | null>(null)
  /** いま出している相。同じ値を毎フレーム書かないための控え */
  const phase = useRef<SplashPhase>('writing')

  /** 答えが出た時刻（`performance.now()`）。ロゴはここから薄れる */
  const answeredAt = useRef<number | null>(null)
  useEffect(() => {
    if (consent !== null && answeredAt.current === null) answeredAt.current = performance.now()
  }, [consent])

  // 触れられたら書き上がりへ飛ばす。読み終えた人を毎回 4 秒待たせない
  useEffect(() => {
    const skip = () => {
      if (started.current === null || phase.current !== 'writing') return
      started.current = performance.now() - askAt
    }
    window.addEventListener('pointerdown', skip)
    window.addEventListener('keydown', skip)
    return () => {
      window.removeEventListener('pointerdown', skip)
      window.removeEventListener('keydown', skip)
    }
  }, [askAt])

  /** 持ち上がりの進み（0〜1）。緩急はこれを `ease` に通して掛ける */
  const lift = useRef(0)

  useFrame((_, delta) => {
    const now = performance.now()
    if (started.current === null) started.current = now
    const elapsed = now - started.current

    // 見えている高さ・幅（ワールド単位）。拡大率は起動直後でも確定している
    const viewHeight = size.height / camera.zoom
    const viewWidth = size.width / camera.zoom
    const unit = Math.min(viewHeight, (viewWidth * MAX_WIDTH) / GLYPH)

    // 断りが出たら、その紙幅を空けるぶんだけ上へ退く。薄れ切るまで戻さない。
    // 緩急は深度をまたぐ動きと同じ曲線（`ease`）に揃える。等速で退くと筆の余韻が切れる
    lift.current = approach(lift.current, elapsed >= askAt ? 1 : 0, delta, ASK_LIFT_SEC)
    const lifted = ease(lift.current) * ASK_LIFT * unit

    const group = groupRef.current
    if (group) {
      // カメラに追従させて画面の中央に据える。紙面のパンに引きずられない
      group.position.set(camera.position.x, camera.position.y + lifted, SPLASH_Z)
      group.scale.setScalar(unit)
    }

    for (const item of items) {
      item.progress.value = progressAt(item.timeline, elapsed - item.start)
      // かすれの粗さはワールド単位で一定。字の実寸が要る（→ materials.ts の `inkDensity`）
      item.brush.scale.value = GLYPH * unit
      item.brush.opacity.value = fade.value as number
    }

    // 書き上がったら答えを待ち（'asking'）、答えが出たところから薄れる
    const answered = answeredAt.current
    const faded = answered === null ? 0 : (now - answered) / FADE_MS
    const next: SplashPhase =
      elapsed < askAt ? 'writing' : answered === null ? 'asking' : faded >= 1 ? 'done' : 'fading'
    fade.value = next === 'writing' || next === 'asking' ? 1 : Math.max(0, 1 - faded)
    if (next !== phase.current) {
      phase.current = next
      setPhase(next)
    }
  })

  return (
    <group ref={groupRef}>
      {items.map((item, i) => {
        const y = ((CHARS.length - 1) / 2 - i) * PITCH
        return (
          <group key={item.char} position={[0, y, 0]}>
            {item.geometry && (
              <mesh geometry={item.geometry} material={item.brush.material} scale={GLYPH} frustumCulled={false} />
            )}
            {/* 滲みは字の裏。加算合成なので墨そのものを白く飛ばさない */}
            <mesh
              geometry={plane}
              material={item.glow}
              position={[0, 0, -0.01]}
              scale={GLYPH * GLOW_PLANE}
              frustumCulled={false}
            />
          </group>
        )
      })}
    </group>
  )
}
