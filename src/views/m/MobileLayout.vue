<script setup lang="ts">
/**
 * PRD-015 · 飞书教务速办 H5 外壳（/m/**）—— **Vant 4 版**。
 *
 * D14：book-ui 内移动端路由组，非独立项目——同仓同部署同接口，复用 api/teacher/** 契约。
 * 🔴 2026-07-31 重做（用户拍板「自研的组件问题太多了，直接改用框架」）：
 *    顶栏 = van-nav-bar，底部四 tab = van-tabbar/van-tabbar-item（route 模式直接吃路由），
 *    主题 = van-config-provider 把 --van-primary-color 染成品牌青绿 #0E8F72。
 *    🔴 theme-vars-scope="global"：Toast / Dialog 这类命令式组件挂在 body 上，不在 ConfigProvider
 *       子树里，只有写到 :root 才能一起变色——否则弹窗按钮会是 Vant 默认蓝。
 * 🔴 vant 只在 /m/ 文件里按需引入（VantResolver 逐组件注入 import + 样式），main.ts 一个字节都没加，
 *    桌面端 chunk 不含 vant（build 后 grep 验证）。
 * 🔴 无桌面导航壳（AppLayout 不参与）；430px 版心；body 不横滚（V24）。
 * 🔴 登录门（D15/V25）：路由守卫拦未登录跳 /m/login；此处再守一道——会话中途 401 被
 *    http/request 拦截器 clear 掉登录态时（桌面登录弹窗对手机没意义），自动落回 /m/login。
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { M_THEME_VARS, usePending } from './shared'
import './mobile.css'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const { pendingList, refreshPending } = usePending()

const TITLES: Record<string, string> = {
  '/m/schedule': '课表总览',
  '/m/settle': '待结算',
  '/m/account': '课时账户',
  '/m/feedback': '课后反馈',
}

const title = computed(() => TITLES[route.path] || '教务速办')
const pendingCount = computed(() => pendingList.value.length)

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
  <van-config-provider :theme-vars="M_THEME_VARS" theme-vars-scope="global" class="m-app">
    <van-nav-bar class="m-navbar" :title="`备课帮 · ${title}`" />

    <main class="m-main">
      <RouterView />
    </main>

    <!-- route 模式：tab 直接绑路由，选中态跟 $route 走，不用自己维护 active 下标 -->
    <van-tabbar route :placeholder="false">
      <van-tabbar-item to="/m/schedule" icon="calendar-o">课表</van-tabbar-item>
      <van-tabbar-item to="/m/settle" icon="balance-list-o" :badge="pendingCount || ''">
        待结算
      </van-tabbar-item>
      <van-tabbar-item to="/m/account" icon="gold-coin-o">账户</van-tabbar-item>
      <van-tabbar-item to="/m/feedback" icon="edit">反馈</van-tabbar-item>
    </van-tabbar>
  </van-config-provider>
</template>
