// 2026-08-29 歷史資料頁：已封存班級的唯讀彙集＋恢復入口。
//   歸檔旗標只存在班級身上（archived=true）；本頁依資料夾（學年）分組列出、
//   提供逐班/整夾恢復，並以唯讀模式嵌入 成績統計/檢討考卷/後續追蹤/訂正紀錄 四個既有頁面。
//   恢復=寫 false（不可寫 undefined/null，sync 清 null 傳不過），班級回到原資料夾。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Archive, ArchiveRestore, Loader } from 'lucide-react'
import { useConfirm } from '@/components/ConfirmModal'
import { db, type Classroom } from '@/lib/db'
import { withoutSchoolExamClassrooms } from '@/lib/school-exam'
import { onlyArchivedClassrooms } from '@/lib/classroom-archive'
import { groupClassroomsByFolder } from '@/lib/classroom-order'
import { requestSync, SYNC_COMPLETE_EVENT_NAME } from '@/lib/sync-events'
import Gradebook from '@/pages/Gradebook'
import AiReport from '@/pages/AiReport'

interface ClassroomArchivePageProps {
  onBack: () => void
  embedded?: boolean
}

type TabKey = 'classes' | 'gradebook' | 'exam' | 'track'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'classes', label: '班級恢復' },
  { key: 'gradebook', label: '成績統計' },
  { key: 'exam', label: '檢討考卷' },
  { key: 'track', label: '後續追蹤' }
]

export default function ClassroomArchivePage({ onBack, embedded = false }: ClassroomArchivePageProps) {
  const confirmModal = useConfirm()
  const [archived, setArchived] = useState<Classroom[]>([])
  const [statsMap, setStatsMap] = useState<Map<string, { studentCount: number; assignmentCount: number }>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('classes')
  // 恢復後讓嵌入分頁重新載入（它們各自 mount 時抓資料）
  const [reloadTick, setReloadTick] = useState(0)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [classrooms, students, assignments] = await Promise.all([
        db.classrooms.toArray().then(withoutSchoolExamClassrooms).then(onlyArchivedClassrooms),
        db.students.toArray(),
        db.assignments.toArray()
      ])
      const stats = new Map<string, { studentCount: number; assignmentCount: number }>()
      for (const c of classrooms) {
        stats.set(c.id, {
          studentCount: students.filter((s) => s.classroomId === c.id).length,
          assignmentCount: assignments.filter((a) => a.classroomId === c.id).length
        })
      }
      setArchived(classrooms)
      setStatsMap(stats)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '載入歷史資料失敗')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const handleSyncComplete = () => void loadData()
    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
    return () => window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
  }, [loadData])

  const groups = useMemo(() => groupClassroomsByFolder(archived), [archived])

  const restoreClassrooms = async (targets: Classroom[]) => {
    setIsSaving(true)
    setError(null)
    try {
      for (const c of targets) {
        await db.classrooms.update(c.id, { archived: false })
      }
      requestSync()
      await loadData()
      setReloadTick((t) => t + 1)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '恢復班級失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRestoreOne = async (classroom: Classroom) => {
    const ok = await confirmModal({
      tone: 'neutral',
      title: `恢復班級「${classroom.name}」？`,
      message: '班級會回到主畫面的原資料夾，恢復後即可照原本流程操作。',
      confirmLabel: '恢復班級'
    })
    if (!ok) return
    await restoreClassrooms([classroom])
  }

  const handleRestoreGroup = async (label: string, classrooms: Classroom[]) => {
    const ok = await confirmModal({
      tone: 'neutral',
      title: `恢復「${label}」的全部 ${classrooms.length} 個班級？`,
      message: '這些班級會回到主畫面的原資料夾，恢復後即可照原本流程操作。',
      confirmLabel: '全部恢復'
    })
    if (!ok) return
    await restoreClassrooms(classrooms)
  }

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-6xl mx-auto pt-8'}`}>
        {/* 標題區 */}
        <div className="mb-4 border-b border-slate-200 pb-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              返回班級管理
            </button>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
              <Archive className="w-6 h-6 text-gray-500" />
              歷史資料
            </h1>
            {isLoading && <Loader className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            已封存班級的成績、檢討與追蹤資料在此唯讀查詢；要修改請先恢復班級。
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* 分頁列 */}
        <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                activeTab === tab.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {archived.length === 0 && !isLoading ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-gray-500">
            目前沒有已封存的班級。在班級管理頁點班級或資料夾上的
            <Archive className="mx-1 inline h-4 w-4 align-text-bottom" />
            即可存入歷史資料。
          </div>
        ) : activeTab === 'classes' ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.label} className="rounded-xl border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
                  <Archive className="h-4 w-4 text-gray-400" />
                  <span className="font-medium text-gray-900">{group.label}</span>
                  <span className="text-xs text-gray-500">{group.classrooms.length} 班</span>
                  {group.classrooms.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleRestoreGroup(group.label, group.classrooms)}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                      disabled={isSaving}
                    >
                      <ArchiveRestore className="h-3.5 w-3.5" />
                      全部恢復
                    </button>
                  )}
                </div>
                <div className="divide-y divide-slate-100">
                  {group.classrooms.map((c) => {
                    const stats = statsMap.get(c.id)
                    return (
                      <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-gray-900">{c.name}</p>
                          <p className="text-xs text-gray-500">
                            {stats ? `${stats.studentCount} 位學生 · ${stats.assignmentCount} 份作業` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRestoreOne(c)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-green-600 bg-white px-2.5 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-60"
                          disabled={isSaving}
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                          恢復班級
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            {activeTab === 'gradebook' && (
              <Gradebook key={`gb-${reloadTick}`} embedded scope="archived" />
            )}
            {activeTab === 'exam' && (
              <AiReport
                key={`exam-${reloadTick}`}
                embedded
                variant="exam"
                classroomScope="archived"
                onBack={() => setActiveTab('classes')}
              />
            )}
            {activeTab === 'track' && (
              <AiReport
                key={`track-${reloadTick}`}
                embedded
                variant="track"
                classroomScope="archived"
                onBack={() => setActiveTab('classes')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
