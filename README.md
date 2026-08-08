# 深般若 — Graphical Heart Sutra Explorer

般若心経を「文字 → 句 → 語 → 構成要素」と際限なく潜っていける、グラフィカルな訳文兼辞書。
**サイトの探索自体が瞑想体験になる UI** を目指す。

## 訪問者が受け取る体験

1. 経文全体がほんわかと浮かんでレンダリングされ、各文字が微妙にゆらいでいる。
2. ある句に hover すると、その範囲の文字がフォーカスして明るくなる。
3. クリックで他の文字が退き、その句へズームイン。訳と解説が現れる。
4. 句の中の語に hover すると構成要素がふわりと周囲に並び、クリックでさらに一段潜る。
5. 以下、あらゆるレイヤー・あらゆる詳細度の用語で同じ操作が反復される。

全遷移はふんわりと滑らかに接続し、その間 BGM は途切れず鳴り続ける。

## 貫く方針

判断に迷ったときはここへ戻る。個々の実装はすべてこの 6 つの帰結として書かれている。

### 1. 紙面は写経の紙面である

ルート画面の格子は、均質な升目に文字が整然と収まった写経の紙面をそのまま画面にしたもの。
だから**意味による分節をしない**（区切りは触れたときだけ浮かぶ）。だから**画面に収まらない**（紙は画面より大きいのが自然）。

### 2. 収めるために設計を曲げない

字の大きさは可読性から決め、画面幅から逆算しない。はみ出したぶんは縮小・折り返し変更・段組み変更ではなく、
**ドラッグで送る**ことで補う。操作は PC とスマホで出し分けない。

### 3. 情報は右から左へ流れる

縦書きの読み順。右が「今いるノード」、左が「その詳説」。この構図は画面幅が変わっても崩さない。

### 4. 潜ると戻るは対称ではない

潜る = 選ばなかった字が解けて飛ぶ。戻る = 無から浮かび上がる。逆再生にはしない。
どちらでも**選んだノードの字だけは薄れも現れもせず、同じ存在として動き続ける**。これが「同じ紙面の続きにいる」感覚を支える。

### 5. 音はノイズにならない

BGM は 1 トラックを常時ループ。階層で切り替えない。音量 UI を振り切っても前に出ない天井を置く。

### 6. 静けさを色数で守る

背景はほぼ黒、白は 3 段の明度差、有彩色は琥珀のアクセントだけ。密度は低く、余白は大きく。

## 用語 — 深度と性能ティアを混同しない

| 呼称 | 意味 | 例 |
|---|---|---|
| **深度 `L0` / `L1` / `L2` …** | グラフを潜った階層。ユーザーの現在位置 | `L0` = 全文の紙面、`L1` = 句、`L3` = 語 |
| **性能ティア `Tier 1` / `Tier 2` / `Tier 3`** | 実行環境の描画能力 | `Tier 1` = WebGPU、`Tier 2` = WebGL2、`Tier 3` = WebGL 不可 |

「Tier」は性能の話にのみ使う。階層の話には使わない。

## 構成

**2 レイヤー合成 — 組版は DOM、絵は GPU。** 縦組みの長文は `writing-mode: vertical-rl` の DOM オーバーレイ、
筆文字グリフ・粒子・ゆらぎ・発光・描線は WebGPU レイヤー。両者はパンを 1 つの atom から読んで同期する。

Vite 8 + TypeScript + React 19 / @react-three/fiber v9 / three 0.185（`WebGPURenderer` + TSL）/ Jotai / motion / zod。
SSR 無し・静的ホスティング前提。

