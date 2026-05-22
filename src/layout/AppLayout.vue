<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import QuestionBasket from '@/components/business/QuestionBasket/index.vue'

const router = useRouter()
const route = useRoute()

interface MenuItem {
  label: string
  path: string
}

const menuItems: MenuItem[] = [
  { label: '首页', path: '/home' },
  { label: '作业管理', path: '/assignment/index' },
  { label: '学生管理', path: '/student/index' },
  { label: '班级管理', path: '/class/index' },
  { label: '卷库', path: '/papers/index' },
  { label: '题库', path: '/question/index' },
  { label: '资料库', path: '/materials/index' },
]

function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path.replace('/index', ''))
}

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
          <div class="avatar-wrap">
            <el-avatar
              :size="34"
              class="user-avatar"
            >
              师
            </el-avatar>
          </div>
        </div>
      </div>
    </el-header>

    <!-- Main Content -->
    <el-main class="app-main">
      <RouterView />
    </el-main>

    <!-- 全局试题栏（FAB + dialog，AppLayout 内挂一次，所有子路由共享） -->
    <QuestionBasket />
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
