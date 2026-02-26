/**
 * PDF 轉圖片工具
 * 使用 pdfjs-dist 將 PDF 轉成 Canvas，再轉成 Blob（WebP 等格式）
 */

import * as pdfjsLib from 'pdfjs-dist'

// 設定 PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

/**
 * 檢測是否為 Safari 瀏覽器
 */
function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent.toLowerCase()
  return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('android')
}

/**
 * 取得預設圖片格式（Safari 用 JPEG，其他用 WebP）
 * 可用於統一整條處理鏈的輸出格式
 */
export function getDefaultImageFormat(): 'image/jpeg' | 'image/webp' {
  return isSafari() ? 'image/jpeg' : 'image/webp'
}

type RenderGuardParams = {
  viewportWidth: number
  viewportHeight: number
  desiredScale: number
  desiredQuality: number
  maxWidth: number
  maxPixels: number
  minWidth: number // soft floor (preferred target)
  hardMinWidth: number // hard floor (absolute minimum)
  format?: 'image/png' | 'image/jpeg' | 'image/webp'
  pageCount?: number
}

/**
 * 分段渲染超大頁面（上下切兩段各轉一張再合成）
 * 當頁面太大無法在 pixel-cap 內保持 hardMinWidth 時使用
 */
async function renderPageTiled(
  page: pdfjsLib.PDFPageProxy,
  options: {
    targetWidth: number
    format: 'image/png' | 'image/jpeg' | 'image/webp'
    quality: number
    maxPixels: number
  }
): Promise<Blob> {
  const { targetWidth, format, quality, maxPixels } = options
  const baseViewport = page.getViewport({ scale: 1 })

  const scale = targetWidth / baseViewport.width
  const fullHeight = Math.round(baseViewport.height * scale)

  const overlap = 10
  const halfHeight = Math.ceil(fullHeight / 2)

  const tileHeights = [
    halfHeight + overlap,
    fullHeight - halfHeight + overlap
  ]
  const maxTileHeight = Math.max(...tileHeights)

  // ✅ 一次算 shrink，兩段共用（避免上下段縮放不同）
  const tileAreaMax = targetWidth * maxTileHeight
  const shrink = tileAreaMax > maxPixels ? Math.sqrt(maxPixels / tileAreaMax) : 1

  const tileScale = scale * shrink
  const tileW = Math.round(targetWidth * shrink)
  const overlapPx = Math.round(overlap * shrink)

  console.log(
    `[renderPageTiled] scale=${scale.toFixed(3)} shrink=${shrink.toFixed(3)} tile=${tileW}px overlapPx=${overlapPx}`
  )

  const tiles: Blob[] = []

  for (let i = 0; i < 2; i++) {
    const yOffset = i === 0 ? 0 : halfHeight - overlap
    const tileH = Math.round(tileHeights[i] * shrink)

    const canvas = document.createElement('canvas')
    canvas.width = tileW
    canvas.height = tileH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('無法建立 Canvas')

    const viewport = page.getViewport({ scale: tileScale })

    // ✅ 用 transform 做「向上平移」裁切區域（不依賴 ctx.translate）
    const translateY = -Math.round(yOffset * shrink)

    // eslint-disable-next-line no-await-in-loop
    await page
      .render({
        canvasContext: ctx,
        viewport,
        canvas,
        transform: [1, 0, 0, 1, 0, translateY]
      })
      .promise

    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob 失敗'))),
        format,
        quality
      )
    })

    canvas.width = 0
    canvas.height = 0
    tiles.push(blob)
  }

  // 合併兩段（寬度必定一致）
  const bitmaps = await Promise.all(tiles.map((b) => createImageBitmap(b)))
  const finalWidth = bitmaps[0].width
  const finalHeight = bitmaps[0].height + bitmaps[1].height - overlapPx

  const mergeCanvas = document.createElement('canvas')
  mergeCanvas.width = finalWidth
  mergeCanvas.height = finalHeight
  const mctx = mergeCanvas.getContext('2d')
  if (!mctx) {
    bitmaps.forEach((b) => b.close())
    throw new Error('無法建立合併 Canvas')
  }

  mctx.drawImage(bitmaps[0], 0, 0)
  mctx.drawImage(bitmaps[1], 0, bitmaps[0].height - overlapPx)
  bitmaps.forEach((b) => b.close())

  const finalBlob = await new Promise<Blob>((resolve, reject) => {
    mergeCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('合併 toBlob 失敗'))),
      format,
      quality
    )
  })

  mergeCanvas.width = 0
  mergeCanvas.height = 0

  console.log(
    `[renderPageTiled] done: ${finalWidth}x${finalHeight}, ${(finalBlob.size / 1024).toFixed(0)}KB`
  )
  return finalBlob
}

