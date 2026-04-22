import { useState, useEffect, useMemo, useCallback, useRef, type ChangeEvent } from 'react'
import {
  Plus, Search, BookOpen, Pencil, Trash2, FileUp, Loader2,
  Folder, ChevronDown, ChevronRight, Edit2
} from 'lucide-react'
import { db, generateId } from '@/lib/db'
import type { Assignment, AnswerKey, Classroom } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { extractAnswerKeyFromImages } from '@/lib/gemini'
import { convertPdfToImages, getFileType, fileToBlob } from '@/lib/pdfToImage'
import { compressImageFile } from '@/lib/imageCompression'
import { startInkSession, closeInkSession } from '@/lib/ink-session'
import { checkFolderNameUnique } from '@/lib/utils'
import AnswerKeyWizardModal from '@/components/AnswerKeyWizardModal'

// ── Helpers ───────────────────────────────────────────────────────────────────

const FOLDER_ORDER_KEY = 'redpen-answer-bank-folder-order'

const reorderList = <T,>(list: T[], draggedItem: T, targetItem: T): T[] => {
  const fromIndex = list.indexOf(draggedItem)
  const toIndex = list.indexOf(targetItem)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list
  const next = [...list]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

const isSameStringArray = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

// ── Types ─────────────────────────────────────────────────────────────────────

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

export default function AnswerBank(_props: AnswerBankProps) {
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDomain, setFilterDomain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // ── Folder state ───────────────────────────────────────────────────────────
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [emptyFolders, setEmptyFolders] = useState<string[]>([])

  // Folder CRUD
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderError, setNewFolderError] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')
  const [editingFolderError, setEditingFolderError] = useState('')

  // Title inline edit
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTitleValue, setEditingTitleValue] = useState('')

  // Drag & drop
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
  const [draggedFolderName, setDraggedFolderName] = useState<string | null>(null)
  const [dragOverFolderName, setDragOverFolderName] = useState<string | null>(null)
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null)

  // Wizard state
  const [showWizard, setShowWizard] = useState(false)
  const [wizardPages, setWizardPages] = useState<Array<{ index: number; url: string; blob: Blob }>>([])
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null)
  const [editingAnswerKey, setEditingAnswerKey] = useState<AnswerKey | null>(null)
  const [editingDomain, setEditingDomain] = useState('')

  // New answer key modal
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [showNewModal, setShowNewModal] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [newDocType, setNewDocType] = useState<'worksheet' | 'exam'>('worksheet')
  const domainOptions = ['數學', '國語（測試中）', '社會', '自然', '英語', '其他']

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [allAssignments, allClassrooms, allFolders] = await Promise.all([
        db.assignments.toArray(),
        db.classrooms.toArray(),
        db.folders.where('type').equals('assignment').toArray(),
      ])
      setAssignments(allAssignments)
      setClassrooms(allClassrooms)
      // Empty folders = folders in DB that might not have any assignments
      const folderNames = allFolders.map((f) => f.name)
      setEmptyFolders(folderNames)
    } catch (err) {
      console.error('Failed to load answer bank data', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // ── Items with answer keys ─────────────────────────────────────────────────

  const classroomNameMap = useMemo(() => {
    const map = new Map<string, string>()
    classrooms.forEach((c) => map.set(c.id, c.name))
    return map
  }, [classrooms])

  const answerKeyItems = useMemo(() => {
    return assignments
      .filter((a) => a.answerKey?.questions?.length)
      .map((a) => ({
        ...a,
        classroomName: classroomNameMap.get(a.classroomId) || '未知班級',
      }))
  }, [assignments, classroomNameMap])

  // ── Folder computations ────────────────────────────────────────────────────

  const usedFolders = useMemo(() => {
    const folders = answerKeyItems
      .map((a) => a.folder)
      .filter((f): f is string => !!f?.trim())
    return [...new Set([...folders, ...emptyFolders])]
  }, [answerKeyItems, emptyFolders])

  const orderedFolders = useMemo(() => {
    const listed = folderOrder.filter((f) => usedFolders.includes(f))
    const missing = usedFolders.filter((f) => !listed.includes(f))
    return [...listed, ...missing]
  }, [folderOrder, usedFolders])

  const uncategorizedItems = useMemo(() => {
    let items = answerKeyItems.filter((a) => !a.folder)
    if (filterDomain) items = items.filter((a) => (a.domain || '其他') === filterDomain)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      items = items.filter((a) => a.title.toLowerCase().includes(q))
    }
    return items
  }, [answerKeyItems, filterDomain, searchQuery])

  const itemsByFolder = useMemo(() => {
    const map = new Map<string, typeof answerKeyItems>()
    for (const folder of orderedFolders) map.set(folder, [])
    for (const item of answerKeyItems) {
      if (!item.folder) continue
      if (filterDomain && (item.domain || '其他') !== filterDomain) continue
      if (searchQuery.trim() && !item.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) continue
      map.get(item.folder)?.push(item)
    }
    return map
  }, [answerKeyItems, orderedFolders, filterDomain, searchQuery])

  const allDomains = useMemo(() => {
    const domains = new Set(answerKeyItems.map((a) => a.domain || '其他'))
    return Array.from(domains).sort()
  }, [answerKeyItems])

  // ── Folder order persistence ───────────────────────────────────────────────

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOLDER_ORDER_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const saved = parsed.filter((s): s is string => typeof s === 'string')
          const listed = saved.filter((f) => usedFolders.includes(f))
          const missing = usedFolders.filter((f) => !listed.includes(f))
          const next = [...listed, ...missing]
          setFolderOrder((prev) => (isSameStringArray(prev, next) ? prev : next))
        }
      }
    } catch { /* ignore */ }
  }, [usedFolders])

  useEffect(() => {
    if (folderOrder.length > 0) {
      localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(folderOrder))
    }
  }, [folderOrder])

  // ── Folder CRUD ────────────────────────────────────────────────────────────

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim()
    if (!trimmed) { setNewFolderError('請輸入資料夾名稱'); return }
    // Use first classroom for folder binding (answer bank is cross-classroom but folders need a classroom)
    const firstClassroom = classrooms[0]
    if (!firstClassroom) { setNewFolderError('請先建立班級'); return }
    const check = await checkFolderNameUnique(trimmed, 'assignment', firstClassroom.id)
    if (!check.isUnique) { setNewFolderError(`此資料夾名稱已被${check.usedBy}使用`); return }
    try {
      await db.folders.add({ id: generateId(), name: trimmed, type: 'assignment', classroomId: firstClassroom.id, updatedAt: Date.now() })
      setEmptyFolders((prev) => [...prev, trimmed])
      setExpandedFolders((prev) => [...prev, trimmed])
      requestSync()
      setIsCreateFolderModalOpen(false)
      setNewFolderName('')
      setNewFolderError('')
    } catch { setNewFolderError('建立資料夾失敗') }
  }

  const handleCommitFolderEdit = async () => {
    const oldName = editingFolderId
    const newName = editingFolderName.trim()
    if (!oldName) return
    if (!newName) { setEditingFolderError('資料夾名稱不能為空'); return }
    if (newName === oldName) { setEditingFolderId(null); return }
    const firstClassroom = classrooms[0]
    const check = await checkFolderNameUnique(newName, 'assignment', firstClassroom?.id)
    if (!check.isUnique) { setEditingFolderError(`此名稱已被${check.usedBy}使用`); return }
    setIsBusy(true)
    try {
      const folderRecord = await db.folders.filter((f) => f.type === 'assignment' && f.name === oldName).first()
      if (folderRecord) await db.folders.update(folderRecord.id, { name: newName, updatedAt: Date.now() })
      const toUpdate = assignments.filter((a) => a.folder === oldName)
      for (const a of toUpdate) await db.assignments.update(a.id, { folder: newName, updatedAt: Date.now() })
      requestSync()
      await loadData()
      setExpandedFolders((prev) => prev.includes(oldName) ? [...prev.filter((f) => f !== oldName), newName] : prev)
      setEditingFolderId(null); setEditingFolderName(''); setEditingFolderError('')
    } catch (err) {
      setEditingFolderError(err instanceof Error ? err.message : '重新命名失敗')
    } finally { setIsBusy(false) }
  }

  const handleDeleteFolder = async (folderName: string) => {
    if (isBusy) return
    const count = answerKeyItems.filter((a) => a.folder === folderName).length
    const msg = count > 0
      ? `資料夾「${folderName}」內有 ${count} 個答案卷，刪除後會移到「未分類」。確定？`
      : `確定要刪除資料夾「${folderName}」嗎？`
    if (!window.confirm(msg)) return
    setIsBusy(true)
    try {
      const toUpdate = assignments.filter((a) => a.folder === folderName)
      for (const a of toUpdate) await db.assignments.update(a.id, { folder: undefined })
      const folderRecord = await db.folders.filter((f) => f.type === 'assignment' && f.name === folderName).first()
      if (folderRecord) { await queueDeleteMany('folders', [folderRecord.id]); await db.folders.delete(folderRecord.id) }
      requestSync()
      await loadData()
      setExpandedFolders((prev) => prev.filter((f) => f !== folderName))
    } catch (err) { setError(err instanceof Error ? err.message : '刪除失敗') }
    finally { setIsBusy(false) }
  }

  const toggleFolderExpanded = (folder: string) => {
    setExpandedFolders((prev) => prev.includes(folder) ? prev.filter((f) => f !== folder) : [...prev, folder])
  }

  // ── Drag & Drop ────────────────────────────────────────────────────────────

  const handleDragStart = (id: string) => { setDraggedFolderName(null); setDraggedItemId(id) }
  const handleDragOver = (e: React.DragEvent, targetFolder: string) => { if (!draggedItemId) return; e.preventDefault(); setDropTargetFolder(targetFolder) }
  const handleDragLeave = () => { setDropTargetFolder(null) }
  const handleDragEnd = () => { setDraggedItemId(null); setDraggedFolderName(null); setDropTargetFolder(null); setDragOverItemId(null); setDragOverFolderName(null) }

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()
    if (!draggedItemId) return
    const newFolder = targetFolder === '__uncategorized__' ? undefined : targetFolder
    try {
      await db.assignments.update(draggedItemId, { folder: newFolder, updatedAt: Date.now() })
      setAssignments((prev) => prev.map((a) => a.id === draggedItemId ? { ...a, folder: newFolder } : a))
      requestSync()
      if (targetFolder !== '__uncategorized__') setExpandedFolders((prev) => prev.includes(targetFolder) ? prev : [...prev, targetFolder])
    } catch { setError('移動失敗') }
    finally { setDraggedItemId(null); setDropTargetFolder(null); setDragOverItemId(null) }
  }

  const handleFolderDragStart = (folder: string) => { if (editingFolderId === folder) return; setDraggedItemId(null); setDraggedFolderName(folder) }
  const handleFolderDragOver = (e: React.DragEvent, folder: string) => { if (!draggedFolderName || draggedFolderName === folder) return; e.preventDefault(); setDragOverFolderName(folder) }
  const handleFolderDropReorder = (e: React.DragEvent, folder: string) => {
    e.stopPropagation(); if (!draggedFolderName || draggedFolderName === folder) return; e.preventDefault()
    setFolderOrder((prev) => { const base = [...new Set([...prev, ...orderedFolders])]; return reorderList(base, draggedFolderName, folder) })
    setDragOverFolderName(null)
  }

  // ── Title inline edit ──────────────────────────────────────────────────────

  const startEditTitle = (a: Assignment) => { setEditingTitleId(a.id); setEditingTitleValue(a.title) }
  const saveEditTitle = async (id: string) => {
    const next = editingTitleValue.trim()
    if (!next) { setEditingTitleId(null); return }
    try {
      await db.assignments.update(id, { title: next, updatedAt: Date.now() })
      setAssignments((prev) => prev.map((a) => a.id === id ? { ...a, title: next } : a))
      requestSync()
    } catch { /* ignore */ }
    setEditingTitleId(null); setEditingTitleValue('')
  }

  // ── File upload → wizard ───────────────────────────────────────────────────

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []); if (files.length === 0) return; e.target.value = ''
    setError(null); setIsExtracting(true)
    try {
      const blobs: Blob[] = []
      for (const file of files) {
        const ft = getFileType(file)
        if (ft === 'pdf') { blobs.push(...await convertPdfToImages(file, { scale: 1.5, quality: 0.7 })) }
        else if (ft === 'image') { blobs.push(await fileToBlob(file)) }
        else { setError(`不支援的檔案格式：${file.name}`); return }
      }
      if (blobs.length === 0) { setError('沒有可用的圖片'); return }
      const compressed = await Promise.all(blobs.map((b) => compressImageFile(b, { maxWidth: 1800, quality: 0.8 })))
      const pages = compressed.map((blob, i) => ({ index: i, blob, url: URL.createObjectURL(blob) }))
      setWizardPages(pages); setEditingAssignmentId(null); setEditingAnswerKey(null); setEditingDomain(newDomain === '國語（測試中）' ? '國語' : newDomain); setShowWizard(true)
    } catch (err) { setError(err instanceof Error ? err.message : '檔案處理失敗') }
    finally { setIsExtracting(false) }
  }

  const handleWizardExtract = async (orderedPages: Array<{ index: number; url: string; blob: Blob }>, _onProgress: (msg: string) => void) => {
    const blobs = orderedPages.map((p) => p.blob)
    await startInkSession()
    try {
      const domain = editingDomain || undefined
      const answerKey = await extractAnswerKeyFromImages(blobs, { domain, docType: editingAssignmentId ? undefined : newDocType })
      return { answerKey, imageBlobs: blobs, notice: null }
    } finally { closeInkSession() }
  }

  const handleWizardSave = async (answerKey: AnswerKey, imageBlobs: Blob[]) => {
    if (editingAssignmentId) {
      const now = Date.now()
      await db.assignments.update(editingAssignmentId, { answerKey, updatedAt: now })
    } else {
      const firstClassroom = classrooms[0]
      if (!firstClassroom) { setError('請先建立班級'); return }
      if (!newTitle.trim()) { setError('請輸入答案卷名稱'); return }
      const domainValue = newDomain === '國語（測試中）' ? '國語' : (newDomain || '其他')
      await db.assignments.add({
        id: generateId(), classroomId: firstClassroom.id, title: newTitle.trim(),
        totalPages: imageBlobs.length, domain: domainValue, folder: newFolder || undefined,
        docType: newDocType, answerKey, updatedAt: Date.now(),
      })
    }
    requestSync(); await loadData()
    setShowWizard(false); wizardPages.forEach((p) => URL.revokeObjectURL(p.url)); setWizardPages([])
  }

  const handleWizardCancel = () => { setShowWizard(false); wizardPages.forEach((p) => URL.revokeObjectURL(p.url)); setWizardPages([]) }

  // ── Edit / Delete ──────────────────────────────────────────────────────────

  const handleEdit = (a: Assignment) => {
    setEditingAssignmentId(a.id); setEditingAnswerKey(a.answerKey!); setEditingDomain(a.domain || '')
    setWizardPages([]); setShowWizard(true)
  }

  const handleDelete = async (id: string) => {
    const a = assignments.find((x) => x.id === id)
    if (!a) return
    if (!window.confirm(`確定要刪除「${a.title}」的答案卷？`)) return
    try {
      await db.assignments.update(id, { answerKey: undefined, updatedAt: Date.now() })
      requestSync(); await loadData()
    } catch (err) { setError(err instanceof Error ? err.message : '刪除失敗') }
  }

  // ── Render answer key card ─────────────────────────────────────────────────

  const renderCard = (a: typeof answerKeyItems[0]) => (
    <div
      key={a.id}
      draggable={editingTitleId !== a.id}
      onDragStart={() => handleDragStart(a.id)}
      onDragOver={(e) => { if (draggedItemId && draggedItemId !== a.id) { e.preventDefault(); setDragOverItemId(a.id) } }}
      onDragLeave={() => { if (dragOverItemId === a.id) setDragOverItemId(null) }}
      onDrop={(e) => { e.stopPropagation(); if (!draggedItemId || draggedItemId === a.id) return; handleDrop(e, a.folder || '__uncategorized__') }}
      onDragEnd={handleDragEnd}
      className={`flex items-center justify-between rounded-xl border bg-white px-4 py-3.5 transition-colors ${
        dragOverItemId === a.id ? 'border-green-400 ring-1 ring-green-300' : 'border-slate-200'
      } ${draggedItemId === a.id ? 'opacity-50 cursor-grabbing' : 'cursor-grab'}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {editingTitleId === a.id ? (
            <input autoFocus type="text" value={editingTitleValue}
              onChange={(e) => setEditingTitleValue(e.target.value)}
              onBlur={() => void saveEditTitle(a.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveEditTitle(a.id); else if (e.key === 'Escape') setEditingTitleId(null) }}
              className="px-2 py-1 border border-green-300 rounded text-sm w-full max-w-[220px] focus:outline-none focus:ring-2 focus:ring-green-500" />
          ) : (
            <>
              <span className="text-sm font-semibold text-slate-900 truncate">{a.title}</span>
              <button type="button" onClick={() => startEditTitle(a)} className="p-0.5 text-gray-400 hover:text-green-600" title="修改標題">
                <Edit2 className="w-3 h-3" />
              </button>
            </>
          )}
          <DomainBadge domain={a.domain || '其他'} />
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {a.answerKey!.questions.length} 題 · 總分 {a.answerKey!.totalScore} · {a.classroomName}
        </p>
      </div>
      <div className="flex items-center gap-1.5 ml-3">
        <button type="button" onClick={() => handleEdit(a)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-blue-300 hover:text-blue-600" title="編輯答案卷">
          <Pencil className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => void handleDelete(a.id)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-red-300 hover:text-red-600" title="刪除答案卷">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )

  // ── Loading ────────────────────────────────────────────────────────────────

  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-slate-400" /></div>

  return (
    <div className="bg-white p-0">
      <div className="max-w-none mx-0 pt-0">
      {/* Header */}
      <div className="mb-4 border-b border-slate-200 pb-3 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">建立答案</h1>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleFileChange} />
          <button type="button" onClick={() => { setNewFolderName(''); setNewFolderError(''); setIsCreateFolderModalOpen(true) }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            <Plus className="w-4 h-4" />建立資料夾
          </button>
          <button type="button" disabled={isExtracting}
            onClick={() => { setNewTitle(''); setNewDomain(''); setNewFolder(''); setNewDocType('worksheet'); setShowNewModal(true) }}
            className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 active:scale-95 disabled:opacity-50">
            {isExtracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}新增答案卷
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="搜尋答案卷..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 pl-10 pr-4 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
        </div>
        <select value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
          <option value="">全部領域</option>
          {allDomains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <button type="button" onClick={() => setError(null)} className="ml-2 font-medium underline">關閉</button>
        </div>
      )}

      {/* Content: folder structure */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
        <div className="space-y-6">
          {/* Empty state: no answer keys at all */}
          {uncategorizedItems.length === 0 && orderedFolders.length === 0 && (
            <div className="py-12 text-center">
              <BookOpen className="mx-auto h-12 w-12 text-slate-300" />
              <p className="mt-4 text-sm font-medium text-slate-500">尚未建立任何答案卷</p>
              <button type="button" onClick={() => { setNewTitle(''); setNewDomain(''); setNewFolder(''); setNewDocType('worksheet'); setShowNewModal(true) }}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50">
                <FileUp className="h-4 w-4" />上傳答案卷圖片
              </button>
            </div>
          )}

          {/* Folders first */}
          <section>
            <div className="space-y-3">
              {orderedFolders.map((folder) => {
                const folderItems = itemsByFolder.get(folder) ?? []
                const isExpanded = expandedFolders.includes(folder)
                const isAssignmentDropTarget = !!draggedItemId && dropTargetFolder === folder
                const isFolderReorderTarget = !!draggedFolderName && dragOverFolderName === folder

                return (
                  <div key={folder}
                    draggable={editingFolderId !== folder}
                    onDragStart={() => handleFolderDragStart(folder)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => { handleDragOver(e, folder); handleFolderDragOver(e, folder) }}
                    onDragLeave={() => { handleDragLeave(); if (dragOverFolderName === folder) setDragOverFolderName(null) }}
                    onDrop={(e) => { if (draggedItemId) { void handleDrop(e, folder); return }; handleFolderDropReorder(e, folder) }}
                    className={`rounded-xl border bg-white transition-all ${
                      isAssignmentDropTarget ? 'border-green-400 bg-green-50' : isFolderReorderTarget ? 'border-blue-400 bg-blue-50/60' : 'border-slate-200'
                    } ${draggedFolderName === folder ? 'opacity-60 cursor-grabbing' : editingFolderId === folder ? '' : 'cursor-grab'}`}
                  >
                    <div className="px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        {editingFolderId === folder ? (
                          <div className="flex-1 flex flex-col gap-1">
                            <input autoFocus type="text" value={editingFolderName}
                              onChange={(e) => { setEditingFolderName(e.target.value); setEditingFolderError('') }}
                              onBlur={() => void handleCommitFolderEdit()}
                              onKeyDown={(e) => { if (e.key === 'Enter') void handleCommitFolderEdit(); else if (e.key === 'Escape') { setEditingFolderId(null); setEditingFolderError('') } }}
                              placeholder="資料夾名稱"
                              className="px-2 py-1 border border-green-300 rounded text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500" disabled={isBusy} />
                            {editingFolderError && <p className="text-xs text-red-600">{editingFolderError}</p>}
                          </div>
                        ) : (
                          <button type="button" onClick={() => toggleFolderExpanded(folder)} className="flex-1 min-w-0 text-left flex items-center gap-2">
                            {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                            <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                            <span className="text-sm font-semibold text-gray-700 truncate">{folder}</span>
                            <span className="text-xs text-gray-400 shrink-0">{folderItems.length}</span>
                          </button>
                        )}
                        {editingFolderId !== folder && (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => { setEditingFolderId(folder); setEditingFolderName(folder); setEditingFolderError('') }}
                              className="p-1 text-gray-400 hover:text-blue-600" title="重新命名" disabled={isBusy}>
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" onClick={() => void handleDeleteFolder(folder)}
                              className="p-1 text-gray-400 hover:text-red-600" title="刪除資料夾" disabled={isBusy}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-gray-100 px-3 py-3 bg-gray-50/40">
                        {folderItems.length === 0 ? (
                          <p className="text-sm text-gray-500 px-1">此資料夾沒有答案卷。</p>
                        ) : (
                          <div className="space-y-2">{folderItems.map((item) => renderCard(item))}</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* Uncategorized items below folders */}
          {uncategorizedItems.length > 0 && (
            <section>
              <div
                onDragOver={(e) => handleDragOver(e, '__uncategorized__')}
                onDragLeave={handleDragLeave}
                onDrop={(e) => void handleDrop(e, '__uncategorized__')}
                className={`transition-colors rounded-lg p-2 -m-2 ${dropTargetFolder === '__uncategorized__' ? 'bg-green-50/70' : ''}`}
              >
                <div className="space-y-2">{uncategorizedItems.map((item) => renderCard(item))}</div>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Create folder modal */}
      {isCreateFolderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">新建資料夾</h2>
              <button type="button" onClick={() => setIsCreateFolderModalOpen(false)} className="rounded-full p-2 hover:bg-gray-100">
                <span className="text-gray-400 text-xl leading-none">&times;</span>
              </button>
            </div>
            <div className="px-6 py-4">
              <input type="text" value={newFolderName} onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError('') }}
                placeholder="例如：段考、小考、作業" autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateFolder() }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
              {newFolderError && <p className="mt-1 text-xs text-red-600">{newFolderError}</p>}
              <p className="mt-2 text-xs text-slate-500">建立資料夾後，可將答案卷卡片拖曳到資料夾中進行分類。</p>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-3">
              <button type="button" onClick={() => setIsCreateFolderModalOpen(false)} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">取消</button>
              <button type="button" disabled={!newFolderName.trim() || !!newFolderError} onClick={() => void handleCreateFolder()}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-gray-300">建立</button>
            </div>
          </div>
        </div>
      )}

      {/* New answer key modal */}
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
                <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="例如：數習P.42-43" autoFocus
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">領域</label>
                <select value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                  <option value="">請選擇</option>
                  {domainOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">類型</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={newDocType === 'worksheet'} onChange={() => setNewDocType('worksheet')} className="w-4 h-4 accent-green-600" />
                    <span className="text-sm text-gray-700">習作</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={newDocType === 'exam'} onChange={() => setNewDocType('exam')} className="w-4 h-4 accent-green-600" />
                    <span className="text-sm text-gray-700">考卷</span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-500">影響 AI 解析時的題號排序策略</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">資料夾（選填）</label>
                <select value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                  <option value="">不分類</option>
                  {usedFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <button type="button" onClick={() => setShowNewModal(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">取消</button>
              <button type="button" disabled={!newTitle.trim() || !newDomain}
                onClick={() => { setShowNewModal(false); fileInputRef.current?.click() }}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed">
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
    </div>
  )
}
