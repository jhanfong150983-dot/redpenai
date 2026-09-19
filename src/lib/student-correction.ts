// 學生訂正（老師端派發／追蹤／申訴）UI 總開關。
//   2026-09-19 user 拍板：學生端已暫停（AssignmentFormModal 的 STUDENT_SUBMIT_UI_ENABLED=false，2026-09-03），
//   老師端的訂正流程沒有對象 → 批改動線第三步改成「檢討考卷」，訂正的入口／標籤／提醒／設定全部收起。
//   程式與路由都保留（/correction-select 仍可用網址進），學生端恢復時這個開關和 STUDENT_SUBMIT_UI_ENABLED 一起打開。
//   伺服器端對應：env STUDENT_CORRECTION_ENABLED=1 才允許「批改後自動派發訂正」（api/data/[action].js）。
export const STUDENT_CORRECTION_UI_ENABLED = false
