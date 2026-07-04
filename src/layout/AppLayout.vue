<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import MultiFunctionFab from '@/components/business/MultiFunctionFab/index.vue'
// PRD-C-212 增量：顶栏简笔画线性图标（设计稿-备课台与顶栏-V1 拍板）
import LineIcon, { type LineIconName } from '@/components/LineIcon.vue'
import { useUserStore } from '@/store/user'
import { useLoginDialog } from '@/composables/useLoginDialog'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const loginDialog = useLoginDialog()

// U-hotfix（2026-05-23）— 头像点击展示用户名 + 退出登录选项。
// userName 兜底优先级：realName > userName > "用户"
const displayName = computed(() => {
  const info = userStore.userInfo
  return info?.realName || info?.userName || '用户'
})

const avatarChar = computed(() => {
  const name = displayName.value
  return name ? name.charAt(0).toUpperCase() : '师'
})

async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定退出登录？', '退出确认', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    // 取消
    return
  }
  await userStore.logout()
  ElMessage.success('已退出登录')
  // PRD-C-212 增量：独立 /login 页已下线，退出后回首页（游客可看门面），整页刷清会话内数据
  window.location.hash = '#/home'
  window.location.reload()
}

function handleDropdownCommand(command: string) {
  if (command === 'profile') {
    router.push('/user/profile')
  } else if (command === 'logout') {
    handleLogout()
  }
}

// PRD-C-212 增量 — 游客点「登录」原地弹登录框（登录成功整页刷新当前页，天然"回跳"）
function goLogin() {
  loginDialog.open()
}

interface MenuItem {
  label: string
  path: string
  /** PRD-C-212 增量 — 顶栏简笔图标名（LineIcon） */
  icon: LineIconName
  /** PRD-A-005 T2 — 可见角色 role_key 集合；省略 = 任意已登录用户可见 */
  roles?: string[]
}

// PRD-C-212 D2 — 导航 9→6：工具箱/个人空间四页（工作台/我的题库/举一反三/几何画板+收藏夹）
// 收拢进「备课台」壳（/desk，见 views/desk/index.vue），旧路径全部 redirect（router）。
const allMenuItems: MenuItem[] = [
  { label: '首页', path: '/home', icon: 'home' },
  { label: '题库', path: '/question/index', icon: 'qbank' },
  { label: '卷库', path: '/papers/index', icon: 'papers' },
  { label: '讲义', path: '/lecture-hub', icon: 'lecture' },      // 🔴 PRD-C-207 教辅讲义只读浏览器
  { label: '备课台', path: '/desk', icon: 'desk' },              // 🔴 PRD-C-212 D3 工具箱+个人空间聚合壳
  { label: '管理', path: '/manage', icon: 'manage', roles: ['superadmin', 'org_admin'] },  // PRD-C-211 管理中心
  // 资料库：用户 2026-06-04 拍板「暂时隐藏不做开发」→ 菜单隐藏，路由 /materials/index 保留备用。
]

// PRD-A-005 T2 — 菜单按 userStore.roles 过滤显隐（单一事实源 = store roles）。
// 无 roles 声明的项始终显示；声明了则需与当前用户 roles 有交集。
const menuItems = computed<MenuItem[]>(() =>
  allMenuItems.filter(
    (item) =>
      !item.roles
      || item.roles.length === 0
      || item.roles.some((r) => userStore.roles.includes(r)),
  ),
)

function isActive(path: string): boolean {
  if (route.path === path) return true
  // /papers/index → 匹配 /papers/source/:id 等子页
  if (path === '/papers/index') {
    return route.path.startsWith('/papers/')
  }
  // 通用：去掉 /index 后缀做前缀匹配（题库 /question/index → /question/）
  const base = path.replace('/index', '')
  return base.length > 1 && route.path.startsWith(base)
}

// PRD-A-002 B1 — 多功能球 hub（合并原 试题栏/试卷篮/拆题 三球为一）。
//   显示白名单 = 三球白名单的并集（题库 / 卷库 / 工作台 / 我的题库 / 举一反三）。
//   排除组卷上下文页（/question/compose、/papers/basket、/papers/workbench：已是组题/
//   组卷上下文，球冗余压 CTA）；排除审核页（/ingest/*：已是作业上下文）。
const showMultiFunctionFab = computed(() => {
  if (
    route.path === '/question/compose'
    || route.path === '/papers/basket'
    || route.path.startsWith('/papers/workbench')
    || route.path.startsWith('/ingest/')
  ) {
    return false
  }
  // PRD-C-212 D3 — 工作台/我的题库/举一反三已收进备课台，白名单同步 /desk/* 新路径
  return route.path.startsWith('/question/')
    || route.path.startsWith('/papers/')
    || route.path === '/desk/workspace'
    || route.path === '/desk/my-question'
    || route.path === '/desk/ai-variant'
})
</script>

