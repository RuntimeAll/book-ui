/**
 * playwright script: sniff misikt favorite folder list API
 * Target: /api/teacher/qd/favorite/folder/list or similar
 * Approach: navigate to question page, click a star/favorite button, capture XHR
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
  const capturedFav = []

  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/teacher/')) {
      capturedAll.push({ method: req.method(), url, postData: req.postData() })
      if (url.includes('favorite') || url.includes('folder')) {
        capturedFav.push({ method: req.method(), url, postData: req.postData() })
        console.log(`[FAV REQ] ${req.method()} ${url}`)
        if (req.postData()) console.log(`  body: ${req.postData()}`)
      }
    }
  })

  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('favorite') || url.includes('folder')) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log(`[FAV RES] ${res.status()} ${url}`)
      console.log(`  body: ${body.slice(0, 500)}`)
    }
  })

  console.log('=== Navigating to misikt question page ===')
  await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 25000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'screenshots/fe-11-sniff-page.png', fullPage: false })

  // look for star/favorite buttons
  console.log('\n=== Looking for star/favorite buttons ===')
  const starBtns = page.locator('button').filter({ hasText: /收藏|⭐|star/i })
  const starCount = await starBtns.count()
  console.log(`Found ${starCount} star/favorite buttons`)

  // also look for icon buttons
  const allBtns = await page.locator('button').all()
  for (let i = 0; i < Math.min(allBtns.length, 30); i++) {
    const text = await allBtns[i].textContent().catch(() => '')
    if (text) console.log(`  btn[${i}]: "${text.trim()}"`)
  }

  if (starCount > 0) {
    console.log('\n=== Clicking first star button ===')
    await starBtns.first().click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'screenshots/fe-11-sniff-after-star.png', fullPage: false })
  } else {
    // try clicking any star icon
    const starIcon = page.locator('.el-icon-star-off, [data-icon*="star"], svg[aria-label*="star"]').first()
    const iconCount = await starIcon.count()
    console.log(`Found ${iconCount} star icons`)
    if (iconCount > 0) {
      await starIcon.click()
      await page.waitForTimeout(3000)
    }
  }

  // look for drawer that might contain folder list
  const drawer = page.locator('.el-drawer')
  const drawerCount = await drawer.count()
  console.log(`\n=== Drawer count: ${drawerCount} ===`)

  if (drawerCount > 0) {
    const drawerText = await drawer.first().textContent().catch(() => '')
    console.log(`Drawer text: ${drawerText?.slice(0, 200)}`)
    await page.screenshot({ path: 'screenshots/fe-11-sniff-drawer.png', fullPage: false })
  }

  console.log('\n=== ALL CAPTURED FAVORITE API CALLS ===')
  if (capturedFav.length === 0) {
    console.log('No favorite/folder API calls captured (likely requires login)')
    console.log('\n=== ALL CAPTURED API CALLS ===')
    capturedAll.slice(0, 20).forEach(r => {
      console.log(`${r.method} ${r.url}`)
    })
  } else {
    capturedFav.forEach(r => {
      console.log(`${r.method} ${r.url}`)
      if (r.postData) console.log(`  body: ${r.postData}`)
    })
  }

  await browser.close()
})()
