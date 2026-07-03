# src 结构说明书 —— 双轨分界（新代码先读这个）

> PRD-C-212 V0 落笔（2026-07-04）。book-ui 里并存两套基础设施是**有意设计**（PRD-C-211 把 B 线 plus-ui
> 管理中心整体移植进来时的隔离决策），**禁合并、禁混用**。本文回答唯一的问题：**新代码该用哪一轨**。
> 规范正本 = `.claude/skills/frontend-dev` 的「C 线增补」节；视觉 tokens 见 PRD-C-212。

## 一句话判据

**写业务页（题库/卷库/讲义/备课台/首页…）→ 业务轨；改管理中心（/manage 下）→ 移植轨。没有第三种情况。**

## 双轨对照表

| | 业务轨（book-ui 原生） | 移植轨（plus-ui，仅 /manage） |
|---|---|---|
| HTTP 封装 | `src/http/request.ts`（misikt envelope：`{code:1,message,response}`，`code!==1` 判错） | `src/utils/request.ts`（RuoYi envelope：`{code:200,msg,data/rows/total}`） |
| API 目录 | `src/api/<域>/`（question/paper/user/auth/kg/variant/ingest…） | `src/api/system/`、`src/api/monitor/` |
| BE 路径 | `/teacher/**`（挂 MisiktEnvelopeAdvice） | `/system/**` 等 RuoYi 原生 |
| user store | `src/store/user.ts`（登录态/roles，守卫用） | `src/store/modules/user.ts`（RuoYi /getInfo 的 permissions，v-hasPermi 用） |
| dict store | `src/store/dict.ts`（`dict.load(DICT_X)`） | `src/store/modules/dict.ts`（plus-ui useDict 适配层） |
| 指令 | `src/directives/`（safeHtml，全局挂） | `src/directive/`（hasPermi/hasRoles/copyText，**懒装载**） |
| globalProperties | 无（显式 import） | `$modal/$tab/$download/useDict/handleTree…`（`src/plugins/`，**懒装载**） |
| 类型声明 | 各 api 的 types.ts | `src/types/module.d.ts`（ComponentCustomProperties）+ `axios.d.ts`（rows/total 增强） |

## 常犯错误（真踩过）

1. **业务页用 `utils/request`** → envelope 判错逻辑对不上，成功响应被当失败。业务页一律 `http/request` + `api/<域>/`。
2. **业务代码用 `res.rows`** → `src/types/axios.d.ts` 的增强是给移植轨的，业务轨运行时没有这个字段，类型能过、运行时 undefined。
3. **纯类型导入不写 `import type`** → vue SFC 编译器不删"模板可疑"导入，运行时炸 "does not provide an export named"（PRD-C-211 的 267 错教训之一）。
4. **在 /manage 之外用 `$modal`/`v-hasPermi`** → 管理台地基是懒装载的（`src/plugins/admin-foundation.ts`，router 守卫进 /manage 才装），业务页用了 = 游客/老师路径直接报未注册。
5. **重量级库（mathjax/simple-mind-map/jspdf/html2canvas/Umo 样式）静态 import 进公共 chunk** → 首屏全站买单。一律 `await import()` 首用加载或页面组件内引（参照 `extensions/kg-nodes/KgMindmapNodeView.vue`、`utils/pdf-export.ts`）。
6. **全局样式塞 main.ts** → 页面级 CSS 在页面组件内引（katex CSS 在 `utils/richtext.ts`，Umo 样式在讲义两页）。

## 首屏加载契约（V0 治理后，别退化）

- main.ts 只装：pinia / router / EP 图标 / safeHtml / style.css / variant-theme.css。
- Element Plus 走 unplugin 按需（vite.config.ts），**禁**再 `app.use(ElementPlus)` 全量；zh-cn locale 在 App.vue 的 `ElConfigProvider`。
- 管理台地基（svg 雪碧图/plugins/directive）只在进 /manage 时装（`plugins/admin-foundation.ts`）。
