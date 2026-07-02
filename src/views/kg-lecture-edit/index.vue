<script setup lang="ts">
/**
 * 课件编辑页（超管/备课后台）—— PRD-C-205
 *
 * 路由：/kg-lecture-edit
 * 权限：登录即可（超管 / 备课角色，BE 侧校验）
 *
 * 功能：
 *   1. 进入时 GET /teacher/kg/doc/{courseId}?bookId=CC7S 取 docJson 灌入 UmoEditor
 *   2. 自定义节点工具栏：插入 kgMindmap / kgNote / kgCallout / kgExample
 *   3. 「保存」按钮 POST /teacher/kg/doc/{courseId} body { bookId, title, docJson }
 *
 * courseId 联调先固定 901001002001，后续可通过路由参数传入。
 */
import { ref, onMounted } from 'vue'
import { UmoEditor } from '@umoteam/editor'
import { ElMessage, ElLoading } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { KG_NODE_EXTENSIONS } from '@/extensions/kg-nodes/index'
import { getKgDoc, saveKgDoc } from '@/api/kg/doc'
import { questionPage, type QuestionItem } from '@/api/question/index'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'

// ── 常量 ─────────────────────────────────────────────────────────────────────
// 2026-07-02 定稿:讲义挂 KG「节」(L3)+lesson_no,课时不再是 KG 节点(PRD-C-206 P2)
const COURSE_ID = '901001002'
const BOOK_ID = 'CC7S'

// ── 状态 ─────────────────────────────────────────────────────────────────────
const editorRef = ref<InstanceType<typeof UmoEditor> | null>(null)
const docTitle = ref('课件文档')
const saving = ref(false)
const loading = ref(false)
const errorMsg = ref<string | null>(null)

// ── Umo 配置（固定对象，不重建编辑器） ────────────────────────────────────────
// 🔴 extensions 传 KG_NODE_EXTENSIONS，document.readOnly=false（可编辑）
const editorConfig = {
  extensions: KG_NODE_EXTENSIONS,
  document: {
    title: docTitle.value,
    readOnly: false,
    placeholder: {
      zh_CN: '开始编辑课件内容…',
    },
  },
  assistant: false,
  locale: 'zh-CN',
}

