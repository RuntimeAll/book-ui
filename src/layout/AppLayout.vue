<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionBasket from '@/components/business/QuestionBasket/index.vue'
import PaperBasketFab from '@/components/business/PaperBasketFab/index.vue'
import { useUserStore } from '@/store/user'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

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
  router.push('/login')
}

function handleDropdownCommand(command: string) {
  if (command === 'profile') {
    router.push('/user/profile')
  } else if (command === 'logout') {
    handleLogout()
  }
}

interface MenuItem {
  label: string
  path: string
  /** PRD-A-005 T2 — 可见角色 role_key 集合；省略 = 任意已登录用户可见 */
  roles?: string[]
}

const allMenuItems: MenuItem[] = [
  { label: '首页', path: '/home' },
  { label: '我的工作台', path: '/workspace' },                  // U-3 教师工作台聚合页
  { label: '卷库', path: '/papers/index' },
  { label: '题库', path: '/question/index' },
  // 资料库：用户 2026-06-04 拍板「暂时隐藏不做开发」→ 菜单隐藏，路由 /materials/index 保留备用。
  // { label: '资料库', path: '/materials/index' },
  // 管理控制台：纯占位无业务（原 PRD-A-005「按角色显隐」示范页），用户 2026-06-04 拍板移除（菜单+路由一并清）。
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

// U 卡顺手实装 P-2 — 试题栏 FAB 路由白名单（仅题库 / 卷库 / 工作台显示）。
// Q 卡正式排除 /question/compose（工作台自身已展示题目列表，FAB 嵌套冗余）。
const showQuestionBasket = computed(() => {
  if (route.path === '/question/compose') {
    return false
  }
  return route.path.startsWith('/question/')
    || route.path.startsWith('/papers/')
    || route.path === '/workspace'
})

// PRD-001 — 旧绿色试卷篮 FAB/dialog(818 行)已下线，功能迁入 /papers/basket 三栏工作台。
//   usePaperBasket 状态 composable 保留(外层"加入试卷篮"入口 + 工作台共享态)。
// PRD-001 回归补丁 — 新增轻量绿色试卷篮 FAB(仅入口+角标，点击跳工作台，不复活旧 dialog)。
//   白名单同试题栏(题库/卷库/工作台)，但在工作台本页隐藏(避免"点了进当前页")。
const showPaperBasketFab = computed(() => {
  if (route.path === '/papers/basket') {
    return false
  }
  return route.path.startsWith('/question/')
    || route.path.startsWith('/papers/')
    || route.path === '/workspace'
})

function handleUpgrade() {
  ElMessage.info('升级会员功能开发中')
}
</script>

<template>
  <el-container class="app-container" direction="vertical" style="height: 100vh;">
    <!-- TopBar -->
    <el-header class="app-header" height="60px">
      <div class="header-inner">
        <!-- Logo 区 -->
        <div class="logo-area">
          <div class="logo-icon">
            <img src="/icon.png" alt="AI·备课助手" class="logo-img" />
          </div>
          <div class="logo-text-group">
            <span class="logo-title"><span class="logo-ai">AI</span>·备课助手</span>
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
            {{ item.label }}
          </span>
        </nav>

        <!-- Right actions -->
        <div class="header-right">
          <el-button
            class="upgrade-btn"
            size="small"
            @click="handleUpgrade"
          >
            <el-icon size="13" style="margin-right: 4px;"><Star /></el-icon>
            升级会员
          </el-button>
          <!-- U-hotfix — avatar 改 dropdown，含"退出登录" -->
          <el-dropdown trigger="click" placement="bottom-end" @command="handleDropdownCommand">
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

    <!-- 全局试题栏（U 卡 P-2 — 路由白名单：仅题库 / 卷库 / 工作台显示，登录 / home 隐藏） -->
    <QuestionBasket v-if="showQuestionBasket" />

    <!-- 全局试卷篮入口 FAB（PRD-001 回归补丁 — 绿色，点击跳 /papers/basket 三栏工作台） -->
    <PaperBasketFab v-if="showPaperBasketFab" />
  </el-container>
</template>

<style scoped>
.app-container {
  background: #f5f8f8;
}

/* ── 顶栏 ── */
.app-header {
  background: #ffffff;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.06);
  padding: 0 24px;
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
  gap: 16px;
}

/* ── Logo ── */
.logo-area {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  text-decoration: none;
  margin-right: 8px;
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

/* "AI" 二字 violet-600 点睛（AI 在场，DESIGN §2.2） */
.logo-ai {
  color: #7b6cf0;
  font-weight: 600;
}

/* ── 导航菜单 ── */
.nav-menu {
  display: flex;
  gap: 2px;
  flex: 1;
  align-items: center;
  height: 60px;
}

.nav-item {
  position: relative;
  padding: 0 14px;
  height: 60px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 14px;
  color: #4e5969;
  font-weight: 400;
  white-space: nowrap;
  transition: all 0.2s ease;
  border-bottom: 2px solid transparent;
}

.nav-item:hover {
  color: #1E8A8A;
  background: rgba(30, 138, 138, 0.04);
}

.nav-item.active {
  color: #1E8A8A;
  font-weight: 600;
  border-bottom-color: #1E8A8A;
  background: rgba(30, 138, 138, 0.04);
}

/* ── 右侧操作区 ── */
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.upgrade-btn {
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  border: none;
  color: #fff;
  font-size: 13px;
  border-radius: 6px;
  padding: 0 14px;
  height: 32px;
  box-shadow: 0 2px 6px rgba(30, 138, 138, 0.28);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

.upgrade-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(30, 138, 138, 0.4);
  background: linear-gradient(135deg, #2BA3A3, #176E6E) !important;
  border: none !important;
  color: #fff !important;
}

.avatar-wrap {
  position: relative;
  cursor: pointer;
}

.user-avatar {
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s ease;
  cursor: pointer;
}

.avatar-wrap:hover .user-avatar {
  box-shadow: 0 0 0 3px rgba(30, 138, 138, 0.2);
}

/* ── 主内容区 ── */
.app-main {
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
</style>
