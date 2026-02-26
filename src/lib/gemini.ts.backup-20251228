import {
  db,
  type Submission,
  type GradingResult,
  type AnswerKey,
  type AnswerExtractionCorrection
} from './db'

const geminiProxyUrl = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'

// 你這套設計是「一定走 proxy」：有沒有可用最後由 fetch 成功與否決定
export const isGeminiAvailable = true

// 工具：Blob 轉 Base64（去掉 data: 前綴）
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

type GeminiInlineDataPart = {
  inlineData: {
    mimeType: string
    data: string
  }
}

type GeminiRequestPart = string | GeminiInlineDataPart
type GeminiPart = { text: string } | GeminiInlineDataPart

function normalizeParts(parts: GeminiRequestPart[]): GeminiPart[] {
  return parts.map((part) => (typeof part === 'string' ? { text: part } : part))
}

async function generateGeminiText(
  modelName: string,
  parts: GeminiRequestPart[]
): Promise<string> {
  const response = await fetch(geminiProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model: modelName,
      contents: [{ role: 'user', parts: normalizeParts(parts) }]
    })
  })

  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    // 特別處理 413 錯誤（檔案過大）
    if (response.status === 413) {
      throw new Error('檔案總大小過大，超過 AI 處理限制。建議分批上傳檔案。')
    }

    const message =
      data?.error?.message ||
      data?.error ||
      `Gemini request failed (${response.status})`
    throw new Error(message)
  }

  const text = (data?.candidates ?? [])
    .flatMap((candidate: any) => candidate?.content?.parts ?? [])
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()

  if (!text) {
    throw new Error('Gemini response empty')
  }

  return text
}

/**
 * 🔍 模型健診工具
 * 依序測試候選模型，選出可用的一個作為 currentModelName
 */
export async function diagnoseModels() {
  if (!isGeminiAvailable) {
    console.error('Gemini 服務未設定')
    return
  }

  const candidates = ['gemini-3-flash-preview']

  console.log('🩺 開始測試可用的 Gemini 模型...')
  let winnerModel = ''

  for (const modelName of candidates) {
    try {
      console.log(`Testing: ${modelName} ...`)
      const text = await generateGeminiText(modelName, ['Hi'])
      console.log(`✅ ${modelName} 測試成功，回應片段:`, text.slice(0, 10))

      if (!winnerModel) winnerModel = modelName
    } catch (error: any) {
      console.warn(
        `⚠️ ${modelName} 測試失敗:`,
        error.message?.split(':')[0] || error.message
      )
    }
  }

  if (winnerModel) {
    console.log(`✅ 最終決定使用模型: ${winnerModel}`)
    alert(`模型偵測完成！推薦模型：${winnerModel}\n(詳細請看 F12 Console)`)
    return winnerModel
  } else {
    console.error('❌ 所有候選模型都測試失敗，請檢查 API Key 或網路狀態')
    alert('所有模型都無法使用，請檢查 API Key 或網路狀態')
    return 'gemini-1.5-flash' // 保留一個預設退路
  }
}

// 預設使用的模型名稱（會被 diagnoseModels 動態覆蓋）
let currentModelName = 'gemini-3-flash-preview'

export interface ExtractAnswerKeyOptions {
  domain?: string
  priorWeightTypes?: import('./db').QuestionCategoryType[] // Prior Weight：優先級順序

  // @deprecated 已廢棄，請使用 priorWeightTypes 替代
  allowedQuestionTypes?: import('./db').QuestionType[]
}

export interface GradeSubmissionOptions {
  strict?: boolean
  domain?: string
  skipMissingRetry?: boolean
  regrade?: {
    questionIds: string[]
    previousDetails?: Array<{
      questionId?: string
      studentAnswer?: string
      score?: number
      maxScore?: number
      isCorrect?: boolean
      reason?: string
      confidence?: number
    }>
    forceUnrecognizableQuestionIds?: string[]
    mode?: 'correction' | 'missing'
  }
}

