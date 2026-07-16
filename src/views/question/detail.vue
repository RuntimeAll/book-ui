<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
// PRD-A-010 T3：备注卡的 Plus 图标随 DetailSidebar 子组件迁出。
import {
  ArrowLeft,
  Star,
  Edit,
  EditPen,
  ShoppingCart,
  ChatDotRound,
  Tools,
} from '@element-plus/icons-vue'
import {
  getQuestionDetail,
  getQuestionNote,
  saveQuestionNote,
  getQuestionSources,
  getSimilarQuestions,
  getQuestionLineage,
  addFavorite,
  removeFavorite,
  type QuestionItem,
  type QuestionDetail,
  type QuestionNote,
  type QuestionSource,
  type SimilarQuestion,
  type QuestionLineage,
  type LineageNode,
} from '@/api/question/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import SketchPad from '@/components/business/SketchPad/index.vue'
import DetailSidebar from './components/DetailSidebar.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
// PRD-A-015 — 结构化网格块统一渲染（题干 blockJson 非空时优先用它，否则回落 QuestionContent）
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { parseBlockDoc } from '@/utils/blockSchema'
import { useDictStore, DICT_QUESTION_TYPE, DICT_QUESTION_DIFFICULTY } from '@/store/dict'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useLoginGuard } from '@/composables/useLoginGuard'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
// H1 卡补丁：admin V-1 新建的题 id 是 19 位 Snowflake（如 2058063361421082625），
// 超 JS Number.MAX_SAFE_INTEGER (2^53)。Number(route.params.id) 会让末尾 25 变 00
// 精度丢失 → BE 查 DB 没这个 id → "题目详情加载失败"。改全程 string，BE @PathVariable
// Long 收 numeric string 自动 parse 不丢精度。
const questionId = computed(() => String(route.params.id))

// ── 草稿纸 ──────────────────────────────────────────────────
const sketchVisible = ref(false)

// ── 试题栏（全局 singleton composable） ──────────────────────
const basket = useQuestionBasket()

// PRD-C-212 D5 — 游客态操作按钮登录引导
const { ensureLogin } = useLoginGuard()

// ── 题目数据 ─────────────────────────────────────────────────
const question = ref<QuestionDetail | null>(null)
const loading = ref(false)

// PRD-A-015 — 题干结构化 block 文档（非法/空返 null → 题干区回落旧富文本/图渲染）
const parsedBlock = computed(() => parseBlockDoc(question.value?.blockJson))
// PRD-C-204 — 答案/解析结构化 block 文档（统一富文本格式化层；非空走 QuestionBlockRender，否则回落 QuestionContent）
const parsedAnswerBlock = computed(() => parseBlockDoc(question.value?.answerBlockJson))
const parsedAnalyzeBlock = computed(() => parseBlockDoc(question.value?.analyzeBlockJson))

// ── 编辑权限（PRD-A-015）──────────────────────────────────────
// 本人题（createUser=登录 id）或 superadmin（角色，对齐 BE LoginHelper.isSuperAdmin）才可编辑。
// teacher 仅本人题；非本人非超管 → 不显示编辑按钮（BE update 同步硬校验，防御纵深）。
const userStore = useUserStore()
const canEdit = computed(() => {
  if (!question.value) return false
  if (userStore.isSuperAdmin) return true
  const uid = userStore.userInfo?.id
  const owner = question.value.createUser
  return uid != null && owner != null && String(owner) === String(uid)
})
function goEdit() {
  router.push(`/question/editor/${questionId.value}`)
}
// PRD-A-015 批1 — 跳题目属性编辑页（同 canEdit 门控）
function goAttributes() {
  router.push(`/question/attributes/${questionId.value}`)
}

async function loadQuestion() {
  loading.value = true
  try {
    // PRD-A-013 T2 — API 签名已改 string，盲 cast 撤掉
    const res = await getQuestionDetail(questionId.value)
    if (res && (res as QuestionDetail).id) {
      question.value = res as QuestionDetail
    } else {
      fallbackFromCache()
    }
  } catch (e) {
    console.warn('[detail] GET /teacher/question/:id failed, falling back to cache', e)
    fallbackFromCache()
  } finally {
    loading.value = false
  }
}

