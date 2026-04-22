import { useState, useEffect, useMemo, useCallback, useRef, type ChangeEvent } from 'react'
import { ArrowLeft, Plus, Search, BookOpen, Pencil, Trash2, FileUp, Loader2 } from 'lucide-react'
import { db, generateId } from '@/lib/db'
import type { Assignment, AnswerKey, Classroom } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { extractAnswerKeyFromImages } from '@/lib/gemini'
import { convertPdfToImages, getFileType, fileToBlob } from '@/lib/pdfToImage'
import { compressImageFile } from '@/lib/imageCompression'
import { startInkSession, closeInkSession } from '@/lib/ink-session'
import AnswerKeyWizardModal from '@/components/AnswerKeyWizardModal'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnswerBankItem {
  id: string // source assignment ID
  title: string
  domain: string
  questionCount: number
  totalScore: number
  answerKey: AnswerKey
  classroomNames: string[] // which classrooms use this answer key
  usageCount: number
  updatedAt?: number
}

interface AnswerBankProps {
  onBack?: () => void
  embedded?: boolean
  inkBalance?: number
  onRequireInkTopUp?: () => void
}

// ── Domain badge ──────────────────────────────────────────────────────────────

const DOMAIN_COLORS: Record<string, string> = {
  '數學': 'bg-blue-100 text-blue-700',
  '國語': 'bg-amber-100 text-amber-700',
  '英語': 'bg-purple-100 text-purple-700',
  '社會': 'bg-green-100 text-green-700',
  '自然': 'bg-teal-100 text-teal-700',
  '其他': 'bg-gray-100 text-gray-600',
}