const gradingDomainHints: Record<string, string> = {
  國語: `
【最高優先規則：studentAnswer 嚴禁優化】
1. studentAnswer 一律逐字抄寫「圖片中看得到的學生筆跡」，不可摘要、不可改寫、不可修正錯字、不可補全。
2. 需要抓重點/摘要只能寫在 reason 或 mistakes/weaknesses/suggestions，絕對不能寫進 studentAnswer。

【國語作業特別警告：造詞題最容易腦補】
⚠️ 嚴重警告：造詞題空白時，絕不可依據讀音或部首腦補詞語！
- 題目：「ㄋㄨㄥˋ：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「弄瓦」「弄璋」）
- 題目：「光：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「光明」「光線」）
- 題目：「辨：□□」，學生空白 → 輸出「未作答」（❌ 不可腦補「辨別」「分辨」）
- 每題獨立判斷：第1格有寫 ≠ 第2格也該有寫，空白就是空白！

【國語作業閱讀方向 - 重要】
⚠️ 國語作業幾乎都是由右往左、由上往下閱讀（直排文字）
- 排序題：要按照「右→左、上→下」的順序判讀學生填寫的內容
- 多欄位題目：右邊的欄位是第一個，左邊的欄位是最後一個
- 例如：選項排列「甲 乙 丙 丁」在圖片中可能是「丁 丙 乙 甲」（從右到左）
- 不要用西式「左→右」的習慣來判讀國語作業

【評分提示（只影響 isCorrect/score/reason，不得影響 studentAnswer）】
1. 文意題：避免主觀推論，只在 reason 說明「缺哪些關鍵字/要點」。
2. 字音造詞題：檢查學生答案讀音是否符合題目要求（如：ㄋㄨㄥˋ 可答「弄瓦」，不可答「巷弄(ㄌㄨㄥˋ)」），讀音錯誤直接 0 分。

【方格框答案擷取】
1. 識別方格區域：確認學生填寫內容在方格框內
2. 擷取規則：
- 單方格 = 單字（□ → "弄"）
- 多方格 = 連續字詞（□□ → "弄瓦"）
- 空白方格 → "未作答"
3. 對齊檢查：確保方格數量與標準答案一致
4. ⚠️ 注意方格排列方向：可能是直排（由右往左、由上往下）

【國語答案擷取特別注意】
1. 相近字造詞題：學生可能寫錯字（如：嗇→普），原樣輸出不修正
2. 同音字造詞題：檢查讀音一致性，但不修正學生用字
3. 開放題/申論題：
- 學生答案可能簡短、不完整、有語病 → 原樣輸出
- 禁止擴寫、補充、修正、優化學生答案
- 即使答案明顯錯誤或不完整，也必須如實記錄「學生實際寫了什麼」
- ⚠️ 學生空白 → 記錄「未作答」，不可腦補內容

【多階段作答題處理】
⚠️ 識別特徵：題目分「步驟一/二」或「第一步/第二步」
- 第一階段（引導）：選擇、分析、構思（通常無對錯，完成即可）
- 第二階段（主要作答）：實際內容（有標準答案）

批改原則：
1. studentAnswer 要包含兩個階段的內容，清楚標示
   例如：「步驟一：動作、想法；步驟二：他揮舞著雙手，心想…」
2. 評分時使用 rubricsDimensions 分階段給分：
   - 第一階段：看「是否完成」不看「是否正確」，有做選擇就給分
   - 第二階段：依據 criteria 判斷內容品質並給分
3. 整題的 isCorrect：以第二階段為準，不因第一階段未完成而判錯
`.trim(),

  數學: `
【數學作業特別警告：計算題最容易腦補】
⚠️ 嚴重警告：計算題空白時，絕不可依據算式或常識腦補答案！
- 題目：「2+3=______」，學生空白 → 輸出「未作答」（❌ 不可腦補「5」）
- 題目：「5×7=______」，學生空白 → 輸出「未作答」（❌ 不可腦補「35」）
- 題目：「周長=______」，學生空白 → 輸出「未作答」（❌ 不可腦補公式或數值）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖題型處理】
典型題型：在座標平面上畫點/線/圖形、畫幾何圖形、標註角度等

評分原則（使用 rubricsDimensions）：
- 圖形正確性：形狀、線條是否正確
- 位置精準度：座標位置、角度、比例是否正確
- 標註完整性：必要標註（如角度、長度）是否完整
⚠️ 圖形對 ≠ 答案對，位置和標註也必須正確

【數學答案擷取要點】
計算題保留最終數值與必要單位；需公式時留核心公式。
幾何/代數題可列主要結論，避免冗長過程。
`.trim(),

  社會: `
【社會作業最高警戒：絕對禁止腦補空白】
🚨 最高優先級規則：社會科最容易腦補，必須嚴格檢查！

⚠️ 重要觀念：「輸出記錄」≠「生成答案」！
- ✅ 正確理解：學生空白 → 輸出 studentAnswer: "未作答"（這是輸出記錄）
- ❌ 錯誤理解：學生空白 → 輸出 studentAnswer: "台北"（這是腦補答案）
- 每題都要有記錄，但空白題的記錄內容是「未作答」，不是腦補的答案！

核心原則：
- 圖片上看不到筆跡 = 未作答，不可有任何例外！
- 即使題目「超級簡單」「人人都知道」也絕不可腦補
- 每次輸出前必須自問：「我在圖片上真的看到這些字了嗎？」

🚨 絕對禁止腦補的例子：

填空題：
- 題目：「台灣的首都是______」，學生空白 → 輸出「未作答」（❌ 即使人人都知道是台北，也不可腦補）
- 題目：「第一次世界大戰發生於______年」，學生空白 → 輸出「未作答」（❌ 即使答案是 1914，也不可腦補）
- 題目：「______是台灣最高峰」，學生空白 → 輸出「未作答」（❌ 即使答案是玉山，也不可腦補）
- 題目：「中華民國的國旗是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「青天白日滿地紅」）
- 題目：「台灣四面環______」，學生空白 → 輸出「未作答」（❌ 不可腦補「海」）

勾選題（最容易腦補！）：
🚨 關鍵：只看「方框□內」是否有標記，不要被箭頭等符號誤導！

- 題目：「台灣位於哪一洲？ □亞洲 ↑  □歐洲 ↖  □非洲 →  □美洲 ↓」，四個方框內都空白
  → 輸出「未作答」（❌ 即使人人都知道是亞洲，也不可腦補「亞洲」）
  → ❌ 箭頭（↑ ↖ → ↓）是題目的一部分，不是學生的作答標記！

- 題目：「首都在台北的國家是？ □日本 □中華民國 □韓國」，三個方框內都空白
  → 輸出「未作答」（❌ 不可腦補「中華民國」）
  → ❌ 選項文字（日本、中華民國、韓國）是題目的一部分，不是學生的作答！

⚠️ 判斷標準：
- ✅ 方框□內有打勾 ✓、圈選 ○、劃記 × = 有作答
- ✅ 方框□內完全空白 = 未作答
- ❌ 看到箭頭或選項文字就以為有作答 → 這些都是題目的一部分！
- 只關注「方框內部」是否有學生的筆跡標記

繪圖題（最容易腦補！）：
- 題目：「在地圖上標註台北的位置」，地圖上沒有任何手繪標記
  → 輸出「未作答」（❌ 即使知道台北在哪，也不可腦補「已標註在北部」）
- 題目：「在經緯度圖上標註颱風位置」，圖上沒有任何符號或標記
  → 輸出「未作答」（❌ 不可腦補「已標註颱風符號」）
- ⚠️ 判斷標準：圖上有手繪痕跡 = 有作答；圖上完全沒有手繪痕跡 = 未作答
- ⚠️ 圖片本身的印刷內容（地圖、座標軸）不算學生作答，只有手繪標記才算！

⚠️ 驗證方法：如果你無法在圖片中用手指指出學生寫的每一個字/每一個標記/每一個符號，那就是腦補！
⚠️ 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖/繪標記題型處理】
⚠️ 這類題型必須多維度評分，符號對 ≠ 答案對！

典型題型：
- 在地圖上標註位置（如：經緯度交匯處標註颱風符號）
- 在四象限圖中標記座標點
- 在時間軸上標註事件位置
- 在方位圖上畫出指定符號

評分原則（使用 rubricsDimensions）：
1. 符號正確性維度：
   - 檢查學生畫的符號是否正確（如：颱風符號 🌀、星號 ★、圓圈 ○）
   - studentAnswer 描述：「符號：颱風符號」

2. 位置精準度維度（最重要！）：
   🚨 經緯度題目必須精準判斷，不可用「大概」「象限」！

   正確判斷步驟：
   a. 先檢查 AnswerKey 中的 criteria，確認是精準座標還是範圍要求
   b. 讀取圖上的經緯度刻度線（如：120°E、121°E、122°E...）
   c. 判斷學生標記的位置在哪兩條經線之間、哪兩條緯線之間
   d. 依據 criteria 檢查：
      - 如果 criteria 要求精準座標（如：「必須在東經 151.4°E、北緯 15°N 附近（±1°以內）」）
        → 判斷學生標記是否在 150.4°E-152.4°E、14°N-16°N 範圍內
      - 如果 criteria 是範圍要求（如：「121°E 以東、23.5°N 以南」）
        → 判斷學生標記是否在此範圍內
   e. studentAnswer 必須描述精準位置：
      - 精準座標型：「位置：約 151°E、15.5°N（在 151.4°E±1°、15°N±1° 範圍內 ✓）」
      - 範圍型：「位置：約 122°E、23°N（121°E 以東 ✓、23.5°N 以南 ✓）」

   ❌ 絕對禁止的模糊判斷：
   - ❌「大致在第四象限」→ 不夠精準，必須讀取刻度
   - ❌「方向正確」→ 不夠精準，必須檢查經緯度
   - ❌「相對位置正確」→ 不夠精準，必須對照刻度線
   - ❌「約在右下角」→ 不夠精準，必須讀取經緯度數值

   ✅ 正確判斷範例：
   精準座標型：
   - ✅「位置在 151°E 附近、15°N 附近，符合『151.4°E±1°、15°N±1°』要求」→ 位置正確
   - ❌「位置在 122°E、23°N，不符合『151.4°E±1°、15°N±1°』要求」→ 位置錯誤

   範圍型：
   - ✅「位置在 122°E、23°N，符合『121°E 以東、23.5°N 以南』要求」→ 位置正確
   - ❌「位置在 120°E、23°N，不符合『121°E 以東』要求」→ 位置錯誤

3. 整體判斷：
   - 符號對 + 位置精準符合要求 → 滿分
   - 符號對 + 位置不符合精準要求 → 0 分或低分（依 criteria 而定）
   - 符號錯 + 位置對 → 部分分或 0 分（依 criteria 而定）
   - 符號錯 + 位置錯 → 0 分

🚨 常見錯誤（絕對禁止）
- ❌ 只看符號對就給滿分，忽略位置精準度
- ❌ 位置只看「大致在那個象限」就判對 → 必須讀取經緯度刻度
- ❌ 用「方向」「相對位置」判斷 → 必須用經緯度數值判斷
- ❌ criteria 要求精準座標（151.4°E, 15°N），卻用寬鬆範圍判斷（121°E 以東）→ 必須依照 criteria 精準判斷
- ✅ 必須先檢查 criteria，再依照 criteria 的精準度要求判斷位置

【社會答案擷取要點】
名詞、年代、地點、人物要精確；時間題保留年份或朝代。
請專注於同音異字的錯誤，特別是地名。用字錯誤視為錯誤。例如：九州和九洲。
`.trim(),

  自然: `
【自然作業特別警告：概念題最容易腦補】
⚠️ 嚴重警告：概念題空白時，絕不可依據科學知識腦補答案！
- 題目：「光合作用的場所是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「葉綠體」）
- 題目：「水的化學式是______」，學生空白 → 輸出「未作答」（❌ 不可腦補「H₂O」）
- 題目：「植物行光合作用需要______和______」，學生空白 → 輸出「未作答」（❌ 不可腦補「陽光」「水」）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【繪圖/標註題型處理】
典型題型：繪製實驗裝置圖、標註器官/部位名稱、畫食物鏈/食物網等

評分原則（使用 rubricsDimensions）：
- 圖形正確性：圖形/結構是否正確
- 標註正確性：標註的名稱/位置是否正確
- 完整性：必要元素（如箭頭方向、連結關係）是否完整
⚠️ 圖畫對 ≠ 答案對，標註和關係也必須正確

【自然答案擷取要點】
保留關鍵名詞、數值、實驗結論；單位必須保留，化學式/符號需完整。
`.trim(),

  英語: `
【英語作業特別警告：填空題最容易腦補】
⚠️ 嚴重警告：填空題空白時，絕不可依據文法或常識腦補單字！
- 題目：「I ____ a student.」，學生空白 → 輸出「未作答」（❌ 不可腦補「am」）
- 題目：「apple: ______（中文）」，學生空白 → 輸出「未作答」（❌ 不可腦補「蘋果」）
- 題目：「The cat is ____ the table.」，學生空白 → 輸出「未作答」（❌ 不可腦補「on」「under」）
- 每題獨立判斷：第1題有寫 ≠ 第2題也該有寫，空白就是空白！

【英語答案擷取要點】
拼字需精確；大小寫與標點依題幹要求；完形/選擇用正確選項或必要單字短語。
`.trim()
}

function buildGradingDomainSection(domain?: string) {
  const hint = domain ? gradingDomainHints[domain] : ''
  return hint ? hint.trim() : ''
}

async function getRecentAnswerExtractionCorrections(
  domain?: string,
  limit = 5
): Promise<AnswerExtractionCorrection[]> {
  try {
    let collection = db.answerExtractionCorrections.orderBy('createdAt').reverse()
    if (domain) {
      collection = collection.filter((item) => item.domain === domain)
    }
    return await collection.limit(limit).toArray()
  } catch (err) {
    console.warn('無法讀取擷取錯誤紀錄', err)
    return []
  }
}

