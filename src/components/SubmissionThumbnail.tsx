import { useState, useEffect } from 'react'
import { ImageIcon } from 'lucide-react'

// Caches blob → ObjectURL so parent re-renders don't recreate the URL every time.
// Without this, every state update (grading progress, thumbnail prefetch) causes
// all thumbnail images to flicker as the browser reloads a freshly-created URL.

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

export default function SubmissionThumbnail({ submission }: {
  submission?: SubmissionThumbnailData | null
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  // Determine the blob to use (thumbnail preferred, fall back to full image)
  const activeBlob = submission?.thumbnailBlob && submission.thumbnailBlob.size > 0
    ? submission.thumbnailBlob
    : submission?.imageBlob && submission.imageBlob.size > 0
      ? submission.imageBlob
      : null

  // Stable base64 string (no URL creation needed)
  const base64Url = submission?.thumbnailBase64 || submission?.imageBase64 || null

  useEffect(() => {
    if (!activeBlob) {
      setBlobUrl(null)
      return
    }
    let url: string
    try {
      url = URL.createObjectURL(activeBlob)
    } catch {
      setBlobUrl(null)
      return
    }
    setBlobUrl(url)
    return () => { URL.revokeObjectURL(url) }
  }, [activeBlob])

  const isSynced = submission?.status === 'synced'
  const imageUrl = base64Url ?? blobUrl ?? submission?.thumbnailUrl ?? submission?.thumbUrl ?? submission?.imageUrl ?? null

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