function fallbackFromCache() {
  // 兜底从 index.vue 写入的 cache 读
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const cache: Record<string, QuestionDetail> = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    const cached = cache[String(questionId.value)]
    if (cached) {
      question.value = cached
    } else {
      question.value = null
      ElMessage.warning('题目详情加载失败，请返回重试')
    }
  } catch {
    question.value = null
  }
}

// ── 收藏状态 ─────────────────────────────────────────────────
const isFavorite = ref(false)
const favoriteLoading = ref(false)

async function handleFavorite() {
  if (!(await ensureLogin())) return
  if (favoriteLoading.value) return
  favoriteLoading.value = true
  const prev = isFavorite.value
  isFavorite.value = !prev
  try {
    if (prev) {
      // PRD-A-013 T2 — API 签名已改 string，盲 cast 撤掉
      await removeFavorite(questionId.value)
      ElMessage.success('已取消收藏')
    } else {
      await addFavorite(questionId.value)
      ElMessage.success('已收藏')
    }
  } catch (e) {
    console.warn('[detail] favorite API failed', e)
  } finally {
    favoriteLoading.value = false
  }
}

// ── 试题栏 toggle（走全局 composable） ───────────────────────
// PRD-A-013 T2 — useQuestionBasket Set/API 已全 string，盲 cast 全清；
// 历史 H1 卡的 admin 19 位 id 误判 "未加入" 一并修复。
const isInBasket = computed(() => basket.basketIds.value.has(questionId.value))
const basketLoading = computed(() => basket.isLoading(questionId.value))

async function handleBasketToggle() {
  if (!(await ensureLogin())) return
  const id = questionId.value
  if (basket.isLoading(id)) return
  if (basket.basketIds.value.has(id)) {
    await basket.remove(id)
  } else if (question.value) {
    await basket.add(question.value)
  }
}

// ── 答案/解析折叠 ─────────────────────────────────────────────
// 2026-06-11 用户拍板：答案默认展开（老师看题先看答案是主流程，点开一次是多余动作）；
// 解析/相似题推荐仍默认收起（内容长非必看，要默认开再调）。
const answerExpanded = ref(true)
const explainExpanded = ref(false)
const similarExpanded = ref(false)

// ── 我的备注 ─────────────────────────────────────────────────
// V1 BE: GET /qd/note/{id} 返单对象 / null（uk_user_question 每用户每题最多 1 条）
const note = ref<QuestionNote | null>(null)
const notesLoading = ref(false)
const noteInput = ref('')
const noteSaving = ref(false)

async function loadNotes() {
  notesLoading.value = true
  try {
    // PRD-A-013 T2 — API 签名已 string
    const res = await getQuestionNote(questionId.value)
    note.value = res && typeof res === 'object' && 'content' in res ? (res as QuestionNote) : null
  } catch (e) {
    console.warn('[detail] notes GET failed', e)
    note.value = null
  } finally {
    notesLoading.value = false
  }
}

async function saveNote() {
  if (!(await ensureLogin())) return
  if (!noteInput.value.trim()) return
  noteSaving.value = true
  try {
    await saveQuestionNote(questionId.value, noteInput.value.trim())
    ElMessage.success('备注已保存')
    noteInput.value = ''
    loadNotes()
  } catch (e) {
    console.warn('[detail] saveNote failed', e)
    ElMessage.warning('保存备注失败（需登录态）')
  } finally {
    noteSaving.value = false
  }
}

// ── 收录情况 ─────────────────────────────────────────────────
const sources = ref<QuestionSource[]>([])
const sourcesLoading = ref(false)

async function loadSources() {
  sourcesLoading.value = true
  try {
    const res = await getQuestionSources(questionId.value)
    sources.value = Array.isArray(res) ? res : []
  } catch (e) {
    console.warn('[detail] sources GET failed', e)
    // 兜底：从题目数据提取 examPaperId / examPaperName
    if (question.value?.examPaperId) {
      sources.value = [{
        examPaperId: question.value.examPaperId,
        examPaperName: question.value.examPaperName ?? `试卷 ${question.value.examPaperId}`,
        examYear: question.value.examYear ?? null,
      }]
    } else {
      sources.value = []
    }
  } finally {
    sourcesLoading.value = false
  }
}

// ── 相似题 ───────────────────────────────────────────────────
const similarQuestions = ref<SimilarQuestion[]>([])
const similarLoading = ref(false)