```
src/
  scene/    Stage.tsx(Canvas+ティア訂正) Paper.tsx(L0格子) NodeStage.tsx(L1以降/3レイアウト)
            Transition.tsx(遷移演出) Particles.tsx carry.ts sway.ts glyphs.ts tier.ts materials.ts
  overlay/  Overlay.tsx PaperFallback.tsx SpeakButton.tsx AudioControls.tsx LeftArrow.tsx
  nav/      fsm.ts atoms.ts router.ts
  content/  schema.ts loader.ts sutra.ts
  world/    paper.ts(格子寸法) pan.ts(可動域・ドラッグ・拡大) node-layout.ts(L1以降の寸法/overlayInsets)
  audio/    index.ts
  generated/  build-glyphs.ts の出力（索引）。コミットしない
scripts/    build-glyphs.ts svg-path.ts sdf.ts validate-graph.ts
content/    sutra.txt / graph/*.yaml(18) / docs/*.md(18)
public/     glyphs/  build-glyphs.ts の出力（mesh/particles/sdf）。コミットしない
assets/     svg/(筆文字123) pattern/circle.svg bgm/ sfx/ voice/(未収録)
docs/       設計資料
sample_image/  PC モック 3 枚（参照用）
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | グリフ前計算 → 開発サーバ |
| `npm run build` | グラフ検証 → グリフ前計算 → `tsc --noEmit` → 本番ビルド |
| `npm run content:validate` | `content/` の静的検証のみ |
| `npm run content:build` | グリフ前計算のみ |
| `npm run typecheck` | `tsc --noEmit` |

テストランナーは無い。検証は `content:validate` と型検査、あとは画面で確認する。
clone 直後は `npm run content:build` を先に走らせる（`src/generated/` と `public/glyphs/` は生成物）。

## 設計資料

観点ごとの設計は Claude Code の skill（`.claude/skills/`）に分かれている。
作業に関係する観点だけを読み込めばよい。**各 skill が、その観点の正典。**

| skill | 扱う範囲 |
|---|---|
| [`sutra-content`](.claude/skills/sutra-content/SKILL.md) | コンテンツモデル。`sutra.txt` の `range`、YAML グラフ、`id` 命名規約、`label`/`reading` の列の切れ目、ビルド時検証 |
| [`paper-grid`](.claude/skills/paper-grid/SKILL.md) | L0 の紙面。格子の組み方、`index → (column, row)`、意味の区切りを見せない方針、hover で範囲だけが光る表現 |
| [`node-screen`](.claude/skills/node-screen/SKILL.md) | L1 以降の画面文法。モック分析、3 種の `layout`、`node-layout.ts` の単独責務、`overlayInsets` |
| [`transition-fx`](.claude/skills/transition-fx/SKILL.md) | 遷移演出。持ち越される字、散開と凝集、尺とカーブ、面の用意をやり直さない理由 |
| [`pan-zoom`](.claude/skills/pan-zoom/SKILL.md) | パンと拡大。可動域の実測、ばねを 1 箇所に置く理由、ドラッグの捕捉 |
| [`ink-visuals`](.claude/skills/ink-visuals/SKILL.md) | デザイントークン、墨のかすれ、ゆらぎ、SDF による琥珀グロー、グリフと円相の前計算 |
| [`navigation-fsm`](.claude/skills/navigation-fsm/SKILL.md) | 遷移フェーズ FSM、URL 同期、現在位置インジケータ、左矢印、読み上げボタン |
| [`audio-design`](.claude/skills/audio-design/SKILL.md) | BGM の常時ループと配信方式、上限ゲイン、SFX、収録音声の読み上げとダッキング |
| [`perf-tier`](.claude/skills/perf-tier/SKILL.md) | 2 レイヤー合成、ティア判定と訂正、ティアごとの落とし所、技術スタック、環境差の落とし穴 |

| 資料 | 内容 |
|---|---|
| [`docs/status.md`](docs/status.md) | 実装状況、完了条件、未確認の項目、未決事項 |
| [`CLAUDE.md`](CLAUDE.md) | 毎回の起動時に要る最小限の索引 |

---

### 補足: 本ドキュメントの方針

経文本文および解説文の本文テキストは、意図的にドキュメントへ含めていない。
これらは `content/graph/*.yaml` の `summary` および `content/docs/*.md` が唯一の出所であり、
README・skill・コード・コミットメッセージに複製しない。
