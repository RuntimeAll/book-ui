<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { getPaperPage, type PaperListItem } from '@/api/paper'
import { getFavoriteFolderTree, type FavoriteFolder } from '@/api/question'

// U 卡 段④ — 教师"我的工作台"聚合页（PRD §0.1 U-3）。
//
// 2 个 section：
//   ① 我创建的卷：调 paper/page + createBy=teacherUserId 拿前 5 条
//   ② 我的收藏：调 q-folder/tree 拿收藏夹 + 总 count
//
// 设计原则：
//   - 任一 section 拉取失败 → 该 section 显示空态文案 + 错误兜底（不阻塞其他 section）
//   - userStore.userInfo 未就绪 → 重新拉一次 getCurrentUser（兜底 — 直接访问 /workspace 而非登录跳转的场景）

const router = useRouter()
const userStore = useUserStore()

// section 1 — 我创建的卷
const myPapers = ref<PaperListItem[]>([])
const myPapersLoading = ref(false)
const myPapersTotal = ref(0)

// section 2 — 我的收藏
const favoriteFolders = ref<FavoriteFolder[]>([])
const favoriteLoading = ref(false)
const favoriteTotal = ref(0)

async function fetchMyPapers() {
  const uid = userStore.userInfo?.id
  if (!uid) {
    return
  }
  myPapersLoading.value = true
  try {
    const result = await getPaperPage({
      pageIndex: 1,
      pageSize: 5,
      createBy: String(uid),
    })
    myPapers.value = result?.list ?? []
    myPapersTotal.value = result?.total ?? 0
  } catch {
    // 兜底：保持空态，section 仍渲染
    myPapers.value = []
    myPapersTotal.value = 0
  } finally {
    myPapersLoading.value = false
  }
}

async function fetchFavoriteFolders() {
  favoriteLoading.value = true
  try {
    const result = await getFavoriteFolderTree()
    favoriteFolders.value = Array.isArray(result) ? result : []
    // 累计所有夹的 count（v1：BE 返单条 mock 我的试题 count=0，仍渲染）
    favoriteTotal.value = favoriteFolders.value.reduce((sum, f) => sum + (f.count ?? 0), 0)
  } catch {
    favoriteFolders.value = []
    favoriteTotal.value = 0
  } finally {
    favoriteLoading.value = false
  }
}

function goPaperDetail(paper: PaperListItem) {
  router.push(`/papers/source/${paper.id}`)
}

function goPaperList() {
  // 「我的卷库」是卷库左侧目录树底部的合成节点，带 ?mine=1 进入卷库页自动选中该节点
  router.push('/papers/index?mine=1')
}

// PRD-A-005 T6 — 进入收藏管理页
function goFavorites() {
  router.push('/favorites/index')
}

function goCreatePaper() {
  // Q 卡已上线 — 跳题库选题（试题栏 → 去组卷 → 工作台）
  router.push('/question/index')
}

onMounted(async () => {
  // Q-hotfix（2026-05-23）真兜底 — 刷新页面后 userInfo 内存态丢失（auth 在 LS 持久化，userInfo 不持久化）
  // 必须先 getCurrentUser 拉 userInfo，否则 fetchMyPapers 在 uid=undefined 时 early return → 列表永远空
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) {
        userStore.setUserInfo(info)
      }
    } catch (e) {
      console.warn('[workspace] getCurrentUser 兜底失败', e)
    }
  }
  await Promise.all([fetchMyPapers(), fetchFavoriteFolders()])
})
</script>

