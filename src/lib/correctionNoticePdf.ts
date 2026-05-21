export interface CorrectionNoticeStudent {
  studentId: string
  name: string
  seatNumber: number | null
  className: string
  totalCount: number
  correctCount: number
  mistakeCount: number
  accuracy: number | null
  score: number | null
  mistakeQuestionIds: string[]
}

export interface CorrectionNoticeData {
  assignmentId: string
  assignmentTitle: string
  className: string
  students: CorrectionNoticeStudent[]
}

export interface GeneratePdfOptions {
  onProgress?: (done: number, total: number) => void
}

export async function fetchCorrectionNoticeData(
  assignmentId: string,
  studentIds?: string[]
): Promise<CorrectionNoticeData> {
  const query = new URLSearchParams({ assignmentId })
  if (studentIds && studentIds.length > 0) {
    query.set('studentIds', studentIds.join(','))
  }
  const response = await fetch(`/api/data/correction-notice?${query.toString()}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store'
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || '載入訂正通知單資料失敗')
  }
  return data as CorrectionNoticeData
}

function formatDateZh(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y} / ${m} / ${d}`
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Pick a font size for the question-ID tag list so the block fits within ~360px of vertical room
// even for high-mistake-count students. Empirical clamp.
function pickQuestionTagFontSize(count: number): number {
  if (count <= 12) return 18
  if (count <= 24) return 16
  if (count <= 40) return 14
  if (count <= 60) return 12
  return 10
}

function renderNoticeHtml(
  student: CorrectionNoticeStudent,
  assignmentTitle: string,
  dateStr: string
): string {
  const scoreText =
    student.score == null ? '未計分' : `${Math.round(student.score * 10) / 10} / 100`
  const accuracyText = student.accuracy == null ? '—' : `${student.accuracy}%`
  const tagFontSize = pickQuestionTagFontSize(student.mistakeQuestionIds.length)
  const questionTagsHtml = student.mistakeQuestionIds
    .map(
      (qid) => `<span style="
        display: inline-block;
        padding: 8px 16px;
        margin: 4px;
        border: 1.5px solid #c2410c;
        border-radius: 8px;
        background: #fff7ed;
        color: #9a3412;
        font-weight: 600;
        font-size: ${tagFontSize}pt;
        font-variant-numeric: tabular-nums;
      ">${escapeHtml(qid)}</span>`
    )
    .join('')

  const seatText = Number.isFinite(student.seatNumber) ? String(student.seatNumber) : '—'

  return `
    <div style="
      width: 794px;
      height: 1123px;
      box-sizing: border-box;
      padding: 64px 64px 56px 64px;
      background: #ffffff;
      color: #0f172a;
      font-family: 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans TC', 'Heiti TC', sans-serif;
      overflow: hidden;
      position: relative;
    ">
      <!-- Header -->
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="
          font-size: 32pt;
          font-weight: 700;
          letter-spacing: 12px;
          color: #0f172a;
          margin-bottom: 16px;
        ">訂&nbsp;正&nbsp;通&nbsp;知&nbsp;單</div>
        <div style="font-size: 14pt; color: #475569; margin-bottom: 4px;">
          作業：${escapeHtml(assignmentTitle || '未命名作業')}
        </div>
        <div style="font-size: 12pt; color: #64748b;">日期：${escapeHtml(dateStr)}</div>
      </div>

      <div style="border-top: 3px double #94a3b8; margin: 16px 0 20px 0;"></div>

      <!-- Student row -->
      <div style="
        display: flex;
        justify-content: space-between;
        font-size: 16pt;
        font-weight: 600;
        color: #1e293b;
        padding: 0 16px;
      ">
        <div>班級：${escapeHtml(student.className || '—')}</div>
        <div>座號：${escapeHtml(seatText)}</div>
        <div>姓名：${escapeHtml(student.name || '—')}</div>
      </div>

      <div style="border-top: 3px double #94a3b8; margin: 20px 0 24px 0;"></div>

      <!-- Stats heading -->
      <div style="
        font-size: 16pt;
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 12px;
      ">📊 作業概況</div>

      <!-- Stats table -->
      <table style="
        width: 100%;
        border-collapse: collapse;
        font-size: 13pt;
        margin-bottom: 16px;
        font-variant-numeric: tabular-nums;
      ">
        <thead>
          <tr style="background: #f1f5f9;">
            <th style="border: 1px solid #cbd5e1; padding: 10px; font-weight: 600; color: #475569;">總題數</th>
            <th style="border: 1px solid #cbd5e1; padding: 10px; font-weight: 600; color: #475569;">正確題數</th>
            <th style="border: 1px solid #cbd5e1; padding: 10px; font-weight: 600; color: #475569;">錯誤題數</th>
            <th style="border: 1px solid #cbd5e1; padding: 10px; font-weight: 600; color: #475569;">答對率</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="border: 1px solid #cbd5e1; padding: 14px; text-align: center; font-size: 18pt; font-weight: 700;">${student.totalCount}</td>
            <td style="border: 1px solid #cbd5e1; padding: 14px; text-align: center; font-size: 18pt; font-weight: 700; color: #15803d;">${student.correctCount}</td>
            <td style="border: 1px solid #cbd5e1; padding: 14px; text-align: center; font-size: 18pt; font-weight: 700; color: #b91c1c;">${student.mistakeCount}</td>
            <td style="border: 1px solid #cbd5e1; padding: 14px; text-align: center; font-size: 18pt; font-weight: 700;">${escapeHtml(accuracyText)}</td>
          </tr>
        </tbody>
      </table>

      <div style="
        font-size: 14pt;
        color: #1e293b;
        padding: 8px 0 16px 0;
      ">
        本次得分：<span style="font-weight: 700; font-size: 18pt; color: ${student.score == null ? '#64748b' : '#0f172a'};">${escapeHtml(scoreText)}</span>
      </div>

      <div style="border-top: 1px solid #cbd5e1; margin: 12px 0 20px 0;"></div>

      <!-- Mistake list -->
      <div style="
        font-size: 16pt;
        font-weight: 700;
        color: #991b1b;
        margin-bottom: 12px;
      ">❌ 需訂正題號</div>

      <div style="
        line-height: 1.6;
        padding: 4px 0;
      ">${questionTagsHtml}</div>

      <!-- Footer (absolutely positioned at bottom) -->
      <div style="
        position: absolute;
        left: 64px;
        right: 64px;
        bottom: 56px;
      ">
        <div style="border-top: 1px solid #cbd5e1; margin-bottom: 16px;"></div>
        <div style="font-size: 12pt; color: #475569; line-height: 1.7;">
          請針對以上題號進行訂正、訂正完成後交回老師確認。
        </div>
        <div style="font-size: 12pt; color: #475569; margin-top: 8px;">
          訂正完成請於&nbsp;&nbsp;______&nbsp;&nbsp;/&nbsp;&nbsp;______&nbsp;&nbsp;前繳回。
        </div>
      </div>
    </div>
  `
}

export async function generateCorrectionNoticePdf(
  data: CorrectionNoticeData,
  options: GeneratePdfOptions = {}
): Promise<{ generated: number; skipped: number }> {
  const eligibleStudents = data.students.filter((s) => s.mistakeCount > 0)
  const skipped = data.students.length - eligibleStudents.length
  if (eligibleStudents.length === 0) {
    return { generated: 0, skipped }
  }

  const [{ default: html2canvas }, jsPDFModule] = await Promise.all([
    import('html2canvas'),
    import('jspdf')
  ])
  const JsPDF = jsPDFModule.jsPDF

  const stagingHost = document.createElement('div')
  stagingHost.style.position = 'fixed'
  stagingHost.style.left = '-100000px'
  stagingHost.style.top = '0'
  stagingHost.style.width = '794px'
  stagingHost.style.height = '1123px'
  stagingHost.style.pointerEvents = 'none'
  stagingHost.style.zIndex = '-1'
  document.body.appendChild(stagingHost)

  const dateStr = formatDateZh(new Date())
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })

  try {
    for (let i = 0; i < eligibleStudents.length; i++) {
      const student = eligibleStudents[i]
      stagingHost.innerHTML = renderNoticeHtml(student, data.assignmentTitle, dateStr)

      const targetEl = stagingHost.firstElementChild as HTMLElement | null
      if (!targetEl) continue

      const canvas = await html2canvas(targetEl, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        width: 794,
        height: 1123,
        windowWidth: 794,
        windowHeight: 1123
      })

      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      if (i > 0) doc.addPage('a4', 'portrait')
      doc.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST')

      options.onProgress?.(i + 1, eligibleStudents.length)
    }

    const safeTitle = (data.assignmentTitle || '訂正通知單').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const today = new Date()
    const dateKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    doc.save(`訂正通知單_${safeTitle}_${dateKey}.pdf`)
  } finally {
    stagingHost.remove()
  }

  return { generated: eligibleStudents.length, skipped }
}