function buildAnswerKeyPrompt(
  domain?: string,
  priorWeightTypes?: import('./db').QuestionCategoryType[]
) {
  const base = `
從標準答案圖片提取可機器批改的答案表。回傳純 JSON（無 Markdown）：

{
  "questions": [{
    "id": "1",           // 題號
    "type": 1 | 2 | 3,   // 題型分類（必填）
    "maxScore": 5,       // 滿分

    // Type 1 專用：標準答案
    "answer": "正確答案",

    // Type 2 專用：可接受的答案變體
    "referenceAnswer": "範例答案",
    "acceptableAnswers": ["同義詞1", "同義詞2"],

    // Type 3 專用：評分規準
    "referenceAnswer": "評分要點",
    "rubricsDimensions": [
      {"name": "計算過程", "maxScore": 3, "criteria": "步驟清晰"},
      {"name": "最終答案", "maxScore": 2, "criteria": "答案正確"}
    ],
    "rubric": {
      "levels": [
        {"label": "優秀", "min": 9, "max": 10, "criteria": "邏輯清晰完整"},
        {"label": "良好", "min": 7, "max": 8, "criteria": "大致正確"},
        {"label": "尚可", "min": 5, "max": 6, "criteria": "部分正確"},
        {"label": "待努力", "min": 1, "max": 4, "criteria": "多處錯誤"}
      ]
    },

    // AI偏離提醒
    "aiDivergedFromPrior": false,
    "aiOriginalDetection": 1
  }],
  "totalScore": 50
}

【答案卷識別提示 - 通用於所有領域】
🚨 彩色筆標記判斷原則（最高優先級！）：
- 教師或書商常用「與題目印刷顏色不同的筆」來標示範例答案
- **顏色是最重要的判斷依據**，優先於題目文字要求！

判斷流程（嚴格按此順序）：
1. 第一優先：尋找「與印刷顏色明顯不同的彩色筆跡」
   - 題目印刷通常是黑色 → 紅筆/藍筆/綠筆手寫內容 = 答案
   - 題目是彩色印刷 → 與印刷顏色明顯不同的筆跡 = 答案
2. 第二步：提取這些彩色筆跡的內容作為答案（不管內容是什麼形式）
3. 第三步：如果沒有明顯彩色筆跡，才參考題目要求

顏色判斷依據：
1. 顏色對比：手寫筆跡與印刷文字有明顯色差（紅、藍、綠 vs 黑色）
2. 位置線索：寫在答題區、空格處、方框內的不同色筆跡
3. 筆觸特徵：手寫筆劃 vs 印刷字體

⚠️ 關鍵原則：彩色筆跡 = 答案，黑色印刷 = 題目
- 即使題目要求「寫國字」，但如果注音是紅色、國字是黑色 → 提取「紅色注音」
- 即使題目要求「寫注音」，但如果國字是藍色、注音是黑色 → 提取「藍色國字」
- 顏色優先級 > 題目文字要求

【複選題/題組勾選題識別】
⚠️ 勾選題可能是單選或複選，需正確識別為 1 題，不可拆分！

識別特徵：
- 題目有多個選項（□A □B □C □D）
- 題目說明「可複選」「選出所有正確的」「可勾選多個」
- 或題目沒有明確說明，但選項之間是並列關係（不是互斥的）

設定原則：
1. 必須視為 1 題（不可拆成 4 題）
2. 題型選擇：
   - 如果答案固定（如：「正確的是 A、C」）→ Type 1，answer: "A、C" 或 "AC"
   - 如果答案有多種表述（如：「A,C」「A C」「AC」都可以）→ Type 2，acceptableAnswers: ["A、C", "A,C", "AC", "A C"]
3. 題號：使用題目標示的題號（如：「三、」就用 "3"）

範例：
- 題目：「三、下列哪些選項正確？（可複選）□A 太陽從東邊升起 □B 地球是平的 □C 水會往低處流 □D 天空是綠色的」
- 設定：1 題，id: "3", type: 1 或 2, answer: "A、C" 或 acceptableAnswers: ["A、C", "AC", "A,C"]

【題型分類標準】
Type 1（唯一答案）：精確匹配，答案唯一且不可替換
- 例：是非題(O/X)、選擇題(A/B/C)、計算結果(2+3=5)

Type 2（多答案可接受）：核心答案固定但允許不同表述
- 例：詞義解釋「光合作用」vs「植物製造養分」
- 異音字造詞「ㄋㄨㄥˋ：弄瓦、弄璋」「ㄌㄨㄥˋ：巷弄」（須記錄讀音於 referenceAnswer）
- 相似字造詞「(言部)辯：辯護、爭辯」「(辛部)辨：辨別、分辨」（須記錄部首於 referenceAnswer）

Type 3（依表現給分）：開放式或計算題，需評分規準
- 計算題：用 rubricsDimensions，維度通常包括「計算過程」和「最終答案」
- 申論題：有明確答案要點時用 rubricsDimensions（如：「列舉三個優點」）
- 多階段作答題：用 rubricsDimensions 分階段評分
  - 識別特徵：「步驟一/二」「第一步/第二步」「先…再…」
  - 第一階段（引導/選擇）：通常給少量分數或不計分
  - 第二階段（主要作答）：依標準答案評分
  - ⚠️ 不可拆成多題，必須視為 1 題
- 純評價題：用 rubric 4級評價（優秀/良好/尚可/待努力）

【規則】
- 題號：圖片有就用，無則 1, 2, 3...（不可跳號）
- 配分：圖片有就用，無則估計（是非/選擇 2-5 分，簡答 5-8 分，申論 8-15 分）
- totalScore = 所有 maxScore 總和
- 無法辨識時回傳 {"questions": [], "totalScore": 0}
`.trim()

  let priorHint = ''
  if (priorWeightTypes && priorWeightTypes.length > 0) {
    const typeLabels = priorWeightTypes
      .map((t, i) => {
        const priority = i === 0 ? '最優先' : i === 1 ? '次優先' : '最後'
        const typeName =
          t === 1 ? 'Type 1（唯一答案）' : t === 2 ? 'Type 2（多答案可接受）' : 'Type 3（依表現給分）'
        return `${priority}：${typeName}`
      })
      .join('、')

    priorHint = `

【Prior Weight - 教師指定題型偏好】
教師指定此作業的題型優先級：${typeLabels}

請優先按此順序判斷，但若遇到強烈證據顯示不符時可偏離並設定：
- "aiDivergedFromPrior": true
- "aiOriginalDetection": <你的判斷類型>

注意：只在強烈證據時才偏離，一般情況應遵循 Prior Weight。
`.trim()
  }

  const domainHints: Record<string, string> = {
    國語: `
【國語作業閱讀方向 - 最優先】
⚠️ 國語作業幾乎都是由右往左、由上往下閱讀（直排文字）
- 題號順序：從右上角開始，往左、往下依序排列
- 選項順序：甲乙丙丁通常是從右到左排列
- 排序題：要注意「右→左、上→下」的閱讀順序
- 不要用西式「左→右」的習慣來判讀

【國字注音題型識別 - 方框結構判斷！】
🚨 答案卷格式說明（最重要！）：
- 答案卷是一篇文章，生字用「方框」挖空
- **方框內結構**：固定為「國字位置（左）｜注音位置（右）」
- **印刷內容**（黑色）：方框內其中一個位置會有「黑色印刷文字」，另一個位置是「空白」
  - 例如：「劈（黑色印刷）｜____（空白）」→ 要填注音
  - 例如：「____（空白）｜ㄆㄧ（黑色印刷）」→ 要填國字
- **教師答案卷**：教師用「彩色筆」（紅、藍、綠、粉紅等，不是黑色）填寫空白處，模擬學生回答
  - 🚨 **顏色辨識原則**：
    - **粉紅色/紅色/藍色/綠色等彩色字體** = 正確答案（學生需要填寫的部分）
    - **黑色字體** = 題目提示（原本就印在上面的）
- **題目判斷**：有方框 = 1 題，沒方框 = 不是題目
- **⚠️ 每題只考一個字或一個注音，不會考一個詞**

🚨 判斷流程（嚴格按照此順序）：
1. **第一步**：找出所有「方框」（方框 = 題目）
2. **第二步**：逐個檢查每個方框內部
3. **第三步**：尋找「彩色筆跡」（紅、藍、綠等，不是黑色印刷）
   - 黑色文字 = 題目提示（印刷的）
   - 彩色筆跡 = 答案（教師填寫的）
4. **第四步**：提取彩色筆跡的內容作為答案
   - 彩色筆跡是國字 → 答案是國字
   - 彩色筆跡是注音 → 答案是注音

判斷規則（必須嚴格遵守）：

🚨 **重要原則**：
1. **考「注音」的題目**（題目給國字，學生要寫注音）：
   - 方框內：黑色國字 + 彩色注音 → 答案是注音
   - 範例：「啪（黑色）｜ㄆㄚ（粉紅色）」→ 答案：「ㄆㄚ」
   - 範例：「烘（黑色）｜ㄏㄨㄥ（紅色）」→ 答案：「ㄏㄨㄥ」

2. **考「國字」的題目**（題目給注音，學生要寫國字）：
   - 方框內：彩色國字 + 黑色注音 → 答案是國字
   - 範例：「耶（粉紅色）｜ㄧㄝˊ（黑色）」→ 答案：「耶」
   - 範例：「慈（藍色）｜ㄘˊ（黑色）」→ 答案：「慈」

3. **每題只考一個字或一個注音**（不會考詞語）

✅ 正確判斷邏輯：
- 方框內：「劈（黑色印刷）｜ㄆㄧ（紅色筆跡）」
  → 答案：「ㄆㄧ」（注音）
  → 理由：黑色「劈」是題目提示，紅色「ㄆㄧ」是教師填寫的答案

- 方框內：「貧（藍色筆跡）｜ㄆㄧㄣˊ（黑色印刷）」
  → 答案：「貧」（國字）
  → 理由：黑色「ㄆㄧㄣˊ」是題目提示，藍色「貧」是教師填寫的答案

- 方框內：「____（空白）｜ㄎㄨㄣˋ（黑色印刷）」，左邊有綠色筆跡「困」
  → 答案：「困」（國字）
  → 理由：綠色「困」是教師填寫的答案

- 方框內：「劈（黑色印刷）｜____（空白）」，右邊有紅色筆跡「ㄆㄧ」
  → 答案：「ㄆㄧ」（注音）
  → 理由：紅色「ㄆㄧ」是教師填寫的答案

❌ 錯誤判斷（禁止）：
- ❌ 把黑色印刷文字當成答案
  → 黑色 = 印刷的題目提示，彩色（粉紅/紅/藍/綠等）= 教師填寫的答案
- ❌ 根據題目大標題判斷（如：看到「寫國字」就都抓國字）
  → 每個方框要看實際的彩色筆跡內容是什麼
- ❌ 根據「空白位置」判斷（如：看到左邊空白就判斷要填國字）
  → 要看實際填寫的彩色筆跡內容是國字還是注音
- ❌ 把整個詞當成答案
  → 每題只考一個字或一個注音，不會考詞語

⚠️ 關鍵原則：
1. 只有方框才是題目，每個方框 = 1 題
2. 黑色文字 = 題目提示（印刷的），彩色筆跡 = 答案（教師填的）
3. 看彩色筆跡的「內容」是國字還是注音
4. 每個方框獨立判斷，不受題目大標題影響
5. 每題只考一個字或一個注音（不會考詞語）

【題號編排規則】
- 方框通常在文章中按順序出現
- 題號編排：依照文章的閱讀順序（直排文字：由右往左、由上往下）
- 如果答案卷有明確標示題號（如：1, 2, 3...），就使用圖片上的題號
- 如果沒有明確題號，則按方框出現順序編號：第一個方框 = 題 1、第二個方框 = 題 2...

【相近字 vs 同音字 vs 異音字題型】
- 相近字造詞：字形相似（如：辨/辯、嗇/普）
- 同音字造詞：讀音相同字形不同（如：ㄋㄨㄥˋ：弄/農）
- 異音字造詞：同字不同讀音（如：行（ㄏㄤˊ/ㄒㄧㄥˊ））
- 題組中可能混合三種題型，需逐題判斷

【多步驟題型處理】
⚠️ 識別「多階段作答題」：第一階段是引導，第二階段是主要作答
- 常見標記：「步驟一/二」「第一步/第二步」「先…再…」
- 第一階段通常是：選擇方向、分析、構思、規劃（無固定答案、開放性）
- 第二階段通常是：實際作答、寫出內容（有標準答案）

處理原則：
1. 必須視為 1 題（不可拆成多題）
2. 使用 Type 3（依表現給分）
3. rubricsDimensions 包含各階段，criteria 設定要區分：
   - 第一階段（引導）：criteria 寫「完成選擇即可，無對錯」或類似描述，重點在「是否完成」而非「是否正確」
   - 第二階段（主要作答）：criteria 寫具體評分標準，這才是判斷對錯的重點

範例：
- 題目：「步驟一：選擇面向（位置/動作/想法/對話）；步驟二：根據面向寫出具體內容」
- 應設定為 1 題，rubricsDimensions:
  [
    {"name": "步驟一（選擇面向）", "maxScore": 0 或 1, "criteria": "完成選擇即可，無對錯"},
    {"name": "步驟二（具體內容）", "maxScore": 4-5, "criteria": "符合所選面向的具體描述"}
  ]

【字音辨別造詞題（含注音符號，如：ㄋㄨㄥˋ：____）】
- 判斷為 Type 2
- referenceAnswer 必須包含讀音說明，如「ㄋㄨㄥˋ讀音的詞語」
- acceptableAnswers 列出標準答案中的所有範例詞

【方格框題目識別】
- 定義：連續空白方格（填單字或注音），如：□□□□
- 判定：一行包含連續方格，該行視為 1 題
- 題號生成：有引導文字（如「ㄋㄨㄥˋ：」）就用；無則按順序編號 1,2,3...
- ⚠️ 方格可能是直排（由右往左、由上往下）
- 典型：
  - 注音填寫：「ㄋㄨㄥˋ：□□□□」→ 1 題（Type 2，注音造詞）
  - 生字造詞：「光：□□ □□」→ 1 題（2個詞，Type 2）
`.trim(),
    數學: `
【繪圖題型識別】
識別特徵：在座標平面畫點/線、畫幾何圖形、標註角度等

設定：Type 3，rubricsDimensions 分維度：
1. 圖形正確性：{"name": "圖形正確性", "criteria": "圖形/線條是否正確"}
2. 位置精準度：{"name": "位置精準度", "criteria": "<精準座標>"}
   - 如果題目給定精準座標（如：點 A(3, 5)）→ criteria 必須寫「必須在座標 (3, 5) 附近（允許誤差 ±0.5）」
   - 如果題目只給範圍（如：第一象限）→ criteria 才寫「必須在第一象限內」
3. 標註完整性：{"name": "標註完整性", "criteria": "必要標註是否完整"}

【其他提示】
數值+單位完整，公式需核心部分
`.trim(),
    社會: `
【繪圖/繪標記題型識別】
識別特徵：題目要求在圖上標註位置、畫符號、標記座標等
- 例如：「在地圖上標註颱風位置」「在座標圖中標出指定點」「在時間軸上標記事件」

設定原則：
- 必須使用 Type 3（依表現給分）
- 使用 rubricsDimensions 分成兩個維度：
  1. 符號正確性：{"name": "符號正確性", "maxScore": X, "criteria": "符號是否正確（如颱風符號、星號等）"}
  2. 位置精準度：{"name": "位置精準度", "maxScore": Y, "criteria": "<精準座標要求>"}

🚨 位置精準度的 criteria 設定（最重要！）：
- 優先抓取題目中的**精準座標**（如：東經 151.4°E、北緯 15°N）
- 如果題目明確給定精準座標，criteria 必須寫：
  「必須標註在東經 151.4°E、北緯 15°N 附近（允許誤差 ±1°以內）」
  ❌ 錯誤：「經度 121°E 以東，23.5°N 以北」（範圍過於寬鬆）
  ✅ 正確：「必須標註在東經 151.4°E、北緯 15°N 附近（允許誤差 ±1°以內）」

- 只有當題目**沒有給定精準座標**，只給範圍描述時，才使用範圍：
  例如：題目說「在台灣東部」→ criteria 才可以寫「經度 121°E 以東，緯度 23°N-25°N 之間」

- 提取步驟：
  1. 先仔細閱讀題目文字，找出是否有精準座標（如：151.4°E, 15°N）
  2. 如果有精準座標 → criteria 必須包含精準座標 + 允許合理誤差
  3. 如果沒有精準座標，只有範圍描述 → criteria 才使用範圍

- ⚠️ 符號對 ≠ 答案對，必須同時檢查符號和位置
- ⚠️ 經緯度題型：criteria 必須精準，不可將精準座標改成寬鬆範圍

【其他提示】
專注同音異字（如：九州≠九洲）
`.trim(),
    自然: `
【繪圖/標註題型識別】
識別特徵：繪製實驗裝置圖、標註器官/部位、畫食物鏈/食物網等
設定：Type 3，rubricsDimensions 分維度（圖形正確性、標註正確性、完整性）

【其他提示】
名詞/數值/單位必須完整
`.trim(),
    英語: '拼字/大小寫需精確'
  }

  const domainHint =
    domain && domainHints[domain] ? `\n\n【${domain}提示】\n${domainHints[domain]}` : ''

  return [base, priorHint, domainHint].filter(Boolean).join('\n')
}

