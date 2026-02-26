import { useEffect, useMemo, useState, useCallback } from 'react'
import { ArrowLeft, Loader, CheckCircle, Download, Columns, SortAsc, Users, X, Plus, Minus, AlertCircle } from 'lucide-react'
import { db } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import type { Assignment, Classroom, Submission } from '@/lib/db'
import { getSubmissionImageUrl } from '@/lib/utils'

interface CorrectionManagementProps {
  assignmentId: string
  onBack?: () => void
}

interface CorrectionItem {
  id: string
  question: string
  reason: string
  done: boolean
}

interface CorrectionCard {
  submissionId: string
  studentId: string
  studentName: string
  seatNumber: number | null
  correctionCount: number
  mistakes: CorrectionItem[]
  imageUrl?: string
  score: number | null
  totalScore: number | null
}

// 排序選項類型
type CorrectionSortOption = 'seat-asc' | 'seat-desc' | 'mistakes-desc' | 'mistakes-asc' | 'group'

// 小組設定類型：studentId -> groupNumber (1-based, 0 = 未分組)
type StudentGroupConfig = Record<string, number>

// localStorage keys
const SORT_STORAGE_KEY = 'redpen-correction-sort'
const GROUP_STORAGE_KEY_PREFIX = 'redpen-student-groups-'

// 排序偏好儲存/讀取
function getSortPreference(): CorrectionSortOption {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY)
    if (stored && ['seat-asc', 'seat-desc', 'mistakes-desc', 'mistakes-asc', 'group'].includes(stored)) {
      return stored as CorrectionSortOption
    }
  } catch (e) {
    console.warn('Failed to read sort preference:', e)
  }
  return 'seat-asc'
}

function setSortPreference(option: CorrectionSortOption): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, option)
  } catch (e) {
    console.warn('Failed to save sort preference:', e)
  }
}

// 小組設定儲存/讀取
function getGroupConfig(classroomId: string): StudentGroupConfig {
  try {
    const stored = localStorage.getItem(GROUP_STORAGE_KEY_PREFIX + classroomId)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.warn('Failed to read group config:', e)
  }
  return {}
}

function setGroupConfig(classroomId: string, config: StudentGroupConfig): void {
  try {
    localStorage.setItem(GROUP_STORAGE_KEY_PREFIX + classroomId, JSON.stringify(config))
  } catch (e) {
    console.warn('Failed to save group config:', e)
  }
}

function getGroupCount(classroomId: string): number {
  try {
    const stored = localStorage.getItem(GROUP_STORAGE_KEY_PREFIX + classroomId + '-count')
    if (stored) {
      const n = parseInt(stored, 10)
      if (n >= 1 && n <= 10) return n
    }
  } catch (e) {
    console.warn('Failed to read group count:', e)
  }
  return 6 // 預設 6 組
}

function setGroupCount(classroomId: string, count: number): void {
  try {
    localStorage.setItem(GROUP_STORAGE_KEY_PREFIX + classroomId + '-count', String(count))
  } catch (e) {
    console.warn('Failed to save group count:', e)
  }
}

