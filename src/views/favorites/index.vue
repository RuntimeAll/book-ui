<script setup lang="ts">
/**
 * 收藏管理页（PRD-A-005 T6）
 *
 * - 调 GET /teacher/qd/favorite/page 分页拉当前老师的收藏题，复用共享题卡 QuestionCard 渲染。
 * - QuestionCard actions 只开 ['favorite','detail']：列表内每题 isFavorite 恒为 true（都是已收藏），
 *   点「已收藏」按钮即取消收藏 → 调现有 removeFavorite → 成功后从列表移除（乐观更新）。
 * - userInfo 内存态不持久化，onMounted 兜底拉 getCurrentUser（守卫已挡未登录，这里只为刷新场景兜底）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Star, ArrowLeft, EditPen } from '@element-plus/icons-vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import { favoritePage, removeFavorite, renameFolder, type QuestionItem } from '@/api/question'
import { getCurrentUser } from '@/api/user'
import { useUserStore } from '@/store/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

// 当前收藏夹上下文（从工作台点夹进入时带 query.folderId；无 query = 全部收藏视图）
// PRD-A-013 T2 — folderId 雪花 string（默认夹 '0' 是 BE 虚拟夹）
const folderId = computed<string | undefined>(() => {
  const v = route.query.folderId
  if (v == null || v === '') return undefined
  return String(v)
})
const inFolderView = computed(() => folderId.value !== undefined)
const isDefaultFolder = computed(() => folderId.value === '0')
const folderName = ref<string>(
  typeof route.query.folderName === 'string' ? route.query.folderName : '',
)

const questions = ref<QuestionItem[]>([])
const total = ref(0)
const loading = ref(false)
const pageParams = reactive({ pageNum: 1, pageSize: 10 })

// 取消收藏进行中的题 id（防连点）
// PRD-A-013 T2 — Set 雪花 string
const removingIds = reactive<Set<string>>(new Set())

async function fetchFavorites() {
  loading.value = true
  try {
    const result = await favoritePage({
      pageNum: pageParams.pageNum,
      pageSize: pageParams.pageSize,
      folderId: folderId.value,
    })
    questions.value = result?.list ?? []
    total.value = result?.total ?? 0
  } catch (e) {
    console.warn('[favorites] favoritePage 拉取失败', e)
    questions.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// 点题卡的收藏按钮（列表内都是已收藏态）→ 取消收藏
function handleRemoveFavorite(q: QuestionItem) {
  if (removingIds.has(q.id)) return
  removingIds.add(q.id)
  removeFavorite(q.id)
    .then(() => {
      // 从当前列表移除
      questions.value = questions.value.filter((item) => item.id !== q.id)
      total.value = Math.max(0, total.value - 1)
      ElMessage.success('已取消收藏')
      // 当前页空了且不是第 1 页 → 回退一页重拉
      if (questions.value.length === 0 && pageParams.pageNum > 1) {
        pageParams.pageNum -= 1
        fetchFavorites()
      }
    })
    .catch((e) => {
      console.warn('[favorites] removeFavorite 失败', e)
      ElMessage.error('取消收藏失败，请重试')
    })
    .finally(() => {
      removingIds.delete(q.id)
    })
}

function handleDetail(q: QuestionItem) {
  router.push(`/question/detail/${q.id}`)
}

function handlePageChange(page: number) {
  pageParams.pageNum = page
  fetchFavorites()
}

// 重命名当前收藏夹（仅夹内视图、非默认夹 id:'0'）
async function handleRename() {
  if (folderId.value == null || folderId.value === '0') return
  let name = ''
  try {
    const { value } = await ElMessageBox.prompt('请输入新的收藏夹名称', '重命名收藏夹', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: folderName.value,
      inputValidator: (v: string) => (v && v.trim() ? true : '名称不能为空'),
    })
    name = (value || '').trim()
  } catch {
    return
  }
  if (!name || name === folderName.value) return
  try {
    await renameFolder(folderId.value, name)
    folderName.value = name
    ElMessage.success('重命名成功')
  } catch (e) {
    console.warn('[favorites] renameFolder failed', e)
    ElMessage.error('重命名失败')
  }
}

// 返回"全部收藏"视图（清掉 folder query）
function goAll() {
  router.push('/desk/favorites')
}

// SPA 内 query.folderId 变化（夹间切换 / 返回全部）重新加载 ——
// 组件复用、onMounted 不重跑（source.vue 踩过同款坑：SPA 复用不刷新致数据停留旧上下文）。
watch(folderId, () => {
  pageParams.pageNum = 1
  folderName.value = typeof route.query.folderName === 'string' ? route.query.folderName : ''
  fetchFavorites()
})

onMounted(async () => {
  // userInfo 内存态不持久化，刷新后兜底拉一次（收藏接口本身按登录 token 取 userId，不依赖此值，
  // 但保持与其他业务页一致的兜底姿势）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[favorites] getCurrentUser 兜底失败', e)
    }
  }
  await fetchFavorites()
})
</script>

<template>
  <div class="favorites-page">
    <header class="favorites-header">
      <div class="header-title">
        <el-icon color="#f59e0b" class="title-icon"><Star /></el-icon>
        <span>{{ inFolderView ? folderName || '收藏夹' : '收藏管理' }}</span>
        <el-tag size="small" type="warning">{{ total }} 题</el-tag>
        <el-button
          v-if="inFolderView && !isDefaultFolder"
          link
          type="primary"
          size="small"
          @click="handleRename"
        >
          <el-icon><EditPen /></el-icon>
          重命名
        </el-button>
      </div>
      <div class="header-sub-row">
        <p class="header-sub">
          {{ inFolderView ? '当前收藏夹内的题目 — 点「已收藏」即可取消收藏' : '管理你收藏的题目 — 点「已收藏」即可取消收藏' }}
        </p>
        <el-button v-if="inFolderView" link type="primary" size="small" @click="goAll">
          <el-icon><ArrowLeft /></el-icon>
          全部收藏
        </el-button>
      </div>
    </header>

    <div v-loading="loading" class="favorites-body">
      <el-empty
        v-if="!loading && questions.length === 0"
        description="还没有收藏任何题目"
        :image-size="80"
      >
        <el-button type="primary" @click="router.push('/question/index')">
          去题库收藏
        </el-button>
      </el-empty>

      <template v-else>
        <QuestionCard
          v-for="q in questions"
          :key="q.id"
          :question="q"
          :is-favorite="true"
          :favorite-loading="removingIds.has(q.id)"
          :actions="['favorite', 'detail']"
          @favorite="handleRemoveFavorite"
          @detail="handleDetail"
        />

        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="pageParams.pageNum"
            :page-size="pageParams.pageSize"
            :total="total"
            layout="total, prev, pager, next, jumper"
            background
            @current-change="handlePageChange"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.favorites-page {
  padding: 24px 32px;
  max-width: 1080px;
  margin: 0 auto;
}

.favorites-header {
  padding: 20px 24px;
  background: linear-gradient(135deg, #fff7e6 0%, #fffbf2 100%);
  border-radius: 12px;
  margin-bottom: 20px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: 600;
  color: #1d2129;
}

.title-icon {
  font-size: 22px;
}

.header-sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
}

.header-sub {
  font-size: 13px;
  color: #86909c;
  margin: 8px 0 0;
}

.header-sub-row .header-sub {
  margin: 0;
}

.favorites-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.pagination-wrap {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
</style>