/**
 * 後處理：檢查並補充缺失的題目
 */
function fillMissingQuestions(
  result: GradingResult,
  answerKey: AnswerKey
): { result: GradingResult; missingQuestionIds: string[] } {
  const expectedIds = new Set(answerKey.questions.map((q) => q.id))
  const actualIds = new Set((result.details ?? []).map((d) => d.questionId))
  const missingIds = Array.from(expectedIds).filter((id) => !actualIds.has(id))

  if (missingIds.length > 0) {
    console.warn(`⚠️ AI 遺漏了 ${missingIds.length} 題：${missingIds.join(', ')}`)

    const missingDetails = missingIds.map((id) => {
      const question = answerKey.questions.find((q) => q.id === id)
      return {
        questionId: id,
        studentAnswer: '無法辨識',
        score: 0,
        maxScore: question?.maxScore ?? 0,
        isCorrect: false,
        reason: 'AI未能辨識此題答案，已自動標記為0分，需人工複核',
        confidence: 0
      }
    })

    result.details = [...(result.details ?? []), ...missingDetails]

    // ✅ 依 AnswerKey 排序（避免補題跑到最尾端）
    const order = new Map(answerKey.questions.map((q, i) => [q.id, i]))
    result.details.sort((a, b) => {
      const ai = order.get(a.questionId ?? '') ?? 9999
      const bi = order.get(b.questionId ?? '') ?? 9999
      return ai - bi
    })

    // 重新計算 totalScore
    result.totalScore = result.details.reduce((sum, d) => sum + (d.score ?? 0), 0)

    // 標記需要複核
    result.needsReview = true
    result.reviewReasons = [
      ...(result.reviewReasons ?? []),
      `AI 遺漏 ${missingIds.length} 題，已自動補上（${missingIds.join(', ')}）`
    ]
  }

  return { result, missingQuestionIds: missingIds }
}

