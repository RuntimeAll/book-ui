<script setup lang="ts">
/**
 * PRD-002 P1 — 书架页。
 * 讲义/练习册/专项的唯一入口：类型筛选 + 书卡片（结构统计一眼看厚度）。
 * 数据源 = /teacher/shelf/book/page（owner 过滤）；「新建书」走 createBook 建空书起步。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageBooks,
  createBook,
  deleteBook,
  BOOK_TYPE_LABEL,
  type BookType,
  type ShelfBookVO,
} from '@/api/shelf'
import LineIcon from '@/components/LineIcon.vue'

const router = useRouter()

// 类型筛选（'' = 全部）
const typeFilter = ref<'' | BookType>('')
const filters: { key: '' | BookType; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'lecture', label: '讲义' },
  { key: 'workbook', label: '练习册' },
  { key: 'special', label: '专项' },
]

const keyword = ref('')
const loading = ref(false)
const books = ref<ShelfBookVO[]>([])

async function load() {
  loading.value = true
  try {
    const res = await pageBooks(typeFilter.value ? { bookType: typeFilter.value } : {})
    books.value = res?.rows ?? []
  } catch (e) {
    console.warn('[shelf] 加载书架失败:', e)
    ElMessage.error('加载书架失败')
    books.value = []
  } finally {
    loading.value = false
  }
}

function selectType(k: '' | BookType) {
  if (typeFilter.value === k) return
  typeFilter.value = k
  load()
}

// 前端关键词过滤（书名/学科/年级；BE 未做搜索，本地兜底）
const shownBooks = computed<ShelfBookVO[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return books.value
  return books.value.filter((b) =>
    [b.title, b.subjectId, b.grade, b.edition]
      .filter(Boolean)
      .some((s) => String(s).toLowerCase().includes(kw)),
  )
})

function coverClass(t: string): string {
  if (t === 'lecture') return 'cover c1'
  if (t === 'special') return 'cover c3'
  return 'cover c2'
}
function tagClass(t: string): string {
  if (t === 'lecture') return 'tag lec'
  if (t === 'special') return 'tag sp'
  return 'tag wb'
}
function typeLabel(t: string): string {
  return BOOK_TYPE_LABEL[t as BookType] ?? t
}

/** 结构统计串（讲/节 + 题；卷面无内部词）。 */
function statLine(b: ShelfBookVO): string {
  const parts: string[] = []
  if (b.nodeCount != null) parts.push(`${b.nodeCount} 节`)
  if (b.questionCount != null) parts.push(`${b.questionCount} 题`)
  else if (b.itemCount != null) parts.push(`${b.itemCount} 项`)
  return parts.join(' · ') || '空书'
}

function openBook(b: ShelfBookVO) {
  router.push(`/bookshelf/book/${b.id}`)
}

function onExport() {
  ElMessage.info('导出功能由备课链（PRD-003）承载，敬请期待')
}

