/**
 * 安全的 canvas.toBlob 包裝器
 *
 * 解決平板Chrome的WebP兼容性問題：
 * 1. WebP 編碼失敗時自動 fallback 到 JPEG
 * 2. 添加 timeout 保護防止永久掛起
 *    - 依 canvas 像素量自動放寬 timeout（多張合併的巨圖編碼較慢，不應誤判失敗）
 *    - 分頁切到背景時暫停計時、回前景再續，避免「老師切走畫面」被當成超時
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
   * Timeout 時間下限（毫秒）。實際 timeout 會取此值與「依圖片像素量自動計算的值」之較大者，
   * 且只計入分頁前景可見的時間（背景凍結不計）。
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

  // 2. 依 canvas 像素量自動放寬 timeout
  //    多張照片合併後的巨圖（如 3000×16000≈48MP）在平板上編碼可能遠超 5 秒，
  //    固定 5 秒會把「還在正常編碼」誤判成失敗。改為每百萬像素額外給 600ms、
  //    上限 60 秒；呼叫端若明確傳入更大的 timeoutMs 則尊重之。
  const megapixels = (canvas.width * canvas.height) / 1_000_000
  const sizeBasedTimeoutMs = Math.min(60_000, 5_000 + Math.round(megapixels * 600))
  const effectiveTimeoutMs = Math.max(timeoutMs, sizeBasedTimeoutMs)

  console.log(
    `🎨 canvas.toBlob: 請求格式=${requestedFormat}, 實際格式=${format}, WebP支持=${supportsWebP}, ` +
      `尺寸=${canvas.width}x${canvas.height}(${megapixels.toFixed(1)}MP), timeout=${effectiveTimeoutMs}ms`
  )

  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null
    let resolved = false

    // 3. 背景分頁暫停計時
    //    分頁切到背景時，瀏覽器會凍結/降速 canvas 編碼，但 setTimeout 仍以真實時間在跑，
    //    會把「老師切走畫面」誤判成超時。改為只累計「前景可見」的時間：切到背景就停錶、
    //    回到前景再續錶，背景被凍結的時間不計入。
    let remainingMs = effectiveTimeoutMs
    let segmentStartedAt: number | null = null

    const onTimeout = () => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(
        new Error(
          `canvas.toBlob 超時（${effectiveTimeoutMs}ms 前景時間）- 可能是${format}格式不支持或記憶體不足`
        )
      )
    }

    const arm = () => {
      // 分頁不可見時不計時，等回到前景再啟動
      if (typeof document !== 'undefined' && document.hidden) return
      segmentStartedAt = Date.now()
      timeoutId = window.setTimeout(onTimeout, Math.max(0, remainingMs))
    }

    const disarm = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (segmentStartedAt !== null) {
        remainingMs -= Date.now() - segmentStartedAt
        segmentStartedAt = null
      }
    }

    const onVisibilityChange = () => {
      if (resolved) return
      if (typeof document !== 'undefined' && document.hidden) {
        disarm()
      } else {
        arm()
      }
    }

    const cleanup = () => {
      disarm()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    arm()

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
