<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionBasket from '@/components/business/QuestionBasket/index.vue'
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
  if (command === 'logout') {
    handleLogout()
  }
}

interface MenuItem {
  label: string
  path: string
  /** U 卡新增 — 是否仅 admin/superadmin 才可见（教师视角隐藏占位空壳） */
  adminOnly?: boolean
}

const menuItems: MenuItem[] = [
  { label: '首页', path: '/home' },
  { label: '我的工作台', path: '/workspace' },                  // U-3 教师工作台聚合页
  { label: '作业管理', path: '/assignment/index', adminOnly: true },
  { label: '学生管理', path: '/student/index', adminOnly: true },
  { label: '班级管理', path: '/class/index', adminOnly: true },
  { label: '卷库', path: '/papers/index' },
  { label: '题库', path: '/question/index' },
  { label: '资料库', path: '/materials/index' },
]

// U 卡新增 — 按角色过滤菜单：
//   - admin/superadmin → 全部菜单可见（向后兼容）
//   - teacher          → 隐藏 adminOnly 项（作业 / 学生 / 班级 — 占位空壳，不属教师场景）
//   - 未拉到角色（store 空）→ 退化为 admin 视角全显（避免首次加载闪烁缺菜单）
const visibleMenuItems = computed(() => {
  const roles = userStore.roles ?? []
  // 老师身份 + 不是 admin/superadmin → 隐 adminOnly
  if (roles.includes('teacher') && !roles.includes('admin') && !roles.includes('superadmin')) {
    return menuItems.filter(m => !m.adminOnly)
  }
  return menuItems
})

function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path.replace('/index', ''))
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

// PRD-001 — 旧绿色试卷篮 FAB/dialog 已下线（功能迁入 /papers/basket 三栏工作台）。
//   usePaperBasket 状态 composable 保留(外层"加入试卷篮"入口 + 工作台共享态)。

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
            <el-icon :size="22" color="#4080ff"><Collection /></el-icon>
          </div>
          <div class="logo-text-group">
            <span class="logo-title">misikt 题库系统</span>
            <span class="logo-subtitle">Teacher Workspace</span>
          </div>
        </div>

        <!-- Navigation Menu -->
        <nav class="nav-menu">
          <span
            v-for="item in visibleMenuItems"
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
                <el-dropdown-item divided command="logout">
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
  </el-container>
</template>

<style scoped>
.app-container {
  background: #f0f2f5;
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
  background: linear-gradient(135deg, #e8f0ff, #d0e2ff);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.logo-text-group {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.logo-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
  letter-spacing: -0.2px;
}

.logo-subtitle {
  font-size: 10px;
  color: #86909c;
  font-weight: 400;
  letter-spacing: 0.5px;
  text-transform: uppercase;
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
  color: #4080ff;
  background: rgba(64, 128, 255, 0.04);
}

.nav-item.active {
  color: #4080ff;
  font-weight: 600;
  border-bottom-color: #4080ff;
  background: rgba(64, 128, 255, 0.04);
}

/* ── 右侧操作区 ── */
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.upgrade-btn {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  border: none;
  color: #fff;
  font-size: 13px;
  border-radius: 6px;
  padding: 0 14px;
  height: 32px;
  box-shadow: 0 2px 6px rgba(64, 128, 255, 0.28);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

.upgrade-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(64, 128, 255, 0.4);
  background: linear-gradient(135deg, #5090ff, #4080ee) !important;
  border: none !important;
  color: #fff !important;
}

.avatar-wrap {
  position: relative;
  cursor: pointer;
}

.user-avatar {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s ease;
  cursor: pointer;
}

.avatar-wrap:hover .user-avatar {
  box-shadow: 0 0 0 3px rgba(64, 128, 255, 0.2);
}

/* ── 主内容区 ── */
.app-main {
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
</style>
