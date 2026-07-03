import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'virtual:uno.css'
// KaTeX 样式 — AI 入库题 Markdown+LaTeX 富文本渲染所需 CSS
import 'katex/dist/katex.min.css'
// PRD-C-205 Umo Editor 样式（全局引入，避免每个页面重复打包 CSS；类型走 shims-umoteam.d.ts）
import '@umoteam/editor/style'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
// PRD-C-211 系统管理移植：svg 雪碧图注册 + plus-ui globalProperties 插件（$modal/$tab/useDict/handleTree…）+ v-hasPermi 指令
import 'virtual:svg-icons-register'
import adminPlugins from '@/plugins'
import adminDirectives from '@/directive'
import App from './App.vue'
import router from './router'
import { safeHtml } from '@/directives/safeHtml'
import './style.css'
// PRD-A-017 举一反三换皮设计 token（作用域 .variant-page，不污染其它页）
import '@/views/variant/variant-theme.css'

const app = createApp(App)

// Register Element Plus icons globally
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
// PRD-A-013 H-3: 全局 v-safe-html 指令 — 富文本一律走它, 禁用裸 v-html
app.directive('safe-html', safeHtml)
// PRD-C-211：系统管理移植页的地基（globalProperties + v-hasPermi/v-hasRoles/v-copyText）
app.use(adminPlugins)
adminDirectives(app)
app.mount('#app')
