import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ---------------------------------------------------------------------------
// PRD-A-005 T2 — 路由 meta 类型增强：页面级权限声明 `meta.roles`
//
//   未声明 meta.roles 的路由 → 仅需登录即可访问（A 线绝大多数页面）。
//   声明 meta.roles: ['xxx'] 的路由 → 当前用户 roles 与之有交集才放行，否则重定向。
//
// A 线业务角色实质仅 teacher（无 admin），机制到位为准；此处把"按角色过滤"的
// 通用能力搭好，受限页以示范级落地（见下方 /admin/console），不硬造真实受限业务页。
// ---------------------------------------------------------------------------
declare module 'vue-router' {
  interface RouteMeta {
    /** 允许访问该路由的角色 role_key 集合；省略 = 任意已登录用户可访问 */
    roles?: string[]
  }
}

// 无需登录即可访问的白名单
// U 卡 段⑧ — /register 加入白名单（注册时不能强制登录）
const PUBLIC_ROUTES = new Set<string>(['/login', '/register'])

// 无权限时的重定向落点（已登录但角色不匹配 meta.roles）
const NO_PERMISSION_REDIRECT = '/question/index'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      redirect: '/home',
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
        // PRD-A-007 — misikt 式两栏组卷工作台（新建态 + 编辑态同页两入口）
        // 新建态（无 id）：数据源 = useQuestionBasket，动作"创建试卷"
        // 编辑态（带 id）：加载 paper detail，动作"保存修改"
        {
          path: '/papers/workbench',
          name: 'PapersWorkbench',
          component: () => import('@/views/papers/workbench.vue'),
        },
        {
          path: '/papers/workbench/:id',
          name: 'PapersWorkbenchEdit',
          component: () => import('@/views/papers/workbench.vue'),
        },
        // PRD-A-007 路由收敛 — 旧 /question/compose 重定向到新两栏工作台（新建态）
        {
          path: '/question/compose',
          redirect: '/papers/workbench',
        },
        // PRD-A-007 路由收敛 — 旧 /papers/edit 重定向到新两栏工作台（新建态）
        {
          path: '/papers/edit',
          redirect: '/papers/workbench',
        },
        // PRD-A-007 路由收敛 — 旧 /papers/edit/:id 重定向到新两栏工作台（编辑态）
        {
          path: '/papers/edit/:id',
          redirect: (to) => ({ path: `/papers/workbench/${to.params.id}` }),
        },
        // 原卷预览页（第十二波）
        {
          path: '/papers/source/:id',
          name: 'PapersSource',
          component: () => import('@/views/papers/source.vue'),
        },
        // 🔴 C 线首页 = 老师 vibe 聊天入口（PRD-C-004）。双栏：左对话流 + 右组卷画布，
        //    调 ai-orchestrator :8092 /chat（vite proxy /ai）。原 Dify chatbot 壳已弃用替换。
        {
          path: '/home',
          name: 'Home',
          component: () => import('@/views/ai-compose/index.vue'),
        },
        // U 卡 段④ — 教师我的工作台聚合页
        {
          path: '/workspace',
          name: 'Workspace',
          component: () => import('@/views/workspace/index.vue'),
        },
        // PRD-A-005 T6 — 收藏管理页（列收藏题 + 取消收藏，工作台「收藏管理」入口指向此）
        {
          path: '/favorites/index',
          name: 'FavoritesIndex',
          component: () => import('@/views/favorites/index.vue'),
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
        // PRD-A-005 T2 — 页面级权限「示范受限页」
        //   meta.roles 限定 superadmin 可见（A 线无真实 admin 业务页，这里以管理控制台
        //   占位页示范"按角色过滤路由"的通用机制；teacher 访问会被守卫重定向）。
        //   待 A 线出现真正需限制的页时，照此挂 meta.roles 即可，无需改守卫。
        {
          path: '/admin/console',
          name: 'AdminConsole',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '管理控制台' },
          meta: { roles: ['superadmin'] },
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
// 全局前置守卫（Y2 卡 2b 波 → PRD-A-005 T2 扩页面级权限）
//
// 流程：
//   1. 白名单路由（/login、/register）→ 直接放行
//   2. 未登录 → 跳 /login，带 redirect query 便于登录后回跳
//   3. 已登录但 userInfo（含 roles）未就绪 → 守卫内集中拉一次 getCurrentUser 回填
//      —— userInfo 内存态不持久化，刷新后丢失（[[feedback_fe_user_info_onmount_fallback]]）；
//         守卫是页面级权限判定点，必须先拿到 roles 再判，否则刷新受限页会被误拦。
//         业务页 onMounted 的 getCurrentUser 兜底保留（双保险，互不冲突，store 缓存命中后不重拉）。
//   4. 命中 meta.roles 的路由 → 当前 roles 与之有交集才放行，否则重定向到无权限落点
//   5. 无 meta.roles → 仅登录即可访问（A 线绝大多数页面）
//
// main.ts 顺序为 `app.use(createPinia()).use(router)` — guard 触发时 pinia 已 install，
// 直接 `useUserStore()` 安全。
// ---------------------------------------------------------------------------
router.beforeEach(async (to) => {
  if (PUBLIC_ROUTES.has(to.path)) {
    return true
  }

  const userStore = useUserStore()
  if (!userStore.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  // userInfo（roles）未就绪时集中回填一次（刷新 / 直达受限页场景）。
  // best-effort：拉失败不阻塞导航（token 真失效会被后续接口 401 拦截器处理），
  // 仅在该页确有 meta.roles 限制时才视作"无权限"重定向。
  if (userStore.roles.length === 0) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[router] 守卫回填 getCurrentUser 失败:', e)
    }
  }

  const requiredRoles = to.meta.roles
  if (requiredRoles && requiredRoles.length > 0) {
    const hasPermission = requiredRoles.some((r) => userStore.roles.includes(r))
    if (!hasPermission) {
      return { path: NO_PERMISSION_REDIRECT }
    }
  }

  return true
})

export default router
