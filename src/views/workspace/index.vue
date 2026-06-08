<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { getPaperPage, deletePaper, type PaperListItem } from '@/api/paper'
import {
  getFavoriteFolderTree,
  createFolder,
  renameFolder,
  deleteFolder,
  type FavoriteFolder,
} from '@/api/question'

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
    // PRD-A-005 收尾 D-bug：传 scope:'mine'（BE 按登录用户 create_by 过滤），
    // 旧的 createBy 缺省被 BE 当 public 处理 → "我创建的卷"错显示全站公共卷。
    const result = await getPaperPage({
      pageIndex: 1,
      pageSize: 5,
      scope: 'mine',
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

// ── PRD-A-005 收尾 A 段 — "我创建的卷"试卷 CRUD（scope=mine，均为本人卷可直接操作）──
function goPaperEdit(paper: PaperListItem) {
  router.push(`/papers/edit/${paper.id}`)
}

async function handleDeletePaper(paper: PaperListItem) {
  try {
    await ElMessageBox.confirm(
      `确认删除试卷「${paper.name}」？删除后不可恢复。`,
      '删除试卷',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await deletePaper(paper.id)
    ElMessage.success('删除成功')
    await fetchMyPapers()
  } catch (e) {
    console.warn('[workspace] deletePaper failed', e)
    ElMessage.error('删除失败')
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

// ── PRD-A-005 收尾 B 段 — 收藏夹 CRUD（范围限本人；默认夹 id:0 虚拟夹不可改/删）──
// 判定虚拟默认夹：BE 首位恒返 {id:0,name:"我的试题"}，String 化兼容 number/string id。
function isDefaultFolder(folder: FavoriteFolder): boolean {
  return String(folder.id) === '0'
}

async function handleCreateFolder() {
  let name = ''
  try {
    const { value } = await ElMessageBox.prompt('请输入收藏夹名称', '新建收藏夹', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPlaceholder: '收藏夹名称',
      inputValidator: (v: string) => (v && v.trim() ? true : '名称不能为空'),
    })
    name = (value || '').trim()
  } catch {
    return // 用户取消
  }
  if (!name) return
  try {
    await createFolder(name)
    ElMessage.success('创建成功')
    await fetchFavoriteFolders()
  } catch (e) {
    console.warn('[workspace] createFolder failed', e)
    ElMessage.error('创建失败')
  }
}

async function handleRenameFolder(folder: FavoriteFolder) {
  if (isDefaultFolder(folder)) return // 默认夹不可改名
  let name = ''
  try {
    const { value } = await ElMessageBox.prompt('请输入新的收藏夹名称', '重命名收藏夹', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: folder.name,
      inputValidator: (v: string) => (v && v.trim() ? true : '名称不能为空'),
    })
    name = (value || '').trim()
  } catch {
    return
  }
  if (!name || name === folder.name) return
  try {
    await renameFolder(folder.id, name)
    ElMessage.success('重命名成功')
    await fetchFavoriteFolders()
  } catch (e) {
    console.warn('[workspace] renameFolder failed', e)
    ElMessage.error('重命名失败')
  }
}

async function handleDeleteFolder(folder: FavoriteFolder) {
  if (isDefaultFolder(folder)) return // 默认夹不可删除
  try {
    await ElMessageBox.confirm(
      `确认删除收藏夹「${folder.name}」？夹内收藏将移至默认夹「我的试题」，不会丢失。`,
      '删除收藏夹',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await deleteFolder(folder.id)
    ElMessage.success('删除成功')
    await fetchFavoriteFolders()
  } catch (e) {
    console.warn('[workspace] deleteFolder failed', e)
    ElMessage.error('删除失败')
  }
}

function goPaperDetail(paper: PaperListItem) {
  router.push(`/papers/source/${paper.id}`)
}

function goPaperList() {
  // 「我的卷库」是卷库左侧目录树底部的合成节点，带 ?mine=1 进入卷库页自动选中该节点
  router.push('/papers/index?mine=1')
}

// PRD-A-005 T6 — 进入收藏管理页（全部收藏，不分夹）
function goFavorites() {
  router.push('/favorites/index')
}

// 点收藏夹 → 进收藏管理页并按该夹筛选（默认夹 id:0 也可点，进默认夹看散收藏）
function goFolderDetail(folder: FavoriteFolder) {
  router.push({
    path: '/favorites/index',
    query: { folderId: folder.id, folderName: folder.name },
  })
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
            <el-icon class="section-icon" color="#1E8A8A"><Document /></el-icon>
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
            >
              <div class="paper-item-main" @click="goPaperDetail(paper)">
                <div class="paper-name">{{ paper.name }}</div>
                <div class="paper-meta">
                  <span>{{ paper.questionCount }} 题</span>
                  <span>·</span>
                  <span>{{ paper.score }} 分</span>
                  <span>·</span>
                  <span>{{ paper.createTime }}</span>
                </div>
              </div>
              <!-- A 段：本人卷（scope=mine 全部本人）可直接编辑/删除，hover 出现 -->
              <div class="paper-item-actions">
                <el-button link type="primary" size="small" @click.stop="goPaperEdit(paper)">
                  编辑
                </el-button>
                <el-button link type="danger" size="small" @click.stop="handleDeletePaper(paper)">
                  删除
                </el-button>
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
          <div class="section-header-actions">
            <el-button link type="primary" size="small" @click="handleCreateFolder">
              <el-icon><Plus /></el-icon>
              新建收藏夹
            </el-button>
            <el-button link type="primary" @click="goFavorites">
              收藏管理
              <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </div>
        <div v-loading="favoriteLoading" class="section-body">
          <ul v-if="favoriteFolders.length > 0" class="folder-list">
            <li
              v-for="folder in favoriteFolders"
              :key="folder.id"
              class="folder-item"
            >
              <el-icon color="#f59e0b"><Folder /></el-icon>
              <div class="folder-info clickable" @click="goFolderDetail(folder)">
                <span class="folder-name">{{ folder.name }}</span>
                <span v-if="folder.createTime" class="folder-time">{{ folder.createTime }}</span>
              </div>
              <el-tag size="small" type="info">{{ folder.count ?? 0 }}</el-tag>
              <!-- B 段：默认夹「我的试题」(id:0) 虚拟夹，不给改名/删除入口 -->
              <div v-if="!isDefaultFolder(folder)" class="folder-actions">
                <el-button link type="primary" size="small" @click="handleRenameFolder(folder)">
                  改名
                </el-button>
                <el-button link type="danger" size="small" @click="handleDeleteFolder(folder)">
                  删除
                </el-button>
              </div>
            </li>
          </ul>
          <el-empty
            v-else
            description="还没有任何收藏夹"
            :image-size="60"
          >
            <el-button size="small" type="primary" @click="handleCreateFolder">
              新建收藏夹
            </el-button>
          </el-empty>
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 6px;
  transition: background 0.2s ease;
}

.paper-item:hover {
  background: #f5f8ff;
}

.paper-item-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.paper-item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.paper-item:hover .paper-item-actions {
  opacity: 1;
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
  transition: background 0.15s ease;
}

.folder-item:hover {
  background: #f5f8ff;
}

.folder-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.folder-info.clickable {
  cursor: pointer;
}

.folder-info.clickable:hover .folder-name {
  color: #1E8A8A;
}

.folder-name {
  font-size: 13px;
  color: #1d2129;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-time {
  font-size: 11px;
  color: #a8abb2;
}

.folder-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.folder-item:hover .folder-actions {
  opacity: 1;
}

.section-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

</style>
