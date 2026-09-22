// 在 Node 跑前端同一支 autoDetectSheetGrid（用 @napi-rs/canvas 假扮 DOM），拿 Storage 上瀏覽器真正轉出的頁圖重現
//   用法：npx tsx scripts/_essay_autobox_node.mts <image…>
import fs from 'node:fs'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const g = globalThis as any
g.document = { createElement: (tag: string) => { if (tag !== 'canvas') throw new Error(tag); return createCanvas(1, 1) } }
g.createImageBitmap = async (blob: Blob) => {
  const img = await loadImage(Buffer.from(await blob.arrayBuffer()))
  return { width: img.width, height: img.height, close() {}, __img: img }
}
// napi canvas 的 drawImage 收 Image，不收我們的假 bitmap → 包一層
const origGetContext = (createCanvas(1, 1) as any).constructor.prototype.getContext
;(createCanvas(1, 1) as any).constructor.prototype.getContext = function (type: string, opts?: unknown) {
  const ctx = origGetContext.call(this, type, opts)
  if (!ctx) return ctx
  const draw = ctx.drawImage.bind(ctx)
  ctx.drawImage = (src: any, ...rest: any[]) => draw(src?.__img ?? src, ...rest)
  return ctx
}

;(globalThis as any).__ESSAY_DBG = !!process.env.ESSAY_DBG
const { autoDetectSheetGrid } = await import('../src/lib/essaySheetAnalyze')
for (const f of process.argv.slice(2)) {
  const blob = new Blob([fs.readFileSync(f)])
  const r = await autoDetectSheetGrid(blob)
  console.log(f.split(/[\\/]/).pop(), r ? `${r.box.x.toFixed(4)},${r.box.y.toFixed(4)},${r.box.w.toFixed(4)},${r.box.h.toFixed(4)} → ${r.cols}行×${r.rows}格 窄欄${r.gutter} (v${r.vLines} h${r.hLines})` : 'null')
}
