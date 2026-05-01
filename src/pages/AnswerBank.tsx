import { useState, useEffect, useMemo, useCallback } from 'react'
import Button from '@/components/ui/Button'
import { shouldAutoFocusOnDesktop } from '@/hooks/useAutoFocusOnDesktop'
import {
  Plus, Search, BookOpen, Pencil, Trash2, FileUp, Loader2,
  Folder, ChevronDown, ChevronRight, Edit2, Download, Copy
} from 'lucide-react'
import { db, generateId } from '@/lib/db'
import type { AnswerKey, AnswerKeyTemplate } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDelete, queueDeleteMany } from '@/lib/sync-delete-queue'
import { extractAnswerKeyFromImages } from '@/lib/gemini'
import { startInkSession, closeInkSession } from '@/lib/ink-session'
import { checkFolderNameUnique } from '@/lib/utils'
import AnswerKeyUnifiedModal from '@/components/AnswerKeyUnifiedModal'

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
  const [templates, setTemplates] = useState<AnswerKeyTemplate[]>([])
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

  // Unified modal state
  const [showUnifiedModal, setShowUnifiedModal] = useState(false)
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null)
  const [editingAnswerKey, setEditingAnswerKey] = useState<AnswerKey | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [editingDomain, setEditingDomain] = useState('')
  const [editingDocType, setEditingDocType] = useState<'worksheet' | 'exam'>('worksheet')
  const [editingFolder, setEditingFolder] = useState('')
  const [editingAnswerSheetMode, setEditingAnswerSheetMode] = useState<'with_questions' | 'answer_only'>('with_questions')
  const [editingAnswerSheetImages, setEditingAnswerSheetImages] = useState<Blob[]>([])
  const domainOptions = ['數學', '國語（測試中）', '社會', '自然', '英語', '其他']

  // 匯入短碼
  const [showImportModal, setShowImportModal] = useState(false)
  const [importCode, setImportCode] = useState('')
  const [importError, setImportError] = useState('')
  const [isImporting, setIsImporting] = useState(false)

  const handleImportByCode = async () => {
    const code = importCode.trim().toUpperCase()
    if (!code) { setImportError('請輸入分享碼'); return }
    setIsImporting(true); setImportError('')
    try {
      const res = await fetch('/api/data/import-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shareCode: code })
      })
      const data = await res.json()
      if (!res.ok) { setImportError(data?.error || '匯入失敗'); return }
      // 寫入本地 IndexedDB
      const t = data.template
      await db.answerKeyTemplates.put({
        id: t.id,
        name: t.name,
        domain: t.domain ?? undefined,
        answerKey: t.answerKey ?? (await db.answerKeyTemplates.get(t.id))?.answerKey ?? { questions: [], totalScore: 0 },
        questionCount: t.questionCount,
        totalScore: t.totalScore,
        shareCode: t.shareCode,
        updatedAt: Date.now(),
      })
      requestSync(); await loadData()
      setShowImportModal(false); setImportCode('')
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '匯入失敗')
    } finally { setIsImporting(false) }
  }

  // 複製短碼
  const copyShareCode = (code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      // 簡單的 toast 效果
      const el = document.createElement('div')
      el.textContent = '已複製分享碼'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      el.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm z-50'
      document.body.appendChild(el)
      setTimeout(() => el.remove(), 2000)
    })
  }

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [allTemplates, allFolders] = await Promise.all([
        db.answerKeyTemplates.toArray(),
        db.folders.where('type').equals('assignment').toArray(),
      ])
      setTemplates(allTemplates)
      const folderNames = allFolders.map((f) => f.name)
      setEmptyFolders(folderNames)
    } catch (err) {
      console.error('Failed to load answer bank data', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // ── Template items ──────────────────────────────────────────────────────────

  const answerKeyItems = useMemo(() => {
    return templates.filter((t) => t.answerKey?.questions?.length)
  }, [templates])

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
    let items = answerKeyItems.filter((t) => !t.folder)
    if (filterDomain) items = items.filter((t) => (t.domain || '其他') === filterDomain)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      items = items.filter((t) => t.name.toLowerCase().includes(q))
    }
    return items
  }, [answerKeyItems, filterDomain, searchQuery])

  const itemsByFolder = useMemo(() => {
    const map = new Map<string, typeof answerKeyItems>()
    for (const folder of orderedFolders) map.set(folder, [])
    for (const item of answerKeyItems) {
      if (!item.folder) continue
      if (filterDomain && (item.domain || '其他') !== filterDomain) continue
      if (searchQuery.trim() && !item.name.toLowerCase().includes(searchQuery.trim().toLowerCase())) continue
      map.get(item.folder)?.push(item)
    }
    return map
  }, [answerKeyItems, orderedFolders, filterDomain, searchQuery])

  const allDomains = useMemo(() => {
    const domains = new Set(answerKeyItems.map((t) => t.domain || '其他'))
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
    const check = await checkFolderNameUnique(trimmed, 'assignment')
    if (!check.isUnique) { setNewFolderError(`此資料夾名稱已被${check.usedBy}使用`); return }
    try {
      await db.folders.add({ id: generateId(), name: trimmed, type: 'assignment', updatedAt: Date.now() })
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
    const check = await checkFolderNameUnique(newName, 'assignment')
    if (!check.isUnique) { setEditingFolderError(`此名稱已被${check.usedBy}使用`); return }
    setIsBusy(true)
    try {
      const folderRecord = await db.folders.filter((f) => f.type === 'assignment' && f.name === oldName).first()
      if (folderRecord) await db.folders.update(folderRecord.id, { name: newName, updatedAt: Date.now() })
      const toUpdate = templates.filter((t) => t.folder === oldName)
      for (const t of toUpdate) await db.answerKeyTemplates.update(t.id, { folder: newName, updatedAt: Date.now() })
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
      const toUpdate = templates.filter((t) => t.folder === folderName)
      for (const t of toUpdate) await db.answerKeyTemplates.update(t.id, { folder: undefined })
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
      await db.answerKeyTemplates.update(draggedItemId, { folder: newFolder, updatedAt: Date.now() })
      setTemplates((prev) => prev.map((t) => t.id === draggedItemId ? { ...t, folder: newFolder } : t))
      requestSync()
      if (targetFolder !== '__uncategorized__') setExpandedFolders((prev) => prev.includes(targetFolder) ? prev : [...prev, targetFolder])
    } catch { setError('移動失敗，請稍後重試或重新整理頁面') }
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

  const startEditTitle = (t: AnswerKeyTemplate) => { setEditingTitleId(t.id); setEditingTitleValue(t.name) }
  const saveEditTitle = async (id: string) => {
    const next = editingTitleValue.trim()
    if (!next) { setEditingTitleId(null); return }
    try {
      await db.answerKeyTemplates.update(id, { name: next, updatedAt: Date.now() })
      setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, name: next } : t))
      requestSync()
    } catch { /* ignore */ }
    setEditingTitleId(null); setEditingTitleValue('')
  }

  // ── Unified modal handlers ─────────────────────────────────────────────────

  const handleUnifiedExtract = async (
    orderedPages: Array<{ index: number; url: string; blob: Blob }>,
    _onProgress: (msg: string) => void,
    context: {
      domain: string
      docType: 'worksheet' | 'exam'
      answerSheetMode: 'with_questions' | 'answer_only'
      bookletBlobs?: Blob[]
    }
  ) => {
    const blobs = orderedPages.map((p) => p.blob)
    await startInkSession()
    try {
      const answerKey = await extractAnswerKeyFromImages(blobs, {
        domain: context.domain || undefined,
        docType: context.docType,
        answerSheetMode: context.answerSheetMode,
        bookletImages: context.bookletBlobs,
      })
      return { answerKey, imageBlobs: blobs, notice: null }
    } finally { closeInkSession() }
  }


  // 上傳 answerKey 每題的 cropImageUrl 到 Supabase Storage，回寫 cropImagePath
  const uploadAnswerCrops = async (templateId: string, ak: AnswerKey) => {
    const questionsWithCrop = (ak.questions || []).filter(q => q.cropImageUrl)
    if (questionsWithCrop.length === 0) return
    try {
      const crops = questionsWithCrop.map(q => ({ questionId: q.id, imageBase64: q.cropImageUrl! }))
      const res = await fetch('/api/storage/download', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upload_crops', assignmentId: templateId, crops }),
      })
      if (!res.ok) { console.warn('⚠️ 答案截圖上傳失敗'); return }
      const { paths } = await res.json() as { paths: Record<string, string> }
      if (!paths || Object.keys(paths).length === 0) return
      const updatedQuestions = ak.questions.map(q => {
        const p = paths[q.id]
        return p ? { ...q, cropImagePath: p } : q
      })
      await db.answerKeyTemplates.update(templateId, {
        answerKey: { ...ak, questions: updatedQuestions }, updatedAt: Date.now()
      })
      console.log(`✅ 答案截圖已上傳 ${Object.keys(paths).length}/${questionsWithCrop.length} 題`)
    } catch (err) { console.warn('⚠️ 答案截圖上傳例外', err) }
  }

  const blobsToBase64 = (blobs: Blob[]) => Promise.all(
    blobs.map(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    }))
  )

  // 上傳題本圖到 Supabase Storage（純答案卷模式，用於 Explain 讀取題目）
  const uploadQuestionBookletImages = async (templateId: string, blobs: Blob[]) => {
    try {
      const imagesBase64 = await blobsToBase64(blobs)
      const res = await fetch('/api/storage/download', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, imagesBase64, storagePrefix: 'question-booklets' }),
      })
      if (!res.ok) {
        console.warn('⚠️ 題本圖片上傳失敗', await res.text())
        return
      }
      const { paths } = await res.json() as { paths: string[] }
      await db.answerKeyTemplates.update(templateId, { questionBookletImagePaths: paths })
      console.log(`✅ 題本圖已上傳 ${paths.length} 頁`)
    } catch (err) {
      console.warn('⚠️ 題本圖片上傳例外', err)
    }
  }

  // 上傳原始答案卷整頁圖到 Supabase Storage，再次開啟編輯器時用於還原預覽
  const uploadAnswerSheetImages = async (templateId: string, blobs: Blob[]) => {
    if (!blobs.length) return
    try {
      const imagesBase64 = await blobsToBase64(blobs)
      const res = await fetch('/api/storage/download', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, imagesBase64, storagePrefix: 'template-answer-sheets' }),
      })
      if (!res.ok) {
        console.warn('⚠️ 答案卷圖片上傳失敗', await res.text())
        return
      }
      const { paths } = await res.json() as { paths: string[] }
      await db.answerKeyTemplates.update(templateId, { answerSheetImagePaths: paths, updatedAt: Date.now() })
      // 觸發 sync push，把 answerSheetImagePaths 寫入 Supabase（避免登出後 Dexie 清空時遺失路徑）
      requestSync()
      console.log(`✅ 答案卷圖已上傳 ${paths.length} 頁`)
    } catch (err) {
      console.warn('⚠️ 答案卷圖片上傳例外', err)
    }
  }

  // 從 Supabase Storage 動態探測 page-0..9，回傳依序命中的 blob
  const downloadAnswerSheetImages = async (templateId: string): Promise<Blob[]> => {
    const MAX_PAGES = 10
    try {
      const fetchPage = (i: number) =>
        fetch(`/api/storage/download?templateId=${encodeURIComponent(templateId)}&pageIndex=${i}`, {
          credentials: 'include',
        }).then(r => r.ok ? r.blob() : null)

      const first = await fetchPage(0)
      if (!first) return []

      const rest = await Promise.all(
        Array.from({ length: MAX_PAGES - 1 }, (_, i) => fetchPage(i + 1))
      )
      const blobs: Blob[] = [first]
      for (const b of rest) {
        if (!b) break
        blobs.push(b)
      }
      // 自動修復本地快取
      const paths = blobs.map((_, i) => `template-answer-sheets/${templateId}/page-${i}.webp`)
      await db.answerKeyTemplates.update(templateId, { answerSheetImagePaths: paths }).catch(() => {})
      return blobs
    } catch (err) {
      console.warn('⚠️ 答案卷圖片下載例外', err)
      return []
    }
  }

  const handleUnifiedSave = async (answerKey: AnswerKey, imageBlobs: Blob[], metadata: {
    title: string; domain: string; docType: 'worksheet' | 'exam'
    folder: string; answerSheetMode: 'with_questions' | 'answer_only'
    questionBookletBlobs: Blob[]
  }) => {
    if (editingTemplateId) {
      // 比對 answerKey 是否有實際變動
      const original = await db.answerKeyTemplates.get(editingTemplateId)
      const answerKeyChanged = !original?.answerKey
        || JSON.stringify(original.answerKey.questions) !== JSON.stringify(answerKey.questions)
        || original.answerKey.totalScore !== answerKey.totalScore

      // 更新 template，若 answerKey 有變動則遞增版本號
      const now = Date.now()
      const currentVersion = original?.version ?? 1
      await db.answerKeyTemplates.update(editingTemplateId, {
        answerKey, name: metadata.title, domain: metadata.domain,
        docType: metadata.docType, answerSheetMode: metadata.answerSheetMode,
        folder: metadata.folder || undefined, updatedAt: now,
        ...(answerKeyChanged ? { version: currentVersion + 1 } : {}),
      })
      if (answerKeyChanged) uploadAnswerCrops(editingTemplateId, answerKey)
      // 若這次有重新解析（imageBlobs 非空），就重新上傳整頁圖；否則保留 Storage 既有版本
      if (imageBlobs.length > 0) uploadAnswerSheetImages(editingTemplateId, imageBlobs)
      // 註：編輯模式不允許後補題本（避免「有的能補有的不能補」混亂的 UX）。
      // 要更新題本請建立新答案卷。
    } else {
      const templateId = generateId()
      const pageOrientations: ('portrait' | 'landscape')[] = []
      for (const blob of imageBlobs) {
        try {
          const bitmap = await createImageBitmap(blob)
          pageOrientations.push(bitmap.height > bitmap.width ? 'portrait' : 'landscape')
          bitmap.close()
        } catch {
          pageOrientations.push('portrait')
        }
      }
      const template: AnswerKeyTemplate = {
        id: templateId,
        name: metadata.title,
        domain: metadata.domain,
        docType: metadata.docType,
        answerSheetMode: metadata.answerSheetMode,
        folder: metadata.folder || undefined,
        answerKey,
        questionCount: answerKey.questions?.length ?? 0,
        totalScore: answerKey.totalScore ?? 0,
        pageOrientations,
        version: 1,
        updatedAt: Date.now(),
      }
      await db.answerKeyTemplates.add(template)
      uploadAnswerCrops(templateId, answerKey)
      uploadAnswerSheetImages(templateId, imageBlobs)
      if (metadata.answerSheetMode === 'answer_only' && metadata.questionBookletBlobs.length > 0) {
        uploadQuestionBookletImages(templateId, metadata.questionBookletBlobs)
      }
    }
    requestSync(); await loadData()
    setShowUnifiedModal(false)
  }

  // ── Edit / Delete ──────────────────────────────────────────────────────────

  const handleEdit = (t: AnswerKeyTemplate) => {
    setEditingTemplateId(t.id)
    setEditingAnswerKey(t.answerKey)
    setEditingTitle(t.name)
    setEditingDomain(t.domain || '')
    setEditingDocType((t.docType as 'worksheet' | 'exam') || 'worksheet')
    setEditingFolder(t.folder || '')
    setEditingAnswerSheetMode((t.answerSheetMode as 'with_questions' | 'answer_only') || 'with_questions')
    setEditingAnswerSheetImages([])
    setShowUnifiedModal(true)
    // 非同步從 Supabase Storage 還原答案卷整頁圖（不依賴 answerSheetImagePaths，因為登出後 Dexie 清空時該欄位會是 undefined）
    void downloadAnswerSheetImages(t.id).then((blobs) => {
      if (blobs.length > 0) setEditingAnswerSheetImages(blobs)
    })
  }

  const handleDelete = async (id: string) => {
    const t = templates.find((x) => x.id === id)
    if (!t) return
    // 檢查是否有班級作業引用此答案卷
    const allAssignments = await db.assignments.toArray()
    const linked = allAssignments.filter((a) => a.answerKeyTemplateId === id)
    if (linked.length > 0) {
      const allClassrooms = await db.classrooms.toArray()
      const lines = linked.map((a) => {
        const cn = allClassrooms.find((c) => c.id === a.classroomId)?.name || '未知班級'
        return `・${cn}「${a.title}」`
      })
      if (!window.confirm(
        `確定要刪除「${t.name}」？\n\n以下班級作業將無法繼續批改，直到重新選擇答案卷：\n${lines.join('\n')}\n\n已批改的成績不會被刪除。`
      )) return
    }
    try {
      await queueDelete('answer_key_templates', id)
      await db.answerKeyTemplates.delete(id)
      requestSync(); await loadData()
    } catch (err) { setError(err instanceof Error ? err.message : '刪除失敗') }
  }

  // ── Render answer key card ─────────────────────────────────────────────────

  const renderCard = (t: AnswerKeyTemplate) => (
    <div
      key={t.id}
      draggable={editingTitleId !== t.id}
      onDragStart={() => handleDragStart(t.id)}
      onDragOver={(e) => { if (draggedItemId && draggedItemId !== t.id) { e.preventDefault(); setDragOverItemId(t.id) } }}
      onDragLeave={() => { if (dragOverItemId === t.id) setDragOverItemId(null) }}
      onDrop={(e) => { e.stopPropagation(); if (!draggedItemId || draggedItemId === t.id) return; handleDrop(e, t.folder || '__uncategorized__') }}
      onDragEnd={handleDragEnd}
      className={`flex items-center justify-between rounded-xl border bg-white px-4 py-3.5 transition-colors ${
        dragOverItemId === t.id ? 'border-green-400 ring-1 ring-green-300' : 'border-slate-200'
      } ${draggedItemId === t.id ? 'opacity-50 cursor-grabbing' : 'cursor-grab'}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {editingTitleId === t.id ? (
            <input autoFocus={shouldAutoFocusOnDesktop()} type="text" value={editingTitleValue}
              onChange={(e) => setEditingTitleValue(e.target.value)}
              onBlur={() => void saveEditTitle(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveEditTitle(t.id); else if (e.key === 'Escape') setEditingTitleId(null) }}
              className="px-2 py-1 border border-green-300 rounded text-sm w-full max-w-[220px] focus:outline-none focus:ring-2 focus:ring-green-500" />
          ) : (
            <>
              <span className="text-sm font-semibold text-slate-900 truncate">{t.name}</span>
              <button type="button" onClick={() => startEditTitle(t)} className="p-0.5 text-gray-400 hover:text-green-600" title="修改標題">
                <Edit2 className="w-3 h-3" />
              </button>
            </>
          )}
          <DomainBadge domain={t.domain || '其他'} />
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {t.answerKey.questions.length} 題 · 總分 {t.answerKey.totalScore}
          {t.shareCode && (
            <span className="ml-2 inline-flex items-center gap-1">
              · 分享碼：<span className="font-mono font-medium text-slate-700">{t.shareCode}</span>
              <button type="button" onClick={(e) => { e.stopPropagation(); copyShareCode(t.shareCode!) }}
                className="p-0.5 text-slate-400 hover:text-green-600" title="複製分享碼">
                <Copy className="w-3 h-3" />
              </button>
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5 ml-3">
        <button type="button" onClick={() => handleEdit(t)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-blue-300 hover:text-blue-600" title="編輯答案卷">
          <Pencil className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => void handleDelete(t.id)} aria-label="刪除答案卷" className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-red-300 hover:text-red-600" title="刪除答案卷">
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
          <Button type="button" variant="outline" onClick={() => { setImportCode(''); setImportError(''); setShowImportModal(true) }}>
            <Download className="w-4 h-4" />匯入短碼
          </Button>
          <Button type="button" variant="outline" onClick={() => { setNewFolderName(''); setNewFolderError(''); setIsCreateFolderModalOpen(true) }}>
            <Plus className="w-4 h-4" />建立資料夾
          </Button>
          <Button type="button" variant="primary"
            onClick={() => { setEditingTemplateId(null); setEditingAnswerKey(null); setEditingTitle(''); setEditingDomain(''); setEditingDocType('worksheet'); setEditingFolder(''); setEditingAnswerSheetMode('with_questions'); setEditingAnswerSheetImages([]); setShowUnifiedModal(true) }}
          >
            <Plus className="h-4 w-4" />新增答案卷
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="搜尋答案卷…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
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
              <button type="button" onClick={() => { setEditingTemplateId(null); setEditingAnswerKey(null); setEditingTitle(''); setEditingDomain(''); setEditingDocType('worksheet'); setEditingFolder(''); setEditingAnswerSheetMode('with_questions'); setEditingAnswerSheetImages([]); setShowUnifiedModal(true) }}
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
                    className={`rounded-xl border bg-white transition-colors ${
                      isAssignmentDropTarget ? 'border-green-400 bg-green-50' : isFolderReorderTarget ? 'border-blue-400 bg-blue-50/60' : 'border-slate-200'
                    } ${draggedFolderName === folder ? 'opacity-60 cursor-grabbing' : editingFolderId === folder ? '' : 'cursor-grab'}`}
                  >
                    <div className="px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        {editingFolderId === folder ? (
                          <div className="flex-1 flex flex-col gap-1">
                            <input autoFocus={shouldAutoFocusOnDesktop()} type="text" value={editingFolderName}
                              onChange={(e) => { setEditingFolderName(e.target.value); setEditingFolderError('') }}
                              onBlur={() => void handleCommitFolderEdit()}
                              onKeyDown={(e) => { if (e.key === 'Enter') void handleCommitFolderEdit(); else if (e.key === 'Escape') { setEditingFolderId(null); setEditingFolderError('') } }}
                              placeholder="例如：英文段考、自然小考"
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
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">新建資料夾</h2>
              <button type="button" onClick={() => setIsCreateFolderModalOpen(false)} className="rounded-full p-2 hover:bg-gray-100">
                <span className="text-gray-400 text-xl leading-none">&times;</span>
              </button>
            </div>
            <div className="px-6 py-4">
              <input type="text" value={newFolderName} onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError('') }}
                placeholder="例如：段考、小考、作業" autoFocus={shouldAutoFocusOnDesktop()}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateFolder() }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
              {newFolderError && <p className="mt-1 text-xs text-red-600">{newFolderError}</p>}
              <p className="mt-2 text-xs text-slate-500">建立資料夾後，可將答案卷卡片拖曳到資料夾中進行分類。</p>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-3">
              <button type="button" onClick={() => setIsCreateFolderModalOpen(false)} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">取消</button>
              <Button type="button" variant="primary" disabled={!newFolderName.trim() || !!newFolderError} onClick={() => void handleCreateFolder()}>建立</Button>
            </div>
          </div>
        </div>
      )}

      {/* Unified Answer Key Modal — conditionally mounted so state resets each open */}
      {showUnifiedModal && (
        <AnswerKeyUnifiedModal
          open
          onClose={() => setShowUnifiedModal(false)}
          onExtract={handleUnifiedExtract}
          onSave={handleUnifiedSave}
          editMode={!!editingTemplateId}
          initialTitle={editingTitle}
          initialDomain={editingDomain}
          initialDocType={editingDocType}
          initialFolder={editingFolder}
          initialAnswerSheetMode={editingAnswerSheetMode}
          initialAnswerKey={editingAnswerKey}
          initialAnswerSheetImages={editingAnswerSheetImages}
          domainOptions={domainOptions}
        />
      )}

      {/* 匯入短碼 Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">匯入答案卷</h2>
              <button type="button" onClick={() => setShowImportModal(false)} className="rounded-full p-2 hover:bg-gray-100">
                <span className="text-gray-400 text-xl leading-none">&times;</span>
              </button>
            </div>
            <div className="px-6 py-4">
              <p className="text-xs text-gray-500 mb-3">輸入其他老師分享的短碼，即可匯入答案卷到你的答案庫。</p>
              <input type="text" value={importCode} onChange={(e) => { setImportCode(e.target.value.toUpperCase()); setImportError('') }}
                placeholder="例如：AK-3F8X2A" autoFocus={shouldAutoFocusOnDesktop()}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleImportByCode() }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono text-center tracking-widest focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
              {importError && <p className="mt-2 text-xs text-red-600">{importError}</p>}
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-3">
              <button type="button" onClick={() => setShowImportModal(false)} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">取消</button>
              <Button type="button" variant="primary" disabled={!importCode.trim() || isImporting} onClick={() => void handleImportByCode()}>
                {isImporting ? '匯入中…' : '匯入'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 同步更新確認 Modal */}

      </div>
    </div>
  )
}
