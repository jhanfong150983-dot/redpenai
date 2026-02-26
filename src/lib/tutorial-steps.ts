/**
 * 引导式教学步骤定义
 */

export interface TutorialStep {
  id: string
  title: string
  content: string
  targetSelector: string // CSS 选择器定位目标元素
  position: 'top' | 'bottom' | 'left' | 'right' | 'center'
  highlightElement?: boolean // 是否高亮显示目标元素
  animation?: {
    type: 'drag-drop' // 动画类型
    fromSelector: string // 起始元素选择器
    toSelector: string // 目标元素选择器
  }
}

export interface TutorialFlow {
  id: string
  name: string
  steps: TutorialStep[]
}

/**
 * 班级管理教学流程（7 步）
 */
const classroomFlow: TutorialFlow = {
  id: 'classroom',
  name: '班級管理教學',
  steps: [
    {
      id: 'welcome',
      title: '歡迎使用班級管理',
      content: '這裡可以管理您的所有班級，包含建立、編輯、分類和刪除班級。讓我們開始快速導覽！',
      targetSelector: 'body',
      position: 'center',
      highlightElement: false
    },
    {
      id: 'create-classroom',
      title: '新增班級',
      content: '點擊卡片列表最下方的「新增班級」按鈕，即可快速建立新班級。您可以輸入班級名稱、學生人數，和直接匯入學生名單。',
      targetSelector: '[data-tutorial="create-classroom"]',
      position: 'top',
      highlightElement: true
    },
    {
      id: 'create-classroom-modal',
      title: '填寫班級資訊',
      content: '這裡會跳出新增班級視窗，接著我們依序填寫。',
      targetSelector: '[data-tutorial="create-classroom-modal"]',
      position: 'center',
      highlightElement: true
    },
    {
      id: 'classroom-name',
      title: '班級名稱',
      content: '先輸入班級名稱，例如「七年甲班」。',
      targetSelector: '[data-tutorial="classroom-name"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'classroom-student-count',
      title: '學生人數（自動產生）',
      content: '如果不匯入名單，就用這裡設定學生人數，系統會自動產生座號。',
      targetSelector: '[data-tutorial="classroom-student-count"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'classroom-import',
      title: '匯入學生名單（可選）',
      content: '也可以從 Excel 貼上座號與姓名，系統會以匯入為主。',
      targetSelector: '[data-tutorial="classroom-import"]',
      position: 'top',
      highlightElement: true
    },
    {
      id: 'classroom-submit',
      title: '建立班級',
      content: '資料填好後，按「建立班級」完成新增。',
      targetSelector: '[data-tutorial="classroom-submit"]',
      position: 'top',
      highlightElement: true
    },
    {
      id: 'create-folder',
      title: '建立資料夾',
      content: '點擊「新建資料夾」按鈕可以建立分類資料夾，例如「112學年度」、「七年級」等，幫助您組織管理班級。',
      targetSelector: '[data-tutorial="create-folder"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'drag-drop',
      title: '拖曳分類',
      content: '您可以直接拖曳左側的班級卡片到右側的資料夾中，輕鬆完成分類。也可以拖曳到「全部」來取消分類。',
      targetSelector: '.space-y-2',
      position: 'right',
      highlightElement: false,
      animation: {
        type: 'drag-drop',
        fromSelector: '[data-tutorial-card="first-classroom-card"]',
        toSelector: '[data-tutorial-folder="first-folder"]'
      }
    },
    {
      id: 'sort-options',
      title: '排序功能',
      content: '使用右上角的排序選單，可以依建立時間或名稱筆畫順序排列班級和資料夾，方便您快速找到需要的班級。',
      targetSelector: 'select[aria-label="排序方式"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'edit-classroom',
      title: '編輯班級',
      content: '點擊班級名稱旁的筆圖標可以修改班級名稱。所有修改都會自動同步到雲端。',
      targetSelector: '[title="更改名稱"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'edit-students',
      title: '編輯學生名單',
      content: '點擊人頭圖標可以編輯學生名單。所有修改都會自動同步到雲端。',
      targetSelector: '[title="編輯學生名單"]',
      position: 'bottom',
      highlightElement: true
    },
    {
      id: 'complete',
      title: '完成！',
      content: '您已經掌握班級管理的基本操作了！現在可以開始建立您的班級，開啟教學管理之旅。',
      targetSelector: 'body',
      position: 'center',
      highlightElement: false
    }
  ]
}