function adjustRenderGuard(params: RenderGuardParams): {
  adjustedScale: number
  adjustedQuality: number
  targetWidth: number
  targetHeight: number
  needsTiling: boolean
} {
  const {
    viewportWidth,
    viewportHeight,
    desiredScale,
    desiredQuality,
    maxWidth,
    maxPixels,
    minWidth,
    hardMinWidth,
    format
  } = params

  const minJpegQuality = 0.68
  const recJpegQuality = 0.7

  let scale = desiredScale
  let quality = desiredQuality

  const widthAtDesired = viewportWidth * scale

  if (widthAtDesired > maxWidth) {
    scale *= maxWidth / widthAtDesired
  }

  const areaAfterWidthCap = viewportWidth * scale * viewportHeight * scale
  if (areaAfterWidthCap > maxPixels) {
    scale *= Math.sqrt(maxPixels / areaAfterWidthCap)
  }

  let widthAfterCaps = viewportWidth * scale

  if (widthAfterCaps < hardMinWidth) {
    const hardScale = hardMinWidth / viewportWidth
    const hardArea = viewportWidth * hardScale * viewportHeight * hardScale

    if (hardArea <= maxPixels) {
      // 拉到 hardMin 不會爆 pixel-cap，可以安全拉升
      scale = hardScale
      widthAfterCaps = viewportWidth * scale
      quality = format === 'image/jpeg' ? Math.max(quality, recJpegQuality) : Math.max(quality, 0.7)
    }
    // else: 拉到 hardMin 會爆 pixel-cap，保留目前 scale，稍後 needsTiling 會被標記
  }

  // soft floor: 只有在不會打穿 maxPixels 時才升級
  if (widthAfterCaps < minWidth) {
    const candidateScale = minWidth / viewportWidth
    const candidateArea = viewportWidth * candidateScale * viewportHeight * candidateScale
    if (candidateArea <= maxPixels) {
      scale = candidateScale
      widthAfterCaps = viewportWidth * scale
    }
  }

  // 再次檢查 pixel-cap（soft floor 可能讓面積超標）
  const areaAfterFloors = viewportWidth * scale * viewportHeight * scale
  if (areaAfterFloors > maxPixels) {
    scale *= Math.sqrt(maxPixels / areaAfterFloors)
  }

  // 最終統一檢查：寬度是否 < hardMin（不管 pixel-cap 這次有沒有觸發）
  let needsTiling = false
  const finalWidth = viewportWidth * scale
  if (finalWidth < hardMinWidth) {
    needsTiling = true
    console.warn(`[adjustRenderGuard] 頁面需要分段渲染：最終寬度 ${Math.round(finalWidth)}px < hardMin ${hardMinWidth}px`)
  }

  if (format === 'image/jpeg') {
    quality = Math.max(quality, minJpegQuality)
  }

  const targetWidth = Math.round(viewportWidth * scale)
  const targetHeight = Math.round(viewportHeight * scale)

  return {
    adjustedScale: scale,
    adjustedQuality: quality,
    targetWidth,
    targetHeight,
    needsTiling
  }
}

/**
 * 將 PDF 檔的「第一頁」轉成單張圖片 Blob
 * @param file PDF 檔
 * @param options 轉換選項
 */
