/**
 * playwright 脚本：抓 misikt 真站 removeBasket / cancelBasket 接口
 * 运行：node scripts/sniff-remove-basket.js
 *
 * 因无登录态，期望：
 *  - 访问真站，记录所有 /api/teacher/question/* 的网络请求
 *  - 若已有 session cookie，可看到 removeBasket 调用
 */
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  // 收集所有 XHR 请求
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
      console.log('[RESPONSE]', res.status(), url, body.slice(0, 200))
    }
  })

  console.log('Navigating to misikt...')
  await page.goto('https://www.misikt.com/teacher/#/question/index', { timeout: 15000 }).catch((e) => {
    console.log('Navigation result:', e.message)
  })

  await page.waitForTimeout(3000)
  console.log('Page title:', await page.title())
  console.log('Captured requests:')
  captured.forEach((r) => {
    console.log(`  ${r.method} ${r.url}`)
    if (r.postData) console.log('    body:', r.postData.slice(0, 200))
  })

  await browser.close()
})()
