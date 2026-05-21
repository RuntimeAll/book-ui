/**
 * playwright 脚本：抓 misikt 真站 removeBasket / cancelBasket 接口
 * 策略：先 addBasket 加一道题，然后点"取消"或"移除"按钮，抓接口
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  const captured = []

  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/teacher/question/')) {
      captured.push({
        method: req.method(),
        url: url,
        postData: req.postData()
      })
      console.log(`[REQ] ${req.method()} ${url}`)
      if (req.postData()) console.log(`  body: ${req.postData().slice(0, 300)}`)
    }
  })

  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('/api/teacher/question/')) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log(`[RES] ${res.status()} ${url} -> ${body.slice(0, 200)}`)
    }
  })

  console.log('1. Navigating to question page...')
  await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 20000 }).catch((e) => {
    console.log('  Navigation result:', e.message)
  })
  await page.waitForTimeout(3000)
  console.log('  Page title:', await page.title())

  // 2. 找到第一道题的 "加入试题栏" 按钮并点击
  console.log('2. Looking for "加入试题栏" button...')
  const addBtn = page.locator('text=加入试题栏').first()
  const addBtnCount = await addBtn.count()
  console.log('  Found "加入试题栏" buttons:', addBtnCount)

  if (addBtnCount > 0) {
    await addBtn.click()
    await page.waitForTimeout(2000)
    console.log('  Clicked "加入试题栏"')
  } else {
    // 尝试找 button 包含文字
    const btn2 = page.locator('button').filter({ hasText: '试题栏' }).first()
    const cnt2 = await btn2.count()
    console.log('  Fallback btn count:', cnt2)
    if (cnt2 > 0) {
      await btn2.click()
      await page.waitForTimeout(2000)
    }
  }

  // 3. 找到已加入后的 "取消" 按钮并点击
  console.log('3. Looking for cancel/remove button...')
  await page.waitForTimeout(1000)

  // 打印页面上所有按钮的文字
  const allBtns = await page.locator('button').allTextContents()
  console.log('  All buttons on page:', allBtns.slice(0, 20))

  // 尝试找 "取消" 相关按钮
  const cancelBtn = page.locator('button').filter({ hasText: '取消' }).first()
  const cancelCount = await cancelBtn.count()
  console.log('  "取消" buttons:', cancelCount)
  if (cancelCount > 0) {
    await cancelBtn.click()
    await page.waitForTimeout(2000)
    console.log('  Clicked "取消"')
  }

  // 4. 也搜索 FAB 角标区域
  console.log('4. Opening basket dialog...')
  const fabBtn = page.locator('.basket-fab, [class*="fab"]').first()
  const fabCount = await fabBtn.count()
  console.log('  FAB count:', fabCount)

  console.log('\n=== SUMMARY ===')
  console.log('Captured question API requests:', captured.length)
  captured.forEach((r) => {
    console.log(`  ${r.method} ${r.url}`)
  })

  await browser.close()
})()
