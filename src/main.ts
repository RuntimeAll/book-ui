import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'virtual:uno.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import { safeHtml } from '@/directives/safeHtml'
import './style.css'

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
app.mount('#app')
