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
import {
  useDictStore,
  DICT_EDU_SUBJECT, DICT_EDU_STAGE, DICT_EDU_GRADE, DICT_EDU_VOLUME,
} from '@/store/dict'
import { getProgress, type ReviewProgress } from '@/api/review'
import LineIcon from '@/components/LineIcon.vue'

const router = useRouter()
const dict = useDictStore()

// ══ 筛选状态（对齐卷库：类型 / 学科 / 学段 / 年级 / 册 + 书名）════
// '' = 全部。书量小（按 owner 归属，通常十几本），一次全量拉回、纯前端过滤：
// 点选即时联动、无逐维度往返，交互与卷库分层收放同构；无需 BE 分页/多参。
type NumOrAll = number | ''
const typeFilter = ref<'' | BookType>('')
const subjectFilter = ref<NumOrAll>('')
const stageFilter = ref<NumOrAll>('')
const gradeFilter = ref<NumOrAll>('')
const volumeFilter = ref<NumOrAll>('')
const keyword = ref('')

const GRADE_NUM: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '高一', 11: '高二', 12: '高三' }
const STAGE_GRADES: Record<number, number[]> = { 1: [1, 2, 3, 4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12] }

// 类型段：书架不含专项（BE 已剔除 special），仅 讲义/练习册/电子课本
const typeSegs: { key: '' | BookType; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'lecture', label: '讲义' },
  { key: 'workbook', label: '练习册' },
  { key: 'textbook', label: '电子课本' },
]

const loading = ref(false)
const books = ref<ShelfBookVO[]>([])

// 🔴 PRD-006 AC5 — 每本书的录入审核进度（角标）。bookId → 进度。
// 不阻塞列表渲染：load() 只等书列表，进度角标 fire-and-forget、限并发池逐本回填。
const progressMap = ref<Record<string, ReviewProgress>>({})

async function load() {
  loading.value = true
  try {
    // 一次全量拉本人书（不传 bookType：全部类型都要，前端再分维度过滤）
    const res = await pageBooks({})
    books.value = res?.rows ?? []
    // 列表已就位即渲染；进度角标异步补（不 await，不挡首屏）
    void loadProgressBadges(books.value)
  } catch (e) {
    console.warn('[shelf] 加载书架失败:', e)
    ElMessage.error('加载书架失败')
    books.value = []
  } finally {
    loading.value = false
  }
}

/** 限并发（5）逐本拉审核进度回填 progressMap；单本失败静默（角标非关键，不打断列表）。 */
async function loadProgressBadges(list: ShelfBookVO[]) {
  progressMap.value = {}
  const ids = list.map((b) => b.id)
  let idx = 0
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++]
      try {
        const p = await getProgress(id)
        if (p) progressMap.value = { ...progressMap.value, [id]: p }
      } catch {
        /* 角标失败静默 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker))
}

/** 书卡审核角标：totalPages>0 才展示；done = 全书页审完（AC5 录入确认完成语义，前端计算）。 */
const reviewInfoMap = computed(() => {
  const m: Record<string, { reviewed: number; total: number; pct: number; done: boolean }> = {}
  for (const [id, p] of Object.entries(progressMap.value)) {
    const total = Number(p?.totalPages ?? 0)
    if (total <= 0) continue
    const reviewed = Math.max(0, Math.min(Number(p?.reviewedPages ?? 0), total))
    m[id] = { reviewed, total, pct: Math.round((reviewed / total) * 100), done: reviewed >= total }
  }
  return m
})

// —— 维度可用集（据已加载书集算，缺该维度数据的选项置灰，对齐卷库 dim 逻辑）——
const subjectsAvail = computed(() => new Set(books.value.map((b) => b.subjectCode).filter((v): v is number => v != null)))
const stagesAvail = computed(() => new Set(books.value.map((b) => b.stageCode).filter((v): v is number => v != null)))
const volumesAvail = computed(() => new Set(books.value.map((b) => b.volumeCode).filter((v): v is number => v != null)))
const typesAvail = computed(() => new Set(books.value.map((b) => String(b.bookType))))
// 年级卡：受选中学科/学段收窄（未选则全集），只亮真有书的年级
const gradesAvail = computed(() => {
  const s = new Set<number>()
  for (const b of books.value) {
    if (b.gradeCode == null) continue
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) continue
    if (stageFilter.value !== '' && b.stageCode !== stageFilter.value) continue
    s.add(b.gradeCode)
  }
  return s
})
// 年级卡网格：选了学段 → 该学段年级；否则 → 有书的年级并集升序
const gradeCells = computed<number[]>(() => {
  if (stageFilter.value !== '') return STAGE_GRADES[stageFilter.value as number] ?? []
  return [...new Set(books.value.map((b) => b.gradeCode).filter((v): v is number => v != null))].sort((a, b) => a - b)
})