function DomainBadge({ domain }: { domain: string }) {
  const cls = DOMAIN_COLORS[domain] || DOMAIN_COLORS['其他']
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{domain || '未設定'}</span>
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function AnswerBank({ onBack }: AnswerBankProps) {
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDomain, setFilterDomain] = useState('')

  // Wizard state
  const [showWizard, setShowWizard] = useState(false)
  const [wizardPages, setWizardPages] = useState<Array<{ index: number; url: string; blob: Blob }>>([])
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null)
  const [editingAnswerKey, setEditingAnswerKey] = useState<AnswerKey | null>(null)
  const [editingDomain, setEditingDomain] = useState('')

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New answer key modal state
  const [showNewModal, setShowNewModal] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const domainOptions = ['數學', '國語（測試中）', '社會', '自然', '英語', '其他']

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [allAssignments, allClassrooms] = await Promise.all([
        db.assignments.toArray(),
        db.classrooms.toArray(),
      ])
      setAssignments(allAssignments)
      setClassrooms(allClassrooms)
    } catch (err) {
      console.error('Failed to load answer bank data', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // ── Build answer bank items (aggregate by title + domain) ──────────────────

  const classroomNameMap = useMemo(() => {
    const map = new Map<string, string>()
    classrooms.forEach((c) => map.set(c.id, c.name))
    return map
  }, [classrooms])

  const bankItems = useMemo(() => {
    const withAnswerKey = assignments.filter((a) => a.answerKey?.questions?.length)
    // Group by (title, domain) — same exam used across classes
    const groupMap = new Map<string, AnswerBankItem>()

    for (const a of withAnswerKey) {
      const key = `${a.title}::${a.domain || ''}`
      const existing = groupMap.get(key)
      const classroomName = classroomNameMap.get(a.classroomId) || '未知班級'

      if (existing) {
        existing.usageCount++
        if (!existing.classroomNames.includes(classroomName)) {
          existing.classroomNames.push(classroomName)
        }
        // Keep the most recently updated one as the source
        if ((a.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
          existing.id = a.id
          existing.answerKey = a.answerKey!
          existing.questionCount = a.answerKey!.questions.length
          existing.totalScore = a.answerKey!.totalScore
          existing.updatedAt = a.updatedAt
        }
      } else {
        groupMap.set(key, {
          id: a.id,
          title: a.title,
          domain: a.domain || '其他',
          questionCount: a.answerKey!.questions.length,
          totalScore: a.answerKey!.totalScore,
          answerKey: a.answerKey!,
          classroomNames: [classroomName],
          usageCount: 1,
          updatedAt: a.updatedAt,
        })
      }
    }

    return Array.from(groupMap.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }, [assignments, classroomNameMap])

  // ── Filter ─────────────────────────────────────────────────────────────────

  const filteredItems = useMemo(() => {
    let items = bankItems
    if (filterDomain) {
      items = items.filter((item) => item.domain === filterDomain)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      items = items.filter((item) => item.title.toLowerCase().includes(q))
    }
    return items
  }, [bankItems, filterDomain, searchQuery])

  const allDomains = useMemo(() => {
    const domains = new Set(bankItems.map((item) => item.domain))
    return Array.from(domains).sort()
  }, [bankItems])

  // ── File upload → wizard ───────────────────────────────────────────────────

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    setError(null)
    setIsExtracting(true)

    try {
      const blobs: Blob[] = []
      for (const file of files) {
        const fileType = getFileType(file)
        if (fileType === 'pdf') {
          const pdfBlobs = await convertPdfToImages(file, { scale: 1.5, quality: 0.7 })
          blobs.push(...pdfBlobs)
        } else if (fileType === 'image') {
          blobs.push(await fileToBlob(file))
        } else {
          setError(`不支援的檔案格式：${file.name}`)
          return
        }
      }

      if (blobs.length === 0) {
        setError('沒有可用的圖片')
        return
      }

      // Compress
      const compressed: Blob[] = []
      for (const blob of blobs) {
        const c = await compressImageFile(blob, { maxWidth: 1800, quality: 0.8 })
        compressed.push(c)
      }

      const pages = compressed.map((blob, i) => ({
        index: i,
        blob,
        url: URL.createObjectURL(blob),
      }))

      setWizardPages(pages)
      setEditingAssignmentId(null)
      setEditingAnswerKey(null)
      setEditingDomain('')
      setShowWizard(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '檔案處理失敗')
    } finally {
      setIsExtracting(false)
    }
  }

  // ── Wizard callbacks ───────────────────────────────────────────────────────

  const handleWizardExtract = async (
    orderedPages: Array<{ index: number; url: string; blob: Blob }>,
    _onProgress: (msg: string) => void
  ) => {
    const blobs = orderedPages.map((p) => p.blob)
    await startInkSession()
    try {
      const domain = editingDomain || (newDomain === '國語（測試中）' ? '國語' : newDomain) || undefined
      const answerKey = await extractAnswerKeyFromImages(blobs, { domain })
      return { answerKey, imageBlobs: blobs, notice: null }
    } finally {
      closeInkSession()
    }
  }

  const handleWizardSave = async (answerKey: AnswerKey, imageBlobs: Blob[]) => {
    if (editingAssignmentId) {
      // Editing existing — update the source assignment's answer key
      const now = Date.now()
      await db.assignments.update(editingAssignmentId, {
        answerKey,
        updatedAt: now,
      })
      // Also update all other assignments that share the same title+domain
      const source = assignments.find((a) => a.id === editingAssignmentId)
      if (source) {
        const siblings = assignments.filter(
          (a) => a.id !== editingAssignmentId && a.title === source.title && a.domain === source.domain && a.answerKey?.questions?.length
        )
        for (const sib of siblings) {
          await db.assignments.update(sib.id, { answerKey: structuredClone(answerKey), updatedAt: now })
        }
      }
    } else {
      // New — create an assignment to hold the answer key
      const firstClassroom = classrooms[0]
      if (!firstClassroom) {
        setError('請先建立班級')
        return
      }
      if (!newTitle.trim()) {
        setError('請輸入答案卷名稱')
        return
      }
      const domainValue = newDomain === '國語（測試中）' ? '國語' : (newDomain || '其他')

      const newAssignment: Assignment = {
        id: generateId(),
        classroomId: firstClassroom.id,
        title: newTitle.trim(),
        totalPages: imageBlobs.length,
        domain: domainValue,
        answerKey,
        updatedAt: Date.now(),
      }
      await db.assignments.add(newAssignment)
    }

    requestSync()
    await loadData()
    setShowWizard(false)
    wizardPages.forEach((p) => URL.revokeObjectURL(p.url))
    setWizardPages([])
  }

  const handleWizardCancel = () => {
    setShowWizard(false)
    wizardPages.forEach((p) => URL.revokeObjectURL(p.url))
    setWizardPages([])
  }

  // ── Edit existing ──────────────────────────────────────────────────────────

  const handleEdit = (item: AnswerBankItem) => {
    setEditingAssignmentId(item.id)
    setEditingAnswerKey(item.answerKey)
    setEditingDomain(item.domain)
    // Open wizard in results mode (skip page order, show existing answer key)
    setWizardPages([]) // No pages needed for edit
    setShowWizard(true)
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (item: AnswerBankItem) => {
    const msg = item.usageCount > 1
      ? `此答案卷被 ${item.usageCount} 個班級使用中，刪除將移除所有班級的答案卷。確定？`
      : `確定要刪除「${item.title}」的答案卷？`
    if (!window.confirm(msg)) return

    // Remove answer key from all assignments with same title+domain
    const toUpdate = assignments.filter(
      (a) => a.title === item.title && (a.domain || '其他') === item.domain && a.answerKey?.questions?.length
    )
    for (const a of toUpdate) {
      await db.assignments.update(a.id, { answerKey: undefined, updatedAt: Date.now() })
    }
    requestSync()
    await loadData()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <button type="button" onClick={onBack} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-bold text-slate-900">題庫</h1>
            <p className="text-sm text-slate-500">管理答案卷，可跨班級使用</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            disabled={isExtracting}
            onClick={() => { setNewTitle(''); setNewDomain(''); setShowNewModal(true) }}
            className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-green-700 active:scale-95 disabled:opacity-50"
          >
            {isExtracting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            新增答案卷
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="搜尋答案卷..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 pl-10 pr-4 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
          />
        </div>
        <select
          value={filterDomain}
          onChange={(e) => setFilterDomain(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-green-400 focus:outline-none"
        >
          <option value="">全部領域</option>
          {allDomains.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 font-medium underline">關閉</button>
        </div>
      )}

      {/* Content */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-slate-200 py-16 text-center">
          <BookOpen className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-4 text-sm font-medium text-slate-500">
            {bankItems.length === 0 ? '尚未建立任何答案卷' : '沒有符合條件的答案卷'}
          </p>
          {bankItems.length === 0 && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
            >
              <FileUp className="h-4 w-4" />
              上傳答案卷圖片
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredItems.map((item) => (
            <div
              key={`${item.title}::${item.domain}`}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-5 py-4 transition-colors hover:border-slate-300"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900 truncate">{item.title}</h3>
                  <DomainBadge domain={item.domain} />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {item.questionCount} 題 · 總分 {item.totalScore} · {item.classroomNames.join('、')}
                  {item.usageCount > 1 && ` （${item.usageCount} 個班級使用）`}
                </p>
              </div>

              <div className="flex items-center gap-2 ml-4">
                <button
                  type="button"
                  onClick={() => handleEdit(item)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-500 transition-colors hover:border-blue-300 hover:text-blue-600"
                  title="編輯答案卷"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(item)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-500 transition-colors hover:border-red-300 hover:text-red-600"
                  title="刪除答案卷"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Answer Key Modal — ask title + domain before file upload */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">新增答案卷</h2>
              <button type="button" onClick={() => setShowNewModal(false)} className="rounded-full p-2 hover:bg-gray-100">
                <span className="text-gray-400 text-xl leading-none">&times;</span>
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">答案卷名稱</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="例如：數習P.42-43"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">領域</label>
                <select
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none"
                >
                  <option value="">請選擇</option>
                  {domainOptions.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!newTitle.trim() || !newDomain}
                onClick={() => {
                  setShowNewModal(false)
                  fileInputRef.current?.click()
                }}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                上傳答案卷圖片
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wizard Modal */}
      {showWizard && (
        <AnswerKeyWizardModal
          initialPages={wizardPages}
          initialStep={editingAnswerKey ? 'results' : 'page_order'}
          initialAnswerKey={editingAnswerKey}
          domain={editingDomain}
          onExtract={handleWizardExtract}
          onSave={handleWizardSave}
          onCancel={handleWizardCancel}
        />
      )}
    </div>
  )
}
