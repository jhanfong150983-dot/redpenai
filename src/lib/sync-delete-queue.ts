import { db, type SyncQueue } from '@/lib/db'

const DELETE_ACTION = 'delete' as const

export interface DeleteQueueEntry {
  id?: number
  tableName: string
  recordId: string
  deletedAt: number
}

function extractDeletedAt(data: unknown, fallback: number): number {
  if (data && typeof data === 'object' && 'deletedAt' in data) {
    const value = (data as { deletedAt?: unknown }).deletedAt
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallback
}

export async function queueDelete(
  tableName: string,
  recordId: string,
  deletedAt = Date.now()
): Promise<void> {
  if (!tableName || !recordId) return
  await db.syncQueue.add({
    action: DELETE_ACTION,
    tableName,
    recordId,
    data: { deletedAt },
    createdAt: deletedAt,
    retryCount: 0
  })
}

export async function queueDeleteMany(
  tableName: string,
  recordIds: string[],
  deletedAt = Date.now()
): Promise<void> {
  if (!tableName || recordIds.length === 0) return

  const rows: Array<Omit<SyncQueue, 'id'>> = recordIds
    .filter((recordId) => recordId)
    .map((recordId) => ({
      action: DELETE_ACTION,
      tableName,
      recordId,
      data: { deletedAt },
      createdAt: deletedAt,
      retryCount: 0
    }))

  if (rows.length > 0) {
    await db.syncQueue.bulkAdd(rows)
  }
}

export async function readDeleteQueue(): Promise<DeleteQueueEntry[]> {
  const rows = await db.syncQueue.toArray()
  return rows
    .filter(
      (row) =>
        row.action === DELETE_ACTION && row.tableName && row.recordId
    )
    .map((row) => ({
      id: row.id,
      tableName: row.tableName,
      recordId: row.recordId,
      deletedAt: extractDeletedAt(row.data, row.createdAt)
    }))
}

export async function clearDeleteQueue(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await db.syncQueue.bulkDelete(ids)
}
