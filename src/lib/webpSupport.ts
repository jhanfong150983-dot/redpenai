/**
 * WebP 支持檢測工具
 *
 * 使用運行時檢測替代不可靠的 User Agent 檢測
 * 通過實際測試 canvas.toBlob 來確定瀏覽器是否支持 WebP 編碼
 */

import { debugLog } from './logger'

let webpSupportCache: boolean | null = null

/**
 * 運行時檢測瀏覽器是否支持 WebP 編碼
 *
 * @returns Promise<boolean> - true 表示支持 WebP，false 表示不支持
 *
 * @example
 * ```typescript
 * const supported = await checkWebPSupport()
 * if (supported) {
 *   // 使用 WebP 格式
 * } else {
 *   // fallback 到 JPEG
 * }
 * ```
 */
export async function checkWebPSupport(): Promise<boolean> {
  // 如果已經檢測過，直接返回緩存結果
  if (webpSupportCache !== null) {
    return webpSupportCache
  }

  try {
    // 創建 1x1 像素的測試 canvas
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1

    const result = await new Promise<boolean>((resolve) => {
      canvas.toBlob(
        (blob) => {
          // 如果返回 null 或大小為 0，表示不支持
          const supported = blob !== null && blob.size > 0
          resolve(supported)
        },
        'image/webp',
        0.8
      )

      // 設置 timeout，如果 1 秒內沒有響應則認為不支持
      // 某些舊版瀏覽器可能不會觸發回調
      setTimeout(() => resolve(false), 1000)
    })

    webpSupportCache = result
    debugLog(`✅ WebP 支持檢測完成: ${result ? '支持' : '不支持'}`)
    return result
  } catch (error) {
    console.warn('⚠️ WebP 支持檢測失敗，默認為不支持', error)
    webpSupportCache = false
    return false
  }
}

/**
 * 同步獲取 WebP 支持狀態
 *
 * 注意：必須先調用過 checkWebPSupport() 才能使用此函數
 * 如果尚未檢測，返回 false（安全預設）
 *
 * @returns boolean - true 表示支持 WebP，false 表示不支持或尚未檢測
 *
 * @example
 * ```typescript
 * // 在應用啟動時檢測
 * await checkWebPSupport()
 *
 * // 之後可以同步獲取結果
 * const format = getWebPSupportSync() ? 'image/webp' : 'image/jpeg'
 * ```
 */
export function getWebPSupportSync(): boolean {
  return webpSupportCache ?? false
}

/**
 * 獲取推薦的圖片格式
 *
 * 根據瀏覽器對 WebP 的支持情況，返回推薦的圖片格式
 *
 * @returns Promise<'image/jpeg' | 'image/webp'> - 推薦的圖片 MIME 類型
 *
 * @example
 * ```typescript
 * const format = await getRecommendedImageFormat()
 * canvas.toBlob(callback, format, quality)
 * ```
 */
export async function getRecommendedImageFormat(): Promise<'image/jpeg' | 'image/webp'> {
  const supported = await checkWebPSupport()
  return supported ? 'image/webp' : 'image/jpeg'
}

/**
 * 重置檢測緩存（僅用於測試）
 *
 * @internal
 */
export function resetWebPCache(): void {
  webpSupportCache = null
}
