/**
 * playwright 脚本：抓 misikt 真站 removeBasket / cancelBasket 接口
 * 运行：node scripts/sniff-remove-basket.cjs
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  const captured = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('misikt') || url.includes('/teacher/')) {
      captured.push({ method: req.method(), url, postData: req.postData() })
    }
  })
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('/teacher/question/')) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log('[RESPONSE]', res.status(), url.split('?')[0], body.slice(0, 300))
    }
  })

  console.log('Navigating to misikt...')
  try {
    await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 15000 })
  } catch (e) {
    console.log('Navigation result:', e.message)
  }

  await page.waitForTimeout(3000)
  console.log('Page title:', await page.title())
  console.log('\\nCaptured requests:')
  captured.forEach((r) => {
    console.log(`  ${r.method} ${r.url.split('?')[0]}`)
    if (r.postData) console.log('    body:', r.postData.slice(0, 200))
  })

  await browser.close()
})()
