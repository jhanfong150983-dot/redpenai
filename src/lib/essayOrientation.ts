// 2026-09-22 作文稿紙一律橫式（user 拍板：會考 B4、學測 A3、市售 500／600 字稿紙全是橫式直書；A4 500 字稿紙 PDF 裡雖是直式頁、
//   內容其實是橫著排的）→ PDF 轉圖／掃描進來若是直式（高 > 寬）就自動順時針轉 90°，老師不用按轉向。
//   方向取順時針：實測「作文稿紙500字A4」PDF 的標題字是逆時針躺著、順時針轉回來才正；轉錯（顛倒）老師仍可用稿紙頁的「轉向」鈕再轉。
//   server cutEssayColumns 也以「一頁＝扁的（高<寬）、兩頁上下疊」判頁數，所以每頁進合併前就要轉正。
import { rotateImageBlob } from '@/lib/imageCompression'

async function blobSize(blob: Blob): Promise<{ w: number; h: number }> {
  const bmp = await createImageBitmap(blob)
  const s = { w: bmp.width, h: bmp.height }
  bmp.close()
  return s
}

/** 直式頁 → 順時針轉 90°；橫式頁原樣回傳 */
export async function uprightEssayPage(blob: Blob): Promise<Blob> {
  try {
    const { w, h } = await blobSize(blob)
    return h > w ? await rotateImageBlob(blob, 90) : blob
  } catch {
    return blob
  }
}

export async function uprightEssayPages<T extends Blob>(blobs: T[]): Promise<Blob[]> {
  const out: Blob[] = []
  for (const b of blobs) out.push(await uprightEssayPage(b))
  return out
}
