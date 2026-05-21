# E2E 测试套（Playwright）

跑 misikt 教师端复刻的端到端回归测试。FE 由 `webServer` 自动启动，**BE 必须手动起**。

---

## 一、前置（一次性）

### 1. 本地 Chrome for Testing

`playwright.config.ts` 默认走 `D:/workplace/workTool/chrome-win64/chrome.exe`（v147）。
换路径用环境变量：
```powershell
$env:LOCAL_CHROME='C:/path/to/chrome.exe'
```

不想用本地 Chrome → 删 `playwright.config.ts` 里 `launchOptions.executablePath` 那行，跑 `pnpm exec playwright install chromium` 装回默认。

### 2. 后端

```powershell
cd D:\workplace\book-ai\codeSpace\book-server\ruoyi-admin
mvn spring-boot:run
# 等到 "Started DromaraApplication in XXX seconds" 再跑测试
```

健康检查：`Invoke-RestMethod http://localhost:8080/actuator` → 401（被 sa-token 拦下 = BE 起来了）

### 3. 数据库

`miskt_data2`（127.0.0.1:3307 / root / 123456）必须已落 W-6 修复：
- `biz_subject` ≥ 2116 行 / 占位名 0
- `biz_question_knowledge` ≥ 29529 行
- `admin / admin123` 账号存在（RuoYi 默认）

验证：
```sql
SELECT COUNT(*) FROM biz_subject;                       -- ≥ 2116
SELECT COUNT(*) FROM biz_subject WHERE name LIKE '节点 %';  -- 0
```

---

## 二、跑测

```powershell
cd D:\workplace\book-ai\codeSpace\book-ui

# 默认 headless 跑全部
pnpm test:e2e:v1

# 想看浏览器跑
pnpm test:e2e:v1:headed

# 只跑某组
pnpm test:e2e:v1 --grep "BUG-2"

# 跑完看 HTML 报告
pnpm test:e2e:report
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOCAL_CHROME` | `D:/workplace/workTool/chrome-win64/chrome.exe` | 本地 Chrome 路径 |
| `FE_PORT` | `4010` | FE dev server 端口（webServer 自动起这个）|
| `HEADED` | unset = headless | 设 `1` 显示浏览器 |
| `CI` | unset | 设了 `reuseExistingServer=false`，每次新起 FE |

---

## 三、测试套清单

### `v1-question-bank-regression.spec.ts`

V1 卡（题库去原网站化）完工后的回归测试。覆盖：

**BE 端口契约组**（直接 fetch / api，覆盖 vite proxy + BE 端到端）
- Bug C — 难度 `difficult` 字段对齐（旧 FE 传 `difficulty` 完全失效）
- 题型 `questionType=1` 选择题命中
- Bug D — 关键词中文筛选（axios UTF-8）
- BUG-2 真修 — `subjectId` 走 `biz_question_knowledge` JOIN（3071/3072/3010001 都应有题）
- SQL 注入防护 — 非法 subjectId 返空集
- Bug A — `POST /cancel/{id}` 返 `code:1`
- Bug A 反例 — 旧错路径 `/removeBasket/{id}` 应返 404

**UI 全链路组**（在题库页操作 vue 组件 ctx）
- 筛选 UI — 难度 / 题型 / 关键词 走 `onSearch` → 验 `ctx.total`
- 章节树点击 — `handleNodeClick({id: '3072'})` → 列表有题
- Bug A — `handleBasketToggle` 加/移无 ElMessage error

**核心目标组**
- 整会话 0 个 `misikt.com` 请求（page.on('request') 监听）

---

## 四、加新测试

### 文件命名

- 回归测试：`<卡号>-<模块>-regression.spec.ts`
- 业务流：`<卡号>-<场景>.spec.ts`
- 烟雾：`smoke-<功能>.spec.ts`

### 数据断言原则

题库数据会随时间增长。所有 `expect(total).toBe(N)` 都改成 `>=` 区间：

```ts
const EXPECTED_MIN = { TOTAL_ALL: 29000, ... }   // 最低线
expect(total).toBeGreaterThanOrEqual(EXPECTED_MIN.TOTAL_ALL)
```

### 登录

复用 `loginAsAdmin(page)` helper，**直接打 `/api/auth/login` 拿 token 存 localStorage**，不走 UI 点击（更稳）。

### 找 Vue VM

```ts
async function findCtx(page) {
  return await page.evaluate(() => {
    for (const el of document.querySelectorAll('.el-input')) {
      // @ts-expect-error
      let c = el.__vueParentComponent
      while (c) {
        const ctx = c.setupState || c.ctx
        if (ctx && ctx.filter && 'difficulty' in ctx.filter) return ctx
        c = c.parent
      }
    }
  })
}
```

调 `ctx.onSearch()` / `ctx.handleNodeClick()` 直接驱动业务逻辑，跳过 Element-Plus DOM 操作的不稳定性。

---

## 五、CI（暂未配）

未来上 CI 时：
1. 装 Chrome：`pnpm exec playwright install --with-deps chromium`（或者 mirror 本地 chrome.exe）
2. 起 BE：单独 service（mysql + spring-boot:run）
3. 跑：`CI=1 pnpm test:e2e:v1`

---

## 六、已知坑

| 坑 | 表现 | 解 |
|---|---|---|
| BE 没起 | 第一个 test fail "登录失败" | 看上面前置 §2 |
| DB 未跑 W-6 | 章节 3072/3010001 test fail（0 题）| 跑 `workplace/数据建模/07-补充资料/W-6-fix.sql` |
| 4010 端口被占 | webServer 自动换端口，baseURL 错 | `$env:FE_PORT='4011'` |
| pnpm dev 启不来 | webServer timeout | 检查 vite.config.ts / node_modules/.vite 清缓存 |
| Chrome 路径不对 | "executable doesn't exist" | `$env:LOCAL_CHROME='你的路径'` 或注释掉 |
