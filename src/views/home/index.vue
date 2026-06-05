<script setup lang="ts">
/**
 * 首页（home）—— A 线 N1 去 misikt 化的门面页（用户 2026-06-04 拍板「做个真首页」）。
 *
 * 定位：浅做。北极星 = 教培老师的 AI 命题 / 备课外脑（放大老师判断，不替代）。
 * 本页只承担「欢迎 + 理念 + 快捷入口」三件事；将来会切换成 AI Agent 聊天页（故 AI 区先放预告）。
 * 不深入做复杂仪表盘 / 数据统计 —— 那不是本期重点。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Notebook,
  Files,
  EditPen,
  Star,
  Search,
  MagicStick,
  ArrowRight,
} from '@element-plus/icons-vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

const router = useRouter()
const userStore = useUserStore()

// 称呼：优先真名，兜底用户名 —— userInfo 内存态刷新会丢，onMounted 兜底拉一次
const displayName = computed(
  () => userStore.userInfo?.realName || userStore.userInfo?.userName || '老师',
)

onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch {
      // 静默兜底失败：首页仍可用，称呼退化为「老师」
    }
  }
})

function go(path: string) {
  router.push(path)
}

// 快捷入口卡片（指向地基功能：找题 → 组卷 → 导出 闭环 + 收藏）
const quickCards = [
  { key: 'question', title: '题库', desc: '多维筛选找题，加入试题栏', icon: Notebook, path: '/question/index', accent: '#4080ff' },
  { key: 'papers', title: '卷库', desc: '公共试卷 · 专题卷库 · 我的卷库', icon: Files, path: '/papers/index', accent: '#16a34a' },
  { key: 'workbench', title: '组卷工作台', desc: '拖拽排序 · 分值 · 导出 PDF', icon: EditPen, path: '/papers/workbench', accent: '#f59e0b' },
  { key: 'favorites', title: '我的收藏', desc: '收藏的题目，随时取用', icon: Star, path: '/favorites/index', accent: '#e0529c' },
]
</script>

<template>
  <div class="home-page">
    <!-- ══ Hero 区 ══ -->
    <section class="hero">
      <div class="hero-inner">
        <p class="hero-greeting">欢迎回来，{{ displayName }} 👋</p>
        <h1 class="hero-title">你的 AI 命题 · 备课外脑</h1>
        <p class="hero-slogan">
          像写代码一样备课命题 —— 思路看得见、随时介入矫正，方向始终在你手里。
          <br />放大你的判断，而不替代。
        </p>
        <div class="hero-actions">
          <el-button type="primary" size="large" class="hero-btn" @click="go('/question/index')">
            <el-icon class="btn-icon"><Search /></el-icon>
            开始找题
          </el-button>
          <el-button size="large" class="hero-btn hero-btn--ghost" @click="go('/papers/index')">
            浏览卷库
            <el-icon class="btn-icon-r"><ArrowRight /></el-icon>
          </el-button>
        </div>
      </div>
    </section>

    <!-- ══ 快捷入口 ══ -->
    <section class="quick-section">
      <h2 class="section-title">快捷入口</h2>
      <div class="quick-grid">
        <div
          v-for="card in quickCards"
          :key="card.key"
          class="quick-card"
          @click="go(card.path)"
        >
          <div class="quick-icon" :style="{ background: card.accent + '18', color: card.accent }">
            <el-icon :size="24"><component :is="card.icon" /></el-icon>
          </div>
          <div class="quick-body">
            <span class="quick-title">{{ card.title }}</span>
            <span class="quick-desc">{{ card.desc }}</span>
          </div>
          <el-icon class="quick-arrow"><ArrowRight /></el-icon>
        </div>
      </div>
    </section>

    <!-- ══ AI 预告（呼应将来 Agent 聊天页）══ -->
    <section class="ai-teaser">
      <div class="ai-teaser-inner">
        <div class="ai-teaser-icon">
          <el-icon :size="26"><MagicStick /></el-icon>
        </div>
        <div class="ai-teaser-text">
          <span class="ai-teaser-title">AI 备课助手 · 正在路上</span>
          <span class="ai-teaser-desc">平行出卷、举一反三、专项命题 —— 让 AI 成为你的命题搭子</span>
        </div>
        <el-tag type="warning" effect="plain" round size="large" class="ai-teaser-tag">即将上线</el-tag>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 24px 48px;
}

/* ── Hero ── */
.hero {
  background: linear-gradient(135deg, #4080ff 0%, #5b8def 50%, #6d6df5 100%);
  border-radius: 18px;
  padding: 48px 44px;
  color: #fff;
  box-shadow: 0 12px 32px rgba(64, 128, 255, 0.25);
  position: relative;
  overflow: hidden;
}

.hero::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -60px;
  width: 240px;
  height: 240px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 50%;
}

.hero-inner {
  position: relative;
  z-index: 1;
}

.hero-greeting {
  font-size: 15px;
  opacity: 0.9;
  margin-bottom: 10px;
}

.hero-title {
  font-size: 34px;
  font-weight: 800;
  margin: 0 0 14px;
  letter-spacing: 0.5px;
}

.hero-slogan {
  font-size: 15px;
  line-height: 1.8;
  opacity: 0.92;
  max-width: 620px;
  margin-bottom: 28px;
}

.hero-actions {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.hero-btn {
  font-weight: 600;
  border-radius: 10px;
  padding: 0 22px;
}

.hero-btn .btn-icon {
  margin-right: 6px;
}

.hero-btn .btn-icon-r {
  margin-left: 6px;
}

/* 主按钮：白底蓝字（在蓝色 hero 上更突出） */
.hero-btn.el-button--primary {
  background: #fff;
  color: #3370e8;
  border-color: #fff;
}

.hero-btn.el-button--primary:hover {
  background: #f0f5ff;
  color: #2c5fd0;
  border-color: #f0f5ff;
}

/* 次按钮：透明描边白字 */
.hero-btn--ghost {
  background: transparent;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.6);
}

.hero-btn--ghost:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border-color: #fff;
}

/* ── 快捷入口 ── */
.quick-section {
  margin-top: 36px;
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 18px;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.quick-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border: 1px solid #f0f1f3;
  border-radius: 14px;
  padding: 18px 18px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.08);
  border-color: #e0e8ff;
}

.quick-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.quick-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.quick-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

.quick-desc {
  font-size: 12px;
  color: #86909c;
  line-height: 1.4;
}

.quick-arrow {
  color: #c9cdd4;
  transition: all 0.2s;
}

.quick-card:hover .quick-arrow {
  color: #4080ff;
  transform: translateX(3px);
}

/* ── AI 预告 ── */
.ai-teaser {
  margin-top: 32px;
}

.ai-teaser-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  background: linear-gradient(135deg, #fff8ec 0%, #fef3f8 100%);
  border: 1px solid #fbe6c9;
  border-radius: 14px;
  padding: 20px 24px;
}

.ai-teaser-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, #f59e0b, #e0529c);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ai-teaser-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.ai-teaser-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

.ai-teaser-desc {
  font-size: 13px;
  color: #86909c;
}

.ai-teaser-tag {
  flex-shrink: 0;
}
</style>
