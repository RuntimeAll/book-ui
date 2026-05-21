/**
 * playwright script: sniff the addFavorite payload when selecting a folder
 * Known: favorite drawer opens on star click, calls GET /teacher/center/q-folder/tree
 * Goal: find what happens when user selects a folder from the drawer
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security']
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  })
  const page = await context.newPage()

  const capturedAll = []

  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/teacher/')) {
      capturedAll.push({ method: req.method(), url, postData: req.postData() })
      console.log(`[REQ] ${req.method()} ${url}`)
      if (req.postData()) console.log(`  body: ${req.postData()}`)
    }
  })

  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('folder') || url.includes('favorite')) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log(`[RES] ${res.status()} ${url}`)
      console.log(`  body: ${body.slice(0, 500)}`)
    }
  })

  console.log('=== Navigating to misikt question page ===')
  await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 25000 })
  await page.waitForTimeout(4000)

  // Click the star icon on first question to open drawer
  console.log('\n=== Clicking first star icon ===')
  const starIcon = page.locator('svg[aria-label*="star"], .el-icon svg, button').filter({ hasText: /收藏/ }).first()
  const iconCount = await page.locator('svg').count()
  console.log(`Total SVG icons: ${iconCount}`)

  // Try different selectors for star icon
  // misikt uses ep:star icon, look for specific buttons without text (icon buttons)
  const btns = await page.locator('button').all()
  for (let i = 0; i < btns.length; i++) {
    const cls = await btns[i].getAttribute('class').catch(() => '')
    const text = await btns[i].textContent().catch(() => '')
    const inner = await btns[i].innerHTML().catch(() => '')
    if (inner.includes('star') || inner.includes('Star')) {
      console.log(`  Star button [${i}]: class="${cls}" text="${text?.trim()}" inner=${inner.slice(0, 100)}`)
    }
  }

  // Since misikt doesn't show star button without login (buttons are: 草稿 | 试题栏 | 详情)
  // Try to find what happens with the 草稿 button + the icon
  const allBtnTexts = await page.locator('button').allTextContents()
  console.log('\nAll button texts:', JSON.stringify(allBtnTexts.slice(0, 30)))

  // Try clicking the star icon directly (SVG)
  const starSvgs = page.locator('span[aria-label="star"], [class*="Star"]')
  const c = await starSvgs.count()
  console.log(`Star spans: ${c}`)

  // Look for the drawer that opened in previous sniff
  const drawerContent = await page.locator('.el-drawer').textContent().catch(() => '')
  console.log(`Drawer text: ${drawerContent?.slice(0, 300)}`)

  await browser.close()
})()
