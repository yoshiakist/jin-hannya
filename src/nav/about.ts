/**
 * このサイトについて（`kind: page` の独立ページ）への入口。
 *
 * ページの実体はコンテンツ側（`content/graph/about.yaml`）にある。ここが持つのは
 * 「その id」だけで、パスは他のノードと同じ写像（`pathOf`）から引く。
 * ノードが無い状態でもアプリは動く（リンクが出ないだけ）ようにしてある。
 */

import { nodeById } from '../content/loader.ts'
import { pathOf } from './url.ts'

export const ABOUT_ID = 'about'

export const hasAboutPage: boolean = nodeById(ABOUT_ID)?.kind === 'page'

export const ABOUT_PATH: string = pathOf(ABOUT_ID)