export async function convertPdfToImage(
  file: File,
  options: {
    scale?: number
    format?: 'image/png' | 'image/jpeg' | 'image/webp'
    quality?: number
    maxWidth?: number
    maxPixels?: number
    minWidth?: number
    hardMinWidth?: number
  } = {}
): Promise<Blob> {
  // Safari 對 WebP 支援不佳，改用 JPEG
  const defaultFormat = isSafari() ? 'image/jpeg' : 'image/webp'

  const {
    scale = 2,
    format = defaultFormat,
    quality = 0.8,
    maxWidth = 1900,
    maxPixels = 10_000_000,
    minWidth = 1400,
    hardMinWidth = 1280
  } = options

  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | undefined
  let pdf: pdfjsLib.PDFDocumentProxy | undefined

  try {
    console.log('開始處理 PDF（單頁）:', file.name)
    const arrayBuffer = await file.arrayBuffer()
    loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
    pdf = await loadingTask.promise

    console.log(`PDF 載入成功，共 ${pdf.numPages} 頁`)

    const page = await pdf.getPage(1)
    const baseViewport = page.getViewport({ scale: 1 })

    const { adjustedScale, adjustedQuality, targetWidth, targetHeight, needsTiling } = adjustRenderGuard({
      viewportWidth: baseViewport.width,
      viewportHeight: baseViewport.height,
      desiredScale: scale,
      desiredQuality: quality,
      maxWidth,
      maxPixels,
      minWidth,
      hardMinWidth,
      format
    })

    // needsTiling 降級策略：解析度救不了，至少保住壓縮品質
    let outQuality = adjustedQuality
    if (needsTiling && format === 'image/jpeg') {
      outQuality = Math.max(outQuality, 0.75)
    }

    let blob: Blob

    // 如果需要分段渲染，使用 tiling
    if (needsTiling) {
      blob = await renderPageTiled(page, {
        targetWidth: hardMinWidth, // 使用 hardMinWidth 作為目標寬度
        format,
        quality: outQuality,
        maxPixels
      })
    } else {
      const viewport = page.getViewport({ scale: adjustedScale })

      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')

      if (!context) {
        throw new Error('無法建立 Canvas context')
      }

      canvas.width = targetWidth
      canvas.height = targetHeight

      await page.render({ canvasContext: context, viewport, canvas }).promise

      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) {
              resolve(b)
            } else {
              reject(new Error('Canvas 轉 Blob 失敗'))
            }
          },
          format,
          outQuality
        )
      })

      // 清理資源
      canvas.width = 0
      canvas.height = 0
    }

    page.cleanup()
    return blob
  } catch (error) {
    console.error('PDF 單頁轉圖失敗:', error)
    throw new Error(
      error instanceof Error
        ? `PDF 轉換失敗：${error.message}`
        : 'PDF 轉換失敗'
    )
  }
  finally {
    try {
      await pdf?.destroy?.()
    } catch (e) {
      console.warn('PDF destroy failed', e)
    }
    try {
      await loadingTask?.destroy?.()
    } catch (e) {
      console.warn('loadingTask destroy failed', e)
    }
  }
}

/**
 * 將 PDF 檔「所有頁面」轉成圖片 Blob 陣列
 * @param file PDF 檔
 * @param options 轉換選項
 */