const subjectList = computed(() => dict.list(DICT_EDU_SUBJECT))
const stageList = computed(() => dict.list(DICT_EDU_STAGE))

// —— 交互 ——
function pickType(k: '' | BookType) { typeFilter.value = k }
function pickSubject(v: NumOrAll) { subjectFilter.value = subjectFilter.value === v ? '' : v }
function pickStage(v: NumOrAll) {
  stageFilter.value = stageFilter.value === v ? '' : v
  // 换学段：若当前年级不在新学段可选年级内则清空
  if (stageFilter.value !== '' && gradeFilter.value !== '' && !(STAGE_GRADES[stageFilter.value as number] ?? []).includes(gradeFilter.value as number)) {
    gradeFilter.value = ''
  }
}
function pickGrade(g: number) {
  if (!gradesAvail.value.has(g)) return
  gradeFilter.value = gradeFilter.value === g ? '' : g
}
function pickVolume(v: NumOrAll) { volumeFilter.value = volumeFilter.value === v ? '' : v }

const hasActiveFilter = computed(() =>
  typeFilter.value !== '' || subjectFilter.value !== '' || stageFilter.value !== '' ||
  gradeFilter.value !== '' || volumeFilter.value !== '' || keyword.value.trim() !== '',
)
function resetFilters() {
  typeFilter.value = ''
  subjectFilter.value = ''
  stageFilter.value = ''
  gradeFilter.value = ''
  volumeFilter.value = ''
  keyword.value = ''
}

// —— 过滤（AND 跨维度 + 书名/学科/年级关键词）——
const shownBooks = computed<ShelfBookVO[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return books.value.filter((b) => {
    if (typeFilter.value !== '' && String(b.bookType) !== typeFilter.value) return false
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) return false
    if (stageFilter.value !== '' && b.stageCode !== stageFilter.value) return false
    if (gradeFilter.value !== '' && b.gradeCode !== gradeFilter.value) return false
    if (volumeFilter.value !== '' && b.volumeCode !== volumeFilter.value) return false
    if (kw) {
      const hay = [b.title, b.subjectId, b.grade, b.edition].filter(Boolean).map((s) => String(s).toLowerCase())
      if (!hay.some((s) => s.includes(kw))) return false
    }
    return true
  })
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

