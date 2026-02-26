/**
 * 從伺服器下載圖片為 Blob
 */

/**
 * 從伺服器下載圖片為 Blob
 *
 * @param submissionId - 提交紀錄 ID
 * @returns 圖片 Blob
 */
export async function downloadImageFromSupabase(submissionId: string): Promise<Blob> {
  try {
    const params = new URLSearchParams({ submissionId })

    const response = await fetch(
      `/api/storage/download?${params.toString()}`,
      { credentials: 'include' }
    )

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data?.error || '下載失敗')
    }

    const blob = await response.blob()
    console.log(`圖片下載成功: ${(blob.size / 1024).toFixed(2)} KB`)

    return blob
  } catch (error) {
    console.error('下載圖片失敗:', error)
    throw error
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
