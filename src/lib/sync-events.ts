export const SYNC_EVENT_NAME = 'rp-sync-request'
export const SYNC_COMPLETE_EVENT_NAME = 'rp-sync-complete'

export function requestSync() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAME))
}

export function notifySyncComplete() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SYNC_COMPLETE_EVENT_NAME))
}

export function waitForSync(timeoutMs = 30000): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null

    // 只有當 timeoutMs > 0 時才設置超時
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
        reject(new Error('同步超時'))
      }, timeoutMs)
    }

    const handler = () => {
      if (timeout) clearTimeout(timeout)
      window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
      resolve()
    }

    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handler, { once: true })
  })
}
