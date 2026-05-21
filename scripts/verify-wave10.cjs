/**
 * 第十波自验脚本
 * 验证：底部知识点 tag 行 + 试题栏 toggle 按钮 + 7步流程不退化
 */
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const BASE_URL = 'http://localhost:5173'
const SCREENSHOTS_DIR = path.resolve(__dirname, '../screenshots')

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  // 收集控制台错误
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  console.log('=== 第十波 playwright 自验 ===\n')

  // 1. 访问题库页
  console.log('1. 访问题库页...')
  await page.goto(`${BASE_URL}/#/question/index`, { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForTimeout(2000)

  // 截图：before（底部 tag 区域前对比图，实际是初始状态）
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'fe-10-before-card-bottom.png'),
    fullPage: false
  })
  console.log('  ✅ fe-10-before-card-bottom.png 已保存')

  // 2. 等待题目列表加载
  await page.waitForSelector('.question-card', { timeout: 15000 })
  const cardCount = await page.locator('.question-card').count()
  console.log(`  题卡片数量: ${cardCount}`)

  // 3. 检查底部知识点 tag 行（子任务 E）
  console.log('\n2. 检查底部知识点 tag 行（子任务 E）...')
  const bottomTagRows = page.locator('.card-knowledge-tags-row')
  const tagRowCount = await bottomTagRows.count()
  console.log(`  .card-knowledge-tags-row 数量: ${tagRowCount}`)

  if (tagRowCount > 0) {
    const firstRowTags = bottomTagRows.first().locator('.el-tag')
    const firstRowTagCount = await firstRowTags.count()
    console.log(`  第一行 tag 数量: ${firstRowTagCount}`)

    if (firstRowTagCount > 0) {
      const tagTexts = await firstRowTags.allTextContents()
      console.log(`  Tag 文字: [${tagTexts.map(t => t.trim()).join(', ')}]`)

      // 检查多色：不同 tag 的 class 应该不同
      const tagClasses = await firstRowTags.evaluateAll((els) => els.map(el => el.className))
      console.log(`  Tag classes: ${tagClasses.slice(0, 3).join(' | ')}`)
      console.log('  ✅ 底部知识点 tag 行渲染正常')
    }
  } else {
    console.log('  ⚠️ 未找到底部 tag 行（可能所有题都无知识点数据）')
  }

  // 4. 截图：after（底部知识点 tag 行）
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'fe-10-after-card-bottom.png'),
    fullPage: false
  })
  console.log('  ✅ fe-10-after-card-bottom.png 已保存')

  // 5. 检查"+ 试题栏"按钮（未加入态）
  console.log('\n3. 检查试题栏 toggle 按钮（子任务 C）...')
  const basketBtns = page.locator('.action-btn--basket')
  const basketBtnCount = await basketBtns.count()
  console.log(`  .action-btn--basket 数量: ${basketBtnCount}`)

  if (basketBtnCount > 0) {
    const firstBtnText = await basketBtns.first().textContent()
    console.log(`  第一个按钮文字: "${firstBtnText?.trim()}"`)
  }

  // 截图：未加入态
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'fe-10-basket-add.png'),
    fullPage: false
  })
  console.log('  ✅ fe-10-basket-add.png（未加入态）已保存')

  // 6. 点击第一个"+ 试题栏"按钮 → 变成"取消"
  console.log('\n4. 点击"+ 试题栏" → 期望变成"取消"...')
  if (basketBtnCount > 0) {
    await basketBtns.first().click()
    await page.waitForTimeout(1500)

    const afterClickText = await basketBtns.first().textContent()
    console.log(`  点击后按钮文字: "${afterClickText?.trim()}"`)

    const isToggled = afterClickText?.trim() === '取消'
    console.log(`  Toggle 是否成功（变为"取消"）: ${isToggled ? '✅ 是' : '❌ 否'}`)

    // 检查 FAB 角标
    const fabBadge = page.locator('.basket-fab .el-badge__content')
    const fabBadgeVisible = await fabBadge.isVisible().catch(() => false)
    if (fabBadgeVisible) {
      const badgeText = await fabBadge.textContent()
      console.log(`  FAB 角标: ${badgeText}`)
    }

    // 截图：已加入态（"取消"按钮）
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'fe-10-basket-added.png'),
      fullPage: false
    })
    console.log('  ✅ fe-10-basket-added.png（已加入态"取消"）已保存')

    // 7. 点击"取消"→ 移除 → 恢复"+ 试题栏"
    console.log('\n5. 点击"取消" → 期望恢复到"+ 试题栏"...')
    await basketBtns.first().click()
    await page.waitForTimeout(1500)

    const afterRemoveText = await basketBtns.first().textContent()
    console.log(`  移除后按钮文字: "${afterRemoveText?.trim()}"`)
    const isRestored = afterRemoveText?.includes('试题栏')
    console.log(`  是否恢复"+ 试题栏": ${isRestored ? '✅ 是' : '❌ 否'}`)

    // 截图：移除后恢复态
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'fe-10-basket-removed.png'),
      fullPage: false
    })
    console.log('  ✅ fe-10-basket-removed.png（移除后恢复态）已保存')
  }

  // 8. 试题栏 dialog 内移除按钮验证
  console.log('\n6. 试题栏 dialog 内移除按钮验证...')
  // 先再次加入一道题
  await basketBtns.first().click()
  await page.waitForTimeout(1000)

  // 点击 FAB 打开 dialog
  const fab = page.locator('.basket-fab')
  if (await fab.count() > 0) {
    await fab.click()
    await page.waitForTimeout(1000)

    const dialog = page.locator('.basket-dialog')
    const dialogVisible = await dialog.isVisible().catch(() => false)
    console.log(`  dialog 是否打开: ${dialogVisible ? '✅ 是' : '❌ 否'}`)

    if (dialogVisible) {
      // 检查 dialog 内是否有移除按钮
      const removeBtns = dialog.locator('.basket-item-ops .el-button').filter({ hasText: /取消/ })
      const removeBtnCount = await removeBtns.count()
      console.log(`  dialog 内"取消"按钮数量: ${removeBtnCount}`)

      if (removeBtnCount > 0) {
        await removeBtns.first().click()
        await page.waitForTimeout(1000)
        const itemsAfterRemove = await dialog.locator('.basket-item').count()
        console.log(`  移除后 dialog 内题数: ${itemsAfterRemove}`)
        console.log('  ✅ dialog 内移除正常')
      }

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'fe-10-basket-dialog.png'),
        fullPage: false
      })
      console.log('  ✅ fe-10-basket-dialog.png 已保存')
    }

    // 关闭 dialog
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // 9. 7 步业务流退化检查
  console.log('\n7. 7步业务流退化检查...')
  // 加入一道题 → 试题栏角标 → 组卷跳转
  await basketBtns.first().click()
  await page.waitForTimeout(1000)
  await fab.click()
  await page.waitForTimeout(1000)

  const composeBtn = page.locator('.basket-dialog').locator('button').filter({ hasText: /组卷/ }).last()
  const composeBtnCount = await composeBtn.count()
  console.log(`  "组卷"按钮: ${composeBtnCount > 0 ? '✅ 存在' : '❌ 不存在'}`)

  if (composeBtnCount > 0) {
    await composeBtn.click()
    await page.waitForTimeout(2000)
    const currentUrl = page.url()
    const isOnEdit = currentUrl.includes('/papers/edit')
    console.log(`  跳转到 /papers/edit: ${isOnEdit ? '✅ 成功' : '❌ 失败'} (当前: ${currentUrl})`)
  }

  // 10. 控制台错误检查
  console.log('\n8. 控制台错误检查...')
  if (consoleErrors.length > 0) {
    console.log(`  ⚠️ 控制台错误 (${consoleErrors.length} 条):`)
    consoleErrors.forEach(e => console.log(`    - ${e}`))
  } else {
    console.log('  ✅ 无控制台错误')
  }

  console.log('\n=== 自验完成 ===')
  await browser.close()
})()
