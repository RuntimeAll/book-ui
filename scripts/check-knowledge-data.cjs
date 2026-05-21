/**
 * 检查本地 API 返回的 questionKnowledges 数据
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let questionData = null
  page.on('response', async (res) => {
    if (res.url().includes('/question/page') || res.url().includes('/api/teacher/question/page')) {
      try {
        const json = await res.json()
        questionData = json
      } catch {}
    }
  })

  await page.goto('http://localhost:5173/#/question/index', { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(3000)

  if (questionData) {
    const list = questionData?.response?.list || questionData?.list || []
    const first3 = list.slice(0, 3)
    first3.forEach((q, i) => {
      console.log(`\nQuestion ${i + 1} (id: ${q.id}):`)
      console.log(`  questionKnowledges: ${JSON.stringify(q.questionKnowledges || [])}`)
    })
  } else {
    console.log('No question data captured (API may have returned error or no login)')
    // 检查页面上知识点 tag 的文字
    await page.waitForSelector('.card-knowledge-tags-row', { timeout: 10000 }).catch(() => {})
    const tags = await page.locator('.card-knowledge-tags-row .el-tag').allTextContents()
    console.log('Visible tag texts:', tags.slice(0, 10))
  }

  await browser.close()
})()