<template>
  <el-container class="app-container" direction="vertical" style="height: 100vh;">
    <!-- TopBar -->
    <el-header class="app-header" height="60px">
      <div class="header-inner">
        <!-- Logo 区 -->
        <div class="logo-area">
          <div class="logo-icon">
            <img src="/icon.png" alt="AI·备课帮" class="logo-img" />
          </div>
          <div class="logo-text-group">
            <span class="logo-title"><span class="logo-ai">AI</span>·备课帮</span>
          </div>
        </div>

        <!-- Navigation Menu -->
        <nav class="nav-menu">
          <span
            v-for="item in menuItems"
            :key="item.path"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
            @click="router.push(item.path)"
          >
            <LineIcon :name="item.icon" :size="19" class="nav-ico" />
            {{ item.label }}
          </span>
        </nav>

        <!-- Right actions（PRD-C-212 D2：会员体系不做，「升级会员」按钮删除） -->
        <div class="header-right">
          <!-- PRD-C-212 D5 — 游客态：登录/免费注册 替代头像 -->
          <template v-if="!userStore.isLoggedIn">
            <el-button class="guest-login-btn" size="default" text @click="goLogin">登录</el-button>
            <el-button class="guest-register-btn" size="default" type="primary" @click="loginDialog.open({ mode: 'register' })">免费注册</el-button>
          </template>
          <!-- U-hotfix — avatar 改 dropdown，含"退出登录" -->
          <el-dropdown v-if="userStore.isLoggedIn" trigger="click" placement="bottom-end" @command="handleDropdownCommand">
            <div class="avatar-wrap">
              <el-avatar
                :size="34"
                class="user-avatar"
              >
                {{ avatarChar }}
              </el-avatar>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  <span class="dropdown-name">{{ displayName }}</span>
                </el-dropdown-item>
                <el-dropdown-item divided command="profile">
                  <el-icon style="margin-right: 6px;"><User /></el-icon>
                  个人资料
                </el-dropdown-item>
                <el-dropdown-item command="logout">
                  <el-icon style="margin-right: 6px;"><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </el-header>

    <!-- Main Content -->
    <el-main class="app-main">
      <RouterView />
    </el-main>

    <!-- 全局多功能球 hub（PRD-A-002 B1 — 合并 试题栏/试卷篮/拆题 三球为一：
         单击展开 hub（＋录入新题 + 进行中/试题栏/试卷篮 三 tab），收起态球内进度环，可拖动）
         PRD-C-212 D5 — 游客不渲染（球会拉试题栏/试卷篮个人接口，游客态全是 401） -->
    <MultiFunctionFab v-if="userStore.isLoggedIn && showMultiFunctionFab" />
  </el-container>
</template>

<style scoped>
/* 容器透明，让 body 的极淡网格纹理透上来铺满全站背景（DESIGN 数学坐标纸） */
.app-container {
  background: transparent;
}

/* ── 顶栏 ── */
.app-header {
  background: #ffffff;
  /* DESIGN §5.4：1px 冷边 #E3E9E9 + 极淡冷中性阴影（去原 rgba(0,0,0) 黑阴影） */
  border-bottom: 1px solid #e3e9e9;
  box-shadow: 0 1px 3px rgba(29, 42, 46, 0.04);
  padding: 0 28px;
  display: flex;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 1000;
}

.header-inner {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 0;
}

/* ── Logo ── */
.logo-area {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  text-decoration: none;
  /* 拉开 logo 与 nav，避免导航紧贴 logo（DESIGN：秩序留白） */
  margin-right: 36px;
}

.logo-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.logo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.logo-text-group {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.logo-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2a2e;
  letter-spacing: -0.2px;
}

/* "AI" 二字点睛（PRD-C-212 V4：紫色归并进品牌青，全站零紫色） */
.logo-ai {
  color: var(--bk-teal);
  font-weight: 600;
}

/* ── 导航菜单 ── */
.nav-menu {
  display: flex;
  gap: 4px;
  flex: 1;
  align-items: center;
  height: 60px;
}

.nav-item {
  position: relative;
  padding: 0 15px;
  height: 60px;
  display: flex;
  align-items: center;
  gap: 7px; /* PRD-C-212 增量：图标与文字间距 */
  cursor: pointer;
  font-size: 14px;
  color: #536268; /* ink-500 */
  font-weight: 500; /* Medium，更精致 */
  letter-spacing: 0.2px;
  white-space: nowrap;
  transition: color 0.2s ease, background 0.2s ease;
}

/* PRD-C-212 增量：简笔图标默认灰青，hover/选中随文字变教育青并轻微上浮（唯一动效，克制） */
.nav-item :deep(.nav-ico) {
  color: #88a9a5;
  transition: color 0.18s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.nav-item:hover :deep(.nav-ico) {
  color: var(--bk-teal);
  transform: translateY(-1.5px);
}
.nav-item.active :deep(.nav-ico) {
  color: var(--bk-teal);
}

.nav-item:hover {
  color: var(--bk-teal); /* 教育青 */
}

.nav-item.active {
  color: var(--bk-teal); /* 教育青 */
  font-weight: 600;
}

/* active 指示器 = 居中收窄的细青条（替代满宽 2px 底边，更克制细腻） */
.nav-item.active::after {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 12px;
  height: 2px;
  border-radius: 2px;
  background: var(--bk-teal); /* 教育青 */
}

/* ── 右侧操作区 ── */
.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.avatar-wrap {
  position: relative;
  cursor: pointer;
}

/* avatar 实心青保留 + 细白边光圈让它精致（PRD-C-212 V4：教育青系） */
.user-avatar {
  background: linear-gradient(135deg, #14958a, var(--bk-teal));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  border: 2px solid #ffffff;
  box-shadow: 0 0 0 1px #d2dcdc, 0 1px 3px rgba(29, 42, 46, 0.08);
  transition: all 0.2s ease;
  cursor: pointer;
}

.avatar-wrap:hover .user-avatar {
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.18), 0 1px 3px rgba(29, 42, 46, 0.08);
}

/* ── 主内容区 ── */
.app-main {
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
</style>
