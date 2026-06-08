<script setup lang="ts">
import { useRouter } from 'vue-router'

interface Props {
  title: string
}

defineProps<Props>()

const router = useRouter()
</script>

<template>
  <div class="placeholder-container">
    <div class="placeholder-card">
      <!-- 图标区 -->
      <div class="placeholder-icon-wrap">
        <el-icon class="placeholder-icon"><Document /></el-icon>
        <div class="icon-ring ring-1"></div>
        <div class="icon-ring ring-2"></div>
      </div>

      <!-- 文字区 -->
      <h2 class="placeholder-title">{{ title }}</h2>
      <p class="placeholder-subtitle">功能开发中，敬请期待</p>
      <p class="placeholder-desc">该模块正在紧张开发中，即将与您见面</p>

      <!-- CTA 按钮 -->
      <el-button
        type="primary"
        class="placeholder-cta"
        @click="router.push('/question/index')"
      >
        <el-icon><Collection /></el-icon>
        返回题库
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.placeholder-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: calc(100vh - 60px);
  background: #f0f2f5;
  padding: 40px 24px;
}

.placeholder-card {
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid #f2f3f5;
  padding: 56px 48px 48px;
  text-align: center;
  box-shadow: 0 4px 24px rgba(30, 138, 138, 0.08);
  max-width: 440px;
  width: 100%;
  position: relative;
  overflow: hidden;
}

.placeholder-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #1E8A8A, #0E9F6E);
  border-radius: 16px 16px 0 0;
}

/* ── 图标区 ── */
.placeholder-icon-wrap {
  position: relative;
  width: 96px;
  height: 96px;
  margin: 0 auto 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-icon {
  font-size: 44px;
  color: #1E8A8A;
  position: relative;
  z-index: 3;
}

.icon-ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid rgba(30, 138, 138, 0.15);
  animation: pulse-ring 2.5s ease-in-out infinite;
}

.ring-1 {
  width: 72px;
  height: 72px;
  animation-delay: 0s;
}

.ring-2 {
  width: 96px;
  height: 96px;
  animation-delay: 0.5s;
}

@keyframes pulse-ring {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.08); opacity: 0.2; }
}

/* ── 文字区 ── */
.placeholder-title {
  font-size: 22px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 10px;
  letter-spacing: -0.3px;
}

.placeholder-subtitle {
  font-size: 15px;
  color: #1E8A8A;
  font-weight: 500;
  margin: 0 0 8px;
}

.placeholder-desc {
  font-size: 13px;
  color: #86909c;
  margin: 0 0 32px;
  line-height: 1.6;
}

/* ── CTA 按钮 ── */
.placeholder-cta {
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  border: none;
  border-radius: 8px;
  height: 40px;
  padding: 0 24px;
  font-weight: 600;
  font-size: 14px;
  box-shadow: 0 3px 10px rgba(30, 138, 138, 0.3);
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.placeholder-cta:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(30, 138, 138, 0.45);
  background: linear-gradient(135deg, #2BA3A3, #176E6E) !important;
  border: none !important;
}
</style>