function isEmptyStudentAnswer(ans?: string) {
  const a = (ans ?? '').trim()
  return a === '未作答' || a === '無法辨識' || a === '未作答/無法辨識'
}

/**
 * 單份作業批改（支援 AnswerKey 與答案卷圖片）
 */
export async function gradeSubmission(
  submissionImage: Blob,
  answerKeyImage: Blob | null,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
): Promise<GradingResult> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  try {
    console.log(`🧠 使用模型 ${currentModelName} 進行批改...`)

    const submissionBase64 = await blobToBase64(submissionImage)
    const submissionMimeType = submissionImage.type || 'image/jpeg'
    const requestParts: GeminiRequestPart[] = []
    const promptSections: string[] = []

    promptSections.push(
      `
你是一位嚴謹、公正的老師，負責批改學生的紙本作業。
本系統會用在各種科目（例如：國語、英文、數學、自然、社會等），
請主要根據「題目文字」與「標準答案」來判斷對錯，不要憑常識亂猜。
`.trim()
    )

    if (answerKey) {
      const questionIds = answerKey.questions.map((q) => q.id).join(', ')
      promptSections.push(
        `
下面是本次作業的標準答案與配分（JSON 格式）：
${JSON.stringify(answerKey)}

【批改流程】
請嚴格依照這份 AnswerKey 逐題批改，請注意「擷取」與「給分」是兩個獨立的步驟：

- 必須輸出所有題號：${questionIds}（共 ${answerKey.questions.length} 題）
- 🚨 重要：即使學生未作答、空白、或無法辨識，也必須輸出該題的記錄
  ⚠️ 但「輸出記錄」≠「生成答案」！
  - ✅ 正確：學生空白 → 輸出 {"questionId": "1", "studentAnswer": "未作答", "score": 0, ...}
  - ❌ 錯誤：學生空白 → 腦補答案並輸出 {"questionId": "1", "studentAnswer": "台北", "score": 0, ...}
  - 空白就是空白，必須如實記錄「未作答」，不可腦補任何內容！
- 題號 id 以 AnswerKey 中的 "id" 為主（例如 "1", "1-1"）。

【步驟 1：擷取（嚴格）】
🚨 最高原則：只抄寫圖片中看得到的筆跡，禁止腦補！
- 無論字跡多潦草或有錯別字，studentAnswer 必須原樣保留學生筆跡與錯誤
- 例如學生寫「苹菓」，就輸出「苹菓」，不可改成「蘋果」
- ⚠️ 學生空白 → 必須輸出「未作答」，絕對不可腦補答案

【步驟 2：給分（寬容）】
- 判斷 isCorrect 時：若包含正確關鍵字，即使字跡不完美或有輕微錯別字，仍可視情況判定為正確
- ⚠️ 重要：寬容只影響 isCorrect/score/reason；不得影響 studentAnswer（studentAnswer 永遠原樣抄寫）

【分層評分規則】
- Type 1（精確）：使用 answer 字段嚴格對比。完全相符 → 滿分；不符 → 0分
- Type 2（模糊）：使用 acceptableAnswers 進行語義匹配。完全/語義相符 → 滿分；部分 → 部分分
  - 字音造詞題：若 referenceAnswer 含讀音說明（如「ㄋㄨㄥˋ讀音」），學生答案必須符合該讀音；讀音錯誤直接 0 分
- Type 3（評價）：使用 rubricsDimensions 多維度評分，逐維度累計總分；若無維度則用 rubric 4級標準
  - ⚠️ 多維度評分時，每個維度的評分標準不同：
    - 「引導/選擇」維度（如：步驟一選擇面向）：看「是否完成」而非「是否正確」，只要學生有做選擇就給分
    - 「主要作答」維度（如：步驟二具體內容）：依據 criteria 判斷內容品質並給分
  - 整題的 isCorrect 判斷：以「主要作答」維度為準，不因「引導階段」未完成而判為錯誤
`.trim()
      )
    } else if (answerKeyImage) {
      const answerKeyBase64 = await blobToBase64(answerKeyImage)
      const answerKeyMimeType = answerKeyImage.type || 'image/jpeg'
      promptSections.push(
        `
第一張圖片是「標準答案／解答本」，第二張圖片是「學生作業」。
請先從標準答案圖片中，為每一題抽取「題號、正確答案、配分（可以合理估計）」，
再根據這些標準答案來批改學生作業。
請不要憑空新增題目，也不要改變題號。

【答案卷識別提示】
⚠️ 教師或書商常用「與題目印刷顏色不同的筆」（如紅筆、藍筆）來標示範例答案
- 優先提取這些與印刷文字顏色不同的手寫筆跡作為標準答案
- 判斷依據：顏色對比、位置（答題區/空格/方框內）、筆觸特徵（手寫 vs 印刷）
`.trim()
      )
      requestParts.push({
        inlineData: { mimeType: answerKeyMimeType, data: answerKeyBase64 }
      })
    } else {
      promptSections.push(
        `
目前沒有提供標準答案，只有學生作業圖片。
請執行以下步驟：
1. 先盡量辨識圖片中的「學生原始筆跡」，填入 studentAnswer（不可修改學生內容；不可摘要/不可改寫/不可補全）。
2. 如需保守推測題意或合理答案，只能寫在 reason（或 mistakes/weaknesses/suggestions），不得寫進 studentAnswer。
`.trim()
      )
    }

    const domainHint = buildGradingDomainSection(options?.domain)
    if (domainHint && options?.domain) {
      promptSections.push(`【${options.domain} 批改要點】\n${domainHint}`.trim())
    }

    if (options?.regrade?.questionIds?.length) {
      const questionIds = options.regrade.questionIds
      const previousDetails = options.regrade.previousDetails ?? []
      const forcedIds = options.regrade.forceUnrecognizableQuestionIds ?? []
      const mode = options.regrade.mode || 'correction'

      if (mode === 'correction') {
        // 人工修正模式：部分題目被標記錯誤
        const markedQuestionsInfo = previousDetails
          .filter((detail) => detail?.questionId && questionIds.includes(detail.questionId))
          .map(
            (detail) =>
              `- 題號 ${detail.questionId}：你之前輸出「${detail?.studentAnswer ?? ''}」（已被老師標記為錯誤）`
          )
          .join('\n')

        const otherQuestionsInfo = previousDetails
          .filter((detail) => detail?.questionId && !questionIds.includes(detail.questionId))
          .map((detail) => `- 題號 ${detail.questionId}：「${detail?.studentAnswer ?? ''}」`)
          .join('\n')

        promptSections.push(
          `
【人工修正模式 - 部分題目需重新檢視】

🔴 以下 ${questionIds.length} 題已被老師標記為錯誤，需要重新仔細檢視圖片：
${markedQuestionsInfo || `題號：${questionIds.join(', ')}`}

✅ 以下題目批改正確，直接使用之前的結果（不要重新批改）：
${otherQuestionsInfo || '（無其他題目）'}

重新批改要求：
1. 標記錯誤的題目：完全忘記之前的判斷，重新從圖片仔細檢視
   - 仔細確認學生筆跡的每一筆畫
   - 確認題目要求（例如：考國字還是注音、選擇題要看打勾位置）
   - 不要再給出和之前一樣的答案（除非你非常確定之前是對的）

2. 其他題目：直接照抄之前的 studentAnswer，不需要重新辨識

3. 必須輸出所有題目（包括正確的和標記錯誤的）

⚠️ 重新批改 ≠ 優化答案
- 「重新檢視」= 重新看圖片上「實際寫了什麼字」，而非「重新理解學生想表達什麼」
- 即使重新批改，studentAnswer 仍必須逐字逐畫對應圖片中的學生筆跡
- 禁止為了「修正錯誤」而優化、補全、或改寫學生答案
- 例如：學生寫「不要讓媽媽著涼」→ 即使第一次漏抓「不」字，重新批改也只能輸出圖片上看得到的文字，不可腦補成「幫媽媽準備壁爐」

❌ 嚴禁：
- 對於標記錯誤的題目：輸出和之前完全相同的內容（這代表你沒有重新思考）
- 對於標記錯誤的題目：為了「合理化」而改寫學生答案（例如：把「不要」改成「要」或腦補成其他內容）
- 對於正確的題目：改動之前的 studentAnswer（這些題目不需要重新批改）
`.trim()
        )
      } else if (mode === 'missing') {
        // 自動補漏模式：第一次完全遺漏的題目
        promptSections.push(
          `
【補漏模式 - AI遺漏題目重新辨識】
第一次批改時你遺漏了以下題目，現在請補上：${questionIds.join(', ')}

要求：
1. 只輸出這 ${questionIds.length} 題（其他題目已經批改過了）
2. 每題都必須有 studentAnswer（即使是「未作答」或「無法辨識」）
3. 不要輸出其他題號

⚠️ 重要：補漏 ≠ 優化答案
- studentAnswer 必須逐字逐畫對應圖片中的學生筆跡，不可優化、補全、或改寫
- 辨識的是「圖片上實際寫了什麼」，而非「學生想表達什麼」
`.trim()
        )
      }

      // 強制無法辨識（優先級最高）
      if (forcedIds.length > 0) {
        promptSections.push(
          `
【強制標記】
以下題目圖片品質太差或筆跡無法辨識，請直接輸出：
${forcedIds.map((id) => `- 題號 ${id}：studentAnswer="無法辨識", score=0, confidence=0`).join('\n')}
`.trim()
        )
      }
    }

    const recentCorrections = await getRecentAnswerExtractionCorrections(options?.domain, 5)
    if (recentCorrections.length > 0) {
      const lines = recentCorrections
        .map((item) => {
          const aiAnswer = item.aiStudentAnswer || '—'
          return `- 題目 ${item.questionId}：AI「${aiAnswer}」→ 正確「${item.correctedStudentAnswer}」`
        })
        .join('\n')

      promptSections.push(`【近期 AI 擷取錯誤參考】\n${lines}`.trim())
    }

    if (options?.strict) {
      promptSections.push(
        `
【嚴謹模式】
- 若題意、字跡或答案不清楚，請判為不給分，並在 reason 說明原因
- 不要推測或補寫；只根據題目文字與標準答案判斷
- 答案不完整或缺少關鍵字/數值時，視為錯誤
- 請再次檢查每題得分與 totalScore 是否一致
`.trim()
      )
    }

    promptSections.push(
      `
【學生答案擷取規則（機械式抄寫）】
核心原則：像 OCR 機器一樣原樣輸出，禁止任何形式的修正或推測。

✅ DO
- 學生寫「光和作用」→ 輸出「光和作用」
- 學生寫「辯別」（錯字）→ 輸出「辯別」（不修正）
- 學生寫「台北」→ 輸出「台北」（不改成「臺北」）
- 學生只填「光合」→ 輸出「光合」（不補全為「光合作用」）
- 筆跡模糊但可辨「光舎」→ 輸出「光舎」（不改成「光合」）

❌ DON'T
- 禁止依上下文推測缺字
- 禁止修正錯字
- 禁止補全答案
- 禁止同義替換
- 禁止為了「合理化」而改寫學生答案
  - 例如：學生寫「不要讓媽媽著涼」，即使漏抓了「不」字，也不可腦補成「幫媽媽準備壁爐」
  - 重新檢視 = 重新看圖片上實際寫了什麼字，而非重新理解學生想表達什麼

🔍 唯一例外
- 完全無法辨識的字跡（墨水塗抹、筆劃模糊）→ 用「[?]」標記
- 例：「光[?]作用」
`.trim()
    )

    promptSections.push(
      `
【空白答案處理（最高優先級：絕對禁止臆測）】
⚠️ 核心原則：學生漏寫 = 未作答，不可腦補！

✅ 正確處理
- 完全未作答（空白方格/空白行）→ 輸出「未作答」
- 只寫了部分 → 輸出可見部分（不補全）
- 無意義符號（如 ???）→ 原樣輸出

❌ 嚴格禁止
- 禁止為空白生成任何內容
- 禁止推測「學生可能想寫什麼」
- 禁止依據題目、標準答案、或常識來補全空白
- 禁止因為「這題很簡單」就腦補答案
- 禁止因為「其他學生都會寫」就腦補答案

🚨 常見錯誤範例（絕對禁止）
填空題：
- 題目問「1+1=?」，學生空白 → ❌ 不可輸出「2」，必須輸出「未作答」
- 題目問「台灣首都」，學生空白 → ❌ 不可輸出「台北」，必須輸出「未作答」
- 造詞題空白 → ❌ 不可依據讀音或部首腦補詞語，必須輸出「未作答」

勾選題（最容易誤判！）：
🚨 關鍵：只看「方框□內」是否有標記，不要被題目的其他符號誤導！

- 題目：「□A ↑  □B ↖  □C →  □D ↓」，四個方框內都沒有打勾/圈選/劃記
  → ❌ 不可腦補「A」或任何選項，必須輸出「未作答」
  → ❌ 箭頭（↑ ↖ → ↓）是題目的一部分，不是學生的作答標記！

- 題目：「□ A. 亞洲  □ B. 歐洲  □ C. 非洲」，三個方框內都是空的
  → ❌ 不可腦補選項，必須輸出「未作答」
  → ❌ 選項文字（A. 亞洲）是題目的一部分，不是學生的作答！

判斷標準（嚴格執行）：
  - ✅ 正確：方框□內有打勾 ✓、圈選 ○、劃記 ×、填滿 ■ → 輸出該選項（如「A」「B」）
  - ✅ 正確：方框□內完全空白，沒有任何標記 → 輸出「未作答」
  - ❌ 錯誤：看到箭頭（↑ ↖ → ↓）就以為有作答 → 箭頭是題目的一部分！
  - ❌ 錯誤：看到選項文字（A、B、亞洲、歐洲）就以為有作答 → 選項文字是題目的一部分！
  - ⚠️ 即使根據題目和答案可以推測出正確選項，也不可腦補！

檢查重點：
  1. 只關注「方框□內部」是否有學生的筆跡標記
  2. 箭頭、選項編號、選項文字都不算學生作答
  3. 如果方框內是空白的 = 未作答

繪圖題：
- 題目：「在地圖上標註颱風位置」，圖上完全沒有任何手繪標記/符號/筆跡
  → ❌ 不可腦補「已標註在某位置」，必須輸出「未作答」
- 題目：「畫出三角形」，圖上沒有任何三角形或線條
  → ❌ 不可腦補「已畫三角形」，必須輸出「未作答」
- 判斷標準：
  - 圖上有手繪標記/符號/線條 → 描述學生實際畫了什麼
  - 圖上完全沒有任何手繪痕跡 → 輸出「未作答」
  - ⚠️ 即使圖片本身有印刷內容（地圖、座標軸等），只要沒有學生手繪標記，就是未作答！

判斷標準（嚴格執行）：
- 填寫區域有筆跡 → 抄寫筆跡內容
- 填寫區域無筆跡/完全空白 → 輸出「未作答」（不可有任何其他內容）
- 有筆跡但完全看不出是什麼 → 輸出「無法辨識」
- 勾選題：方框□內沒有標記（即使有箭頭等符號）→ 輸出「未作答」
- 繪圖題：圖上沒有手繪痕跡（即使有印刷內容）→ 輸出「未作答」

⚠️ 驗證方法：如果你輸出的 studentAnswer 無法在圖片中找到對應的學生筆跡，那就是腦補！
`.trim()
    )

    promptSections.push(
      `
【低成就學生答案處理】
核心原則：保真 > 優化，寧可記錄錯誤，不可美化答案

✅ 正確
- 原樣輸出，不擴寫、不書面化、不補完、不修正
`.trim()
    )

    promptSections.push(
      `
【每題獨立判斷原則（防止連鎖腦補）】
🚨 嚴重警告：前一題的判斷不可影響後續題目！

核心原則：
- 每題都必須獨立從圖片辨識，不受其他題目影響
- 前一題有內容 ≠ 後一題也該有內容
- 前一題空白 ≠ 後一題也該空白
- 每題的 studentAnswer 都必須能在圖片中獨立找到對應的學生筆跡

🚨 常見連鎖腦補錯誤（絕對禁止）
- 第1題腦補了「光合作用」→ 第2題也跟著腦補 ❌
- 第1題有寫答案 → 推測第2題「應該也有寫」而腦補 ❌
- 看到標準答案有5題 → 強迫自己為每題都生成內容 ❌
- 題組中前幾題有答案 → 推測後面的題目「不可能空白」而腦補 ❌

✅ 正確做法
- 第1題：圖片有筆跡 → 輸出筆跡內容
- 第2題：圖片無筆跡 → 輸出「未作答」（即使第1題有寫）
- 第3題：圖片有筆跡 → 輸出筆跡內容（即使第2題空白）
- 獨立判斷，互不影響

⚠️ 自我檢查：批改完成後，檢查是否有「連續多題都有內容，沒有任何未作答」的情況。
如果出現這種情況，很可能是發生了連鎖腦補，請重新逐題檢視圖片。
`.trim()
    )

    promptSections.push(
      `
【單題擷取信心率（0-100）】
- 定義：只反映「擷取時的猶豫程度」（字跡清晰度），與答案正確性無關
- 100：唯一解釋，不需推測
- 80-99：小雜訊但可排除
- 60-79：有兩個以上候選，需要比筆劃
- 0-59：幾乎在猜

常見誤區：
- ❌ 看到錯字就給低信心
- ✅ 字很清楚但答案錯，也應給高信心
`.trim()
    )

    promptSections.push(
      `
【最終硬規則（輸出前自我檢查）】
在輸出 JSON 之前，必須逐題檢查以下項目：

1. 筆跡對應檢查：
   - ✅ 每個 studentAnswer 都必須能在圖片中逐字逐畫對應到學生筆跡
   - ❌ 如果圖片中找不到對應筆跡 → 那就是腦補，必須改為「未作答」

2. 空白腦補檢查：
   - ✅ 填寫區域無筆跡 → 必須輸出「未作答」
   - ❌ 絕不可依據題目、標準答案、常識來為空白生成內容

3. 連鎖腦補檢查：
   - ✅ 每題獨立判斷，互不影響
   - ❌ 不可因為前一題有內容就推測後一題也該有內容
   - ⚠️ 檢查是否有「連續多題都有內容，沒有任何未作答」→ 可能是連鎖腦補

4. 修正限制：
   - ✅ 若你想「修正錯字、補全、換詞、變通語序、抓重點」→ 一律只能寫在 reason
   - ❌ 不得改動 studentAnswer

回傳純 JSON：
{
  "totalScore": 整數,
  "details": [
    {
      "questionId": 題號,
      "detectedType": 1|2|3,
      "studentAnswer": 學生答案,
      "isCorrect": true/false,
      "score": 得分,
      "maxScore": 滿分,
      "reason": 簡短理由,
      "confidence": 0-100,
      "matchingDetails": {Type 2: {matchedAnswer, matchType: exact|synonym|keyword}},
      "rubricScores": {Type 3: [{dimension, score, maxScore}]}
    }
  ],
  "mistakes": [{id, question, reason}],
  "weaknesses": [概念],
  "suggestions": [建議]
}

若為「再次批改模式」，details 只回傳被要求重新批改的題號。
`.trim()
    )

    const prompt = promptSections.join('\n\n')
    requestParts.push(prompt)
    requestParts.push({
      inlineData: { mimeType: submissionMimeType, data: submissionBase64 }
    })

    const text = (await generateGeminiText(currentModelName, requestParts))
      .replace(/```json|```/g, '')
      .trim()

    let parsed = JSON.parse(text) as GradingResult

    // 硬性覆蓋：強制無法辨識的題目
    if (options?.regrade?.forceUnrecognizableQuestionIds?.length && parsed.details) {
      const forcedIds = new Set(options.regrade.forceUnrecognizableQuestionIds)
      parsed.details = parsed.details.map((detail) => {
        if (forcedIds.has(detail.questionId ?? '')) {
          return {
            ...detail,
            studentAnswer: '無法辨識',
            score: 0,
            isCorrect: false,
            confidence: 0,
            reason: '圖片品質不佳或筆跡無法辨識'
          }
        }
        return detail
      })
    }

    // 檢查：correction 模式下，被標記的題目是否真的重新思考了
    if (
      options?.regrade?.mode === 'correction' &&
      options.regrade.questionIds &&
      options.regrade.previousDetails &&
      parsed.details
    ) {
      const markedIds = new Set(options.regrade.questionIds)
      const previousMap = new Map(
        options.regrade.previousDetails.map((d) => [d.questionId, d.studentAnswer?.trim()])
      )
      const sameAnswerIds: string[] = []
      const changedOtherIds: string[] = []

      parsed.details.forEach((detail) => {
        const qid = detail.questionId ?? ''
        const prevAnswer = previousMap.get(qid)
        const currAnswer = detail.studentAnswer?.trim()

        if (markedIds.has(qid)) {
          // 被標記的題目：應該要不一樣（除非 AI 真的確定之前是對的）
          if (prevAnswer && currAnswer && prevAnswer === currAnswer) {
            sameAnswerIds.push(qid)
          }
        } else {
          // 沒被標記的題目：應該要一樣（直接照抄）
          if (prevAnswer && currAnswer && prevAnswer !== currAnswer) {
            changedOtherIds.push(qid)
          }
        }
      })

      if (sameAnswerIds.length > 0) {
        console.warn(
          `⚠️ 被標記錯誤的題目，AI 重新批改後仍給出相同答案：${sameAnswerIds.join(', ')}`
        )
        parsed.needsReview = true
        parsed.reviewReasons = [
          ...(parsed.reviewReasons ?? []),
          `標記題目 AI 答案未改變（${sameAnswerIds.join(', ')}），可能需人工介入`
        ]
      }

      if (changedOtherIds.length > 0) {
        console.warn(`⚠️ 未標記的題目被 AI 改動了：${changedOtherIds.join(', ')}，已自動還原`)
        // 自動還原未標記題目的答案
        parsed.details = parsed.details.map((detail) => {
          const qid = detail.questionId ?? ''
          if (changedOtherIds.includes(qid)) {
            const prev = options.regrade!.previousDetails!.find((d) => d.questionId === qid)
            if (prev && prev.studentAnswer !== undefined) {
              return {
                ...detail,
                studentAnswer: prev.studentAnswer,
                score: prev.score ?? 0,
                isCorrect: prev.isCorrect ?? false,
                confidence: prev.confidence ?? 0,
                reason: prev.reason ?? ''
              }
            }
          }
          return detail
        })
      }
    }

    const reviewReasons: string[] = [...(parsed.reviewReasons ?? [])]
    if (!parsed.details || !Array.isArray(parsed.details)) {
      reviewReasons.push('缺少逐題詳解')
    }
    if (parsed.totalScore === 0 && (parsed.details?.length ?? 0) === 0) {
      reviewReasons.push('總分為 0 且缺少逐題詳解，請複核')
    }
    if ((parsed.mistakes?.length ?? 0) === 0 && (parsed.details?.length ?? 0) === 0) {
      reviewReasons.push('未偵測到題目或錯誤，請確認解析是否成功')
    }

    const textBlob = [
      ...(parsed.feedback ?? []),
      ...(parsed.suggestions ?? []),
      ...(parsed.weaknesses ?? [])
    ]
      .join(' ')
      .toLowerCase()

    if (/[?？]|模糊|無法|不確定|看不清楚|not sure|uncertain/.test(textBlob)) {
      reviewReasons.push('模型信心不明或表述不確定')
    }

    parsed.needsReview = reviewReasons.length > 0
    parsed.reviewReasons = reviewReasons

    // 步驟 2：後處理補漏（如果有 AnswerKey）
    let missingQuestionIds: string[] = []
    if (answerKey && !options?.regrade?.mode) {
      const fillResult = fillMissingQuestions(parsed, answerKey)
      parsed = fillResult.result
      missingQuestionIds = fillResult.missingQuestionIds
    }

    // 步驟 3：自動重試缺失的題目（除非明確跳過）
    if (missingQuestionIds.length > 0 && !options?.skipMissingRetry && !options?.regrade?.mode) {
      console.log(`🔄 自動重試批改缺失的 ${missingQuestionIds.length} 題...`)

      try {
        const retryResult = await gradeSubmission(submissionImage, answerKeyImage, answerKey, {
          ...options,
          skipMissingRetry: true,
          regrade: {
            questionIds: missingQuestionIds,
            previousDetails: parsed.details,
            mode: 'missing'
          }
        })

        if (retryResult.details && Array.isArray(retryResult.details)) {
          const retryDetailsMap = new Map(retryResult.details.map((d) => [d.questionId, d]))

          parsed.details = (parsed.details ?? []).map((detail) => {
            const qid = detail.questionId ?? ''
            if (missingQuestionIds.includes(qid) && retryDetailsMap.has(qid)) {
              const retryDetail = retryDetailsMap.get(qid)
              // ✅ 只有重試不是空答案才替換
              if (retryDetail && !isEmptyStudentAnswer(retryDetail.studentAnswer)) {
                console.log(`✅ 重試成功辨識題目 ${qid}`)
                return retryDetail
              }
            }
            return detail
          })

          parsed.totalScore = (parsed.details ?? []).reduce((sum, d) => sum + (d.score ?? 0), 0)

          const stillMissingIds = (parsed.details ?? [])
            .filter(
              (d) => missingQuestionIds.includes(d.questionId ?? '') && isEmptyStudentAnswer(d.studentAnswer)
            )
            .map((d) => d.questionId)

          if (stillMissingIds.length < missingQuestionIds.length) {
            parsed.reviewReasons = (parsed.reviewReasons ?? []).map((reason) =>
              reason.includes('AI 遺漏')
                ? `AI 遺漏 ${missingQuestionIds.length} 題，重試後仍有 ${stillMissingIds.length} 題無法辨識（${stillMissingIds.join(
                    ', '
                  )}）`
                : reason
            )
          }
        }
      } catch (retryError) {
        console.warn('⚠️ 重試批改失敗:', retryError)
      }
    }

    return parsed
  } catch (error) {
    console.error(`❌ ${currentModelName} 批改失敗:`, error)

    if ((error as any).message?.includes('404') || (error as any).message?.includes('not found')) {
      return {
        totalScore: 0,
        mistakes: [],
        weaknesses: [],
        suggestions: [],
        feedback: [`模型 ${currentModelName} 不存在或不可用`]
      }
    }

    return {
      totalScore: 0,
      mistakes: [],
      weaknesses: [],
      suggestions: [],
      feedback: ['系統錯誤', (error as Error).message]
    }
  }
}

