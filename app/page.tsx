import { root } from '../src/content/loader.ts'
import { StaticDoc } from './StaticDoc.tsx'

/**
 * L0（全文の紙面）。絵と操作は layout の AppShell が描く。
 * page が持つのは metadata（layout の既定）と、GPU レイヤーの写しである隠し文書だけ。
 */
export default function Page() {
  return <StaticDoc node={root} />
}
