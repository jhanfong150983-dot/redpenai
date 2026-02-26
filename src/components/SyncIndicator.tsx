import { CloudOff, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { useSync } from '@/hooks/useSync'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

interface SyncIndicatorProps {
  autoSync?: boolean
}

export default function SyncIndicator({ autoSync = true }: SyncIndicatorProps) {
  const isOnline = useOnlineStatus()
  const { isSyncing, lastSyncTime, pendingCount, error } = useSync({
    autoSync
  })

  const formatLastSyncTime = (timestamp: number) => {
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

  let text = '已同步'
  let icon = <CheckCircle className="w-4 h-4 text-green-600" />

  if (!isOnline) {
    text = '離線，待連線後同步'
    icon = <CloudOff className="w-4 h-4 text-gray-400" />
  } else if (error) {
    text = '同步失敗，等待下次變更'
    icon = <AlertCircle className="w-4 h-4 text-red-500" />
  } else if (isSyncing) {
    text = '同步中...'
    icon = <RefreshCw className="w-4 h-4 text-blue-600 animate-spin" />
  } else if (pendingCount > 0) {
    text = `待同步 ${pendingCount} 筆`
    icon = <RefreshCw className="w-4 h-4 text-blue-600" />
  } else if (lastSyncTime) {
    text = `已同步 · ${formatLastSyncTime(lastSyncTime)}`
    icon = <CheckCircle className="w-4 h-4 text-green-600" />
  }

  return (
    <div className="inline-flex items-center gap-2 text-xs text-gray-600">
      {icon}
      <span>{text}</span>
    </div>
  )
}
