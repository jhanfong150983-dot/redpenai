import { useState, useEffect } from 'react'
import { ArrowLeft, Users, FileText, Droplet } from 'lucide-react'

interface AdminUserDetailProps {
  userId: string
  onBack: () => void
}

interface ProfileData {
  id: string
  email?: string
  name?: string
  avatar_url?: string
  role?: string
  permission_tier?: string
  ink_balance?: number
  created_at?: string
  updated_at?: string
}

interface ClassroomData {
  id: string
  name: string
  created_at?: string
  studentCount: number
}

interface AssignmentData {
  id: string
  title: string
  classroom_id: string
  created_at?: string
  submissionCount: number
  gradedCount: number
  gradingProgress: number
}

interface InkLedgerRecord {
  id: string
  delta: number
  reason?: string
  metadata?: Record<string, unknown>
  created_at: string
}

interface UserDetailData {
  profile: ProfileData
  classrooms: ClassroomData[]
  assignments: AssignmentData[]
  inkLedger: InkLedgerRecord[]
}

type TabType = 'classrooms' | 'assignments' | 'ink'

export default function AdminUserDetail({ userId, onBack }: AdminUserDetailProps) {
  const [detail, setDetail] = useState<UserDetailData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>('classrooms')

  useEffect(() => {
    const loadDetail = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/user-detail?action=user-detail&userId=${encodeURIComponent(userId)}`,
          { credentials: 'include' }
        )

        if (!res.ok) {
          const errorData = await res.json()
          throw new Error(errorData.error || '获取详细信息失败')
        }

        const data = await res.json()
        setDetail(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取详细信息失败')
        console.error('Error loading user detail:', err)
      } finally {
        setIsLoading(false)
      }
    }

    if (userId) {
      void loadDetail()
    }
  }, [userId])

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleDateString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  const formatDateTime = (dateString?: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const translateReason = (reason?: string) => {
    if (!reason) return '-'
    const translations: Record<string, string> = {
      'purchase': '购买套餐',
      'grading': '批改作业',
      'admin_adjustment': '管理员调整',
      'refund': '退款'
    }
    return translations[reason] || reason
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="flex items-center justify-center py-12">
              <div className="text-gray-600">载入中...</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center py-12">
              <p className="text-red-600 mb-4">{error || '无法载入数据'}</p>
              <button
                onClick={onBack}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                返回列表
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'classrooms' as TabType, label: '班级管理', icon: Users, count: detail.classrooms.length },
    { id: 'assignments' as TabType, label: '作业列表', icon: FileText, count: detail.assignments.length },
    { id: 'ink' as TabType, label: '墨水记录', icon: Droplet, count: detail.inkLedger.length }
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <div className="flex items-center gap-4 mb-6">
            <button
              onClick={onBack}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="返回列表"
            >
              <ArrowLeft className="w-5 h-5 text-gray-600" />
            </button>
            <h1 className="text-2xl font-bold text-gray-900">使用者详细资讯</h1>
          </div>

          {/* Profile Overview */}
          <div className="flex items-start gap-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg">
              {detail.profile.name?.charAt(0).toUpperCase() || detail.profile.email?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold text-gray-900 mb-1">
                {detail.profile.name || '未命名用户'}
              </h2>
              <p className="text-gray-600 mb-3">{detail.profile.email}</p>
              <div className="flex gap-2 mb-4">
                {detail.profile.role === 'admin' && (
                  <span className="px-3 py-1 bg-red-100 text-red-700 text-sm font-medium rounded-full">
                    管理员
                  </span>
                )}
                {detail.profile.permission_tier === 'advanced' && (
                  <span className="px-3 py-1 bg-purple-100 text-purple-700 text-sm font-medium rounded-full">
                    Pro
                  </span>
                )}
                <span className="px-3 py-1 bg-gray-100 text-gray-700 text-sm font-medium rounded-full">
                  {detail.profile.role || 'user'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-600">墨水余额</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {detail.profile.ink_balance || 0} 滴
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">注册时间</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {formatDate(detail.profile.created_at)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">最后活跃</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {formatDate(detail.profile.updated_at)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="border-b border-gray-200">
            <div className="flex">
              {tabs.map((tab) => {
                const Icon = tab.icon
                const isActive = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`
                      flex items-center gap-2 px-6 py-4 border-b-2 transition-colors flex-1
                      ${
                        isActive
                          ? 'border-blue-600 text-blue-600 font-semibold bg-blue-50'
                          : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                      }
                    `}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-sm">{tab.label}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
                      {tab.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'classrooms' && <ClassroomsList classrooms={detail.classrooms} formatDate={formatDate} />}
            {activeTab === 'assignments' && <AssignmentsList assignments={detail.assignments} formatDate={formatDate} />}
            {activeTab === 'ink' && <InkLedger records={detail.inkLedger} formatDateTime={formatDateTime} translateReason={translateReason} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// 子组件：班级列表
function ClassroomsList({ classrooms, formatDate }: { classrooms: ClassroomData[]; formatDate: (date?: string) => string }) {
  if (classrooms.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Users className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暂无班级</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {classrooms.map((classroom) => (
        <div
          key={classroom.id}
          className="p-4 border border-gray-200 rounded-lg hover:shadow-md transition-shadow"
        >
          <h3 className="font-semibold text-gray-900 mb-2">{classroom.name}</h3>
          <div className="space-y-1 text-sm text-gray-600">
            <p>学生数: {classroom.studentCount}</p>
            <p>创建时间: {formatDate(classroom.created_at)}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

// 子组件：作业列表
function AssignmentsList({ assignments, formatDate }: { assignments: AssignmentData[]; formatDate: (date?: string) => string }) {
  if (assignments.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <FileText className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暂无作业</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">作业名称</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">提交数</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">已批改</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">进度</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment) => (
            <tr key={assignment.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-3 px-4 text-sm text-gray-900">{assignment.title}</td>
              <td className="py-3 px-4 text-sm text-gray-600">{assignment.submissionCount}</td>
              <td className="py-3 px-4 text-sm text-gray-600">{assignment.gradedCount}</td>
              <td className="py-3 px-4 text-sm text-gray-600">
                <div className="flex items-center gap-2">
                  <div className="flex-1 max-w-[100px] h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 rounded-full transition-all"
                      style={{ width: `${assignment.gradingProgress}%` }}
                    />
                  </div>
                  <span className="text-xs">{assignment.gradingProgress}%</span>
                </div>
              </td>
              <td className="py-3 px-4 text-sm text-gray-600">{formatDate(assignment.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 子组件：墨水记录
function InkLedger({
  records,
  formatDateTime,
  translateReason
}: {
  records: InkLedgerRecord[]
  formatDateTime: (date?: string) => string
  translateReason: (reason?: string) => string
}) {
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Droplet className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暂无墨水记录</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">时间</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">变动</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">原因</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">备注</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-3 px-4 text-sm text-gray-600">{formatDateTime(record.created_at)}</td>
              <td className={`py-3 px-4 text-sm font-semibold ${record.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {record.delta > 0 ? '+' : ''}{record.delta}
              </td>
              <td className="py-3 px-4 text-sm text-gray-600">{translateReason(record.reason)}</td>
              <td className="py-3 px-4 text-sm text-gray-500">
                {record.metadata ? JSON.stringify(record.metadata) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
