// 2026-08-29 公版答案卷範本「動態產生」（user 拍板：下載前名稱/領域必填，系統自動帶入）：
//   標題列=「{校名}{答案卷名稱}　答案卷」、科目={領域}；OMR 標頭圖（角標＋座號劃卡，
//   幾何=answerSheetLayout.ts RPOMR1）從 public/templates/omr-header.png 取回嵌入。
//   頁數（題目卷/答案卷 __ 頁）在下載當下考卷還沒編出來、無從得知 → 留空由老師填。
//   docx 套件走 dynamic import，不進主 bundle。
import { db } from '@/lib/db'

export interface TemplateInputs {
  /** 答案卷名稱（modal 必填欄），例「109學年度第一學期第2次定期考查 一年級」 */
  examTitle: string
  /** 領域（modal 必填欄）→ 印成「科目」 */
  domain: string
  /** 校名；不給則自動偵測（1Campus 班級資料夾），偵測不到留手寫底線 */
  schoolName?: string
}

/** 從 1Campus 同步班級的資料夾名「校名 114-2」推校名；非 1Campus 老師回 '' */
export async function detectSchoolName(): Promise<string> {
  try {
    const rows = await db.classrooms.toArray()
    const synced = rows.find((c) => !!c.school_id && !!c.folder)
    if (!synced?.folder) return ''
    return synced.folder.replace(/\s*\d{2,3}\s*-\s*\d\s*$/, '').trim()
  } catch {
    return ''
  }
}

export async function generateAnswerSheetTemplateDocx(inputs: TemplateInputs): Promise<Blob> {
  const { examTitle, domain } = inputs
  const schoolName = inputs.schoolName ?? (await detectSchoolName())

  const [docx, headerPngResp] = await Promise.all([
    import('docx'),
    fetch('/templates/omr-header.png')
  ])
  if (!headerPngResp.ok) throw new Error('無法載入範本標頭圖，請稍後再試')
  const headerPng = new Uint8Array(await headerPngResp.arrayBuffer())

  const {
    Document, Packer, Paragraph, TextRun, Header, ImageRun,
    AlignmentType, convertMillimetersToTwip
  } = docx

  const GRAY = '888888'
  // OMR 圖實體 174×34mm → 96dpi 顯示 px
  const IMG_W = Math.round((174 / 25.4) * 96)
  const IMG_H = Math.round((34 / 25.4) * 96)

  const titleLine = `${schoolName || '＿＿＿＿＿＿＿＿'}${examTitle}　答案卷`

  const doc = new Document({
    creator: 'RedPen AI',
    title: titleLine,
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertMillimetersToTwip(62),
              bottom: convertMillimetersToTwip(18),
              left: convertMillimetersToTwip(18),
              right: convertMillimetersToTwip(18),
              header: convertMillimetersToTwip(6)
            }
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 80 },
                children: [new TextRun({ text: titleLine, bold: true, size: 28 })]
              }),
              new Paragraph({
                spacing: { after: 80 },
                children: [
                  new TextRun({ text: `科目：${domain}`, size: 22 }),
                  new TextRun({ text: '　　適用班級：＿＿＿＿＿＿＿＿', size: 22 })
                ]
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 60 },
                children: [
                  new ImageRun({
                    type: 'png',
                    data: headerPng,
                    transformation: { width: IMG_W, height: IMG_H }
                  })
                ]
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: '本份試題：題目卷＿＿頁，手寫答案卷＿＿頁', size: 22 })
                ]
              })
            ]
          })
        },
        children: [
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: '【範本使用說明，編輯前請閱讀，完成後可刪除此段】', bold: true, size: 20, color: GRAY })
            ]
          }),
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: '1. 請保留每頁頁首的標頭（黑色角標與座號劃卡格是系統辨識的依據），不要刪除、裁切或縮放；標題與班級等文字可自行修改。', size: 20, color: GRAY })]
          }),
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: '2. 從此處開始自由編輯題目與作答區，完成後直接列印；同一份卷可影印或油印給全班、跨班共用。', size: 20, color: GRAY })]
          }),
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: '3. 考試時請學生在每一頁「手寫」並「劃卡」自己的座號（用黑筆塗滿）。', size: 20, color: GRAY })]
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({ text: '4. 考後掃描或拍照，在 RedPen 匯入作業時使用「座號辨識模式」，系統會自動依劃卡座號對應學生，不需依號碼排序。', size: 20, color: GRAY })]
          }),
          new Paragraph({ children: [new TextRun({ text: '' })] })
        ]
      }
    ]
  })

  return Packer.toBlob(doc)
}
