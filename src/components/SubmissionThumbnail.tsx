import { useState, useEffect, memo } from 'react'
import { ImageIcon } from 'lucide-react'

export interface SubmissionThumbnailData {
  id?: string
  status?: string
  thumbnailBlob?: Blob
  thumbnailBase64?: string
  imageBlob?: Blob
  imageBase64?: string
  imageUrl?: string
  thumbUrl?: string
  thumbnailUrl?: string
}

// Cache: submissionId → fetched ObjectURL (avoid re-fetching on every render)
const fetchedUrlCache = new Map<string, string>()
// Cache: Blob reference → ObjectURL (avoid recreating URL for same blob)
const blobUrlCache = new WeakMap<Blob, string>()

function SubmissionThumbnailInner({ submission }: {
  submission?: SubmissionThumbnailData | null
}) {
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null)

  // 只用縮圖，不 fallback 到原圖（原圖幾 MB，渲染會 lag）
  const thumbBlob = submission?.thumbnailBlob && submission.thumbnailBlob.size > 0
    ? submission.thumbnailBlob
    : null

  const base64Url = submission?.thumbnailBase64 || null

  // Blob → ObjectURL（用 WeakMap cache，避免重複建立）
  const blobUrl = thumbBlob ? (() => {
    const cached = blobUrlCache.get(thumbBlob)
    if (cached) return cached
    const url = URL.createObjectURL(thumbBlob)
    blobUrlCache.set(thumbBlob, url)
    return url
  })() : null

  // Fallback: fetch thumbnail from Storage API when no local data available
  const subId = submission?.id
  const storagePath = submission?.thumbUrl || submission?.thumbnailUrl || submission?.imageUrl || null
  const needsFetch = !base64Url && !thumbBlob && !!subId && !!storagePath

  useEffect(() => {
    if (!needsFetch || !subId) return

    const cached = fetchedUrlCache.get(subId)
    if (cached) {
      setFetchedUrl(cached)
      return
    }

    let cancelled = false
    const fetchThumb = async () => {
      try {
        const res = await fetch(
          `/api/storage/download?submissionId=${encodeURIComponent(subId)}&thumbnail=1`,
          { credentials: 'include' }
        )
        if (!res.ok || cancelled) return
        const blob = await res.blob()
        if (cancelled || blob.size === 0) return
        const url = URL.createObjectURL(blob)
        fetchedUrlCache.set(subId, url)
        setFetchedUrl(url)
      } catch {
        // Silent fail
      }
    }
    fetchThumb()
    return () => { cancelled = true }
  }, [needsFetch, subId])

  const isSynced = submission?.status === 'synced'
  // 2026-05-28: blob URL 優先於 base64
  // 歷史背景：commit eaee1d9 (2026-04-13) 優先 base64 是為了避免「blob URL 每次 render
  // 重新 createObjectURL → img reload → 縮圖閃爍」。後來加了 blobUrlCache (WeakMap)、
  // 同一個 Blob 永遠拿同一個 URL、閃爍問題已解決。
  // 改回 blob URL 優先的好處：
  //   - 60+ 卡片 base64 字串約 4-5 MB 在 JS heap、改用 blob URL 只是 ~60 個 reference
  //   - <img> 從 blob: URL 載入比 data: URL 快、瀏覽器有更好的 decode 快取
  //   - React 比對 props 時不用比 70KB 字串
  // 風險：sync 重建 submission 物件可能重建 Blob reference → WeakMap miss → 重做 URL
  // → 真會閃爍時 fallback 還在、不影響功能
  const imageUrl = blobUrl ?? base64Url ?? fetchedUrl ?? null

  return (
    <>
      <div className="absolute inset-0 flex items-center justify-center">
        {isSynced ? (
          <div className="flex flex-col items-center justify-center text-gray-500">
            <ImageIcon className="w-10 h-10 text-blue-500" />
            <p className="text-xs text-gray-500">已上傳雲端</p>
          </div>
        ) : (
          <ImageIcon className="w-12 h-12 text-gray-400" />
        )}
      </div>
      {imageUrl && (
        <img
          src={imageUrl}
          alt="作業縮圖"
          className="w-full h-full object-cover relative"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={(event) => { event.currentTarget.style.display = 'none' }}
        />
      )}
    </>
  )
}

// React.memo: 只在 submission reference 變化時 re-render
const SubmissionThumbnail = memo(SubmissionThumbnailInner, (prev, next) => {
  const a = prev.submission
  const b = next.submission
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id
    && a.status === b.status
    && a.thumbnailBlob === b.thumbnailBlob
    && a.thumbnailBase64 === b.thumbnailBase64
})

export default SubmissionThumbnail