/**
 * 批改多份作業（一鍵批改）
 */
export async function gradeMultipleSubmissions(
  submissions: Submission[],
  answerKeyBlob: Blob | null,
  onProgress: (current: number, total: number) => void,
  answerKey?: AnswerKey,
  options?: GradeSubmissionOptions
) {
  console.log(`📝 開始批量批改 ${submissions.length} 份作業`)

  const workingModel = await diagnoseModels()
  if (workingModel) {
    currentModelName = workingModel
    console.log(`✅ 使用模型: ${workingModel}`)
  }

  let successCount = 0
  let failCount = 0

  for (let i = 0; i < submissions.length; i++) {
    const sub = submissions[i]
    console.log(`\n📄 批改第 ${i + 1}/${submissions.length} 份作業: ${sub.id}`)
    onProgress(i + 1, submissions.length)

    try {
      if (!sub.imageBlob) {
        console.warn(`⚠️ 跳過沒有 imageBlob 的作業: ${sub.id}`)
        failCount++
        continue
      }

      console.log(`🔍 開始批改作業 ${sub.id}...`)
      const result = await gradeSubmission(sub.imageBlob, answerKeyBlob, answerKey, options)
      console.log(`📊 批改結果: 得分 ${result.totalScore}`)

      console.log(`💾 儲存批改結果到資料庫...`)
      await db.submissions.update(sub.id!, {
        status: 'graded',
        score: result.totalScore,
        gradingResult: result,
        gradedAt: Date.now(),
        imageBlob: sub.imageBlob,
        imageBase64: sub.imageBase64
      })

      successCount++
      console.log(
        `✅ 批改成功 (${i + 1}/${submissions.length}): ${sub.id}, 得分: ${result.totalScore}, 累計成功: ${successCount}`
      )
    } catch (e) {
      failCount++
      console.error(`❌ 批改作業失敗 (${i + 1}/${submissions.length}): ${sub.id}`, e)
      console.error(`   累計失敗: ${failCount}`)
    }

    if (i < submissions.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log(`\n🏁 批改完成！總計: ${submissions.length}, 成功: ${successCount}, 失敗: ${failCount}`)
  console.log(`📤 返回結果: { successCount: ${successCount}, failCount: ${failCount} }`)

  return { successCount, failCount }
}

/**
 * 從答案卷圖片中抽取 AnswerKey（給 AssignmentSetup 使用）
 */
export async function extractAnswerKeyFromImage(
  answerSheetImage: Blob,
  opts?: ExtractAnswerKeyOptions
): Promise<AnswerKey> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  console.log('🧾 開始從答案卷圖片抽取 AnswerKey...')
  const imageBase64 = await blobToBase64(answerSheetImage)
  const mimeType = answerSheetImage.type || 'image/jpeg'

  let priorWeightTypes = opts?.priorWeightTypes
  if (!priorWeightTypes && opts?.allowedQuestionTypes && opts.allowedQuestionTypes.length > 0) {
    const { migrateLegacyQuestionType } = await import('./db')
    priorWeightTypes = Array.from(new Set(opts.allowedQuestionTypes.map(migrateLegacyQuestionType))).sort() as import(
      './db'
    ).QuestionCategoryType[]
    console.log('📦 已自動遷移 allowedQuestionTypes 為 priorWeightTypes:', priorWeightTypes)
  }

  const prompt = buildAnswerKeyPrompt(opts?.domain, priorWeightTypes)

  const text = (await generateGeminiText(currentModelName, [
    prompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ]))
    .replace(/```json|```/g, '')
    .trim()

  return JSON.parse(text) as AnswerKey
}

/**
 * 從多張答案卷圖片中抽取 AnswerKey（一次上傳多張圖片）
 * 支持答案卷跨多頁的情況
 */
export async function extractAnswerKeyFromImages(
  answerSheetImages: Blob[],
  opts?: ExtractAnswerKeyOptions
): Promise<AnswerKey> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')
  if (answerSheetImages.length === 0) throw new Error('至少需要提供一張圖片')

  console.log(`🧾 開始從 ${answerSheetImages.length} 張答案卷圖片抽取 AnswerKey...`)

  let priorWeightTypes = opts?.priorWeightTypes
  if (!priorWeightTypes && opts?.allowedQuestionTypes && opts.allowedQuestionTypes.length > 0) {
    const { migrateLegacyQuestionType } = await import('./db')
    priorWeightTypes = Array.from(new Set(opts.allowedQuestionTypes.map(migrateLegacyQuestionType))).sort() as import(
      './db'
    ).QuestionCategoryType[]
    console.log('📦 已自動遷移 allowedQuestionTypes 為 priorWeightTypes:', priorWeightTypes)
  }

  const prompt = buildAnswerKeyPrompt(opts?.domain, priorWeightTypes)

  // 多圖片提示增強
  const multiImagePrompt = `
${prompt}

【多張圖片處理】
- 你會收到 ${answerSheetImages.length} 張答案卷圖片
- 這些圖片可能是同一份作業的不同頁面
- 請從所有圖片中提取題目，並合併成一個完整的 AnswerKey
- 題號必須連續且不重複（如果多張圖片有重複題號，請保留最完整的版本）
- totalScore 是所有圖片中所有題目的 maxScore 總和
`.trim()

  // 準備多圖片請求
  const requestParts: GeminiRequestPart[] = [multiImagePrompt]

  // 添加所有圖片
  for (let i = 0; i < answerSheetImages.length; i++) {
    const imageBase64 = await blobToBase64(answerSheetImages[i])
    const mimeType = answerSheetImages[i].type || 'image/jpeg'
    requestParts.push({
      inlineData: { mimeType, data: imageBase64 }
    })
    console.log(`  📄 已添加第 ${i + 1} 張圖片`)
  }

  console.log('🤖 發送請求到 Gemini API...')
  const text = (await generateGeminiText(currentModelName, requestParts))
    .replace(/```json|```/g, '')
    .trim()

  const result = JSON.parse(text) as AnswerKey
  console.log(`✅ 成功提取 ${result.questions.length} 題，總分 ${result.totalScore}`)

  return result
}