const escapeXml = (v: string) =>
  (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeHtml = (v: string) =>
  (v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const formatMistakeId = (value: string) => (value || '').trim()

const buildMistakeTitle = (m: CorrectionItem) => {
  const parts = [
    formatMistakeId(m.id) ? `題號 ${formatMistakeId(m.id)}` : '',
    m.question || '',
    m.reason || ''
  ].filter(Boolean)
  return parts.join('｜')
}

function heatColor(count: number): string {
  if (count >= 6) return 'border-l-4 border-red-500 bg-red-50'
  if (count >= 4) return 'border-l-4 border-red-400 bg-red-50'
  if (count >= 2) return 'border-l-4 border-amber-400 bg-amber-50'
  if (count >= 1) return 'border-l-4 border-amber-200 bg-amber-50'
  return 'border-l-4 border-gray-200 bg-white'
}

export default function CorrectionManagement({
  assignmentId,
  onBack
}: CorrectionManagementProps) {
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [classroom, setClassroom] = useState<Classroom | null>(null)
  const [cards, setCards] = useState<CorrectionCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [compactMode, setCompactMode] = useState(true)
  const [showCompleted, setShowCompleted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 排序相關 state
  const [sortOption, setSortOption] = useState<CorrectionSortOption>(() => getSortPreference())
  const [groupConfig, setGroupConfigState] = useState<StudentGroupConfig>({})
  const [groupCount, setGroupCountState] = useState(6)
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false)
  const [tempGroupConfig, setTempGroupConfig] = useState<StudentGroupConfig>({})
  const [tempGroupCount, setTempGroupCount] = useState(6)
  const [draggedStudentId, setDraggedStudentId] = useState<string | null>(null)

  // 是否有小組設定
  const hasGroupConfig = useMemo(() => Object.keys(groupConfig).length > 0, [groupConfig])

  // 處理排序變更
  const handleSortChange = useCallback((newOption: CorrectionSortOption) => {
    if (newOption === 'group' && !hasGroupConfig && classroom?.id) {
      // 沒有設定過小組，打開設定 Modal
      setTempGroupConfig({})
      setTempGroupCount(getGroupCount(classroom.id))
      setIsGroupModalOpen(true)
    }
    setSortOption(newOption)
    setSortPreference(newOption)
  }, [hasGroupConfig, classroom?.id])

  // 打開編輯小組 Modal
  const openEditGroupModal = useCallback(() => {
    if (!classroom?.id) return
    setTempGroupConfig({ ...groupConfig })
    setTempGroupCount(groupCount)
    setIsGroupModalOpen(true)
  }, [classroom?.id, groupConfig, groupCount])

  // 儲存小組設定
  const saveGroupConfig = useCallback(() => {
    if (!classroom?.id) return
    setGroupConfigState(tempGroupConfig)
    setGroupCountState(tempGroupCount)
    setGroupConfig(classroom.id, tempGroupConfig)
    setGroupCount(classroom.id, tempGroupCount)
    setIsGroupModalOpen(false)
    // 如果當前不是小組排序，切換到小組排序
    if (sortOption !== 'group') {
      setSortOption('group')
      setSortPreference('group')
    }
  }, [classroom?.id, tempGroupConfig, tempGroupCount, sortOption])

  // 取消小組設定
  const cancelGroupConfig = useCallback(() => {
    setIsGroupModalOpen(false)
    // 如果之前沒有設定過，且當前選的是 group，切回座號排序
    if (!hasGroupConfig && sortOption === 'group') {
      setSortOption('seat-asc')
      setSortPreference('seat-asc')
    }
  }, [hasGroupConfig, sortOption])

  // 拖拉處理
  const handleDragStart = useCallback((e: React.DragEvent, studentId: string) => {
    e.dataTransfer.effectAllowed = 'move'
    setDraggedStudentId(studentId)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedStudentId(null)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDropToGroup = useCallback((e: React.DragEvent, groupNumber: number) => {
    e.preventDefault()
    if (!draggedStudentId) return
    setTempGroupConfig(prev => ({
      ...prev,
      [draggedStudentId]: groupNumber
    }))
    setDraggedStudentId(null)
  }, [draggedStudentId])

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const a = await db.assignments.get(assignmentId)
        if (!a) throw new Error('找不到這份作業')
        setAssignment(a)

        const c = await db.classrooms.get(a.classroomId)
        if (!c) throw new Error('找不到班級資料')
        setClassroom(c)

        const stu = await db.students
          .where('classroomId')
          .equals(a.classroomId)
          .toArray()
        const subs = await db.submissions
          .where('assignmentId')
          .equals(assignmentId)
          .toArray()

        const mapped = subs.reduce<CorrectionCard[]>((acc, s) => {
          const mistakes = s.gradingResult?.mistakes || []
          if (!mistakes.length) return acc

          const student = stu.find((st) => st.id === s.studentId)
          const imageUrl = getSubmissionImageUrl(s) || undefined

          const items: CorrectionItem[] = mistakes.map((m) => ({
            id: m.id,
            question: m.question,
            reason: m.reason,
            done: false
          }))

          acc.push({
            submissionId: s.id,
            studentId: s.studentId,
            studentName: student?.name || '未知學生',
            seatNumber: student?.seatNumber ?? null,
            correctionCount: s.correctionCount ?? 0,
            mistakes: items,
            imageUrl,
            score: s.score ?? null,
            totalScore: a.answerKey?.totalScore ?? null
          })
          return acc
        }, [])

        mapped.sort((a, b) => {
          const sa = a.seatNumber ?? 99999
          const sb = b.seatNumber ?? 99999
          if (sa !== sb) return sa - sb
          return a.studentName.localeCompare(b.studentName)
        })

        setCards(mapped)

        // 載入該班級的小組設定
        const savedGroupConfig = getGroupConfig(c.id)
        const savedGroupCount = getGroupCount(c.id)
        setGroupConfigState(savedGroupConfig)
        setGroupCountState(savedGroupCount)
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '載入訂正資料失敗')
      } finally {
        setIsLoading(false)
      }
    }
    void load()

    return () => {
      setCards((prev) => {
        prev.forEach((c) => {
          if (c.imageUrl) URL.revokeObjectURL(c.imageUrl)
        })
        return prev
      })
    }
  }, [assignmentId])

  // 排序函數
  const sortCards = useCallback((cardsToSort: CorrectionCard[]): CorrectionCard[] => {
    const sorted = [...cardsToSort]
    switch (sortOption) {
      case 'seat-asc':
        sorted.sort((a, b) => {
          const sa = a.seatNumber ?? 99999
          const sb = b.seatNumber ?? 99999
          if (sa !== sb) return sa - sb
          return a.studentName.localeCompare(b.studentName)
        })
        break
      case 'seat-desc':
        sorted.sort((a, b) => {
          const sa = a.seatNumber ?? -1
          const sb = b.seatNumber ?? -1
          if (sa !== sb) return sb - sa
          return a.studentName.localeCompare(b.studentName)
        })
        break
      case 'mistakes-desc':
        sorted.sort((a, b) => {
          const ma = a.mistakes.filter(m => !m.done).length
          const mb = b.mistakes.filter(m => !m.done).length
          if (ma !== mb) return mb - ma
          const sa = a.seatNumber ?? 99999
          const sb = b.seatNumber ?? 99999
          return sa - sb
        })
        break
      case 'mistakes-asc':
        sorted.sort((a, b) => {
          const ma = a.mistakes.filter(m => !m.done).length
          const mb = b.mistakes.filter(m => !m.done).length
          if (ma !== mb) return ma - mb
          const sa = a.seatNumber ?? 99999
          const sb = b.seatNumber ?? 99999
          return sa - sb
        })
        break
      case 'group':
        sorted.sort((a, b) => {
          const ga = groupConfig[a.studentId] ?? 0
          const gb = groupConfig[b.studentId] ?? 0
          if (ga !== gb) return ga - gb
          const sa = a.seatNumber ?? 99999
          const sb = b.seatNumber ?? 99999
          return sa - sb
        })
        break
    }
    return sorted
  }, [sortOption, groupConfig])

  const activeCards = useMemo(
    () => sortCards(cards.filter((c) => c.mistakes.some((m) => !m.done))),
    [cards, sortCards]
  )

  const visibleCards = useMemo(
    () => sortCards(showCompleted ? cards : cards.filter((c) => c.mistakes.some((m) => !m.done))),
    [showCompleted, cards, sortCards]
  )

  // 按小組分組的卡片（用於顯示分隔線）
  const cardsByGroup = useMemo(() => {
    if (sortOption !== 'group') return null
    const groups: { groupNumber: number; cards: CorrectionCard[] }[] = []
    let currentGroup = -1
    for (const card of visibleCards) {
      const g = groupConfig[card.studentId] ?? 0
      if (g !== currentGroup) {
        currentGroup = g
        groups.push({ groupNumber: g, cards: [] })
      }
      groups[groups.length - 1].cards.push(card)
    }
    return groups
  }, [sortOption, visibleCards, groupConfig])

  const toggleMistake = (submissionId: string, mistakeId: string) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.submissionId !== submissionId) return c
        const mistakes = c.mistakes.map((m) =>
          m.id === mistakeId ? { ...m, done: !m.done } : m
        )
        return { ...c, mistakes }
      })
    )
  }

  const setCorrectionCount = async (submissionId: string, nextCount: number) => {
    const safeCount = Math.max(0, nextCount)
    setCards((prev) =>
      prev.map((c) =>
        c.submissionId === submissionId ? { ...c, correctionCount: safeCount } : c
      )
    )
    try {
      await db.submissions.update(submissionId, {
        correctionCount: safeCount
      } as Partial<Submission>)
      requestSync()
    } catch (e) {
      console.error('更新訂正次數失敗', e)
    }
  }

  const increaseCount = async (submissionId: string) => {
    const current =
      cards.find((c) => c.submissionId === submissionId)?.correctionCount || 0
    await setCorrectionCount(submissionId, current + 1)
  }

  const resetCount = async (submissionId: string) => {
    await setCorrectionCount(submissionId, 0)
  }

  const handleExportExcel = () => {
    const preferred = showCompleted ? cards : activeCards
    const targets = preferred.length > 0 ? preferred : cards
    const sheets = targets
      .map((c, idx) => {
        const seat = c.seatNumber != null ? c.seatNumber.toString() : ''
      const name = c.studentName || `學生${idx + 1}`
      const sheetNameRaw = `${seat ? `${seat}-` : ''}${name}`.slice(0, 25)
      const sheetName = escapeXml(sheetNameRaw || `sheet${idx + 1}`)
      const titleLine = `作業標題：${assignment?.title || ''}`
      const seatNameLine = `座號：${seat || '—'}    姓名：${name}`
      const scoreLine =
        c.score !== null && c.totalScore !== null
          ? `得分：${c.score} / ${c.totalScore}`
          : c.totalScore !== null
          ? `得分：尚未批改（總分：${c.totalScore}）`
          : `得分：尚未批改`
        const divider = '-----------------------------------------'
        const mistakesRows = c.mistakes
          .filter((m) => !m.done)
          .map(
            (m) => `<Row>
              <Cell ss:StyleID="cell"><Data ss:Type="String">□</Data></Cell>
              <Cell ss:StyleID="cell"><Data ss:Type="String">${escapeXml(
                formatMistakeId(m.id)
              )}</Data></Cell>
              <Cell ss:StyleID="cell"><Data ss:Type="String">${escapeXml(m.question)}</Data></Cell>
              <Cell ss:StyleID="cell"><Data ss:Type="String">${escapeXml(m.reason)}</Data></Cell>
            </Row>`
          )
          .join('')
        return `
        <Worksheet ss:Name="${sheetName}">
          <Table>
            <Column ss:AutoFitWidth="1" ss:Width="40"/>
            <Column ss:AutoFitWidth="1" ss:Width="70"/>
            <Column ss:AutoFitWidth="1" ss:Width="200"/>
            <Column ss:AutoFitWidth="1" ss:Width="220"/>
            <Row>
              <Cell ss:MergeAcross="3" ss:StyleID="card"><Data ss:Type="String">${escapeXml(titleLine)}</Data></Cell>
            </Row>
            <Row>
              <Cell ss:MergeAcross="3" ss:StyleID="card"><Data ss:Type="String">${escapeXml(seatNameLine)}</Data></Cell>
            </Row>
            <Row>
              <Cell ss:MergeAcross="3" ss:StyleID="card"><Data ss:Type="String">${escapeXml(scoreLine)}</Data></Cell>
            </Row>
            <Row>
              <Cell ss:MergeAcross="3" ss:StyleID="card"><Data ss:Type="String">${escapeXml(divider)}</Data></Cell>
            </Row>
            <Row>
              <Cell ss:StyleID="header"><Data ss:Type="String">確認</Data></Cell>
              <Cell ss:StyleID="header"><Data ss:Type="String">題號</Data></Cell>
              <Cell ss:StyleID="header"><Data ss:Type="String">錯題</Data></Cell>
              <Cell ss:StyleID="header"><Data ss:Type="String">原因</Data></Cell>
            </Row>
            ${
              mistakesRows ||
              `<Row>
                <Cell ss:StyleID="cell"><Data ss:Type="String">□</Data></Cell>
                <Cell ss:StyleID="cell"><Data ss:Type="String"></Data></Cell>
                <Cell ss:StyleID="cell"><Data ss:Type="String">全部正確</Data></Cell>
                <Cell ss:StyleID="cell"><Data ss:Type="String"></Data></Cell>
              </Row>`
            }
          </Table>
        </Worksheet>`
      })
      .join('\n')

    const xml = `<?xml version="1.0"?>
    <?mso-application progid="Excel.Sheet"?>
    <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
      xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
      <Styles>
        <Style ss:ID="base">
          <Font ss:FontName="標楷體" />
          <Alignment ss:Vertical="Top" ss:WrapText="1"/>
        </Style>
        <Style ss:ID="card">
          <Font ss:FontName="標楷體" ss:Bold="1" />
          <Alignment ss:Vertical="Top" ss:WrapText="1"/>
          <Borders>
            <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
          </Borders>
        </Style>
        <Style ss:ID="header" ss:Parent="card">
          <Font ss:FontName="標楷體" ss:Bold="1" />
          <Alignment ss:Vertical="Center" ss:WrapText="1"/>
        </Style>
        <Style ss:ID="cell" ss:Parent="base">
          <Borders>
            <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
            <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
          </Borders>
        </Style>
      </Styles>
      ${sheets}
    </Workbook>`

    const blob = new Blob([`\uFEFF${xml}`], {
      type: 'application/vnd.ms-excel;charset=utf-8;'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '訂正清單.xls'
    a.click()
    URL.revokeObjectURL(url)
  }

  const ensurePdfLibs = async () => {
    const anyWin = window as any
    const load = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = src
        s.onload = () => resolve()
        s.onerror = () => reject(new Error(`載入失敗: ${src}`))
        document.body.appendChild(s)
      })
    if (!anyWin.html2canvas) {
      await load('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js')
    }
    if (!anyWin.jspdf) {
      await load('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js')
    }
  }

  const handleExportPdf = async () => {
    try {
      await ensurePdfLibs()
      const anyWin = window as any
      const targets = activeCards.length > 0 ? activeCards : cards
      if (targets.length === 0) return

      const container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.top = '0'
      container.style.width = '800px'
      container.style.fontFamily = 'DFKai-SB, PMingLiU, "Microsoft JhengHei", serif'

      targets.forEach((c) => {
        const seat = c.seatNumber != null ? c.seatNumber.toString() : '—'
        const name = c.studentName
        const scoreText =
          c.score !== null && c.totalScore !== null
            ? `${c.score} / ${c.totalScore}`
            : c.totalScore !== null
            ? `尚未批改（總分：${c.totalScore}）`
            : `尚未批改`
        const card = document.createElement('div')
        card.style.border = '1px solid #000'
        card.style.padding = '16px'
        card.style.marginBottom = '12px'
        card.style.width = '760px'
        card.style.boxSizing = 'border-box'
        card.style.backgroundColor = '#fff'
        card.innerHTML = `
          <div style="font-weight:bold;margin-bottom:6px;">作業標題：${escapeHtml(
            assignment?.title || ''
          )}</div>
          <div style="font-weight:bold;margin-bottom:6px;">座號：${escapeHtml(
            seat
          )}　　姓名：${escapeHtml(name)}</div>
          <div style="font-weight:bold;color:#059669;margin-bottom:6px;">得分：${escapeHtml(scoreText)}</div>
          <div style="margin-bottom:8px;">-----------------------------------------</div>
          <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <colgroup>
              <col style="width:50px;" />
              <col style="width:70px;" />
              <col style="width:200px;" />
              <col style="width:240px;" />
            </colgroup>
            <thead>
              <tr>
                <th style="border:1px solid #000; padding:6px; text-align:center;">確認</th>
                <th style="border:1px solid #000; padding:6px; text-align:center;">題號</th>
                <th style="border:1px solid #000; padding:6px; text-align:center;">錯題</th>
                <th style="border:1px solid #000; padding:6px; text-align:center;">原因</th>
              </tr>
            </thead>
            <tbody>
              ${
                c.mistakes.filter((m) => !m.done).length === 0
                  ? `<tr>
                      <td style="border:1px solid #000; padding:6px; text-align:center; vertical-align:top;">□</td>
                      <td style="border:1px solid #000; padding:6px; word-break:break-word;"></td>
                      <td style="border:1px solid #000; padding:6px; word-break:break-word;">全部正確</td>
                      <td style="border:1px solid #000; padding:6px; word-break:break-word;"></td>
                    </tr>`
                  : c.mistakes
                      .filter((m) => !m.done)
                      .map(
                        (m) => `<tr>
                          <td style="border:1px solid #000; padding:6px; text-align:center; vertical-align:top;">□</td>
                          <td style="border:1px solid #000; padding:6px; text-align:center; vertical-align:top;">${escapeHtml(
                            formatMistakeId(m.id)
                          )}</td>
                          <td style="border:1px solid #000; padding:6px; word-break:break-word;">${escapeHtml(
                            m.question
                          )}</td>
                          <td style="border:1px solid #000; padding:6px; word-break:break-word;">${escapeHtml(
                            m.reason
                          )}</td>
                        </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        `
        container.appendChild(card)
      })

      document.body.appendChild(container)
      const canvases = await Promise.all(
        Array.from(container.children).map((node) =>
          (anyWin.html2canvas as any)(node as HTMLElement, { scale: 2 })
        )
      )

      const { jsPDF } = anyWin.jspdf
      const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 24
      const usableHeight = pageHeight - margin * 2
      let yCursor = margin
      canvases.forEach((canvas: HTMLCanvasElement) => {
        const imgData = canvas.toDataURL('image/jpeg', 0.95)
        const ratio = Math.min(
          (pageWidth - margin * 2) / canvas.width,
          usableHeight / canvas.height
        )
        const w = canvas.width * ratio
        const h = canvas.height * ratio

        if (yCursor + h > margin + usableHeight) {
          pdf.addPage()
          yCursor = margin
        }
        const x = (pageWidth - w) / 2
        pdf.addImage(imgData, 'JPEG', x, yCursor, w, h)
        yCursor += h + 12
      })
      pdf.save('訂正清單.pdf')
      document.body.removeChild(container)
    } catch (e) {
      console.error('匯出 PDF 失敗', e)
      alert('匯出 PDF 失敗，請再試一次')
    }
  }

  // 渲染單一學生卡片
  const renderStudentCard = useCallback((card: CorrectionCard) => (
    <div
      key={card.submissionId}
      className={`rounded-xl shadow ${compactMode ? 'p-3' : 'p-4'} border border-gray-100 ${heatColor(
        card.correctionCount || 0
      )}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 leading-tight">
            {card.seatNumber != null
              ? `${card.seatNumber} ${card.studentName}`
              : card.studentName}
          </h3>
          <p className="text-[11px] text-gray-500">
            訂正次數：{card.correctionCount || 0}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void increaseCount(card.submissionId)}
            className="inline-flex items-center px-2 py-1 rounded-lg bg-white/80 border border-orange-200 text-orange-700 text-xs hover:bg-orange-50"
          >
            +1
          </button>
          <button
            type="button"
            onClick={() => void resetCount(card.submissionId)}
            className="inline-flex items-center px-2 py-1 rounded-lg bg-white/80 border border-gray-200 text-gray-600 text-xs hover:bg-gray-50"
            title="重置為 0"
          >
            0
          </button>
        </div>
      </div>

      <div className={compactMode ? 'flex flex-wrap gap-1' : 'space-y-2'}>
        {card.mistakes.map((m) => {
          const common = {
            key: m.id,
            type: 'button' as const,
            onClick: () => toggleMistake(card.submissionId, m.id)
          }
          return compactMode ? (
            <button
              {...common}
              className={`px-2 py-1 rounded border text-left text-xs ${
                m.done
                  ? 'bg-green-50 border-green-200 text-green-700 line-through'
                  : 'bg-white border-gray-200 text-gray-800 hover:bg-gray-50'
              }`}
              title={buildMistakeTitle(m)}
            >
              <div className="flex items-center gap-1">
                {m.done ? (
                  <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                ) : (
                  <span className="w-3.5 h-3.5 border border-gray-300 rounded-full inline-flex" />
                )}
                <span className="font-medium truncate max-w-[140px]">
                  {formatMistakeId(m.id) || m.question}
                </span>
              </div>
            </button>
          ) : (
            <button
              {...common}
              className={`w-full text-left px-3 py-2 rounded-lg border ${
                m.done
                  ? 'bg-green-50 border-green-200 text-green-700 line-through'
                  : 'bg-white border-gray-200 text-gray-800 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2 text-sm">
                {m.done ? (
                  <CheckCircle className="w-4 h-4 text-green-600" />
                ) : (
                  <span className="w-4 h-4 border border-gray-300 rounded-full inline-flex" />
                )}
                {formatMistakeId(m.id) && (
                  <span className="text-[11px] font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                    {formatMistakeId(m.id)}
                  </span>
                )}
                <span className="font-medium truncate">{m.question}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                {m.reason}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  ), [compactMode, increaseCount, resetCount, toggleMistake])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-orange-500 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入訂正資料中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-red-50 p-4">
      <style>
        {`
          @page {
            size: A4;
            margin: 12mm;
          }
          @media print {
            .print-hidden { display: none !important; }
            .print-block { display: block !important; }
            .print-card { break-inside: avoid; page-break-inside: avoid; }
          }
        `}
      </style>
      <div className="max-w-7xl mx-auto pt-8">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors print-hidden"
          >
            <ArrowLeft className="w-5 h-5" />
            返回
          </button>
        )}

        <div className="bg-white rounded-2xl shadow-xl p-6 mb-4">
          {/* 標題區 */}
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">訂正管理 · 儀表板</h1>
              <p className="text-sm text-gray-600">
                班級：{classroom?.name || '未知班級'} · 作業：{assignment?.title || '未知作業'}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                需訂正學生：{activeCards.length} 人
              </p>
            </div>
            {/* 匯出按鈕 */}
            <div className="flex flex-wrap gap-2 print-hidden">
              <button
                type="button"
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1 px-3 py-2 bg-white text-gray-700 rounded-lg hover:bg-gray-100 border border-gray-200 text-sm"
              >
                <Download className="w-4 h-4" />
                匯出PDF
              </button>
              <button
                type="button"
                onClick={handleExportExcel}
                className="inline-flex items-center gap-1 px-3 py-2 bg-white text-gray-700 rounded-lg hover:bg-gray-100 border border-gray-200 text-sm"
              >
                <Download className="w-4 h-4" />
                匯出Excel
              </button>
            </div>
          </div>

          {/* 排序與顯示控制 */}
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100 print-hidden">
            {/* 排序下拉選單 */}
            <div className="relative">
              <select
                value={sortOption}
                onChange={(e) => handleSortChange(e.target.value as CorrectionSortOption)}
                className="appearance-none inline-flex items-center gap-1 pl-8 pr-8 py-1.5 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 border border-gray-200 text-sm cursor-pointer"
              >
                <option value="seat-asc">座號 ↑</option>
                <option value="seat-desc">座號 ↓</option>
                <option value="mistakes-desc">錯題多→少</option>
                <option value="mistakes-asc">錯題少→多</option>
                <option value="group">按小組</option>
              </select>
              <SortAsc className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            </div>
            {/* 編輯小組按鈕 */}
            {sortOption === 'group' && (
              <button
                type="button"
                onClick={openEditGroupModal}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 border border-purple-200 text-sm"
              >
                <Users className="w-4 h-4" />
                編輯小組
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setCompactMode((v) => !v)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-sm bg-white text-gray-700 hover:bg-gray-100 border-gray-200 transition-colors"
            >
              <Columns className="w-4 h-4" />
              {compactMode ? '寬鬆視圖' : '緊湊視圖'}
            </button>
            <button
              type="button"
              onClick={() => setShowCompleted((v) => !v)}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                showCompleted
                  ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-100'
              }`}
            >
              <CheckCircle className="w-4 h-4" />
              {showCompleted ? '隱藏已完成' : '顯示已完成'}
            </button>
          </div>
        </div>

        {/* 小組排序提醒 Banner */}
        {sortOption === 'group' && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 mb-4 print-hidden flex items-start gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <strong>提醒：</strong>小組設定僅儲存於此裝置，不會同步到其他裝置或帳號。
              {!hasGroupConfig && ' 請先設定小組分配。'}
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-4 print-hidden">
            <p>{error}</p>
          </div>
        )}

        <div className="print-hidden">
          {visibleCards.length === 0 ? (
            <div className="bg-white rounded-xl shadow p-6 text-center text-gray-500">
              {showCompleted ? '目前沒有學生紀錄。' : '目前沒有需要訂正的學生。'}
            </div>
          ) : sortOption === 'group' && cardsByGroup ? (
            /* 按小組排序時：分組顯示 */
            <div className="space-y-6">
              {cardsByGroup.map(group => {
                const isUnassigned = group.groupNumber === 0
                return (
                  <div key={group.groupNumber}>
                    <div className={`flex items-center gap-2 mb-3 pb-2 border-b ${isUnassigned ? 'border-gray-200' : 'border-blue-200'}`}>
                      <Users className={`w-4 h-4 ${isUnassigned ? 'text-gray-500' : 'text-blue-500'}`} />
                      <span className={`font-medium ${isUnassigned ? 'text-gray-600' : 'text-blue-700'}`}>
                        {isUnassigned ? '未分組' : `第 ${group.groupNumber} 組`}
                      </span>
                      <span className={`text-sm ${isUnassigned ? 'text-gray-400' : 'text-blue-400'}`}>
                        ({group.cards.length} 人)
                      </span>
                    </div>
                    <div
                      className={`grid ${compactMode ? 'gap-3' : 'gap-4'}`}
                      style={compactMode ? { gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } : undefined}
                    >
                      {group.cards.map(renderStudentCard)}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            /* 其他排序：一般顯示 */
            <div
              className={`grid ${compactMode ? 'gap-3' : 'gap-4'}`}
              style={compactMode ? { gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } : undefined}
            >
              {visibleCards.map(renderStudentCard)}
            </div>
          )}
        </div>

      </div>

      {/* 小組設定 Modal */}
      {isGroupModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">小組設定</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  拖曳學生卡片到對應的組別
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">組數：</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setTempGroupCount(Math.max(1, tempGroupCount - 1))}
                      disabled={tempGroupCount <= 1}
                      className="w-7 h-7 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="w-8 text-center font-medium">{tempGroupCount}</span>
                    <button
                      type="button"
                      onClick={() => setTempGroupCount(Math.min(10, tempGroupCount + 1))}
                      disabled={tempGroupCount >= 10}
                      className="w-7 h-7 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={cancelGroupConfig}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body - 組別區域 */}
            <div className="flex-1 overflow-auto p-4">
              {/* 未分組區域 */}
              <div className="mb-4">
                <h4 className="text-sm font-medium text-gray-600 mb-2 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  未分組（拖曳至下方組別）
                </h4>
                <div
                  className="min-h-[60px] p-3 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 flex flex-wrap gap-2"
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDropToGroup(e, 0)}
                >
                  {cards
                    .filter(c => (tempGroupConfig[c.studentId] || 0) === 0)
                    .sort((a, b) => (a.seatNumber || 999) - (b.seatNumber || 999))
                    .map(card => (
                      <div
                        key={card.studentId}
                        draggable
                        onDragStart={(e) => handleDragStart(e, card.studentId)}
                        onDragEnd={handleDragEnd}
                        className="px-3 py-1.5 bg-white rounded-lg border border-gray-200 shadow-sm cursor-grab hover:shadow-md transition-shadow select-none flex items-center gap-2"
                      >
                        <span className="text-xs text-gray-500 font-mono">
                          {card.seatNumber || '-'}
                        </span>
                        <span className="text-sm font-medium">{card.studentName}</span>
                        <span className="text-xs text-gray-400">
                          ({card.mistakes.filter(m => !m.done).length})
                        </span>
                      </div>
                    ))}
                  {cards.filter(c => (tempGroupConfig[c.studentId] || 0) === 0).length === 0 && (
                    <div className="w-full text-center text-sm text-gray-400 py-2">
                      全部學生已分組
                    </div>
                  )}
                </div>
              </div>

              {/* 各組區域 */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Array.from({ length: tempGroupCount }, (_, i) => i + 1).map(groupNum => {
                  const groupStudents = cards.filter(c => tempGroupConfig[c.studentId] === groupNum)
                  return (
                    <div
                      key={groupNum}
                      className="border rounded-lg overflow-hidden"
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDropToGroup(e, groupNum)}
                    >
                      <div className="px-3 py-2 bg-blue-50 border-b flex items-center justify-between">
                        <span className="font-medium text-blue-700">第 {groupNum} 組</span>
                        <span className="text-xs text-blue-500">
                          {groupStudents.length} 人
                        </span>
                      </div>
                      <div className="min-h-[80px] p-2 bg-white flex flex-wrap gap-1.5 content-start">
                        {groupStudents
                          .sort((a, b) => (a.seatNumber || 999) - (b.seatNumber || 999))
                          .map(card => (
                            <div
                              key={card.studentId}
                              draggable
                              onDragStart={(e) => handleDragStart(e, card.studentId)}
                              onDragEnd={handleDragEnd}
                              className="px-2 py-1 bg-blue-50 rounded border border-blue-200 cursor-grab hover:bg-blue-100 transition-colors select-none text-sm"
                            >
                              <span className="text-xs text-blue-500 font-mono mr-1">
                                {card.seatNumber || '-'}
                              </span>
                              <span className="text-blue-800">{card.studentName}</span>
                            </div>
                          ))}
                        {groupStudents.length === 0 && (
                          <div className="w-full text-center text-xs text-gray-400 py-4">
                            拖曳學生至此
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t bg-gray-50 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                💡 小組設定只會儲存在此瀏覽器，不會同步到雲端
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cancelGroupConfig}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={saveGroupConfig}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  儲存設定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
