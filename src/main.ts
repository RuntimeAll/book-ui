import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'virtual:uno.css'
// PRD-C-212 V0 首屏减重（改前 main.ts 挂三座大山，全部下沉）：
//  1) 全量 ElementPlus JS+CSS 已删 —— unplugin 按需导入在 vite.config.ts；zh-cn locale 走 App.vue 的 ElConfigProvider
//  2) katex CSS 下沉到 utils/richtext.ts（谁渲染公式谁背 CSS）；InlineMath.vue 本就自带
//  3) @umoteam/editor/style 下沉到 lecture-hub / kg-lecture-edit 两页
//  4) PRD-C-211 管理台地基（svg雪碧图 + adminPlugins + adminDirectives）改为进 /manage 懒装载
//     —— 见 plugins/admin-foundation.ts + router 守卫，老师不进管理中心不为它买单
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import { safeHtml } from '@/directives/safeHtml'
import './style.css'
// BUG-002 修复：全项目 40+ 文件显式 `import { ElMessage/ElMessageBox/ElNotification } from 'element-plus'`
// 绕过 unplugin-vue-components resolver 的按需样式注入 —— 命令式弹窗（confirm/toast/notification）
// 裸渲染无样式。这三个组件全局补样式（体量小，值得常驻；其余组件仍走 resolver 按需）。
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/notification/style/css'
// PRD-A-017 举一反三换皮设计 token（作用域 .variant-page，不污染其它页）
import '@/views/variant/variant-theme.css'

const app = createApp(App)

// Element Plus 图标全局注册（业务页模板裸用 <Search/> 等，unplugin 不解析图标，保留全局）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
// PRD-A-013 H-3: 全局 v-safe-html 指令 — 富文本一律走它, 禁用裸 v-html
app.directive('safe-html', safeHtml)
app.mount('#app')

// 供 router 守卫懒装载管理台地基时取 app 实例（plugins/admin-foundation.ts）
export { app }
