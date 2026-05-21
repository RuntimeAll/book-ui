/**
 * playwright 自验脚本：第十二波
 * 验收点：
 *   1. 题目详情独立页 /question/detail/:id — 双栏布局 + meta 行 + sidebar 3 card
 *   2. 原卷预览页 /papers/source/:id — 题列表 + 返回按钮
 *   3. 错题栏 toggle — 加入/取消 乐观更新
 *   4. 业务流不退化：题库页正常加载
 */
const { chromium } = require('playwright')
const path = require('path')

const DEV_URL = 'http://localhost:5173'
const SCREENSHOTS = path.resolve(__dirname, '../screenshots')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  console.log('[wave12] 开始自验...')

  // ─ 步骤 1: 题库页正常加载 ─
  await page.goto(`${DEV_URL}/#/question/index`, { timeout: 20000 })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(3000)

  const questionPage = await page.evaluate(() => ({
    hasQuestionList: !!document.querySelector('.question-list'),
    hasFilterBar: !!document.querySelector('.el-form'),
    hasTree: !!document.querySelector('.el-tree'),
    hasFAB: !!document.querySelector('.basket-fab'),
    bodySnippet: document.body.textContent.trim().slice(0, 100),
  }))
  console.log('[step1] 题库页:', JSON.stringify(questionPage))
  await page.screenshot({ path: `${SCREENSHOTS}/fe-12-router-flow.png`, fullPage: false })
  console.log('[step1] SCREENSHOT: fe-12-router-flow.png')

  // ─ 步骤 2: 写 localStorage cache（模拟从 index.vue 点详情按钮写的 cache）─
  await page.evaluate(() => {
    const testQ = {
      id: 1045, questionType: 1, difficult: 2,
      stemImg: 'https://question-1256278081.cos.ap-shanghai.myqcloud.com/2024-04-23/cd2f5750-692b-411d-a335-895ccdf848b0/list/1/question.png',
      stemText: '下列各式中，是二次根式有 () ①sqrt(7)；②sqrt(-3)；③sqrt(10,3) A.2个 B.3个 C.4个 D.5个',
      answerImg: 'https://question-1256278081.cos.ap-shanghai.myqcloud.com/2024-04-23/cd2f5750-692b-411d-a335-895ccdf848b0/list/1/answer.png',
      explainImg: 'https://question-1256278081.cos.ap-shanghai.myqcloud.com/2024-04-23/cd2f5750-692b-411d-a335-895ccdf848b0/list/1/explain.png',
      examPaperId: 70, examPaperName: '1.1认识二次根式', examYear: '2024',
      questionKnowledges: [{ id: null, questionId: 1045, knowledgeId: '3082001001001', knowledgeName: '认识二次根式' }],
      freeTag: '二次根式定义，判断'
    }
    const cache = { '1045': testQ }
    localStorage.setItem('book-ui:question-cache-by-id', JSON.stringify(cache))
    console.log('[test] localStorage cache written for id 1045')
  })

  // ─ 步骤 3: 访问详情页 /question/detail/1045 ─
  await page.goto(`${DEV_URL}/#/question/detail/1045`, { timeout: 20000 })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(4000)

  const detailSnapshot = await page.evaluate(() => ({
    hasTopbar: !!document.querySelector('.detail-topbar'),
    topbarText: document.querySelector('.detail-topbar')?.textContent?.trim()?.slice(0, 60),
    hasMetaRow: !!document.querySelector('.meta-row'),
    hasStemArea: !!document.querySelector('.stem-area'),
    hasStemImg: !!document.querySelector('.stem-img'),
    hasSidebar: !!document.querySelector('.detail-sidebar'),
    sidebarCardCount: document.querySelectorAll('.sidebar-card').length,
    sidebarTitles: Array.from(document.querySelectorAll('.sidebar-card-title')).map(el => el.textContent?.trim()),
    hasCollapses: !!document.querySelector('.collapse-section'),
    collapseCount: document.querySelectorAll('.collapse-section').length,
    hasStars: !!document.querySelector('.stars-row'),
    hasKnowledgeTag: !!document.querySelector('.knowledge-tag'),
    hasBasketBtn: !!document.querySelector('.action-btn--basket'),
    hasFavBtn: !!document.querySelector('.action-btn'),
    bodyText: document.body.textContent.trim().slice(0, 300),
  }))
  console.log('[step3] 详情页 DOM:', JSON.stringify(detailSnapshot, null, 2))
  await page.screenshot({ path: `${SCREENSHOTS}/fe-12-detail-page.png`, fullPage: true })
  console.log('[step3] SCREENSHOT: fe-12-detail-page.png')

  // 截图 sidebar 特写
  const sidebarEl = await page.locator('.detail-sidebar').first()
  if (await sidebarEl.count() > 0) {
    await sidebarEl.screenshot({ path: `${SCREENSHOTS}/fe-12-detail-sidebar.png` })
    console.log('[step3] SCREENSHOT: fe-12-detail-sidebar.png')
  }

  // ─ 步骤 4: 验证"展开答案"折叠交互 ─
  const collapseHeader = await page.locator('.collapse-header').first()
  if (await collapseHeader.count() > 0) {
    await collapseHeader.click()
    await page.waitForTimeout(500)
    const answerVisible = await page.evaluate(() => !!document.querySelector('.collapse-body'))
    console.log('[step4] 展开答案折叠区:', answerVisible ? 'VISIBLE' : 'NOT FOUND')
  }

  // ─ 步骤 5: 试题栏 toggle ─
  const basketBtn = await page.locator('.action-btn--basket').first()
  if (await basketBtn.count() > 0) {
    const beforeText = await basketBtn.textContent()
    await basketBtn.click()
    await page.waitForTimeout(1500)
    const afterText = await basketBtn.textContent()
    console.log('[step5] 试题栏 toggle: before=', beforeText?.trim(), 'after=', afterText?.trim())
  }

  await page.screenshot({ path: `${SCREENSHOTS}/fe-12-detail-vs-misikt.png`, fullPage: false })
  console.log('[step5] SCREENSHOT: fe-12-detail-vs-misikt.png')

  // ─ 步骤 6: 原卷预览页 /papers/source/70 ─
  await page.goto(`${DEV_URL}/#/papers/source/70`, { timeout: 20000 })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(4000)

  const sourceSnapshot = await page.evaluate(() => ({
    hasTopbar: !!document.querySelector('.source-topbar'),
    topbarText: document.querySelector('.source-topbar')?.textContent?.trim()?.slice(0, 80),
    hasQuestionList: !!document.querySelector('.question-list'),
    hasEmpty: !!document.querySelector('.el-empty'),
    hasPaperHeader: !!document.querySelector('.paper-header'),
    questionCount: document.querySelectorAll('.source-question-card').length,
    hasErrorBookBtn: !!document.querySelector('.error-book-btn'),
    bodyText: document.body.textContent.trim().slice(0, 300),
  }))
  console.log('[step6] 原卷页 DOM:', JSON.stringify(sourceSnapshot, null, 2))
  await page.screenshot({ path: `${SCREENSHOTS}/fe-12-source-page.png`, fullPage: true })
  console.log('[step6] SCREENSHOT: fe-12-source-page.png')

  // ─ 步骤 7: 错题栏 toggle（需要有题卡片才能测）─
  // 原卷页如果有题卡片，点第一道题的"加入错题栏"
  const errorBtns = await page.locator('.error-book-btn').all()
  if (errorBtns.length > 0) {
    const beforeText = await errorBtns[0].textContent()
    await errorBtns[0].click()
    await page.waitForTimeout(1500)
    const afterText = await errorBtns[0].textContent()
    console.log('[step7] 错题栏 toggle: before=', beforeText?.trim(), 'after=', afterText?.trim())
    await page.screenshot({ path: `${SCREENSHOTS}/fe-12-error-book-toggle.png`, fullPage: false })
    console.log('[step7] SCREENSHOT: fe-12-error-book-toggle.png')
  } else {
    // 接口失败空列表状态下，手动模拟 localStorage 错题栏 toggle
    console.log('[step7] 原卷页无题卡片（接口需登录态）— 截图空态')
    await page.screenshot({ path: `${SCREENSHOTS}/fe-12-error-book-toggle.png`, fullPage: false })
    console.log('[step7] SCREENSHOT: fe-12-error-book-toggle.png (空态)')
  }

  // ─ 步骤 8: 测试"返回"按钮跳转 ─
  const backBtn = await page.locator('.back-btn').first()
  if (await backBtn.count() > 0) {
    await backBtn.click()
    await page.waitForTimeout(1500)
    const currentUrl = page.url()
    console.log('[step8] 点"返回"后 URL:', currentUrl)
  }

  // ─ 步骤 9: 模拟题库页点"详情"按钮验证 router.push ─
  await page.goto(`${DEV_URL}/#/question/index`, { timeout: 20000 })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(3000)

  const detailLinkBtns = await page.locator('.detail-link-btn').all()
  if (detailLinkBtns.length > 0) {
    const beforeUrl = page.url()
    await detailLinkBtns[0].click()
    await page.waitForTimeout(2000)
    const afterUrl = page.url()
    console.log('[step9] 详情按钮跳转: before=', beforeUrl.slice(-30), 'after=', afterUrl.slice(-30))
    await page.screenshot({ path: `${SCREENSHOTS}/fe-12-router-flow.png`, fullPage: false })
    console.log('[step9] SCREENSHOT: fe-12-router-flow.png (跳转后)')
  }

  // ─ 汇总 ─
  console.log('\n=== 自验汇总 ===')
  console.log('console.error 数量:', consoleErrors.length)
  if (consoleErrors.length > 0) {
    console.log('errors:', consoleErrors.slice(0, 3).join('\n'))
  }
  console.log('所有截图已保存到 screenshots/')

  await browser.close()
  console.log('[wave12] 自验完成')
})().catch(e => { console.error('PLAYWRIGHT ERROR:', e); process.exit(1); })
