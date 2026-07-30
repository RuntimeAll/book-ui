<script setup lang="ts">
/**
 * PRD-015 批5 · 飞书教务速办 H5 外壳（/m/**）。
 *
 * D14：book-ui 内移动端路由组，非独立项目——同仓同部署同接口，复用 api/teacher/** 契约。
 * 交互正本 = artifacts/设计稿/飞书移动端-教务速办-demo.html（v5）：顶栏 + 内容区 + 底部四项 tabbar。
 * 🔴 无桌面导航壳（AppLayout 不参与）；430px 移动版式；body 不横滚（V24）。
 * 🔴 登录门（D15/V25）：路由守卫拦未登录跳 /m/login；此处再守一道——会话中途 401 被
 *    http/request 拦截器 clear 掉登录态时（桌面登录弹窗对手机没意义），自动落回 /m/login。
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { usePending } from './shared'
import './mobile.css'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const { pendingList, refreshPending } = usePending()

const TABS = [
  { key: 'schedule', path: '/m/schedule', icon: '▦', label: '课表' },
  { key: 'settle', path: '/m/settle', icon: '✓', label: '待结算' },
  { key: 'account', path: '/m/account', icon: '¥', label: '账户' },
  { key: 'feedback', path: '/m/feedback', icon: '✎', label: '反馈' },
] as const

const TITLES: Record<string, string> = {
  '/m/schedule': '课表总览',
  '/m/settle': '待结算',
  '/m/account': '课时账户',
  '/m/feedback': '课后反馈',
}

const title = computed(() => TITLES[route.path] || '教务速办')
const pendingCount = computed(() => pendingList.value.length)

function go(path: string) {
  if (route.path !== path) router.push(path)
}

// 会话中途掉登录态 → 回登录页（带 redirect 回原页）
watch(
  () => userStore.isLoggedIn,
  (ok) => {
    if (!ok) router.replace({ path: '/m/login', query: { redirect: route.fullPath } })
  },
)

// tabbar 角标：进壳拉一次待结算数（settle 页自己会再刷）
onMounted(() => {
  void refreshPending()
})
</script>

<template>
  <div class="m-app">
    <header class="m-appbar">
      <span class="t">备课帮 · {{ title }}</span>
      <span class="m-envchip">教务速办</span>
    </header>

    <main class="m-main">
      <RouterView />
    </main>

    <nav class="m-tabbar">
      <button
        v-for="t in TABS"
        :key="t.key"
        :class="{ on: route.path === t.path }"
        @click="go(t.path)"
      >
        <span class="ic">{{ t.icon }}</span>{{ t.label }}
        <span v-if="t.key === 'settle' && pendingCount > 0" class="badge">{{ pendingCount }}</span>
      </button>
    </nav>
  </div>
</template>
