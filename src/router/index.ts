import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'
import { useUserStore } from '@/store/user'

// 无需登录即可访问的白名单（Y2 卡 2b 波）
const PUBLIC_ROUTES = new Set<string>(['/login', '/cookie-expired'])

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      redirect: '/question/index',
      children: [
        // 题库（FE-2 真实现）
        {
          path: '/question/index',
          name: 'QuestionIndex',
          component: () => import('@/views/question/index.vue'),
        },
        // 题目详情独立页（第十二波）
        {
          path: '/question/detail/:id',
          name: 'QuestionDetail',
          component: () => import('@/views/question/detail.vue'),
        },
        // 组卷工作台（FE-4 真实现）
        {
          path: '/papers/edit',
          name: 'PapersEdit',
          component: () => import('@/views/papers/edit.vue'),
        },
        // 原卷预览页（第十二波）
        {
          path: '/papers/source/:id',
          name: 'PapersSource',
          component: () => import('@/views/papers/source.vue'),
        },
        // 空壳菜单页
        {
          path: '/home',
          name: 'Home',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '首页' },
        },
        {
          path: '/assignment/index',
          name: 'AssignmentIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '作业管理' },
        },
        {
          path: '/student/index',
          name: 'StudentIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '学生管理' },
        },
        {
          path: '/class/index',
          name: 'ClassIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '班级管理' },
        },
        {
          path: '/papers/index',
          name: 'PapersIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '卷库' },
        },
        {
          path: '/materials/index',
          name: 'MaterialsIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '资料库' },
        },
      ],
    },
    // 登录页（无 layout 包裹，Y2 卡 2a 波）
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/login/index.vue'),
    },
    // Cookie 失效提示页（无 layout 包裹）
    {
      path: '/cookie-expired',
      name: 'CookieExpired',
      component: () => import('@/views/CookieExpired.vue'),
    },
  ],
})

// ---------------------------------------------------------------------------
// 全局前置守卫（Y2 卡 2b 波）
//
// - 白名单路由（/login / /cookie-expired）→ 直接放行
// - 其他路由 → 检查 useUserStore().isLoggedIn
//     已登录 → 放行
//     未登录 → 跳 /login，带 redirect query 便于登录后回跳
//
// main.ts 顺序为 `app.use(createPinia()).use(router)` — guard 触发时 pinia 已 install，
// 直接 `useUserStore()` 安全。
// ---------------------------------------------------------------------------
router.beforeEach((to) => {
  if (PUBLIC_ROUTES.has(to.path)) {
    return true
  }
  const userStore = useUserStore()
  if (userStore.isLoggedIn) {
    return true
  }
  return { path: '/login', query: { redirect: to.fullPath } }
})

export default router
