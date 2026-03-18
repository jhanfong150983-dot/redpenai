import { useEffect, useState } from 'react'
import { SYNC_EVENT_NAME, SYNC_COMPLETE_EVENT_NAME } from '@/lib/sync-events'

/**
 * 全頁面頂端同步進度條
 * 當同步請求發出後顯示，同步完成後消失。
 */
export default function GlobalSyncBar() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const show = () => setVisible(true)
    const hide = () => setVisible(false)

    window.addEventListener(SYNC_EVENT_NAME, show)
    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, hide)
    return () => {
      window.removeEventListener(SYNC_EVENT_NAME, show)
      window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, hide)
    }
  }, [])

  if (!visible) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-1 overflow-hidden bg-blue-100">
      <div className="h-full w-1/2 animate-syncSlide bg-blue-500" />
    </div>
  )
}