/**
 * 重新分析被標記的題目
 * 只針對 needsReanalysis === true 的題目重新分析
 */
export async function reanalyzeQuestions(
  answerSheetImage: Blob,
  markedQuestions: import('./db').AnswerKeyQuestion[],
  domain?: string,
  priorWeightTypes?: import('./db').QuestionCategoryType[]
): Promise<import('./db').AnswerKeyQuestion[]> {
  if (!isGeminiAvailable) throw new Error('Gemini 服務未設定')

  if (markedQuestions.length === 0) {
    return []
  }

  console.log(`🔄 重新分析 ${markedQuestions.length} 題...`)

  const imageBase64 = await blobToBase64(answerSheetImage)
  const mimeType = answerSheetImage.type || 'image/jpeg'

  const questionIds = markedQuestions.map((q) => q.id).join(', ')
  const basePrompt = buildAnswerKeyPrompt(domain, priorWeightTypes)

  const reanalyzePrompt = `
${basePrompt}

【重新分析模式 - 強制完整輸出】
必須重新分析以下題號：${questionIds}（共 ${markedQuestions.length} 題）

⚠️ 強制要求：
- 必須輸出所有 ${markedQuestions.length} 題的完整資料
- 即使某題在圖片中看不清楚，也必須輸出該題的記錄
  ⚠️ 但「輸出記錄」≠「腦補答案」！
  - ✅ 正確：看不清楚 → 在 referenceAnswer 標記「圖片中無法辨識」
  - ❌ 錯誤：看不清楚 → 腦補一個答案
- 題號順序可以不同，但數量必須完全一致
- 禁止遺漏任何題號

其他題目請忽略，不要輸出。

請仔細辨識這些題目的內容，重新判斷類型並提取答案。
`.trim()

  const text = (await generateGeminiText(currentModelName, [
    reanalyzePrompt,
    { inlineData: { mimeType, data: imageBase64 } }
  ]))
    .replace(/```json|```/g, '')
    .trim()

  const result = JSON.parse(text) as import('./db').AnswerKey

  const requestedIds = markedQuestions.map((q) => q.id)
  const returnedIds = result.questions.map((q) => q.id)
  const missingIds = requestedIds.filter((id) => !returnedIds.includes(id))

  if (missingIds.length > 0) {
    console.warn(`⚠️ AI 遺漏了 ${missingIds.length} 題：${missingIds.join(', ')}`)
    console.warn(`要求分析：${requestedIds.join(', ')}`)
    console.warn(`實際回傳：${returnedIds.join(', ')}`)

    const placeholderQuestions = missingIds.map((id) => {
      const originalQuestion = markedQuestions.find((q) => q.id === id)!
      return {
        id,
        type: 2 as import('./db').QuestionCategoryType,
        maxScore: originalQuestion.maxScore || 0,
        referenceAnswer: 'AI 無法從圖片中重新辨識此題，請手動編輯',
        acceptableAnswers: [],
        needsReanalysis: true
      }
    })

    result.questions.push(...placeholderQuestions)
    console.log(`🔧 已自動為遺漏的 ${missingIds.length} 題創建佔位項（需手動編輯）`)
  }

  console.log(`✅ 重新分析完成，共 ${result.questions.length} 題（要求 ${markedQuestions.length} 題）`)

  return result.questions
}
