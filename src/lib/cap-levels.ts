// 2026-08-07 家長報告「精熟程度總覽」的會考能力等級語言(user 拍板 mockup 定稿)。
//
// 我們的三級標籤(精熟/基礎/待加強)本來就在用,這裡補上「這一級代表什麼」的說明文字,
// 文字**引用國中教育會考官方公告的各科能力等級描述**(心測中心 cap.rcpet.edu.tw/score1.html)。
// ⚠ 這些描述是心測中心的公告內容,**不是印在學生成績單上的東西**(成績單只印等級與標示)
//   → 對外一律標示「參照」,不可寫成「官方檢測結果」。CAP_LEVEL_DISCLAIMER 必附。
//
// ⛔ 門檻不照搬會考(2026-08-07 查證 114/115 年官方對照表後的決定):
//   會考實際門檻(答對率換算):精熟 國文85.7%/社會88.9%/自然86.0%/英閱88.4%;
//                             基礎 國文40~43%/社會37~39%/自然36~38%/英閱32.6%
//   不採用的三個理由:①分析單位不同(會考=整科總分、我們=單一主題可能只有 3~4 題,小樣本波動大)
//   ②難度基準不同(段考通常比會考容易,照搬 40% 當基礎門檻會變成幾乎全綠、失去鑑別力)
//   ③逐年變動(國文基礎門檻 114 年 18 題、115 年 17 題)。
//   → 借語言、不借門檻;門檻抽成下方常數,日後要校準改這裡即可。

/** 精熟程度門檻(原本寫死在 parentReport.ts,抽出集中管理) */
export const MASTERY_THRESHOLDS = {
  /** 主題層級徽章:得分率 ≥green→精熟、≥amber→基礎、其餘待加強 */
  topic: { green: 0.8, amber: 0.6 },
  /** 知識點格子:≥expert→精熟色、≥basic→基礎色、其餘待加強色 */
  kp: { expert: 0.8, basic: 0.5 },
} as const

export type CapBand = 'green' | 'amber' | 'red'

/** 會考各科能力等級描述(官方原文;green=精熟、amber=基礎、red=待加強) */
const CAP_DESC: Record<string, Record<CapBand, string>> = {
  國文: {
    green: '能具備與教材相關的語文知識，能深入的理解、評鑑各類文本',
    amber: '大致能具備與教材相關的語文知識，大致能理解、評鑑各類文本',
    red: '僅能具備部分與教材相關的語文知識，僅能有限的理解',
  },
  英語: {
    green: '能理解所學字詞的常見語意、常見的句型結構，能指出主旨',
    amber: '能理解所學字詞的基本語意、基本的句型結構，能提取明確訊息',
    red: '僅能理解少數所學字詞的基本語意',
  },
  數學: {
    green: '能分析複雜、不明顯的數學訊息，並發展解題策略',
    amber: '理解基本的數學概念，能操作算則或程序',
    red: '僅認識部分基本的數學概念，僅能操作部分的算則',
  },
  社會: {
    green: '能廣泛認識社會領域學習內容，運用多元知識探究',
    amber: '能大致認識社會領域學習內容，運用基礎知識探究',
    red: '能約略認識社會領域學習內容，並能覺察相關訊息',
  },
  自然: {
    green: '能融會貫通學習內容，運用探究能力解決多層次思考問題',
    amber: '能知道及理解學習內容，運用探究能力解決基本問題',
    red: '能部分知道及理解學習內容',
  },
}

/** 科目名稱正規化:系統的 domain 名稱 → 會考科目名(對不上回 null=不顯示描述) */
export function normalizeCapSubject(subject: string): string | null {
  const s = String(subject || '').trim()
  if (!s) return null
  if (/國語|國文/.test(s)) return '國文'
  if (/英語|英文/.test(s)) return '英語'
  if (/數學/.test(s)) return '數學'
  if (/社會|歷史|地理|公民/.test(s)) return '社會'
  if (/自然|理化|物理|化學|生物|地科|地球科學/.test(s)) return '自然'
  return null
}

/**
 * 取某科某等級的描述,以及「再上一級」的描述(給努力方向;精熟級無下一級)。
 * 科目對不上(如藝文、健體)→ 回 null,呼叫端不渲染這段。
 */
export function capLevelDesc(subject: string, band: CapBand): { current: string; next?: string } | null {
  const key = normalizeCapSubject(subject)
  if (!key) return null
  const set = CAP_DESC[key]
  if (!set) return null
  const next = band === 'red' ? set.amber : band === 'amber' ? set.green : undefined
  return { current: set[band], ...(next ? { next } : {}) }
}

/** 精熟程度總覽段落末尾的免責(必附;不可省) */
export const CAP_LEVEL_DISCLAIMER =
  '※ 等級用語參照「國中教育會考」能力等級描述，協助家長理解孩子目前的學習位置。'
  + '本報告依本次評量結果推估，非官方檢測結果，亦不代表會考成績預測。'
