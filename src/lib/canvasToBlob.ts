/**
 * 安全的 canvas.toBlob 包裝器
 *
 * 解決平板Chrome的WebP兼容性問題：
 * 1. WebP 編碼失敗時自動 fallback 到 JPEG
 * 2. 添加 timeout 保護防止永久掛起
 * 3. 修復 Blob type 屬性丟失問題
 * 4. 處理 toBlob 返回 null 的情況
 */

import { getWebPSupportSync } from './webpSupport'

export interface ToBlobOptions {
  /**
   * 圖片格式
   * @default 'image/webp' (會根據瀏覽器支持情況自動調整)
   */
  format?: 'image/jpeg' | 'image/png' | 'image/webp'

  /**
   * 圖片質量 (0-1)
   * @default 0.8
   */
  quality?: number

  /**
   * Timeout 時間（毫秒）
   * @default 5000 (5秒)
   */
  timeoutMs?: number
}

/**
 * 安全的 canvas.toBlob 函數，帶自動 fallback 和 timeout 保護
 *
 * @param canvas - HTML Canvas 元素
 * @param options - 轉換選項
 * @returns Promise<Blob> - 轉換後的 Blob 對象
 * @throws Error - 如果轉換失敗或超時
 *
 * @example
 * ```typescript
 * const canvas = document.createElement('canvas')
 * // ... 繪製圖片到 canvas ...
 *
 * try {
 *   const blob = await safeToBlobWithFallback(canvas, {
 *     format: 'image/webp',  // 平板不支持時會自動 fallback 到 JPEG
 *     quality: 0.8
 *   })
 *   console.log('轉換成功:', blob.type, blob.size)
 * } catch (error) {
 *   console.error('轉換失敗:', error)
 * }
 * ```
 */
export async function safeToBlobWithFallback(
  canvas: HTMLCanvasElement,
  options: ToBlobOptions = {}
): Promise<Blob> {
  const {
    format: requestedFormat = 'image/webp',
    quality = 0.8,
    timeoutMs = 5000
  } = options

  // 1. 根據 WebP 支持情況選擇格式
  const supportsWebP = getWebPSupportSync()
  const format =
    requestedFormat === 'image/webp' && !supportsWebP ? 'image/jpeg' : requestedFormat

  console.log(
    `🎨 canvas.toBlob: 請求格式=${requestedFormat}, 實際格式=${format}, WebP支持=${supportsWebP}`
  )

  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null
    let resolved = false

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    // Timeout 保護
    timeoutId = window.setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(
          new Error(
            `canvas.toBlob 超時（${timeoutMs}ms）- 可能是${format}格式不支持或記憶體不足`
          )
        )
      }
    }, timeoutMs)

    canvas.toBlob(
      (blob) => {
        if (resolved) return
        resolved = true
        cleanup()

        if (!blob) {
          // 如果返回 null，嘗試 fallback 到 JPEG
          if (format !== 'image/jpeg') {
            console.warn(`⚠️ ${format} 返回 null，fallback 到 JPEG`)
            safeToBlobWithFallback(canvas, { ...options, format: 'image/jpeg' })
              .then(resolve)
              .catch(reject)
          } else {
            reject(new Error('canvas.toBlob 返回 null - 可能是記憶體不足或 canvas 損壞'))
          }
          return
        }

        // 修復 Blob type（某些瀏覽器可能返回空 type）
        if (!blob.type || blob.type === '') {
          console.warn(`⚠️ Blob type 為空，手動設定為 ${format}`)
          const fixedBlob = new Blob([blob], { type: format })
          resolve(fixedBlob)
        } else {
          resolve(blob)
        }
      },
      format,
      quality
    )
  })
}

/**
 * 同步版本的格式選擇（不執行toBlob，只返回推薦格式）
 *
 * @param requestedFormat - 請求的格式
 * @returns 實際應使用的格式
 *
 * @example
 * ```typescript
 * const format = getSafeFormat('image/webp')
 * // 平板Chrome上會返回 'image/jpeg'
 * // 桌面Chrome上會返回 'image/webp'
 * ```
 */
export function getSafeFormat(
  requestedFormat: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/webp'
): 'image/jpeg' | 'image/png' | 'image/webp' {
  const supportsWebP = getWebPSupportSync()
  return requestedFormat === 'image/webp' && !supportsWebP ? 'image/jpeg' : requestedFormat
}