async function loadSimilar() {
  if (!similarExpanded.value) return
  if (similarLoading.value || similarQuestions.value.length > 0) return
  similarLoading.value = true
  try {
    const res = await getSimilarQuestions(questionId.value)
    similarQuestions.value = Array.isArray(res) ? res : []
  } catch (e) {
    console.warn('[detail] similar GET failed', e)
    similarQuestions.value = []
  } finally {
    similarLoading.value = false
  }
}

// ── PRD-C-204 血缘母子链 ─────────────────────────────────────
const lineage = ref<QuestionLineage | null>(null)
const lineageLoading = ref(false)

async function loadLineage() {
  lineageLoading.value = true
  try {
    const res = await getQuestionLineage(questionId.value)
    // 宽松兜底：role 不合法时按 none 处理，绝不崩
    if (res && (res.role === 'mother' || res.role === 'variant' || res.role === 'none')) {
      lineage.value = {
        role: res.role,
        motherSource: res.motherSource ?? null,
        mother: res.mother ?? null,
        variants: Array.isArray(res.variants) ? res.variants : [],
      }
    } else {
      lineage.value = { role: 'none', mother: null, variants: [] }
    }
  } catch (e) {
    console.warn('[detail] lineage GET failed', e)
    lineage.value = null
  } finally {
    lineageLoading.value = false
  }
}

// 血缘家族文案：mother_source='教材配套' → 典型例题/配套练习（教材天然母子）；其余 → 母题/变式题（举一反三）
const lineageWords = computed(() => {
  const tb = lineage.value?.motherSource === '教材配套'
  return {
    motherTag: tb ? '典型例题' : '母题',
    variantTag: tb ? '配套练习' : '变式题',
    motherDesc: tb ? '本题为典型例题，下列为其配套练习：' : '本题为母题，下列为其变式：',
    motherLabel: tb ? '典型例题：' : '母题：',
    siblingLabel: tb ? '配套练习：' : '同门变式：',
    emptyVariants: tb ? '暂无配套练习' : '暂无变式',
  }
})

// 题型/难度文案真读字典（biz_question_type / biz_question_difficulty，超管改字典即生效）
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
dict.load(DICT_QUESTION_DIFFICULTY)
// 题型文案（血缘条目用）
function lineageTypeLabel(type: number | null): string {
  return type == null ? '—' : (dict.label(DICT_QUESTION_TYPE, type) || '—')
}
function lineageDifficultyLabel(d: number | null): string {
  if (d == null || d < 1 || d > 4) return '—'
  return `${dict.label(DICT_QUESTION_DIFFICULTY, d) || d}（${d}）`
}
// 跳到血缘条目对应题详情（id 全程 String，防精度）
function goToLineageNode(node: LineageNode) {
  const id = String(node.id)
  if (!id || id === String(questionId.value)) return
  router.push(`/question/detail/${id}`)
}

// ── 工具 ─────────────────────────────────────────────────────
function getDifficultyStars(difficult: number | null) {
  const val = difficult ?? 0
  return Array.from({ length: 4 }, (_, i) => i < val)
}

// 题型 label/彩标的死代码（getQuestionTypeLabel / getQuestionTypeTagType）已删除：
// 右栏「题目信息」题型展示统一走 DetailSidebar 的 useDictStore（字典 SSOT），父组件不再各写一份。

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getKnowledgeTagType(idx: number): 'success' | 'primary' | 'warning' | 'danger' | 'info' {
  const types: Array<'success' | 'primary' | 'warning' | 'danger' | 'info'> = [
    'success', 'primary', 'warning', 'danger', 'info'
  ]
  return types[idx % 5]
}

function goBack() {
  router.back()
}

// PRD-A-013 T2 — paperId 雪花 string
function goToPaperSource(paperId: string) {
  router.push(`/papers/source/${paperId}`)
}

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  // 兜底拉当前用户（权限判定需 userInfo.id/roles；内存态刷新会丢，与 editor.vue 同款兜底）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[detail] getCurrentUser 兜底失败', e)
    }
  }
  await loadQuestion()
  // 并行加载侧边栏数据 + 血缘母子链（PRD-C-204）
  Promise.allSettled([loadNotes(), loadSources(), loadLineage()])
})