const assignmentFlow: TutorialFlow = {
  id: 'assignment',
  name: '作業管理教學',
  steps: [
    {
      id: 'welcome',
      title: '歡迎使用作業管理',
      content: '這裡可以為班級建立作業、設定標準答案、管理作業分類。讓我們開始導覽！',
      targetSelector: 'body',
      position: 'center',
      highlightElement: false
    },

    // 1) 班級選擇
    {
      id: 'select-classroom',
      title: '選擇班級',
      content: '首先選擇要管理作業的班級。每個班級都有獨立的作業列表和資料夾。',
      targetSelector: '[data-tutorial="select-classroom"]',
      position: 'bottom',
      highlightElement: true
    },

    // 2) 新增作業按鈕
    {
      id: 'create-assignment',
      title: '新增作業',
      content: '點擊「新增作業」按鈕可以建立新作業。',
      targetSelector: '[data-tutorial="create-assignment"]',
      position: 'top',
      highlightElement: true
    },

    // 3) 新增作業 modal（外框）
    {
      id: 'create-assignment-modal',
      title: '新增作業視窗',
      content: '這裡會跳出新增作業視窗，接著我們依序填寫作業資訊與上傳標準答案。',
      targetSelector: '[data-tutorial="create-assignment-modal"]',
      position: 'center',
      highlightElement: true
    },

    // 3-1) 指派班級
    {
      id: 'assignment-classroom',
      title: '指派班級',
      content: '選擇這份作業屬於哪一個班級。',
      targetSelector: '[data-tutorial="assignment-classroom"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-2) 作業標題
    {
      id: 'assignment-title',
      title: '作業標題',
      content: '輸入作業名稱，例如「數學作業第 1 份」。',
      targetSelector: '[data-tutorial="assignment-title"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-3) 作業領域
    {
      id: 'assignment-domain',
      title: '作業領域',
      content: '選擇作業科目/領域，AI 解析答案時會參考此資訊。',
      targetSelector: '[data-tutorial="assignment-domain"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-4) Prior Weight
    {
      id: 'assignment-prior-weight',
      title: '主要題型（Prior Weight）',
      content: '選擇這份作業大部分題型。先選的優先級較高，AI 會參考這個順序判斷題型。',
      targetSelector: '[data-tutorial="assignment-prior-weight"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-5) 每生頁數
    {
      id: 'assignment-total-pages',
      title: '每生頁數',
      content: '設定每位學生的頁數，用於拍照/批次分割處理。',
      targetSelector: '[data-tutorial="assignment-total-pages"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-6) 上傳答案卷
    {
      id: 'assignment-upload-answerkey',
      title: '上傳答案卷',
      content: '上傳 PDF 或圖片（可多檔）。建議一次 1–2 個檔案，辨識品質較好。',
      targetSelector: '[data-tutorial="assignment-upload-answerkey"]',
      position: 'bottom',
      highlightElement: true
    },

    // 3-7) AI 解析
    {
      id: 'assignment-ai-extract',
      title: '使用 AI 解析',
      content: '點擊後會解析並合併標準答案，產生下方的「預覽答案」。',
      targetSelector: '[data-tutorial="assignment-ai-extract"]',
      position: 'top',
      highlightElement: true
    },

    // 3-8) 預覽答案
    {
      id: 'assignment-preview-answerkey',
      title: '預覽答案',
      content: '這裡可以確認題號、題型、配分、答案與可接受答案變體。',
      targetSelector: '[data-tutorial="assignment-preview-answerkey"]',
      position: 'left',
      highlightElement: true
    },

    // 3-9) 建立作業
    {
      id: 'assignment-submit',
      title: '建立作業',
      content: '確認資料無誤後點擊建立，作業就會加入列表。',
      targetSelector: '[data-tutorial="assignment-submit"]',
      position: 'top',
      highlightElement: true
    },

    // 4) 新建資料夾
    {
      id: 'create-folder',
      title: '建立作業資料夾',
      content: '點擊「新建資料夾」建立分類，例如：段考、小考、作業等。',
      targetSelector: '[data-tutorial="create-folder"]',
      position: 'bottom',
      highlightElement: true
    },

    // 5) 拖曳分類
    {
      id: 'drag-drop',
      title: '拖曳分類',
      content: '拖曳左側作業卡片到右側資料夾中完成分類，也可以拖曳到「全部」取消分類。',
      targetSelector: '[data-tutorial-card="first-assignment-card"]',
      position: 'bottom',
      highlightElement: false,
      animation: {
        type: 'drag-drop',
        fromSelector: '[data-tutorial-card="first-assignment-card"]',
        toSelector: '[data-tutorial-folder="first-assignment-folder"]'
      }
    },

    // 6) 排序
    {
      id: 'sort-and-folder',
      title: '排序與分類',
      content: '使用排序選單可以調整作業與資料夾的順序。',
      targetSelector: 'select[aria-label="排序方式"]',
      position: 'bottom',
      highlightElement: true
    },

    // 7) 編輯標題（鎖第一張卡）
    {
      id: 'edit-assignment',
      title: '修改作業標題',
      content: '點擊筆圖標可以修改作業名稱。',
      targetSelector:
        '[data-tutorial-card="first-assignment-card"] button[title="修改標題"]',
      position: 'bottom',
      highlightElement: true
    },

    // 8) 編輯標準答案
    {
      id: 'answer-key',
      title: '編輯標準答案',
      content: '點擊書本圖標可編輯作業標準答案與設定。',
      targetSelector:
        '[data-tutorial-card="first-assignment-card"] button[title="編輯標準答案"]',
      position: 'left',
      highlightElement: true
    },

    // 9) 複製作業
    {
      id: 'copy-assignment',
      title: '複製作業',
      content: '點擊複製圖標可以將作業複製到其他班級。',
      targetSelector:
        '[data-tutorial-card="first-assignment-card"] button[title="複製作業到其他班級"]',
      position: 'left',
      highlightElement: true
    },

    // 10) 刪除作業
    {
      id: 'delete-assignment',
      title: '刪除作業',
      content: '點擊垃圾桶圖標可以刪除作業（注意：刪除後無法恢復）。',
      targetSelector:
        '[data-tutorial-card="first-assignment-card"] button[title="刪除作業"]',
      position: 'bottom',
      highlightElement: true
    },

    {
      id: 'complete',
      title: '完成！',
      content: '您已經了解作業管理的功能了！接下來可以建立作業、匯入學生作業並使用 AI 批改。',
      targetSelector: 'body',
      position: 'center',
      highlightElement: false
    }
  ]
}



/**
 * 所有教学流程
 */
export const TUTORIAL_FLOWS: Record<string, TutorialFlow> = {
  classroom: classroomFlow,
  assignment: assignmentFlow
  // 注：import 和 grading 流程暂不实现，因为这些页面不在当前修改范围内
}

/**
 * 获取指定教学流程
 * @param flowId 流程 ID
 */
export function getTutorialFlow(flowId: string): TutorialFlow | undefined {
  return TUTORIAL_FLOWS[flowId]
}
