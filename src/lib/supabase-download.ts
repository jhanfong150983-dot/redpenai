/**
 * 從伺服器下載圖片為 Blob
 */

/**
 * 從伺服器下載圖片為 Blob
 *
 * @param submissionId - 提交紀錄 ID
 * @returns 圖片 Blob
 */
// 下載 timeout（毫秒）：超時拋 AbortError、避免 server hang 時 spinner 卡無限久
const DOWNLOAD_TIMEOUT_MS = 60_000

export async function downloadImageFromSupabase(submissionId: string): Promise<Blob> {
  const params = new URLSearchParams({ submissionId })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(
      `/api/storage/download?${params.toString()}`,
      { credentials: 'include', signal: controller.signal }
    )

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data?.error || `下載失敗 (status ${response.status})`)
    }

    const blob = await response.blob()
    console.log(`圖片下載成功: ${(blob.size / 1024).toFixed(2)} KB`)

    return blob
  } catch (error) {
    // AbortError → 改成更有意義的 timeout 訊息
    if (error instanceof DOMException && error.name === 'AbortError') {
      const msg = `下載逾時 (${DOWNLOAD_TIMEOUT_MS / 1000}s)、伺服器無回應`
      console.error(msg, submissionId)
      throw new Error(msg)
    }
    console.error('下載圖片失敗:', error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量下載圖片
 *
 * @param submissionIds - 提交紀錄 ID 列表
 * @param onProgress - 進度回呼
 * @returns 下載結果 Map
 */
export async function downloadMultipleImages(
  submissionIds: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, Blob>> {
  const results = new Map<string, Blob>()

  for (let i = 0; i < submissionIds.length; i++) {
    const id = submissionIds[i]

    if (onProgress) {
      onProgress(i + 1, submissionIds.length)
    }

    try {
      const blob = await downloadImageFromSupabase(id)
      results.set(id, blob)
    } catch (error) {
      console.error(`下載失敗 ${id}:`, error)
      // 繼續下載其他圖片
    }
  }

  return results
}
