import { Cloud, CloudOff, RefreshCw, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { useSync } from '@/hooks/useSync'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

interface SyncStatusProps {
  autoSync?: boolean
  syncInterval?: number
}

export default function SyncStatus({ autoSync = true, syncInterval = 30000 }: SyncStatusProps) {
  const isOnline = useOnlineStatus()
  const { isSyncing, lastSyncTime, pendingCount, error, triggerSync } = useSync({
    autoSync,
    syncInterval
  })

  const formatLastSyncTime = (timestamp: number | null) => {
    if (!timestamp) return '從未同步'

    const now = Date.now()
    const diff = now - timestamp

    if (diff < 60000) return '剛剛'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`

    return new Date(timestamp).toLocaleString('zh-TW', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div className="bg-white rounded-xl shadow-md p-4 border border-gray-200">
      {/* 標題與網路狀態 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isOnline ? (
            <Cloud className="w-5 h-5 text-blue-600" />
          ) : (
            <CloudOff className="w-5 h-5 text-gray-400" />
          )}
          <span className="font-semibold text-gray-900">雲端同步</span>
        </div>

        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
            isOnline
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-600'
          }`}>
            {isOnline ? '在線' : '離線'}
          </span>
        </div>
      </div>

      {/* 同步狀態資訊 */}
      <div className="space-y-2 mb-4">
        {/* 待同步數量 */}
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <AlertCircle className="w-4 h-4 text-orange-500" />
            <span className="text-gray-700">
              待同步: <span className="font-semibold text-orange-600">{pendingCount}</span> 條記錄
            </span>
          </div>
        )}

        {/* 已完成同步 */}
        {pendingCount === 0 && lastSyncTime && !isSyncing && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle className="w-4 h-4 text-green-500" />
            <span className="text-gray-700">所有資料已同步</span>
          </div>
        )}

        {/* 上次同步時間 */}
        {lastSyncTime && (
          <div className="text-xs text-gray-500">
            上次同步: {formatLastSyncTime(lastSyncTime)}
          </div>
        )}

        {/* 同步中 */}
        {isSyncing && (
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <Loader className="w-4 h-4 animate-spin" />
            <span>正在同步...</span>
          </div>
        )}

        {/* 錯誤訊息 */}
        {error && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {error}
          </div>
        )}
      </div>

      {/* 手動同步按鈕 */}
      <button
        onClick={triggerSync}
        disabled={isSyncing || !isOnline}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm font-medium"
      >
        <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
        {isSyncing ? '同步中...' : '手動同步'}
      </button>

      {/* 離線提示 */}
      {!isOnline && (
        <p className="mt-2 text-xs text-gray-500 text-center">
          網路恢復後將自動同步
        </p>
      )}
    </div>
  )
}
