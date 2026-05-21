/**
 * playwright 脚本：直接访问 misikt 真站，点击"试题栏"按钮（第一道题），
 * 然后点击打开的 FAB 或"取消"按钮，抓网络请求
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security']
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  })
  const page = await context.newPage()

  const captured = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/teacher/')) {
      captured.push({ method: req.method(), url: url, postData: req.postData() })
      if (!url.includes('favorite') && !url.includes('lazyTree') && !url.includes('visit')) {
        console.log(`[REQ] ${req.method()} ${url}`)
        if (req.postData()) console.log(`  body: ${req.postData()}`)
      }
    }
  })
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('/api/teacher/question/') && !url.includes('page') && !url.includes('lazyTree')) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log(`[RES] ${res.status()} ${url} -> ${body.slice(0, 300)}`)
    }
  })

  await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 20000 })
  await page.waitForTimeout(3000)

  // 找第一道题的 "试题栏" 按钮（misikt 真站文案是"试题栏"不是"加入试题栏"）
  console.log('\n=== Step 1: Click first "试题栏" button ===')
  // 先截图看页面状态
  await page.screenshot({ path: 'screenshots/sniff-step1.png', fullPage: false })

  // 找所有包含"试题栏"的按钮
  const basketBtns = page.locator('button').filter({ hasText: /试题栏/ })
  const basketBtnCount = await basketBtns.count()
  console.log(`Found ${basketBtnCount} "试题栏" buttons`)

  if (basketBtnCount > 0) {
    // 点击第一个
    const firstBtn = basketBtns.nth(0)
    const btnText = await firstBtn.textContent()
    console.log(`First btn text: "${btnText?.trim()}"`)
    await firstBtn.click()
    await page.waitForTimeout(2000)

    // 截图
    await page.screenshot({ path: 'screenshots/sniff-step2.png', fullPage: false })

    // 现在检查按钮状态（加入后可能变为"取消"）
    const newText = await firstBtn.textContent().catch(() => 'N/A')
    console.log(`After click btn text: "${newText?.trim()}"`)
  }

  // 找"取消"按钮（如果加入后出现）
  await page.waitForTimeout(1000)
  const allBtnTexts = await page.locator('button').allTextContents()
  console.log('All button texts:', JSON.stringify(allBtnTexts))

  const cancelBtn = page.locator('button').filter({ hasText: /取消/ })
  const cancelCount = await cancelBtn.count()
  console.log(`Found ${cancelCount} "取消" buttons`)

  if (cancelCount > 0) {
    console.log('\n=== Step 2: Click "取消" button ===')
    await cancelBtn.first().click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'screenshots/sniff-step3.png', fullPage: false })
  }

  // 打开 FAB 试题栏 dialog
  const fabIcon = page.locator('[class*="basket"]').first()
  const fabCount = await fabIcon.count()
  console.log(`Found ${fabCount} basket FAB elements`)

  console.log('\n=== CAPTURED API CALLS ===')
  const questionApis = captured.filter(r => r.url.includes('/question/') && !r.url.includes('page') && !r.url.includes('lazyTree') && !r.url.includes('basketNum'))
  questionApis.forEach(r => {
    console.log(`${r.method} ${r.url}`)
    if (r.postData) console.log(`  body: ${r.postData}`)
  })

  console.log('\n=== ALL QUESTION API CALLS ===')
  const allQ = captured.filter(r => r.url.includes('/question/'))
  allQ.forEach(r => {
    console.log(`${r.method} ${r.url}`)
  })

  await browser.close()
})()