// ── 加载文档 ──────────────────────────────────────────────────────────────────
async function loadDoc() {
  loading.value = true
  errorMsg.value = null
  const loadingInstance = ElLoading.service({
    text: '课件加载中…',
    background: 'rgba(255,255,255,0.85)',
  })
  try {
    const res = await getKgDoc(COURSE_ID, BOOK_ID)
    docTitle.value = res.course?.name ?? '课件文档'
    if (res.docJson && editorRef.value) {
      // 灌入 docJson：setContent 接受 Tiptap JSON 对象
      const editor = editorRef.value.useEditor()
      if (editor) {
        editor.commands.setContent(res.docJson as Parameters<typeof editor.commands.setContent>[0])
      }
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : '课件加载失败'
  } finally {
    loading.value = false
    loadingInstance.close()
  }
}

onMounted(() => {
  loadDoc()
})

// ── 保存文档 ──────────────────────────────────────────────────────────────────
async function handleSave() {
  if (!editorRef.value) return
  const editor = editorRef.value.useEditor()
  if (!editor) return

  saving.value = true
  try {
    const docJson = editor.getJSON()
    await saveKgDoc(COURSE_ID, {
      bookId: BOOK_ID,
      title: docTitle.value,
      docJson,
    })
    ElMessage.success('课件已保存')
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

// ── 插入自定义节点 ────────────────────────────────────────────────────────────
function insertNode(type: string, attrs: Record<string, string>) {
  if (!editorRef.value) return
  const editor = editorRef.value.useEditor()
  if (!editor) return
  // 🔴 用 insertContentAt(selection.to) 而非 insertContent：后者语义=替换当前选区，
  // 光标若停在某个原子卡片上（NodeSelection），插入会静默吞掉那张卡。落在选区之后最安全。
  editor.chain().focus().insertContentAt(editor.state.selection.to, { type, attrs }).run()
}

function insertKgMindmap() {
  const sampleData = JSON.stringify({
    text: '思维导图根节点',
    children: [
      { text: '分支 A', color: '#ef4444', children: [{ text: '叶节点', detail: '说明' }] },
      { text: '分支 B', color: '#3b82f6', children: [] },
    ],
  })
  insertNode('kgMindmap', { data: sampleData })
}

function insertKgNote() {
  insertNode('kgNote', { title: '名师解读', text: '（在此输入解读内容）' })
}

function insertKgCallout() {
  insertNode('kgCallout', {
    lines: '记忆点第一行\n记忆点第二行\n记忆点第三行',
    color: '#2563eb',
  })
}

// ── 例题选题器：直接搜题库选题插入（不再手填 qid） ────────────────────────────
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
const pickerVisible = ref(false)
const pickerKeyword = ref('')
const pickerLoading = ref(false)
const pickerList = ref<QuestionItem[]>([])

async function searchPicker() {
  pickerLoading.value = true
  try {
    const res = await questionPage({
      pageIndex: 1,
      pageSize: 8,
      keyWord: pickerKeyword.value.trim() || undefined,
    })
    pickerList.value = res.list ?? []
  } catch {
    pickerList.value = []
  } finally {
    pickerLoading.value = false
  }
}

function insertKgExample() {
  pickerVisible.value = true
  if (!pickerList.value.length) searchPicker()
}

function pickQuestion(q: QuestionItem) {
  // knowledgeId 取题目主考点所在 KG 节点（subjectId），兜底当前节
  insertNode('kgExample', { qid: String(q.id), knowledgeId: q.subjectId ?? COURSE_ID })
  pickerVisible.value = false
  ElMessage.success('例题已插入')
}

function pickerStem(q: QuestionItem): string {
  const raw = q.stemTextContent || q.stemText || ''
  // 列表预览：剥 HTML 标签，截断由 CSS line-clamp 负责
  return raw.replace(/<[^>]+>/g, ' ').trim() || '（无题干文本，图片题）'
}
</script>

<template>
  <div class="kg-edit-page">
    <!-- 顶部操作栏 -->
    <div class="kg-edit-toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">课件编辑</span>
        <span class="toolbar-subtitle">{{ docTitle }}</span>
        <span class="toolbar-course-id">courseId: {{ COURSE_ID }}</span>
      </div>

      <!-- 插入自定义节点按钮组 -->
      <div class="toolbar-insert">
        <span class="toolbar-insert-label">插入：</span>
        <el-button size="small" type="primary" plain @click="insertKgMindmap">思维导图</el-button>
        <el-button size="small" type="danger" plain @click="insertKgNote">名师解读</el-button>
        <el-button size="small" type="info" plain @click="insertKgCallout">记忆框</el-button>
        <el-button size="small" plain @click="insertKgExample">例题卡</el-button>
      </div>

      <!-- 保存 -->
      <div class="toolbar-right">
        <el-button
          type="primary"
          size="small"
          :loading="saving"
          @click="handleSave"
        >
          保存课件
        </el-button>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="kg-edit-error">
      {{ errorMsg }}
      <el-button size="small" text @click="loadDoc">重试</el-button>
    </div>

    <!-- Umo 编辑器主体 -->
    <div class="kg-edit-editor-wrap">
      <UmoEditor
        ref="editorRef"
        v-bind="editorConfig"
      />
    </div>

    <!-- 例题选题器：搜题库 → 点选插入（kgExample 只存 qid，题库=唯一真相源） -->
    <el-dialog v-model="pickerVisible" title="从题库选例题" width="720px" append-to-body>
      <div class="picker-search">
        <el-input
          v-model="pickerKeyword"
          placeholder="关键词搜题干（如：量筒 / 刻度尺）"
          clearable
          :prefix-icon="Search"
          @keyup.enter="searchPicker"
        />
        <el-button type="primary" :loading="pickerLoading" @click="searchPicker">搜索</el-button>
      </div>
      <div v-loading="pickerLoading" class="picker-list">
        <div v-for="q in pickerList" :key="q.id" class="picker-item">
          <div class="picker-item-meta">
            <el-tag size="small" disable-transitions>
              {{ dict.label(DICT_QUESTION_TYPE, q.questionType) || `题型${q.questionType}` }}
            </el-tag>
            <el-rate v-if="q.difficult" :model-value="q.difficult" :max="4" disabled class="picker-rate" />
          </div>
          <div class="picker-item-stem">{{ pickerStem(q) }}</div>
          <el-button size="small" type="primary" plain @click="pickQuestion(q)">插入</el-button>
        </div>
        <el-empty v-if="!pickerLoading && !pickerList.length" description="没有匹配的题目" :image-size="60" />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.kg-edit-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px); /* 减去 AppLayout 顶栏高度 */
  overflow: hidden;
  background: #f5f5f5;
}

/* 操作栏 */
.kg-edit-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-shrink: 0;
}

.toolbar-title {
  font-size: 15px;
  font-weight: 700;
  color: #1e293b;
}

.toolbar-subtitle {
  font-size: 14px;
  color: #475569;
}

.toolbar-course-id {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
}

.toolbar-insert {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
}

.toolbar-insert-label {
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
}

.toolbar-right {
  flex-shrink: 0;
}

/* 错误提示 */
.kg-edit-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: #fef2f2;
  border-left: 4px solid #dc2626;
  font-size: 13px;
  color: #991b1b;
  flex-shrink: 0;
}

/* 编辑器容器：撑满剩余高度 */
.kg-edit-editor-wrap {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* 例题选题器 */
.picker-search {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.picker-list {
  min-height: 120px;
  max-height: 55vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
}

.picker-item:hover {
  border-color: #93c5fd;
  background: #f8fafc;
}

.picker-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.picker-rate :deep(.el-rate__icon) {
  font-size: 13px;
  margin-right: 1px;
}

.picker-item-stem {
  flex: 1;
  font-size: 13px;
  color: #334155;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