async function onDelete(b: ShelfBookVO) {
  try {
    await ElMessageBox.confirm(`确认删除「${b.title}」？该书的目录与内容项将一并删除（题库原题不受影响）。`, '删除书', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteBook(b.id)
    ElMessage.success('已删除')
    load()
  } catch (e) {
    console.warn('[shelf] 删除失败:', e)
    ElMessage.error('删除失败')
  }
}

// —— 新建书对话框 ——
const createVisible = ref(false)
const creating = ref(false)
const form = ref<{ title: string; bookType: BookType }>({ title: '', bookType: 'workbook' })

function openCreate() {
  form.value = { title: '', bookType: 'workbook' }
  createVisible.value = true
}

async function submitCreate() {
  const title = form.value.title.trim()
  if (!title) {
    ElMessage.warning('请填写书名')
    return
  }
  creating.value = true
  try {
    const res = await createBook({ title, bookType: form.value.bookType })
    ElMessage.success('已创建')
    createVisible.value = false
    if (res?.id) router.push(`/bookshelf/book/${res.id}`)
    else load()
  } catch (e) {
    console.warn('[shelf] 创建失败:', e)
    ElMessage.error('创建失败')
  } finally {
    creating.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="shelf-page">
    <div class="page-head">
      <div class="title-wrap">
        <LineIcon name="shelf" :size="22" class="head-ico" />
        <h1>书架</h1>
      </div>
      <p class="sub">讲义、练习册、专项——我的书统一入口</p>
    </div>

    <div class="shelfbar">
      <div class="filters">
        <span
          v-for="f in filters"
          :key="f.key"
          class="fbtn"
          :class="{ on: typeFilter === f.key }"
          @click="selectType(f.key)"
        >{{ f.label }}</span>
      </div>
      <el-input
        v-model="keyword"
        class="search"
        placeholder="搜书名 / 学科 / 年级"
        clearable
        :prefix-icon="undefined"
      />
      <el-button type="primary" plain @click="openCreate">＋ 新建书</el-button>
    </div>

    <div v-loading="loading" class="grid-wrap">
      <div v-if="shownBooks.length" class="grid">
        <div v-for="b in shownBooks" :key="b.id" class="bookcard">
          <div :class="coverClass(b.bookType)" @click="openBook(b)">{{ b.title }}</div>
          <div class="bd">
            <span :class="tagClass(b.bookType)">{{ typeLabel(b.bookType) }}</span>
            <div class="stat">{{ statLine(b) }}</div>
            <div class="ops">
              <el-button size="small" type="primary" @click="openBook(b)">打开</el-button>
              <el-button size="small" @click="onExport">导出</el-button>
              <el-dropdown trigger="click" @command="(c: string) => c === 'del' && onDelete(b)">
                <el-button size="small">⋯</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="del" style="color: var(--el-color-danger)">删除书</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-else-if="!loading" description="书架还没有书">
        <el-button type="primary" @click="openCreate">＋ 新建第一本书</el-button>
      </el-empty>
    </div>

    <el-dialog v-model="createVisible" title="新建书" width="420px">
      <el-form label-width="64px">
        <el-form-item label="书名">
          <el-input v-model="form.title" placeholder="如：暑假计算册 · 七上" maxlength="80" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="form.bookType">
            <el-radio-button value="lecture">讲义</el-radio-button>
            <el-radio-button value="workbook">练习册</el-radio-button>
            <el-radio-button value="special">专项</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建并打开</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.shelf-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 24px 60px;
}
.page-head {
  margin-bottom: 8px;
}
.title-wrap {
  display: flex;
  align-items: center;
  gap: 9px;
}
.head-ico {
  color: var(--bk-teal);
}
.page-head h1 {
  font-size: 22px;
  font-weight: 800;
  color: var(--bk-ink);
}
.page-head .sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 3px;
}

.shelfbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--bk-line);
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.filters {
  display: flex;
  gap: 6px;
}
.fbtn {
  font-size: 13px;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid var(--bk-line);
  background: #fff;
  color: var(--el-text-color-regular);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.fbtn:hover {
  border-color: var(--bk-teal);
  color: var(--bk-teal);
}
.fbtn.on {
  background: var(--bk-teal);
  border-color: var(--bk-teal);
  color: #fff;
  font-weight: 700;
}
.search {
  width: 240px;
  margin-left: auto;
}

.grid-wrap {
  min-height: 200px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 16px;
  padding: 18px 0;
}
.bookcard {
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  transition: box-shadow 0.18s, transform 0.18s;
}
.bookcard:hover {
  box-shadow: 0 6px 20px rgba(15, 118, 110, 0.12);
  transform: translateY(-2px);
}
.cover {
  height: 88px;
  display: flex;
  align-items: flex-end;
  padding: 10px 14px;
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  line-height: 1.35;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}
.cover.c1 {
  background: linear-gradient(135deg, #1268b3, #4fa3e0);
}
.cover.c2 {
  background: linear-gradient(135deg, #0f766e, #4cc2b4);
}
.cover.c3 {
  background: linear-gradient(135deg, #7a4fc0, #a98ae0);
}
.bd {
  padding: 10px 14px 12px;
}
.tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 6px;
}
.tag.lec {
  background: #e8f1fb;
  color: #1268b3;
}
.tag.wb {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
}
.tag.sp {
  background: #f3ecfb;
  color: #7a4fc0;
}
.stat {
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  margin-top: 5px;
}
.ops {
  margin-top: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
