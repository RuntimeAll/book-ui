<script setup lang="ts">
/**
 * 备课台 · 概览分区（PRD-C-212 V1）。
 *
 * - 顶部问候：按时段 + userInfo.realName||userName 兜底"老师"。
 * - 三张统计卡：均走已有业务接口（questionPage mine / getPaperPage scope=mine / favoritePage），
 *   无游离造接口；请求走 src/http/request 业务轨，失败静默（catch 后占位"—"，不额外弹错）。
 * - 「最近动态」暂无可用的动态流接口 → 落静态快捷入口卡（去题库逛逛 / 组一张卷 / 试试举一反三）。
 * - 跳转一律走 /desk/* 新路径。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { questionPage, favoritePage } from '@/api/question'
import { getPaperPage } from '@/api/paper'

const router = useRouter()
const userStore = useUserStore()

// ── 顶部问候 ────────────────────────────────────────────────
const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
})
const displayName = computed(
  () => userStore.userInfo?.realName || userStore.userInfo?.userName || '老师',
)

// ── 三张统计卡（均走现成接口；拉不到就占位 "—"，不阻塞页面）────────────
const questionTotal = ref<number | null>(null)
const paperTotal = ref<number | null>(null)
const favoriteTotal = ref<number | null>(null)
const statsLoading = ref(false)

async function fetchStats() {
  statsLoading.value = true
  const results = await Promise.allSettled([
    // 我的题库题数：questionPage(mine:true) 的 total
    questionPage({ pageIndex: 1, pageSize: 1, mine: true }),
    // 我创建的试卷数：getPaperPage(scope:'mine') 的 total
    getPaperPage({ pageIndex: 1, pageSize: 1, scope: 'mine' }),
    // 我的收藏题数：favoritePage 的 total
    favoritePage({ pageNum: 1, pageSize: 1 }),
  ])
  questionTotal.value = results[0].status === 'fulfilled' ? (results[0].value?.total ?? 0) : null
  paperTotal.value = results[1].status === 'fulfilled' ? (results[1].value?.total ?? 0) : null
  favoriteTotal.value = results[2].status === 'fulfilled' ? (results[2].value?.total ?? 0) : null
  statsLoading.value = false
}

interface StatCard {
  label: string
  value: () => number | null
  path: string
}

const statCards: StatCard[] = [
  { label: '我的题库', value: () => questionTotal.value, path: '/desk/my-question' },
  { label: '我创建的试卷', value: () => paperTotal.value, path: '/desk/workspace' },
  { label: '我的收藏', value: () => favoriteTotal.value, path: '/desk/favorites' },
]

function goCard(path: string) {
  router.push(path)
}

// ── 「最近动态」— 无现成动态流接口，静态快捷入口卡（TODO：后端有动态流接口后替换为真数据）────
const quickEntries = [
  { title: '去题库逛逛', desc: '到公共题库按章节找找好题', path: '/question/index' },
  { title: '组一张卷', desc: '进组卷工作台，从零攒一份新卷', path: '/papers/workbench' },
  { title: '试试举一反三', desc: '拍一道题，备课帮帮你出变式', path: '/desk/ai-variant' },
]

function goQuick(path: string) {
  router.push(path)
}

onMounted(async () => {
  // 刷新页面后 userInfo 内存态丢失（auth 持久化，userInfo 不持久化）——必须兜底拉一次
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[desk-overview] getCurrentUser 兜底失败', e)
    }
  }
  await fetchStats()
})
</script>

<template>
  <div class="dk-overview">
    <header class="dk-greeting">
      <h1 class="dk-greeting-title">{{ greeting }}，{{ displayName }} 老师</h1>
      <p class="dk-greeting-sub">这里是你的备课台，题库 / 试卷 / 举一反三 / 几何画板 / 收藏一站直达</p>
    </header>

    <section class="dk-stats" v-loading="statsLoading">
      <div
        v-for="card in statCards"
        :key="card.path"
        class="dk-stat-card"
        @click="goCard(card.path)"
      >
        <div class="dk-stat-value">{{ card.value() ?? '—' }}</div>
        <div class="dk-stat-label">{{ card.label }}</div>
      </div>
    </section>

    <section class="dk-recent">
      <h2 class="dk-recent-title">最近动态</h2>
      <div class="dk-quick-grid">
        <div
          v-for="q in quickEntries"
          :key="q.path"
          class="dk-quick-card"
          @click="goQuick(q.path)"
        >
          <div class="dk-quick-title">{{ q.title }}</div>
          <div class="dk-quick-desc">{{ q.desc }}</div>
          <el-icon class="dk-quick-arrow"><ArrowRight /></el-icon>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dk-overview {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.dk-greeting-title {
  font-size: 20px;
  font-weight: 700;
  color: #13312b;
  margin: 0 0 6px;
}

.dk-greeting-sub {
  font-size: 13px;
  color: #6b7a77;
  margin: 0;
}

.dk-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.dk-stat-card {
  background: #fff;
  border: 1px solid #e5ebe9;
  border-radius: 12px;
  padding: 18px 20px;
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}

.dk-stat-card:hover {
  border-color: #0f766e;
  box-shadow: 0 2px 8px rgba(15, 118, 110, .08);
}

.dk-stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #0f766e;
  line-height: 1.3;
}

.dk-stat-label {
  font-size: 13px;
  color: #6b7a77;
  margin-top: 4px;
}

.dk-recent-title {
  font-size: 15px;
  font-weight: 700;
  color: #13312b;
  margin: 0 0 12px;
}

.dk-quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.dk-quick-card {
  position: relative;
  background: #fff;
  border: 1px solid #e5ebe9;
  border-radius: 12px;
  padding: 16px 18px;
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}

.dk-quick-card:hover {
  border-color: #0f766e;
  box-shadow: 0 2px 8px rgba(15, 118, 110, .08);
}

.dk-quick-title {
  font-size: 14px;
  font-weight: 600;
  color: #13312b;
  margin-bottom: 4px;
}

.dk-quick-desc {
  font-size: 12px;
  color: #6b7a77;
  padding-right: 20px;
}

.dk-quick-arrow {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: #0f766e;
  font-size: 14px;
}
</style>
