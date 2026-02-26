import { useState } from 'react'
import { ArrowLeft, Users, Receipt, BarChart3, Tags } from 'lucide-react'
import AdminUsers from './AdminUsers'
import AdminOrders from './AdminOrders'
import AdminAnalytics from './AdminAnalytics'
import AdminTags from './AdminTags'

type AdminPanelProps = {
  onBack: () => void
  onNavigateToDetail?: (userId: string) => void
  initialTab?: 'users' | 'orders' | 'analytics' | 'tags'
}

type TabType = 'users' | 'orders' | 'analytics' | 'tags'

export default function AdminPanel({ onBack, onNavigateToDetail, initialTab = 'users' }: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab)

  const tabs = [
    { id: 'users' as TabType, label: '使用者統計', icon: Users, color: 'text-amber-600' },
    { id: 'orders' as TabType, label: '訂單管理', icon: Receipt, color: 'text-sky-600' },
    { id: 'analytics' as TabType, label: '使用情形', icon: BarChart3, color: 'text-purple-600' },
    { id: 'tags' as TabType, label: '標籤字典', icon: Tags, color: 'text-indigo-600' }
  ]

  const renderContent = () => {
    switch (activeTab) {
      case 'users':
        return <AdminUsers onNavigateToDetail={onNavigateToDetail} />
      case 'orders':
        return <AdminOrders />
      case 'analytics':
        return <AdminAnalytics />
      case 'tags':
        return <AdminTags />
      default:
        return null
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* 頂部導航 */}
        <div className="bg-white rounded-2xl shadow-xl mb-6">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onBack}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
                aria-label="返回首頁"
              >
                <ArrowLeft className="w-5 h-5 text-gray-600" />
              </button>
              <h1 className="text-2xl font-bold text-gray-900">管理者面板</h1>
            </div>
          </div>

          {/* Tab 導航 */}
          <div className="px-6 flex gap-2 border-b border-gray-200">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center gap-2 px-4 py-3 border-b-2 transition-colors
                    ${
                      isActive
                        ? 'border-blue-600 text-blue-600 font-semibold'
                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }
                  `}
                >
                  <Icon className={`w-4 h-4 ${isActive ? tab.color : ''}`} />
                  <span className="text-sm">{tab.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Tab 內容 */}
        <div>{renderContent()}</div>
      </div>
    </div>
  )
}