// 🔴 PRD-006 — 录入审核入口（按页比对源书原版 → 逐页确认；普通用户可见）
function openReview(b: ShelfBookVO) {
  router.push(`/bookshelf/review/${b.id}`)
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

onMounted(() => {
  // 筛选维度字典（学科/学段/年级/册）—— 与卷库同源 sys_dict
  void dict.load(DICT_EDU_SUBJECT)
  void dict.load(DICT_EDU_STAGE)
  void dict.load(DICT_EDU_GRADE)
  void dict.load(DICT_EDU_VOLUME)
  load()
})
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

    <!-- ══ 筛选面板（对齐卷库：类型 / 学科 / 学段 / 年级 / 册 + 书名）══ -->
    <div class="filter-panel">
      <div class="frow">
        <!-- 类型 -->
        <div class="grp">
          <div class="grp-lab">类型</div>
          <div class="seg">
            <button
              v-for="t in typeSegs"
              :key="t.key || 'all'"
              :class="{ on: typeFilter === t.key }"
              :disabled="!!t.key && !typesAvail.has(t.key)"
              @click="pickType(t.key)"
            >{{ t.label }}</button>
          </div>
        </div>
        <!-- 学科 -->
        <div class="grp">
          <div class="grp-lab">学科</div>
          <div class="seg">
            <button :class="{ on: subjectFilter === '' }" @click="pickSubject('')">全部</button>
            <button
              v-for="s in subjectList"
              :key="s.dictValue"
              :class="{ on: subjectFilter === Number(s.dictValue) }"
              :disabled="!subjectsAvail.has(Number(s.dictValue))"
              @click="pickSubject(Number(s.dictValue))"
            >{{ s.dictLabel }}</button>
          </div>
        </div>
        <!-- 学段 -->
        <div class="grp">
          <div class="grp-lab">学段</div>
          <div class="seg">
            <button :class="{ on: stageFilter === '' }" @click="pickStage('')">全部</button>
            <button
              v-for="st in stageList"
              :key="st.dictValue"
              :class="{ on: stageFilter === Number(st.dictValue) }"
              :disabled="!stagesAvail.has(Number(st.dictValue))"
              @click="pickStage(Number(st.dictValue))"
            >{{ st.dictLabel }}</button>
          </div>
        </div>
        <!-- 册 -->
        <div class="grp">
          <div class="grp-lab">册</div>
          <div class="seg">
            <button :class="{ on: volumeFilter === '' }" @click="pickVolume('')">全部</button>
            <button :class="{ on: volumeFilter === 1 }" :disabled="!volumesAvail.has(1)" @click="pickVolume(1)">上册</button>
            <button :class="{ on: volumeFilter === 2 }" :disabled="!volumesAvail.has(2)" @click="pickVolume(2)">下册</button>
          </div>
        </div>
      </div>
      <!-- 年级卡（点选即定位；无书年级置灰）-->
      <div v-if="gradeCells.length" class="frow grade-row">
        <div class="grp grade-grp">
          <div class="grp-lab">年级</div>
          <div class="grades">
            <div class="grade all" :class="{ on: gradeFilter === '' }" @click="gradeFilter = ''">
              <div class="num">全</div><div class="cn">全部</div>
            </div>
            <div
              v-for="g in gradeCells"
              :key="g"
              class="grade"
              :class="{ on: gradeFilter === g, dim: !gradesAvail.has(g) }"
              @click="pickGrade(g)"
            >
              <div class="num">{{ GRADE_NUM[g] }}</div>
              <div class="cn">{{ dict.label(DICT_EDU_GRADE, g) }}</div>
            </div>
          </div>
        </div>
      </div>
      <!-- 底栏：书名搜索 + 重置 + 新建书 -->
      <div class="frow foot-row">
        <el-input
          v-model="keyword"
          class="search"
          placeholder="搜书名 / 学科 / 年级"
          clearable
        />
        <el-button v-if="hasActiveFilter" text class="reset-btn" @click="resetFilters">重置筛选</el-button>
        <span class="count">共 {{ shownBooks.length }} 本</span>
        <el-button type="primary" plain class="new-btn" @click="openCreate">＋ 新建书</el-button>
      </div>
    </div>

    <div v-loading="loading" class="grid-wrap">
      <div v-if="shownBooks.length" class="grid">
        <div v-for="b in shownBooks" :key="b.id" class="bookcard">
          <div :class="coverClass(b.bookType)" @click="openBook(b)">{{ b.title }}</div>
          <div class="bd">
            <span :class="tagClass(b.bookType)">{{ typeLabel(b.bookType) }}</span>
            <div class="stat">{{ statLine(b) }}</div>
            <!-- 🔴 PRD-006 录入审核进度角标（AC5）：done→录入确认完成徽标 / 否则迷你进度条 -->
            <div v-if="reviewInfoMap[b.id]" class="rv-badge">
              <span v-if="reviewInfoMap[b.id].done" class="rv-done">✓ 录入确认完成</span>
              <template v-else>
                <div class="rv-mini-bar"><i :style="{ width: reviewInfoMap[b.id].pct + '%' }"></i></div>
                <span class="rv-mini-num">已审 {{ reviewInfoMap[b.id].reviewed }}/{{ reviewInfoMap[b.id].total }} 页</span>
              </template>
            </div>
            <div class="ops">
              <el-button size="small" type="primary" @click="openBook(b)">打开</el-button>
              <el-button size="small" class="review-btn" @click="openReview(b)">录入审核</el-button>
              <el-dropdown trigger="click" @command="(c: string) => c === 'del' ? onDelete(b) : c === 'export' && onExport()">
                <el-button size="small">⋯</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="export">导出</el-dropdown-item>
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

/* ── 筛选面板（与卷库目录同构：grp-lab + seg 段 + grade 卡）── */
.filter-panel {
  margin-top: 12px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}
.frow {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 22px;
  align-items: flex-end;
}
.grade-row {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #eef2f2;
}
.foot-row {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #eef2f2;
  align-items: center;
  gap: 12px;
}
.grp {
  min-width: 0;
}
.grp-lab {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #7c8a90;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.seg {
  display: inline-flex;
  background: #eef2f2;
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.seg button {
  border: 0;
  background: transparent;
  font-size: 12.5px;
  font-weight: 600;
  color: #536268;
  padding: 7px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: 0.15s;
}
.seg button.on {
  background: #fff;
  color: var(--bk-teal);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}
.seg button:disabled {
  color: #b7c0c4;
  cursor: not-allowed;
  opacity: 0.55;
}
.grade-grp {
  flex: 1;
}
.grades {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.grade {
  border: 1px solid #e3e9e9;
  border-radius: 9px;
  background: #fff;
  cursor: pointer;
  padding: 6px 12px 5px;
  text-align: center;
  transition: 0.15s;
  position: relative;
  overflow: hidden;
  min-width: 46px;
}
.grade .num {
  font-size: 15px;
  font-weight: 700;
  color: var(--bk-ink);
  line-height: 1.1;
}
.grade .cn {
  font-size: 10px;
  color: #7c8a90;
  margin-top: 2px;
  font-weight: 600;
}
.grade:hover {
  border-color: #14958a;
}
.grade.on {
  border-color: var(--bk-teal);
  background: linear-gradient(180deg, #f0faf9, #fff);
}
.grade.on .num {
  color: var(--bk-teal);
}
.grade.on::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: var(--bk-teal);
}
.grade.dim {
  opacity: 0.32;
  pointer-events: none;
  filter: grayscale(0.4);
}
.search {
  width: 240px;
}
.reset-btn {
  color: var(--el-text-color-secondary);
}
.count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.new-btn {
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
/* ── 录入审核进度角标（PRD-006 AC5）── */
.rv-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  min-height: 16px;
}
.rv-mini-bar {
  flex: 1;
  height: 5px;
  border-radius: 4px;
  background: var(--bg-100, #edf2f2);
  overflow: hidden;
}
.rv-mini-bar > i {
  display: block;
  height: 100%;
  background: var(--bk-teal);
  transition: width 0.25s ease;
}
.rv-mini-num {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rv-done {
  font-size: 11px;
  font-weight: 800;
  color: var(--bk-red-pen, #e0526b);
  background: #fdecef;
  border: 1px solid #f4c6d0;
  border-radius: 999px;
  padding: 1px 9px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.ops {
  margin-top: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.review-btn {
  color: var(--bk-teal-deep);
  border-color: var(--el-color-primary-light-7);
}
.review-btn:hover {
  color: #fff;
  background: var(--bk-teal);
  border-color: var(--bk-teal);
}
</style>
