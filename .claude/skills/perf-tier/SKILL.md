---
name: perf-tier
description: 深般若の性能ティア（Tier 1 WebGPU / Tier 2 WebGL2 / Tier 3 WebGL 不可）の判定と、ティアごとの演出の落とし所、Tier 3 の DOM フォールバック、2 レイヤー合成と技術スタックの前提。Stage.tsx / tier.ts / PaperFallback.tsx を触るときや、環境差による不具合を追うときに参照する。
---

# 性能ティアと描画基盤

**用語を混ぜない。** 深度 `L0/L1/L2…` はユーザーの階層、性能ティア `Tier 1/2/3` は描画能力。**「Tier」は性能の話にのみ使う。**

## 2 レイヤー合成

**組版は DOM、絵は GPU。**

| レイヤー | 内容 | 技術 |
|---|---|---|
| WebGPU レイヤー（Canvas） | 大書の筆文字グリフ、粒子の散開・再凝集、ゆらぎ、hover 発光、円相・連結線の描線 | three.js `WebGPURenderer` + TSL、@react-three/fiber v9 |
| DOM レイヤー（HTML オーバーレイ） | 縦書きの長文解説、サマリー、読み・梵語、読み上げボタン、現在位置インジケータ、左矢印 | `writing-mode: vertical-rl` + motion |

数百字級の縦組みを WebGL で描くと品質・実装コスト・アクセシビリティのすべてで損をするため、この振り分けにする。筆文字は SVG パスがあるので GPU 側の素材として最適。

- **カメラのドラッグ移動は両レイヤーを同期させる。** ワールド座標系のコンテナを 1 つ定義し、three.js のカメラと DOM の `transform` に同じ変換を適用する（→ `pan-zoom`）。
- `drei` の `<Html>` ではなくワールド固定の独自オーバーレイにする（長文組版の制御性、およびフォールバックの都合）。
- **`drei` は使わない**（WebGL 前提のコンポーネントが混ざる）。

## ティア判定

| ティア | 条件 | 内容 |
|---|---|---|
| Tier 1 | `navigator.gpu` あり + アダプタが取れる | フル演出。数十万粒子、コンピュートシェーダ |
| Tier 2 | WebGL2 のみ | 粒子数を 1 桁落とし、頂点シェーダの時間ベースアニメへ切替。中位機のスマホはここ |
| Tier 3 | WebGL 不可 | Canvas を一切マウントせず、DOM レイヤー + CSS フェードのみ |

- 判定順は `navigator.gpu` → WebGL2 コンテキスト取得試行。
- **`navigator.gpu` があってもアダプタが無い環境がある。`renderer.init()` 後に実バックエンドを見てティアを訂正する**（`Stage.tsx` / `tier.ts`）。headless Chromium がまさにこれで、Tier 2 に落ちる。
- `devicePixelRatio` は 1.5〜2 で上限キャップ。
- 起動後数秒のフレームタイム計測で粒子数を動的に下げ、機種差を吸収する。

## 演出の落とし所

演出の**筋書きは全ティアで共通**にし、粒子数と表現の粒度だけを落とす（→ `transition-fx`）。

| ティア | 散開・凝集の表現 |
|---|---|
| `Tier 1` | 数十万粒子。コンピュートシェーダで 1 文字あたり数千点を個別に動かす |
| `Tier 2` | 粒子数を 1 桁落とす。頂点シェーダの時間ベースアニメで散開・凝集を表現。密度の低さを不透明度とサイズで補う |
| `Tier 3` | 粒子表現なし。DOM のフェードイン／アウトのみ。文字の再配置は CSS transition |

Tier 3 は 2 レイヤー構成の帰結として「WebGPU レイヤーを外すだけ」で自然に得られる（`PaperFallback.tsx`）。**Tier 3 の紙面は拡大しない**（→ `pan-zoom`）。

## 技術スタック

| 領域 | 採用 | 備考 |
|---|---|---|
| ビルド | Vite 8 + TypeScript + React 19 | SSR 不要。静的ホスティング前提 |
| 3D | three 0.185 `WebGPURenderer` + TSL / r3f v9 | `gl: async (props) => { const r = new WebGPURenderer(props); await r.init(); return r }` |
| 状態 | Jotai | 現在ノード、遷移フェーズ、パン量、設定（音量等） |
| 遷移制御 | 小さな手書き FSM | 相を明示的に持つ（→ `navigation-fsm`） |
| アニメーション | TSL（粒子）+ spring 補間（カメラ・DOM） | DOM 側は motion |
| コンテンツ | YAML（グラフ）+ Markdown（解説） | **ビルド時に JSON へ変換する自作 Vite プラグイン。ランタイムに YAML パーサを載せない。** zod で検証 |
| 音声 | Web Audio API 直 | → `audio-design` |

## ターゲット環境

- 最新のスマホ・タブレット・Chrome のみを対象とする。
- **スマホ対応は必須要件。** ただし左右スクロールではなく、**ドラッグでカメラのフレームを移動**させる操作にする。

## 環境差で踏んだもの

| 症状 | 原因と対処 |
|---|---|
| ティアが実態と合わない | `navigator.gpu` の有無だけで判定していた。`init()` 後に実バックエンドを見て訂正する |
| hover 発光が効かない | `instanceColor` は `WebGPURenderer` のノードマテリアル経路で効かない。インスタンス属性 + TSL で書く（→ `ink-visuals`） |
| 粒子が 1px に潰れて見えない | `PointsNodeMaterial` の `sizeNode` は `Points` に対して読まれない。`Sprite` のインスタンシングへ（→ `transition-fx`） |
| レイキャストに当たらない | 当たり判定用オブジェクトを `visible={false}` にしていた。透明マテリアルで置く |
| 遷移が固まったり固まらなかったり | マテリアルを作り直している。TSL の吐くソースが毎回変わりプログラムキャッシュに当たらない（→ `transition-fx`） |
