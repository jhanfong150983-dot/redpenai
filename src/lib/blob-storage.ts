export function shouldAvoidIndexedDbBlob(): boolean {
  if (typeof navigator === 'undefined') return false

  const ua = navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const isIPadOS = !isIOS && /Macintosh/.test(ua) && navigator.maxTouchPoints > 1

  return isIOS || isIPadOS
}

export function isIndexedDbBlobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('blob') ||
    lower.includes('dataclone') ||
    lower.includes('structured clone') ||
    lower.includes('preparing') ||
    lower.includes('object store')
  )
}
