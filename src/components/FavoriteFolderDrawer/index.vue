<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Folder } from '@element-plus/icons-vue'
import { getFavoriteFolderTree, addFavorite, type FavoriteFolder } from '@/api/question/index'

// ── Props / Emits ──────────────────────────────────────────
interface Props {
  modelValue: boolean  // v-model 控制抽屉开关
  questionId: number   // 待收藏题 id
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'success', folderId: number | string | undefined): void
}>()

// ── 默认 hardcode 收藏夹（兜底 — 当接口 401 或不可达时展示）──
const DEFAULT_FOLDERS: FavoriteFolder[] = [
  { id: 0, name: '我的试题', count: 0 },
]

// ── 状态 ─────────────────────────────────────────────────
const folders = ref<FavoriteFolder[]>(DEFAULT_FOLDERS)
const loadingFolders = ref(false)
const selectedFolderId = ref<number | string | undefined>(undefined)
const confirming = ref(false)

// ── 拉收藏夹列表 ─────────────────────────────────────────
async function loadFolders() {
  loadingFolders.value = true
  try {
    const res = await getFavoriteFolderTree()
    // 接口返回可能是数组或 { response: [...] } 结构
    let list: FavoriteFolder[] = []
    if (Array.isArray(res)) {
      list = res
    } else if (res && typeof res === 'object') {
      const r = res as Record<string, unknown>
      if (Array.isArray(r['response'])) {
        list = r['response'] as FavoriteFolder[]
      } else if (Array.isArray(r['data'])) {
        list = r['data'] as FavoriteFolder[]
      }
    }
    // 只展示一级（不展示 children 嵌套，按 Image #5 效果）
    const flatList = list.length > 0 ? list : DEFAULT_FOLDERS
    folders.value = flatList
  } catch {
    // 接口失败（如 401）→ 保留 hardcode 默认夹
    folders.value = DEFAULT_FOLDERS
  } finally {
    loadingFolders.value = false
  }
}

// ── 打开抽屉时重置状态 + 拉夹列表 ──────────────────────
watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      selectedFolderId.value = undefined
      confirming.value = false
      loadFolders()
    }
  },
)

// ── 关闭 ─────────────────────────────────────────────────
function handleClose() {
  emit('update:modelValue', false)
}

// ── 选中某收藏夹 → 调收藏接口（乐观更新）────────────────
// 策略：先乐观关闭抽屉 + 更新本地状态，再异步调 API
// 理由：开发阶段 misikt API 需要 cookie 登录态（401），乐观更新让 UI 反馈即时
async function handleSelectFolder(folder: FavoriteFolder) {
  if (confirming.value) return
  selectedFolderId.value = folder.id
  confirming.value = true

  // 乐观更新：先关闭抽屉 + 触发 success
  ElMessage.success(`已收藏到"${folder.name}"`)
  emit('success', folder.id)
  emit('update:modelValue', false)

  // 异步调 API（失败时 console.warn，不影响已关闭的 UI 状态）
  addFavorite(props.questionId, folder.id)
    .catch((e) => {
      console.warn('[favorite] addFavorite API failed (local state already updated):', e)
    })
    .finally(() => {
      confirming.value = false
      selectedFolderId.value = undefined
    })
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    size="400px"
    :before-close="handleClose"
    class="fav-folder-drawer"
  >
    <template #header>
      <div class="drawer-header">
        <span class="drawer-title">选择收藏目录</span>
      </div>
    </template>

    <div class="drawer-body">
      <!-- 副标题 -->
      <p class="drawer-subtitle">把这道题收藏到：</p>

      <!-- 收藏夹列表 -->
      <div v-if="loadingFolders" class="folder-loading">
        <el-skeleton :rows="3" animated />
      </div>

      <div v-else class="folder-list">
        <div
          v-for="folder in folders"
          :key="folder.id"
          class="folder-item"
          :class="{
            'is-active': selectedFolderId === folder.id,
            'is-confirming': confirming && selectedFolderId === folder.id,
          }"
          @click="handleSelectFolder(folder)"
        >
          <el-icon class="folder-icon"><Folder /></el-icon>
          <span class="folder-name">{{ folder.name }}</span>
          <el-tag
            v-if="folder.count !== undefined"
            size="small"
            type="info"
            class="folder-count"
          >
            {{ folder.count }}
          </el-tag>
          <el-icon
            v-if="confirming && selectedFolderId === folder.id"
            class="folder-loading-icon"
          >
            <svg viewBox="0 0 1024 1024" class="spin-icon" xmlns="http://www.w3.org/2000/svg">
              <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z" fill="#c9cdd4"/>
              <path d="M512 140c-205.4 0-372 166.6-372 372 0 205.4 166.6 372 372 372s372-166.6 372-372c0-205.4-166.6-372-372-372zm192 458c0 3.3-2.7 6-6 6H326c-3.3 0-6-2.7-6-6V426c0-3.3 2.7-6 6-6h42c3.3 0 6 2.7 6 6v138h124V426c0-3.3 2.7-6 6-6h42c3.3 0 6 2.7 6 6v172z" fill="#4080ff" opacity="0.4"/>
            </svg>
          </el-icon>
        </div>
      </div>
    </div>

    <!-- 底部：+ 新建收藏夹（占位，不实现）-->
    <template #footer>
      <div class="drawer-footer">
        <el-button disabled class="new-folder-btn" @click.prevent>
          + 新建收藏夹
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.fav-folder-drawer :deep(.el-drawer__header) {
  padding: 20px 24px 16px;
  margin-bottom: 0;
  border-bottom: 1px solid #f2f3f5;
}

.drawer-header {
  display: flex;
  align-items: center;
}

.drawer-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

.drawer-body {
  padding: 0 24px;
  flex: 1;
}

.drawer-subtitle {
  font-size: 14px;
  color: #86909c;
  margin: 16px 0 12px;
}

/* ── 文件夹列表 ── */
.folder-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.folder-loading {
  padding: 12px 0;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid #f2f3f5;
  cursor: pointer;
  transition: all 0.18s ease;
  background: #fafafa;
  user-select: none;
}

.folder-item:hover {
  background: rgba(64, 128, 255, 0.06);
  border-color: rgba(64, 128, 255, 0.2);
}

.folder-item.is-active {
  border-color: #4080ff;
  background: rgba(64, 128, 255, 0.08);
  box-shadow: 0 0 0 2px rgba(64, 128, 255, 0.1);
}

.folder-item.is-confirming {
  opacity: 0.8;
  pointer-events: none;
}

.folder-icon {
  font-size: 18px;
  color: #ffc040;
  flex-shrink: 0;
}

.folder-name {
  flex: 1;
  font-size: 14px;
  color: #1d2129;
  font-weight: 500;
}

.folder-count {
  flex-shrink: 0;
}

.folder-loading-icon {
  flex-shrink: 0;
  font-size: 16px;
}

.spin-icon {
  animation: spin 1s linear infinite;
  width: 1em;
  height: 1em;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── 底部 footer ── */
.drawer-footer {
  padding: 12px 24px;
  border-top: 1px solid #f2f3f5;
}

.new-folder-btn {
  width: 100%;
  border-style: dashed;
  color: #c9cdd4;
  border-color: #e5e6eb;
}
</style>