// SPA 内 route.params.id 变化（如点「相似题推荐」跳另一题）时重载——
// 否则 vue-router 复用本组件、onMounted 不重跑，题干/备注/收录/相似题全停在旧题
// （与 source.vue PRD-A-005 G6 同类坑）。换题时先重置展开/输入态，再重新拉数据。
watch(questionId, async () => {
  answerExpanded.value = false
  explainExpanded.value = false
  similarExpanded.value = false
  similarQuestions.value = []
  noteInput.value = ''
  lineage.value = null
  await loadQuestion()
  Promise.allSettled([loadNotes(), loadSources(), loadLineage()])
})
</script>

<template>
  <div class="detail-page">
    <!-- 顶部导航栏 -->
    <div class="detail-topbar">
      <el-button link @click="goBack" class="back-btn">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回题库</span>
      </el-button>
      <span class="topbar-title">题目详情</span>
      <span class="topbar-spacer" />
    </div>

    <div v-if="loading" class="detail-loading">
      <el-skeleton :rows="10" animated style="max-width: 900px; margin: 0 auto;" />
    </div>

    <div v-else-if="!question" class="detail-empty">
      <el-empty description="题目数据加载失败">
        <el-button type="primary" @click="goBack">返回题库</el-button>
      </el-empty>
    </div>

    <div v-else class="detail-body">
      <!-- ══ 左主体区（70%）══ -->
      <div class="detail-main">
        <!-- 顶部 meta 行 -->
        <div class="meta-row">
          <div class="meta-left">
            <!-- 难度星 -->
            <span class="meta-label">难度:</span>
            <span class="stars-row">
              <span
                v-for="(active, i) in getDifficultyStars(question.difficult)"
                :key="i"
                class="star-icon"
                :class="{ 'star-active': active }"
              >★</span>
            </span>
            <!-- 知识点 — misikt 风格：label + 主知识点单 tag -->
            <span class="meta-label">知识点:</span>
            <el-tag
              v-if="question.questionKnowledges && question.questionKnowledges.length > 0"
              type="primary"
              size="small"
              class="knowledge-tag"
            >
              {{ question.questionKnowledges[0].knowledgeName || question.questionKnowledges[0].knowledgeId }}
            </el-tag>
            <span v-else class="knowledge-empty">暂无</span>
          </div>
          <div class="meta-right">
            <!-- 编辑（PRD-A-015）：本人题 / superadmin 才显示；BE update 同步硬校验 -->
            <el-button
              v-if="canEdit"
              size="small"
              type="primary"
              plain
              class="action-btn"
              @click="goEdit"
            >
              <el-icon><EditPen /></el-icon>编辑
            </el-button>
            <!-- 属性（PRD-A-015 批1）：同 canEdit 门控，跳题目属性编辑页 -->
            <el-button
              v-if="canEdit"
              size="small"
              type="primary"
              plain
              class="action-btn"
              @click="goAttributes"
            >
              <el-icon><Tools /></el-icon>高级属性
            </el-button>
            <!-- 草稿 -->
            <el-button size="small" class="action-btn" @click="sketchVisible = true">
              <el-icon><Edit /></el-icon>草稿
            </el-button>
            <!-- 收藏 -->
            <el-button
              size="small"
              class="action-btn"
              :type="isFavorite ? 'warning' : undefined"
              :loading="favoriteLoading"
              @click="handleFavorite"
            >
              <el-icon><Star /></el-icon>
              {{ isFavorite ? '已收藏' : '收藏' }}
            </el-button>
            <!-- 试题栏 toggle -->
            <el-button
              size="small"
              class="action-btn action-btn--basket"
              :class="{ 'action-btn--basket-added': isInBasket }"
              :type="isInBasket ? undefined : 'primary'"
              :plain="!isInBasket"
              :loading="basketLoading"
              @click="handleBasketToggle"
            >
              <el-icon v-if="!isInBasket"><ShoppingCart /></el-icon>
              {{ isInBasket ? '取消' : '+ 试题栏' }}
            </el-button>
          </div>
        </div>

        <!-- 题干区（PRD-A-015）：
             parsedBlock 非空 → 结构化网格块整题内容为权威（QuestionBlockRender）；
             否则回落旧富文本/图链（stemTextContent 优先，fallback stemText / stemImg）。 -->
        <div class="stem-area">
          <QuestionBlockRender
            v-if="parsedBlock"
            :doc="parsedBlock"
          />
          <QuestionContent
            v-else
            :text="question.stemTextContent || question.stemText"
            :img-url="question.stemImg"
            alt="题干"
          />
        </div>

        <!-- 来源行 + freeTags + 问AI（misikt 风格：来源 + 多个 freeTag 同一行）-->
        <div
          v-if="question.examPaperName || question.examYear || (question.freeTags && question.freeTags.length > 0)"
          class="source-row"
        >
          <span v-if="question.examPaperName" class="source-item">
            来源: {{ question.examPaperName }}{{ question.examYear ? ` · ${question.examYear}年` : '' }}
          </span>
          <span v-else-if="question.examYear" class="source-item">
            年份: {{ question.examYear }}
          </span>
          <!-- 自由标签 freeTags（X 卡 段③ + 用户验收轮 2 调整位置 → misikt 底部布局）-->
          <FreeTagList
            v-if="question.freeTags && question.freeTags.length > 0"
            :tags="question.freeTags"
            mode="detail"
            class="source-row-freetag"
          />
          <el-button
            size="small"
            link
            type="primary"
            class="ai-btn"
            @click="ElMessage.info('问AI功能开发中')"
          >
            <el-icon><ChatDotRound /></el-icon>问AI
          </el-button>
        </div>

        <!-- 收起/展开答案折叠区 -->
        <div class="collapse-section">
          <div class="collapse-header" @click="answerExpanded = !answerExpanded">
            <span class="collapse-label">{{ answerExpanded ? '收起答案' : '展开答案' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': answerExpanded }">▼</span>
          </div>
          <div v-if="answerExpanded" class="collapse-body">
            <div class="answer-label">【答案】</div>
            <!-- PRD-C-204：答案 blockJson 非空 → 结构化网格渲染（三端一致）；否则回落旧富文本 -->
            <QuestionBlockRender
              v-if="parsedAnswerBlock"
              :doc="parsedAnswerBlock"
            />
            <QuestionContent
              v-else
              :text="question.answerTextContent || question.answer"
              :img-url="question.answerImg"
              alt="答案"
            />
          </div>
        </div>

        <!-- 展开解析折叠区 -->
        <div class="collapse-section">
          <div class="collapse-header" @click="explainExpanded = !explainExpanded">
            <span class="collapse-label">{{ explainExpanded ? '收起解析' : '展开解析' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': explainExpanded }">▼</span>
          </div>
          <div v-if="explainExpanded" class="collapse-body">
            <!-- PRD-C-204：解析 blockJson 非空 → 结构化网格渲染（选项分析/小问/步骤各自成块）；否则回落旧富文本 -->
            <QuestionBlockRender
              v-if="parsedAnalyzeBlock"
              :doc="parsedAnalyzeBlock"
            />
            <QuestionContent
              v-else
              :text="question.analyzeTextContent || question.explain"
              :img-url="question.explainImg"
              alt="解析"
            />
          </div>
        </div>

        <!-- 相似题推荐折叠区 -->
        <div class="collapse-section">
          <div
            class="collapse-header"
            @click="similarExpanded = !similarExpanded; loadSimilar()"
          >
            <span class="collapse-label">{{ similarExpanded ? '收起相似题' : '展开相似题推荐' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': similarExpanded }">▼</span>
          </div>
          <div v-if="similarExpanded" class="collapse-body">
            <div v-if="similarLoading" class="similar-loading">
              <el-skeleton :rows="3" animated />
            </div>
            <div v-else-if="similarQuestions.length === 0" class="no-content">
              暂无相似题（接口需登录态）
            </div>
            <div
              v-else
              v-for="sq in similarQuestions"
              :key="sq.id"
              class="similar-item"
            >
              <QuestionContent
                :text="sq.stemText"
                :img-url="sq.stemImg"
                alt="相似题"
              />
            </div>
          </div>
        </div>

        <!-- ══ PRD-C-204 血缘关系（母子链）══ -->
        <div class="lineage-card">
          <div class="lineage-head">
            <span class="lineage-title">血缘关系</span>
            <el-tag
              v-if="lineage && lineage.role !== 'none'"
              :type="lineage.role === 'mother' ? 'warning' : 'primary'"
              size="small"
            >
              {{ lineage.role === 'mother' ? lineageWords.motherTag : lineageWords.variantTag }}
            </el-tag>
          </div>

          <div v-if="lineageLoading" class="lineage-loading">
            <el-skeleton :rows="2" animated />
          </div>

          <template v-else-if="lineage">
            <!-- role=mother：本题为母题，下列为其变式 -->
            <template v-if="lineage.role === 'mother'">
              <p class="lineage-desc">{{ lineageWords.motherDesc }}</p>
              <div v-if="lineage.variants.length" class="lineage-list">
                <div
                  v-for="v in lineage.variants"
                  :key="v.id"
                  class="lineage-item"
                  @click="goToLineageNode(v)"
                >
                  <span class="lineage-item-brief">{{ v.stemBrief || '（无摘要）' }}</span>
                  <span class="lineage-item-meta">
                    {{ lineageTypeLabel(v.questionType) }} · {{ lineageDifficultyLabel(v.difficult) }}
                    <span v-if="v.variantRelation" class="lineage-rel">· {{ v.variantRelation }}</span>
                  </span>
                </div>
              </div>
              <p v-else class="lineage-empty">{{ lineageWords.emptyVariants }}</p>
            </template>

            <!-- role=variant：本题为变式，显示母题 + 同门变式 -->
            <template v-else-if="lineage.role === 'variant'">
              <div v-if="lineage.mother" class="lineage-sub">
                <span class="lineage-sub-label">{{ lineageWords.motherLabel }}</span>
                <div class="lineage-item lineage-item--mother" @click="goToLineageNode(lineage.mother)">
                  <span class="lineage-item-brief">{{ lineage.mother.stemBrief || '（无摘要）' }}</span>
                  <span class="lineage-item-meta">
                    {{ lineageTypeLabel(lineage.mother.questionType) }} · {{ lineageDifficultyLabel(lineage.mother.difficult) }}
                  </span>
                </div>
              </div>
              <div v-if="lineage.variants.length" class="lineage-sub">
                <span class="lineage-sub-label">{{ lineageWords.siblingLabel }}</span>
                <div class="lineage-list">
                  <div
                    v-for="v in lineage.variants"
                    :key="v.id"
                    class="lineage-item"
                    @click="goToLineageNode(v)"
                  >
                    <span class="lineage-item-brief">{{ v.stemBrief || '（无摘要）' }}</span>
                    <span class="lineage-item-meta">
                      {{ lineageTypeLabel(v.questionType) }} · {{ lineageDifficultyLabel(v.difficult) }}
                      <span v-if="v.variantRelation" class="lineage-rel">· {{ v.variantRelation }}</span>
                    </span>
                  </div>
                </div>
              </div>
            </template>

            <!-- role=none -->
            <p v-else class="lineage-empty">无血缘关系</p>
          </template>

          <p v-else class="lineage-empty">血缘信息加载失败</p>
        </div>
      </div>

      <!-- ══ 右侧 sidebar（30%）══
           PRD-A-010 T3：抽 DetailSidebar 子组件（备注/收录/题目信息三卡）。
           备注输入 v-model:note-input 双向，保存/跳收录卷 emit 给父级原函数。-->
      <DetailSidebar
        v-model:note-input="noteInput"
        :note="note"
        :notes-loading="notesLoading"
        :note-saving="noteSaving"
        :sources="sources"
        :sources-loading="sourcesLoading"
        :question-type="question.questionType"
        @save-note="saveNote"
        @go-to-source="goToPaperSource"
      />
    </div>
  </div>

  <!-- 草稿纸 -->
  <SketchPad v-model:visible="sketchVisible" />
</template>

<style scoped>
.detail-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部导航栏 ── */
.detail-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  color: #4e5969;
  font-size: 14px;
  gap: 4px;
}

.back-btn:hover {
  color: var(--bk-teal);
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--bk-ink);
}
.topbar-spacer {
  flex: 1;
}

.detail-loading,
.detail-empty {
  padding: 40px 24px;
  display: flex;
  justify-content: center;
}

/* ── 主体布局（左70% + 右30%）── */
.detail-body {
  display: flex;
  gap: 16px;
  padding: 16px 24px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  align-items: flex-start;
}

/* ── 左主体区 ── */
.detail-main {
  flex: 7;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 顶部 meta 行 ── */
.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  background: #fff;
  border-radius: 12px;
  padding: 12px 16px;
  border: 1px solid var(--bk-line);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}

.meta-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}

.meta-label {
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
}

.stars-row {
  display: flex;
  align-items: center;
  gap: 1px;
}

.star-icon {
  font-size: 15px;
  color: #e5e6eb;
}

.star-icon.star-active {
  color: #f7ba1e;
}

.knowledge-tag {
  flex-shrink: 0;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.source-row-freetag {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.meta-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.action-btn {
  font-size: 12px;
}

.action-btn--basket-added {
  color: #86909c !important;
  border-color: #86909c !important;
}

.action-btn--basket-added:hover {
  color: #f53f3f !important;
  border-color: #f53f3f !important;
}

/* ── 题干区 ── */
.stem-area {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--bk-line);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
  min-height: 160px;
}

.stem-img {
  max-width: 100%;
  height: auto;
  display: block;
}

/* 字号由 MarkdownMath 固定 16px 基准驱动；markdown 自带换行，去掉 pre-wrap */
.stem-text {
  line-height: 1.7;
  color: var(--bk-ink);
}

.stem-placeholder {
  color: #c9cdd4;
  font-size: 14px;
}

/* ── 来源行 ── */
.source-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: #fff;
  border-radius: 12px;
  padding: 10px 16px;
  border: 1px solid var(--bk-line);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}

.source-item {
  font-size: 13px;
  color: #86909c;
}

.ai-btn {
  margin-left: auto;
  font-size: 13px;
}

/* ── 折叠区 ── */
.collapse-section {
  background: #fff;
  border-radius: 12px;
  border: 1px solid var(--bk-line);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
  overflow: hidden;
}

.collapse-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.collapse-header:hover {
  background: #fafbfc;
}

.collapse-label {
  font-size: 14px;
  font-weight: 500;
  color: #4e5969;
}

.collapse-arrow {
  font-size: 12px;
  color: #c9cdd4;
  transition: transform 0.2s;
}

.collapse-arrow.expanded {
  transform: rotate(180deg);
}

.collapse-body {
  padding: 12px 16px 16px;
  border-top: 1px solid #f2f3f5;
}

.answer-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bk-ink);
  margin-bottom: 8px;
}

.answer-img,
.explain-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.no-content {
  font-size: 13px;
  color: #c9cdd4;
}

.similar-loading {
  padding: 8px 0;
}

.similar-item {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px dashed #f2f3f5;
}

.similar-item:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.similar-img {
  max-width: 100%;
  height: auto;
}

/* 相似题文本也走统一字号变量（与主题面一致缩放） */
.similar-text {
  color: #4e5969;
}

/* ── PRD-C-204 血缘关系卡 ── */
.lineage-card {
  background: #fff;
  border-radius: 12px;
  border: 1px solid var(--bk-line);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
  padding: 14px 16px;
}

.lineage-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.lineage-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--bk-ink);
}

