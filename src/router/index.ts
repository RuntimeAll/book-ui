import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'
import { useUserStore } from '@/store/user'
// PRD-C-211 — 管理中心权限 store（/getInfo 拉 permissions，v-hasPermi 与守卫共用）
import { useUserStore as useAdminUserStore } from '@/store/modules/user'
import { getCurrentUser } from '@/api/user'
// PRD-C-212 V0 — 管理台地基（雪碧图/globalProperties/指令）懒装载，进 /manage 才拉
import { ensureAdminFoundation } from '@/plugins/admin-foundation'

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
    /** PRD-C-211 — RuoYi 权限串（管理中心子路由用，比对 /getInfo permissions） */
    perms?: string[]
  }
}

// 无需登录即可访问的白名单
// U 卡 段⑧ — /register 加入白名单（注册时不能强制登录）
const PUBLIC_ROUTES = new Set<string>(['/login', '/register', '/geo-engine-test'])

// PRD-C-212 D5 — 未登录漫游白名单：首页/题库(列表+详情)/卷库(列表+原卷结构)/讲义 可看。
// 收藏/加篮/组卷/下载/备课台/管理仍需登录（守卫拦 + 页面按钮登录引导 + BE 只放只读端点）。
const GUEST_EXACT = new Set<string>(['/home', '/question/index', '/papers/index', '/lecture-hub'])
const GUEST_PREFIXES = ['/question/detail/', '/papers/source/']

