/**
 * playwright 自验脚本：第十一波 — 收藏抽屉
 * 验收点：
 *   1. 点未收藏题的⭐ → 抽屉打开 + 展示收藏夹列表
 *   2. 选"我的试题" → toast 成功（可能 API 失败但乐观更新）+ 抽屉关闭 + ⭐ 变 active
 *   3. 点已收藏题的⭐ → 直接 removeFavorite（不弹抽屉）
 *   4. 业务流不退化：题库加载 + 试题栏 + toggle 正常
 */
const { chromium } = require('playwright')
const path = require('path')

const DEV_URL = 'http://localhost:5189'
const SCREENSHOTS = path.resolve(__dirname, '../screenshots')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  // ── 1. 打开题库页 ──────────────────────────────────────────
  console.log('\n=== Step 1: Open question page ===')
  await page.goto(`${DEV_URL}/#/question/index`, { timeout: 20000 })
  await page.waitForTimeout(5000)

  const cards = await page.locator('.question-card').count()
  console.log(`Question cards loaded: ${cards}`)

  await page.screenshot({ path: `${SCREENSHOTS}/fe-11-before-fav-click.png`, fullPage: false })
  console.log('Screenshot: fe-11-before-fav-click.png')

  // ── 2. 点击第一张题卡片的"收藏"按钮（未收藏状态）──────────
  console.log('\n=== Step 2: Click star/favorite button (should open drawer) ===')

  // 等待题卡片
  await page.waitForSelector('.question-card', { timeout: 10000 })

  // 找到第一个 "收藏" 按钮（card-meta-right 里的收藏按钮）
  const favBtns = page.locator('.card-meta-right .action-btn').filter({ hasText: /收藏/ })
  const favBtnCount = await favBtns.count()
  console.log(`Found ${favBtnCount} favorite buttons`)

  if (favBtnCount > 0) {
    // 先确认不是已收藏状态
    const firstFavBtn = favBtns.nth(0)
    const btnText = await firstFavBtn.textContent()
    console.log(`First fav btn text: "${btnText?.trim()}"`)

    // 点击收藏按钮
    await firstFavBtn.click()
    await page.waitForTimeout(2000)

    // 检查抽屉是否打开
    const drawer = page.locator('.el-drawer')
    const drawerCount = await drawer.count()
    console.log(`Drawers after click: ${drawerCount}`)

    // 找包含"选择收藏目录"的抽屉
    const favDrawer = drawer.filter({ hasText: '选择收藏目录' })
    const favDrawerCount = await favDrawer.count()
    console.log(`FavoriteFolderDrawer visible: ${favDrawerCount > 0}`)

    await page.screenshot({ path: `${SCREENSHOTS}/fe-11-drawer-open.png`, fullPage: false })
    console.log('Screenshot: fe-11-drawer-open.png')

    if (favDrawerCount > 0) {
      // 检查抽屉内容
      const drawerText = await favDrawer.textContent()
      console.log(`Drawer text: ${drawerText?.slice(0, 200)}`)

      // 找收藏夹列表项
      const folderItems = page.locator('.folder-item')
      const folderCount = await folderItems.count()
      console.log(`Folder items in drawer: ${folderCount}`)

      if (folderCount > 0) {
        // 点击第一个收藏夹（"我的试题"）
        console.log('\n=== Step 3: Click folder item in drawer ===')
        const firstFolder = folderItems.nth(0)
        const folderText = await firstFolder.textContent()
        console.log(`Clicking folder: "${folderText?.trim()}"`)
        await firstFolder.click()
        await page.waitForTimeout(2500)

        await page.screenshot({ path: `${SCREENSHOTS}/fe-11-fav-success.png`, fullPage: false })
        console.log('Screenshot: fe-11-fav-success.png')

        // 检查抽屉是否关闭
        const drawerAfter = page.locator('.el-drawer').filter({ hasText: '选择收藏目录' })
        const drawerAfterVisible = await drawerAfter.count()
        console.log(`Drawer closed after success: ${drawerAfterVisible === 0}`)

        // 检查收藏按钮状态（变"已收藏"）
        await page.waitForTimeout(1000)
        const newBtnText = await favBtns.nth(0).textContent().catch(() => 'N/A')
        console.log(`Fav btn text after success: "${newBtnText?.trim()}"`)
      }
    } else {
      console.log('WARNING: FavoriteFolderDrawer did not open!')
      // 可能是"已收藏"状态，再找其他按钮
      const allFavBtns = page.locator('.action-btn').filter({ hasText: /收藏|已收藏/ })
      const allTexts = await allFavBtns.allTextContents()
      console.log('All fav btn texts:', JSON.stringify(allTexts))
    }
  }

  // ── 4. 点已收藏题（已收藏状态）→ 直接 removeFavorite ──────
  console.log('\n=== Step 4: Test remove favorite (already collected) ===')
  // 找"已收藏"按钮
  const alreadyFavBtns = page.locator('.card-meta-right .action-btn').filter({ hasText: '已收藏' })
  const alreadyFavCount = await alreadyFavBtns.count()
  console.log(`Already-favorited buttons: ${alreadyFavCount}`)

  if (alreadyFavCount > 0) {
    await alreadyFavBtns.nth(0).click()
    await page.waitForTimeout(2000)

    // 检查抽屉是否没打开（直接 remove，不弹抽屉）
    const drawerAfterRemove = page.locator('.el-drawer').filter({ hasText: '选择收藏目录' })
    const drawerAfterRemoveCount = await drawerAfterRemove.count()
    console.log(`Drawer NOT opened on remove: ${drawerAfterRemoveCount === 0}`)

    await page.screenshot({ path: `${SCREENSHOTS}/fe-11-fav-remove.png`, fullPage: false })
    console.log('Screenshot: fe-11-fav-remove.png')
  } else {
    console.log('No already-favorited buttons found (API 401 means getFavorite returns false for all)')
    // 即使如此，还是截图一张
    await page.screenshot({ path: `${SCREENSHOTS}/fe-11-fav-remove.png`, fullPage: false })
    console.log('Screenshot: fe-11-fav-remove.png (showing current state)')
  }

  // ── 5. 业务流不退化自查 ─────────────────────────────────────
  console.log('\n=== Step 5: Business flow regression check ===')

  // 试题栏 toggle
  const basketBtns = page.locator('.action-btn--basket').filter({ hasText: /试题栏/ })
  const basketBtnCount = await basketBtns.count()
  console.log(`Basket toggle buttons: ${basketBtnCount}`)

  if (basketBtnCount > 0) {
    await basketBtns.nth(0).click()
    await page.waitForTimeout(1500)
    const basketAdded = await page.locator('.action-btn--basket-added').count()
    console.log(`Basket toggle added state: ${basketAdded > 0}`)
  }

  // FAB 存在
  const fab = page.locator('.basket-fab')
  const fabCount = await fab.count()
  console.log(`Basket FAB exists: ${fabCount > 0}`)

  // ── 6. 汇总 ────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===')
  console.log(`Cards loaded: ${cards}`)
  console.log(`Console errors: ${consoleErrors.length}`)
  if (consoleErrors.length > 0) {
    console.log('Errors:', consoleErrors.slice(0, 5).join('\n'))
  }

  await browser.close()
  console.log('\nDone.')
})()
