/**
 * WebGPU レイヤー。
 *
 * Tier 1 / Tier 2 でのみマウントされる（Tier 3 は Canvas を一切作らない）。
 * WebGPURenderer は WebGPU が無ければ WebGL2 バックエンドへ落ちるので、
 * 2 つのティアで同じシーングラフ・同じ TSL ノードグラフが走る。
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import * as THREE from 'three/webgpu'
import { Paper } from './Paper.tsx'
import { NodeStage } from './NodeStage.tsx'
import { Transition } from './Transition.tsx'
import { loadGlyphs } from './glyphs.ts'
import { cappedDpr, measureFrameBudget } from './tier.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import { panXAtom, panBoundsAtom, panBoundsFor, halfWidthFor, INITIAL_PAN_X } from '../world/pan.ts'
import { navAtom, isRootAtom, particleScaleAtom, tierAtom } from '../nav/atoms.ts'
import { root } from '../content/loader.ts'

/** 視野高を VIEW_HEIGHT に固定し、パンをカメラへ反映する */
function CameraRig() {
  const camera = useThree((state) => state.camera) as THREE.OrthographicCamera
  const size = useThree((state) => state.size)
  const panX = useAtomValue(panXAtom)
  const setPan = useSetAtom(panXAtom)
  const setBounds = useSetAtom(panBoundsAtom)
  const isRoot = useAtomValue(isRootAtom)
  const target = useRef(INITIAL_PAN_X)
  const initialised = useRef(false)
  /** 最初のフレームで読み始めの位置へ飛ばしたか */
  const snapped = useRef(false)

  useEffect(() => {
    // 縦 16 升ぶんが必ず画面高に収まる。はみ出すのは横方向のみ
    camera.zoom = size.height / VIEW_HEIGHT
    camera.updateProjectionMatrix()

    // 可動域は画面のアスペクト比で変わる。リサイズのたびに引き直す
    const bounds = panBoundsFor(halfWidthFor(size.width, size.height))
    setBounds(bounds)
    // 読み始めは紙面の右上、すなわち第 1 列の先頭。
    // atom の初期値は窓の寸法から出してあるので、ここは Canvas の実測との差を詰めるだけ。
    // 補間を挟むと起動直後に紙面が横へ流れて見えるので、初回はカメラごと飛ばす
    setPan((x) => (initialised.current ? x : bounds.max))
    if (!initialised.current) {
      initialised.current = true
      target.current = bounds.max
      camera.position.x = bounds.max
    }
  }, [camera, size.width, size.height, setBounds, setPan])

  useFrame((_, delta) => {
    // L0 ではパンに追従し、潜ったら中央へ戻る
    target.current = isRoot ? panX : 0
    // 最初の 1 フレームだけは補間せず読み始めの位置へ置く。
    // 補間すると起動直後に紙面が中央から右へ流れて見える
    if (!snapped.current) {
      snapped.current = true
      camera.position.x = target.current
      return
    }
    // spring 相当の指数補間。フレームレートに依らないよう delta で減衰させる
    const k = 1 - Math.exp(-delta * 9)
    camera.position.x += (target.current - camera.position.x) * k
  })

  return null
}

/** 実測フレームタイムから粒子数の係数を決め、機種差を吸収する */
function FrameBudget() {
  const setScale = useSetAtom(particleScaleAtom)
  useEffect(() => measureFrameBudget(setScale), [setScale])
  return null
}

function SceneContent() {
  const nav = useAtomValue(navAtom)
  const showPaper = nav.nodeId === root.id
  return (
    <>
      <CameraRig />
      <FrameBudget />
      {showPaper ? <Paper /> : <NodeStage />}
      <Transition />
    </>
  )
}

export function Stage() {
  const [ready, setReady] = useState(false)
  const setTier = useSetAtom(tierAtom)
  useEffect(() => {
    loadGlyphs().then(() => setReady(true))
  }, [])

  if (!ready) return null

  return (
    <Canvas
      className="stage"
      orthographic
      // position の x は 0 のまま置く。r3f は原点を向く姿勢を初期に与えるので、
      // ここに読み始めの x を書くとカメラが斜めを向き、紙面が横に潰れる。
      // 読み始めの位置は CameraRig が最初のフレームで入れる
      camera={{
        position: [0, 0, 10],
        near: 0.1,
        far: 100,
        zoom: (globalThis.innerHeight || 0) / VIEW_HEIGHT || 40,
      }}
      dpr={cappedDpr()}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(props as THREE.WebGPURendererParameters)
        await renderer.init()
        // navigator.gpu があってもアダプタが取れず WebGL2 バックエンドへ落ちることがある。
        // 粒子数はバックエンドの実態に合わせる必要があるので、init 後の結果でティアを訂正する
        const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined
        if (!backend?.isWebGPUBackend) setTier(2)
        return renderer
      }}
    >
      <Suspense fallback={null}>
        <SceneContent />
      </Suspense>
    </Canvas>
  )
}