function isGuestBrowsable(path: string): boolean {
  return GUEST_EXACT.has(path) || GUEST_PREFIXES.some((p) => path.startsWith(p))
}

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
        // PRD-A-015 批3 — 单题网格编辑器（新建态 + 编辑态同页）
        //   新建态（无 id）：doc 从 emptyDoc() 起，动作"创建题目"
        //   编辑态（带 id）：加载 getQuestionDetail → parseBlockDoc 还原 doc，动作"保存修改"
        {
          path: '/question/editor',
          name: 'QuestionEditorNew',
          component: () => import('@/views/question/editor.vue'),
        },
        {
          path: '/question/editor/:id',
          name: 'QuestionEditorEdit',
          component: () => import('@/views/question/editor.vue'),
        },
        // PRD-A-015 批1 — 题目属性编辑页（基础设置可改 + AI 打标维度/元数据/高级属性只读展示）
        {
          path: '/question/attributes/:id',
          name: 'QuestionAttributes',
          component: () => import('@/views/question/attributes.vue'),
        },
        // PRD-C-212 D3 — 「我的题库」收进备课台，旧地址兜书签
        {
          path: '/my-question',
          redirect: '/desk/my-question',
        },
        // PRD-A-002 路A「框选录题全屏页」——上传题/卷照片 → 拖框选区 → 每框识别去手写富文本题
        //   → 改题/解题（可选）→ 绑定章节 → 录入 biz_question 草稿(status='0')。
        {
          path: '/ingest/frame',
          name: 'IngestFrame',
          component: () => import('@/views/ingest/frame.vue'),
        },
        // PRD-A-002 路B「批量上传录题」审核页——审核某拆题作业拆出的题项 → 勾选入库 / 软弃题。
        {
          path: '/ingest/review/:jobId',
          name: 'IngestReview',
          component: () => import('@/views/ingest/review.vue'),
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
        // 首页（用户 2026-06-04 拍板做真首页：去 misikt 门面 + 北极星理念 + 快捷入口 + AI 预告）。
        //   🔴 合并裁决（2026-06-05）：真首页占 /home（以 A 线 master 为准）；原占 /home 的
        //   AI vibe 聊天入口让位，下移到独立路由 /ai-assistant（见下方「AI 助手」），菜单加 tab。
        {
          path: '/home',
          name: 'Home',
          component: () => import('@/views/home/index.vue'),
        },
        // AI 助手（/ai-assistant，原 PRD-C-004/005 vibe 聊天入口）2026-06-30 移除：
        //   功能暂废，菜单项 + 本路由 + views/ai-compose + api/chat 一并清。
        // PRD-C-212 D3 — 举一反三/工作台/收藏 收进备课台，旧地址兜书签
        {
          path: '/ai-variant',
          redirect: '/desk/ai-variant',
        },
        {
          path: '/workspace',
          redirect: '/desk/workspace',
        },
        {
          path: '/favorites/index',
          redirect: '/desk/favorites',
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
        // 资料库：菜单已隐藏（用户 2026-06-04「暂不做开发」），路由保留备用，待开发时恢复 AppLayout 菜单项即可。
        {
          path: '/materials/index',
          name: 'MaterialsIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '资料库' },
        },
        // 管理控制台 /admin/console：纯占位无业务，用户 2026-06-04 拍板移除（菜单 + 路由一并清）。
        //   原为 PRD-A-005「页面级权限·按角色显隐」示范页；A 线无真实 admin 业务，故撤。
        //   若将来需页面级权限示范，照 meta.roles 模式挂任意真实页即可，无需复活此占位。

        // PRD-C-212 D3 — 几何画板收进备课台，旧地址兜书签
        {
          path: '/geo-board',
          redirect: '/desk/geo-board',
        },
        {
          path: '/geo-board/gallery',
          redirect: '/desk/geo-board/gallery',
        },
        // 🔴 PRD-C-212 D3 — 备课台（工具箱+个人空间聚合壳，照 manage 壳模式）。
        //   原页面组件零重写零搬家，路由 component 直指现有 views 文件；壳=views/desk/index.vue。
        {
          path: '/desk',
          name: 'DeskCenter',
          component: () => import('@/views/desk/index.vue'),
          redirect: '/desk/overview',
          children: [
            // 概览：问候+统计卡+快捷入口（PRD-C-212 V1 新页）
            { path: 'overview', name: 'DeskOverview', component: () => import('@/views/desk/overview.vue') },
            // U 卡 段④ — 教师我的工作台聚合页
            { path: 'workspace', name: 'Workspace', component: () => import('@/views/workspace/index.vue') },
            // PRD-C-009「我的题库」——只看当前登录老师自己的题（mine:true）
            { path: 'my-question', name: 'MyQuestion', component: () => import('@/views/my-question/index.vue') },
            // 🔴 举一反三（PRD-C-009）= 图片变式入口（toolkit :8093，vite proxy /agent）
            { path: 'ai-variant', name: 'AiVariant', component: () => import('@/views/variant/index.vue') },
            // 几何画板（GeoBoard）——JSXGraph 引擎，draw 主页 + 只读画廊
            { path: 'geo-board', name: 'GeoBoardStudio', component: () => import('@/views/geo-board/index.vue') },
            { path: 'geo-board/gallery', name: 'GeoBoardGallery', component: () => import('@/views/geo-board/gallery.vue') },
            // PRD-A-005 T6 — 收藏管理页
            { path: 'favorites', name: 'FavoritesIndex', component: () => import('@/views/favorites/index.vue') },
          ],
        },
        // PRD-C-207 退役：旧「讲义查看」单课时页 → 重定向到新讲义浏览器（兜老书签）
        {
          path: '/kg-lecture',
          redirect: '/lecture-hub',
        },
        // PRD-C-205 — 课件编辑页（超管/备课后台，UmoEditor readOnly:false）
        {
          path: '/kg-lecture-edit',
          name: 'KgLectureEdit',
          component: () => import('@/views/kg-lecture-edit/index.vue'),
        },
        // 🔴 PRD-C-207 — 讲义浏览器（片段汇聚 + 三栏只读；替代 /kg-lecture 入口）
        {
          path: '/lecture-hub',
          name: 'LectureHub',
          component: () => import('@/views/lecture-hub/index.vue'),
        },
        // PRD-C-211 — 系统管理中心（B 线 admin 系统管理直接移植）；壳=左菜单+右内容区。
        // 页面级权限=superadmin/org_admin 双保险；子路由 meta.perms= RuoYi 权限串（守卫比对 /getInfo 拉回的 permissions）。
        {
          path: '/manage',
          name: 'ManageCenter',
          component: () => import('@/views/manage/index.vue'),
          meta: { roles: ['superadmin', 'org_admin'] },
          redirect: '/manage/user',
          children: [
            { path: 'user', name: 'ManageUser', component: () => import('@/views/manage/system/user/index.vue'), meta: { perms: ['system:user:list'] } },
            { path: 'user-auth/role/:userId', name: 'ManageUserAuthRole', component: () => import('@/views/manage/system/user/authRole.vue'), meta: { perms: ['system:user:edit'] } },
            { path: 'role', name: 'ManageRole', component: () => import('@/views/manage/system/role/index.vue'), meta: { perms: ['system:role:list'] } },
            { path: 'role-auth/user/:roleId', name: 'ManageRoleAuthUser', component: () => import('@/views/manage/system/role/authUser.vue'), meta: { perms: ['system:role:edit'] } },
            { path: 'menu', name: 'ManageMenu', component: () => import('@/views/manage/system/menu/index.vue'), meta: { perms: ['system:menu:list'] } },
            { path: 'dept', name: 'ManageDept', component: () => import('@/views/manage/system/dept/index.vue'), meta: { perms: ['system:dept:list'] } },
            { path: 'post', name: 'ManagePost', component: () => import('@/views/manage/system/post/index.vue'), meta: { perms: ['system:post:list'] } },
            { path: 'dict', name: 'ManageDict', component: () => import('@/views/manage/system/dict/index.vue'), meta: { perms: ['system:dict:list'] } },
            { path: 'config', name: 'ManageConfig', component: () => import('@/views/manage/system/config/index.vue'), meta: { perms: ['system:config:list'] } },
            { path: 'notice', name: 'ManageNotice', component: () => import('@/views/manage/system/notice/index.vue'), meta: { perms: ['system:notice:list'] } },
            { path: 'operlog', name: 'ManageOperlog', component: () => import('@/views/manage/system/log/operlog.vue'), meta: { perms: ['monitor:operlog:list'] } },
            { path: 'logininfor', name: 'ManageLogininfor', component: () => import('@/views/manage/system/log/logininfor.vue'), meta: { perms: ['monitor:logininfor:list'] } },
            { path: 'oss', name: 'ManageOss', component: () => import('@/views/manage/system/oss/index.vue'), meta: { perms: ['system:oss:list'] } },
            { path: 'oss-config', name: 'ManageOssConfig', component: () => import('@/views/manage/system/oss/config.vue'), meta: { perms: ['system:ossConfig:list'] } },
            { path: 'client', name: 'ManageClient', component: () => import('@/views/manage/system/client/index.vue'), meta: { perms: ['system:client:list'] } },
          ],
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
    // PRD-C-110 B1 — geo-engine 引擎自检页（无 layout，免登录；懒加载，prod 不打进首屏 chunk）
    {
      path: '/geo-engine-test',
      name: 'GeoEngineTest',
      component: () => import('@/views/dev/GeoEngineTest.vue'),
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
    // PRD-C-212 D5 — 游客可漫游白名单页（个人化子请求由 http/request 游客态 401 静默兜底）
    if (isGuestBrowsable(to.path)) {
      return true
    }
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

  // PRD-C-211 — 管理中心：进 /manage/* 前拉一次 RuoYi /getInfo（roles+permissions，
  // v-hasPermi 指令与左菜单显隐的数据源），并按子路由 meta.perms 拦截越权直达
  // （org_admin 直敲 /manage/role → 弹回自己第一个可见模块）。
  if (to.path.startsWith('/manage')) {
    // PRD-C-212 V0：管理台地基（svg雪碧图/globalProperties/v-hasPermi）懒装载，
    // 首次进 /manage 才拉 chunk；app 实例走动态 import 取，避免 main↔router 静态环
    const { app } = await import('../main')
    await ensureAdminFoundation(app)
    const adminStore = useAdminUserStore()
    try {
      await adminStore.fetchInfo()
    } catch (e) {
      console.warn('[router] /getInfo 拉取失败:', e)
    }
    const perms = to.meta.perms as string[] | undefined
    if (perms && perms.length > 0) {
      const ok = adminStore.permissions.some((p) => p === '*:*:*' || perms.includes(p))
      if (!ok) {
        return to.path === '/manage/user' ? { path: NO_PERMISSION_REDIRECT } : { path: '/manage/user' }
      }
    }
  }

  return true
})

export default router