export async function convertPdfToImages(
  file: File,
  options: {
    scale?: number
    format?: 'image/png' | 'image/jpeg' | 'image/webp'
    quality?: number
    maxWidth?: number
    maxPixels?: number
    minWidth?: number
    hardMinWidth?: number
  } = {}
): Promise<Blob[]> {
  const defaultFormat = isSafari() ? 'image/jpeg' : 'image/webp'
  const {
    scale = 2,
    format = defaultFormat,
    quality = 0.8,
    maxWidth = 1900,
    maxPixels = 10_000_000,
    minWidth = 1400,
    hardMinWidth = 1280
  } = options

  let loadingTask: pdfjsLib.PDFDocumentLoadingTask | undefined
  let pdf: pdfjsLib.PDFDocumentProxy | undefined

  let canvas: HTMLCanvasElement | null = null
  let context: CanvasRenderingContext2D | null | undefined

  try {
    console.log('開始處理 PDF（多頁）:', file.name)
    const arrayBuffer = await file.arrayBuffer()
    loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
    pdf = await loadingTask.promise

    console.log(`PDF 載入成功，共 ${pdf.numPages} 頁`)

    const blobs: Blob[] = []
    canvas = document.createElement('canvas')

    context = canvas.getContext('2d')

    if (!canvas || !context) {
      throw new Error('無法建立 Canvas context')
    }

    // 在 guard 之後建立 const 參照以解決 TS 控制流問題
    const canvasRef = canvas
    const contextRef = context

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      if (!pdf) {
        throw new Error('PDF 載入失敗，無法取得頁面')
      }

      const page = await pdf.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })

      const { adjustedScale, adjustedQuality, targetWidth, targetHeight, needsTiling } = adjustRenderGuard({
        viewportWidth: baseViewport.width,
        viewportHeight: baseViewport.height,
        desiredScale: scale,
        desiredQuality: quality,
        maxWidth,
        maxPixels,
        minWidth,
        hardMinWidth,
        format,
        pageCount: pdf.numPages
      })

      // needsTiling 降級策略：解析度救不了，至少保住壓縮品質
      let outQuality = adjustedQuality
      if (needsTiling && format === 'image/jpeg') {
        outQuality = Math.max(outQuality, 0.75)
      }

      let blob: Blob

      // 如果需要分段渲染，使用 tiling
      if (needsTiling) {
        // eslint-disable-next-line no-await-in-loop
        blob = await renderPageTiled(page, {
          targetWidth: hardMinWidth,
          format,
          quality: outQuality,
          maxPixels
        })
      } else {
        const viewport = page.getViewport({ scale: adjustedScale })

        canvasRef.width = targetWidth
        canvasRef.height = targetHeight

        // eslint-disable-next-line no-await-in-loop
        await page.render({ canvasContext: contextRef, viewport, canvas: canvasRef }).promise

        // eslint-disable-next-line no-await-in-loop
        blob = await new Promise<Blob>((resolve, reject) => {
          canvasRef.toBlob(
            (b) => {
              if (b) {
                resolve(b)
              } else {
                reject(new Error('Canvas 轉 Blob 失敗'))
              }
            },
            format,
            outQuality
          )
        })
      }

      page.cleanup()
      blobs.push(blob)

      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0))
    }

    console.log(`PDF 全部轉換完成，共 ${blobs.length} 頁`)
    return blobs
  } catch (error) {
    console.error('PDF 全頁轉圖失敗:', error)
    throw new Error(
      error instanceof Error
        ? `PDF 全頁轉換失敗：${error.message}`
        : 'PDF 全頁轉換失敗'
    )
  } finally {
    if (canvas) {
      try {
        canvas.width = 0
        canvas.height = 0
      } catch {}
    }

    try {
      await pdf?.destroy?.()
    } catch (e) {
      console.warn('PDF destroy failed', e)
    }
    try {
      await loadingTask?.destroy?.()
    } catch (e) {
      console.warn('loadingTask destroy failed', e)
    }
  }
}

/**
 * 從檔案名稱中提取數字（通常是座號）
 * 例如：「1.pdf」→ 1, 「座號03.pdf」→ 3, 「scan_025.pdf」→ 25
 */
function extractNumberFromFilename(filename: string): number | null {
  // 移除副檔名
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '')

  // 嘗試匹配數字（支援前導零）
  const match = nameWithoutExt.match(/\d+/)

  if (match) {
    return parseInt(match[0], 10)
  }

  return null
}

/**
 * 智能排序檔案陣列
 * 優先按照檔案名稱中的數字排序，如果沒有數字則按照檔名字串排序
 */
export function sortFilesByNumber(files: File[]): File[] {
  return [...files].sort((a, b) => {
    const numA = extractNumberFromFilename(a.name)
    const numB = extractNumberFromFilename(b.name)

    // 如果兩個都有數字，按數字排序
    if (numA !== null && numB !== null) {
      if (numA !== numB) {
        return numA - numB
      }
      // 數字相同時，按照檔名字串排序
      return a.name.localeCompare(b.name, 'zh-TW', { numeric: true })
    }

    // 如果只有一個有數字，有數字的排前面
    if (numA !== null) return -1
    if (numB !== null) return 1

    // 都沒有數字，按照檔名字串排序
    return a.name.localeCompare(b.name, 'zh-TW', { numeric: true })
  })
}

/**
 * 簡單檢測檔案類型（圖片 / PDF / 其他）
 */
export function getFileType(file: File): 'image' | 'pdf' | 'unknown' {
  const mimeType = file.type.toLowerCase()

  if (mimeType === 'application/pdf') {
    return 'pdf'
  }

  if (mimeType.startsWith('image/')) {
    return 'image'
  }

  const extension = file.name.split('.').pop()?.toLowerCase()

  if (extension === 'pdf') {
    return 'pdf'
  }

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension || '')) {
    return 'image'
  }

  return 'unknown'
}

/**
 * 將 File 轉成 Blob（主要用於圖片檔）
 */
export async function fileToBlob(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      if (e.target?.result) {
        const blob = new Blob([e.target.result], { type: file.type })
        resolve(blob)
      } else {
        reject(new Error('檔案讀取失敗'))
      }
    }

    reader.onerror = () => {
      reject(new Error('檔案讀取錯誤'))
    }

    reader.readAsArrayBuffer(file)
  })
}


