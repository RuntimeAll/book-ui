/**
 * 第七波视觉升级截图脚本
 * 捕获顶栏/题库页/工作台/空壳页的渲染后截图
 */
import { chromium } from 'playwright'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../../workplace/PRD/2026-05-20-B-question-crud-scaffold/screenshots')

const BASE_URL = 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function captureWithWait(page, url, filename, waitMs = 2500) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await sleep(waitMs)
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, filename),
    fullPage: false,
  })
  console.log(`[screenshot] Saved: ${filename}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  // 1. 顶栏 + 空壳页（首页）
  await captureWithWait(page, `${BASE_URL}/#/home`, 'fe-7-after-topbar.png', 2000)

  // 2. 题库页（接口可能需要 cookie，等 loading 结束后截图）
  await captureWithWait(page, `${BASE_URL}/#/question/index`, 'fe-7-after-question.png', 3500)

  // 3. 空壳页示例（资料库）
  await captureWithWait(page, `${BASE_URL}/#/materials/index`, 'fe-7-after-placeholder.png', 1500)

  // 4. 工作台（需要 localStorage paperDraft，先注入 mock 数据）
  await page.goto(`${BASE_URL}/#/question/index`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const mockDraft = {
      questions: [
        {
          id: 1001,
          questionType: 1,
          difficult: 2,
          stemImg: null,
          stemText: '下列选项中，正确的是（  ）A. 1+1=2  B. 1+1=3  C. 1+1=4  D. 1+1=5',
          score: 5,
          questionKnowledges: [{ id: 1, questionId: 1001, knowledgeId: 'k1', knowledgeName: '基础运算' }]
        },
        {
          id: 1002,
          questionType: 4,
          difficult: 3,
          stemImg: null,
          stemText: '请填写下列空白处：圆的面积公式为 S = ___。',
          score: 3,
          questionKnowledges: []
        },
        {
          id: 1003,
          questionType: 5,
          difficult: 4,
          stemImg: null,
          stemText: '请简述勾股定理的内容及其应用场景。',
          score: 10,
          questionKnowledges: [{ id: 2, questionId: 1003, knowledgeId: 'k2', knowledgeName: '几何定理' }]
        }
      ],
      examData: null,
      createdAt: new Date().toISOString(),
    }
    localStorage.setItem('paperDraft', JSON.stringify(mockDraft))
  })
  await captureWithWait(page, `${BASE_URL}/#/papers/edit`, 'fe-7-after-workspace.png', 2000)

  // 5. 题库页带加载状态（更大视口）
  await context.close()
  await browser.close()
  console.log('[screenshot] All done!')
}

main().catch((e) => {
  console.error('[screenshot] Error:', e)
  process.exit(1)
})
