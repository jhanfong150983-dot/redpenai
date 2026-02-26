import { useEffect, useRef } from 'react'
import { getInkSessionId, startInkSession, closeInkSession } from '@/lib/ink-session'

/**
 * 批改頁面專用 Hook：管理 Ink Session 生命週期
 * 
 * - 頁面 mount 時 startInkSession()
 * - 頁面 unmount 時 closeInkSession()
 * - 處理瀏覽器關閉/重新整理
 * 
 * @example
 * ```tsx
 * function GradingPage() {
 *   useInkSessionOnPageLifecycle()
 *   // ... 頁面邏輯
 * }
 * ```
 */
export function useInkSessionOnPageLifecycle() {
  const closingRef = useRef(false)
  const startedRef = useRef(false)

  useEffect(() => {
    const ensureSession = async () => {
      if (startedRef.current) return
      startedRef.current = true

      // 已有 session（例如同頁面重載狀態復原）就不重建
      if (getInkSessionId()) {
        console.log('[ink-session] 頁面載入：已有 session，沿用')
        return
      }

      try {
        console.log('[ink-session] 頁面載入：建立新 session...')
        await startInkSession()
        console.log('[ink-session] 頁面載入：session 建立成功')
      } catch (e) {
        // 這裡不要 throw，避免整頁壞掉
        console.warn('[ink-session] 頁面載入：建立 session 失敗:', e)
      }
    }

    ensureSession()

    return () => {
      if (closingRef.current) return
      closingRef.current = true

      // ⚠️ unmount 時不能 await（React 不等），但可以 fire-and-forget
      console.log('[ink-session] 頁面離開：關閉 session...')
      void closeInkSession().catch((e) => {
        console.warn('[ink-session] 頁面離開：關閉 session 失敗:', e)
      })
    }
  }, [])

  // 處理瀏覽器關閉/重新整理（unmount 有時候抓不到）
  useEffect(() => {
    const handler = () => {
      // pagehide/beforeunload 不能做複雜 async，盡力送一次
      console.log('[ink-session] 瀏覽器關閉/重新整理：嘗試關閉 session...')
      void closeInkSession().catch(() => {})
    }

    window.addEventListener('pagehide', handler)
    window.addEventListener('beforeunload', handler)

    return () => {
      window.removeEventListener('pagehide', handler)
      window.removeEventListener('beforeunload', handler)
    }
  }, [])
}

export default useInkSessionOnPageLifecycle