.lineage-loading {
  padding: 4px 0;
}

.lineage-desc {
  font-size: 13px;
  color: #4e5969;
  margin: 0 0 8px;
}

.lineage-sub {
  margin-bottom: 10px;
}

.lineage-sub:last-child {
  margin-bottom: 0;
}

.lineage-sub-label {
  display: block;
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
  margin-bottom: 6px;
}

.lineage-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lineage-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid #f0f1f3;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.lineage-item:hover {
  border-color: var(--bk-teal);
  background: var(--bk-teal-soft);
}

.lineage-item--mother {
  border-color: #fadcaa;
  background: #fffbf3;
}

.lineage-item--mother:hover {
  border-color: #f7ba1e;
}

.lineage-item-brief {
  font-size: 13px;
  color: var(--bk-ink);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.lineage-item-meta {
  font-size: 12px;
  color: #86909c;
}

.lineage-rel {
  color: var(--bk-teal);
}

.lineage-empty {
  font-size: 13px;
  color: #c9cdd4;
  margin: 0;
}

/* ── 右侧 sidebar 样式（.detail-sidebar / .sidebar-card* / .note-* / 收录卡 /
   题目信息 .info-*）已随 DetailSidebar 子组件迁出（PRD-A-010 T3）。
   原「报错 card」.sidebar-card--report/.report-btn 为既有未使用样式，一并清除。*/
</style>