<template>
  <div class="workspace-page">
    <!-- 头部欢迎 -->
    <header class="workspace-header">
      <div>
        <h1 class="title">
          {{ userStore.userInfo?.realName || userStore.userInfo?.userName || '老师' }}，欢迎回来
        </h1>
        <p class="subtitle">这里是你的个人工作台 — 一站式管理你的卷 / 收藏</p>
      </div>
      <el-button type="primary" @click="goCreatePaper">
        <el-icon><Plus /></el-icon>
        新建试卷
      </el-button>
    </header>

    <!-- 4 section 网格 -->
    <main class="sections-grid">
      <!-- section 1 — 我创建的卷 -->
      <section class="section-card">
        <div class="section-header">
          <div class="section-title">
            <el-icon class="section-icon" color="#4080ff"><Document /></el-icon>
            <span>我创建的卷</span>
            <el-tag size="small" type="info">{{ myPapersTotal }} 份</el-tag>
          </div>
          <el-button link type="primary" @click="goPaperList">
            查看更多
            <el-icon><ArrowRight /></el-icon>
          </el-button>
        </div>
        <div v-loading="myPapersLoading" class="section-body">
          <ul v-if="myPapers.length > 0" class="paper-list">
            <li
              v-for="paper in myPapers"
              :key="paper.id"
              class="paper-item"
              @click="goPaperDetail(paper)"
            >
              <div class="paper-name">{{ paper.name }}</div>
              <div class="paper-meta">
                <span>{{ paper.questionCount }} 题</span>
                <span>·</span>
                <span>{{ paper.score }} 分</span>
                <span>·</span>
                <span>{{ paper.createTime }}</span>
              </div>
            </li>
          </ul>
          <el-empty
            v-else
            description="还没有创建过试卷"
            :image-size="60"
          >
            <el-button size="small" type="primary" @click="goCreatePaper">
              去新建
            </el-button>
          </el-empty>
        </div>
      </section>

      <!-- section 2 — 我的收藏 -->
      <section class="section-card">
        <div class="section-header">
          <div class="section-title">
            <el-icon class="section-icon" color="#f59e0b"><Star /></el-icon>
            <span>我的收藏</span>
            <el-tag size="small" type="warning">{{ favoriteTotal }} 题</el-tag>
          </div>
          <el-button link type="primary" @click="goFavorites">
            收藏管理
            <el-icon><ArrowRight /></el-icon>
          </el-button>
        </div>
        <div v-loading="favoriteLoading" class="section-body">
          <ul v-if="favoriteFolders.length > 0" class="folder-list">
            <li
              v-for="folder in favoriteFolders"
              :key="folder.id"
              class="folder-item"
            >
              <el-icon color="#f59e0b"><Folder /></el-icon>
              <span class="folder-name">{{ folder.name }}</span>
              <el-tag size="small" type="info">{{ folder.count ?? 0 }}</el-tag>
            </li>
          </ul>
          <el-empty
            v-else
            description="还没有收藏任何题目"
            :image-size="60"
          />
        </div>
      </section>

    </main>
  </div>
</template>

<style scoped>
.workspace-page {
  padding: 24px 32px;
  max-width: 1280px;
  margin: 0 auto;
}

.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 28px;
  background: linear-gradient(135deg, #e8f0ff 0%, #f5f8ff 100%);
  border-radius: 12px;
  margin-bottom: 24px;
}

.workspace-header .title {
  font-size: 22px;
  font-weight: 600;
  color: #1d2129;
  margin: 0 0 8px;
}

.workspace-header .subtitle {
  font-size: 13px;
  color: #4e5969;
  margin: 0;
}

.sections-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 20px;
}

.section-card {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  min-height: 280px;
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f2f5;
  margin-bottom: 16px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: #1d2129;
}

.section-icon {
  font-size: 18px;
}

.section-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.paper-list,
.folder-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.paper-item {
  padding: 12px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.paper-item:hover {
  background: #f5f8ff;
}

.paper-name {
  font-size: 13px;
  font-weight: 500;
  color: #1d2129;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paper-meta {
  font-size: 12px;
  color: #86909c;
  display: flex;
  gap: 6px;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 6px;
  background: #fafafa;
}

.folder-name {
  flex: 1;
  font-size: 13px;
  color: #1d2129;
}

</style>
