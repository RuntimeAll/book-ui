import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'
import { useUserStore } from '@/store/user'

// 无需登录即可访问的白名单
// U 卡 段⑧ — /register 加入白名单（注册时不能强制登录）
const PUBLIC_ROUTES = new Set<string>(['/login', '/register'])

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
        // Q 卡 段② — 组卷工作台（新页面，试题栏 → 去组卷 → 这里）
        {
          path: '/question/compose',
          name: 'QuestionCompose',
          component: () => import('@/views/question/compose.vue'),
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
        // U 卡 段④ — 教师我的工作台聚合页
        {
          path: '/workspace',
          name: 'Workspace',
          component: () => import('@/views/workspace/index.vue'),
        },
        // PRD-002 — 个人资料页（登录态内页）
        {
          path: '/user/profile',
          name: 'UserProfile',
          component: () => import('@/views/user/profile.vue'),
        },
        // 作业/学生/班级 三个 out-of-scope 占位路由已删（CLAUDE.md §1：题库+卷库 only）
        // 卷库主页 — 公共试卷（D 卡 段③ — 视觉级还原 misikt /papers/index）
        {
          path: '/papers/index',
          name: 'PapersIndex',
          component: () => import('@/views/papers/index.vue'),
        },
        // PRD-001 — 三栏组卷工作台（试卷篮打散成题 → 左考点/中题域/右组卷面板）
        {
          path: '/papers/basket',
          name: 'PapersBasket',
          component: () => import('@/views/papers/basket.vue'),
        },
        {
          path: '/materials/index',
          name: 'MaterialsIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '资料库' },
        },
      ],
    },
    // 登录页（无 layout 包裹）
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/login/index.vue'),
    },
    // U 卡 段⑧ — 注册页（无 layout 包裹）
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/register/index.vue'),
    },
  ],
})

// ---------------------------------------------------------------------------
// 全局前置守卫（Y2 卡 2b 波）
//
// - 白名单路由（/login）→ 直接放行
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
