<script setup lang="ts">
/**
 * PRD-C-213 FP23 装题弹窗 —— 双 tab：①题库检索（复用 /teacher/question/page）②私有题池（/teacher/question/pool）。
 * 勾选加入 → emit('pick', SegQMeta[])，父级把 id 追加进当前段的 question_ids。
 * 🔴 id 全 string；切 tab / 翻页 / 搜索用 AbortController 防旧响应覆盖（PRD-A-013 M-10）。
 * 🔴 已在段内的题禁重复勾选（excludeIds）。
 */
import { ref, computed, watch } from 'vue'
import { questionPage, type QuestionItem } from '@/api/question/index'
import { pageQuestionPool, type QuestionPoolItem, type StarLevel } from '@/api/teacher/schedule'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import { metaFromQuestionItem, metaFromPoolItem, starText, type SegQMeta } from '../helpers'

const props = defineProps<{
  visible: boolean
  /** 当前段标题（弹窗标题辅助） */
  segName?: string
  /** 已在段内的题 id（禁重复加入） */
  excludeIds: string[]
  /**
   * BUG-014 备课上下文预筛：课次/学生的前置条件带进题库检索。
   * kgNodeIds = 课次知识单元锚点（biz_subject 树节点 id），传给 /teacher/question/page 的 subjectId
   *   做前缀圈子树预筛；多锚点默认取第一个、chips 可切换；用户移除 → 回到无预筛全库。
   * subjectLabel/gradeLabel 仅作范围提示文案。拿不到 kgNodeIds 时不显示 chips、不预筛。
   */
  context?: {
    kgNodeIds?: string[]
    kgNodeNames?: string[]
    subjectLabel?: string
    gradeLabel?: string
  }
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  pick: [items: SegQMeta[]]
}>()

const activeTab = ref<'bank' | 'pool'>('bank')
const excludeSet = computed(() => new Set(props.excludeIds.map(String)))
// 本次弹窗内已勾选（跨 tab 累积），id → SegQMeta
const picked = ref<Map<string, SegQMeta>>(new Map())
const pickedCount = computed(() => picked.value.size)

function isPicked(id: string): boolean {
  return picked.value.has(String(id))
}
function isExcluded(id: string): boolean {
  return excludeSet.value.has(String(id))
}
function togglePick(meta: SegQMeta) {
  if (isExcluded(meta.id)) return
  const next = new Map(picked.value)
  if (next.has(meta.id)) next.delete(meta.id)
  else next.set(meta.id, meta)
  picked.value = next
}

const PAGE_SIZE = 8
let abortCtl: AbortController | null = null
function freshSignal(): AbortSignal {
  abortCtl?.abort()
  abortCtl = new AbortController()
  return abortCtl.signal
}

// ── BUG-014 上下文预筛（subjectId = KG 锚点，前缀圈子树）───────────────────────
// anchorChips = 课次知识单元锚点（可切换 chips）；activeAnchor = 当前生效的 subjectId 预筛（空=全库）。
interface AnchorChip {
  id: string
  name: string
}
const activeAnchor = ref<string>('')
const anchorChips = computed<AnchorChip[]>(() => {
  const ids = props.context?.kgNodeIds ?? []
  const names = props.context?.kgNodeNames ?? []
  return ids.map((id, i) => ({ id: String(id), name: names[i] || `本课知识点${ids.length > 1 ? i + 1 : ''}`.trim() }))
})
// 范围提示文案（年级 · 学科）
const ctxScope = computed(() =>
  [props.context?.gradeLabel, props.context?.subjectLabel].filter(Boolean).join(' · '),
)
function switchAnchor(id: string) {
  if (activeAnchor.value === id) return
  activeAnchor.value = id
  onBankSearch()
}
function clearAnchor() {
  if (!activeAnchor.value) return
  activeAnchor.value = ''
  onBankSearch()
}

// ── tab1 题库检索 ──────────────────────────────────────────────
const bankLoading = ref(false)
const bankList = ref<QuestionItem[]>([])
const bankTotal = ref(0)
const bankPage = ref(1)
const bankKeyword = ref('')
const bankType = ref<number | ''>('')
const bankDiff = ref<number | ''>('')

async function searchBank() {
  bankLoading.value = true
  const signal = freshSignal()
  try {
    const res = await questionPage(
      {
        pageIndex: bankPage.value,
        pageSize: PAGE_SIZE,
        notTaskQuestion: 0,
        notUsedQuestion: 0,
        // BUG-014：有生效锚点 → 按 KG 树节点（前缀圈子树）预筛
        ...(activeAnchor.value ? { subjectId: activeAnchor.value } : {}),
        ...(bankKeyword.value.trim() ? { keyWord: bankKeyword.value.trim() } : {}),
        ...(bankType.value !== '' ? { questionType: Number(bankType.value) } : {}),
        ...(bankDiff.value !== '' ? { difficult: Number(bankDiff.value) } : {}),
      },
      { signal },
    )
    bankList.value = res?.list ?? []
    bankTotal.value = res?.total ?? 0
  } catch (e) {
    if ((e as { code?: string })?.code === 'ERR_CANCELED') return
    bankList.value = []
    bankTotal.value = 0
  } finally {
    bankLoading.value = false
  }
}
function onBankSearch() {
  bankPage.value = 1
  searchBank()
}
function onBankPage(p: number) {
  bankPage.value = p
  searchBank()
}

// ── tab2 私有题池 ──────────────────────────────────────────────
const poolLoading = ref(false)
const poolList = ref<QuestionPoolItem[]>([])
const poolTotal = ref(0)
const poolPage = ref(1)
const poolKeyword = ref('')
const poolTopicTag = ref('')
const poolStar = ref<StarLevel | ''>('')

async function searchPool() {
  poolLoading.value = true
  const signal = freshSignal()
  try {
    const res = await pageQuestionPool({
      pageNum: poolPage.value,
      pageSize: PAGE_SIZE,
      ...(poolKeyword.value.trim() ? { keyword: poolKeyword.value.trim() } : {}),
      ...(poolTopicTag.value.trim() ? { topicTag: poolTopicTag.value.trim() } : {}),
      ...(poolStar.value ? { starLevel: poolStar.value } : {}),
    })
    void signal
    poolList.value = res?.rows ?? []
    poolTotal.value = res?.total ?? 0
  } catch (e) {
    if ((e as { code?: string })?.code === 'ERR_CANCELED') return
    poolList.value = []
    poolTotal.value = 0
  } finally {
    poolLoading.value = false
  }
}
function onPoolSearch() {
  poolPage.value = 1
  searchPool()
}
function onPoolPage(p: number) {
  poolPage.value = p
  searchPool()
}

// 打开时重置 + 首搜；切 tab 首次进也搜
watch(
  () => props.visible,
  (v) => {
    if (!v) {
      abortCtl?.abort()
      return
    }
    picked.value = new Map()
    activeTab.value = 'bank'
    // BUG-014：默认取第一个 KG 锚点做预筛（多锚点 chips 可切换；无锚点=全库）
    activeAnchor.value = props.context?.kgNodeIds?.[0] ? String(props.context.kgNodeIds[0]) : ''
    bankPage.value = 1
    bankKeyword.value = ''
    bankType.value = ''
    bankDiff.value = ''
    poolPage.value = 1
    poolKeyword.value = ''
    poolTopicTag.value = ''
    poolStar.value = ''
    poolList.value = []
    searchBank()
  },
)

watch(activeTab, (t) => {
  if (!props.visible) return
  if (t === 'pool' && poolList.value.length === 0) searchPool()
})

function confirm() {
  if (picked.value.size === 0) {
    close()
    return
  }
  emit('pick', Array.from(picked.value.values()))
  close()
}
function close() {
  emit('update:visible', false)
}

// 题型 label（本页轻量映射，避免拉字典 store）
const TYPE_LABEL: Record<number, string> = { 1: '选择', 2: '判断', 3: '多选', 4: '填空', 5: '解答' }
function typeLabel(t?: number | null): string {
  return t != null ? TYPE_LABEL[t] || `题型${t}` : ''
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="`装题${segName ? ' · ' + segName : ''}`"
    width="760px"
    top="6vh"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="close"
  >
    <el-tabs v-model="activeTab" class="qp-tabs">
      <!-- tab1 题库检索 -->
      <el-tab-pane label="题库检索" name="bank">
        <!-- BUG-014：备课上下文预筛 chips（按本课知识单元圈子树；可切换 / 可移除回全库）-->
        <div v-if="anchorChips.length" class="qp-ctx">
          <span class="qp-ctx-label">按本课预筛<template v-if="ctxScope">（{{ ctxScope }}）</template>：</span>
          <button
            v-for="c in anchorChips"
            :key="c.id"
            class="qp-chip"
            :class="{ on: activeAnchor === c.id }"
            @click="switchAnchor(c.id)"
          >
            {{ c.name }}
          </button>
          <button v-if="activeAnchor" class="qp-chip clear" @click="clearAnchor">✕ 全库</button>
        </div>
        <div class="qp-filter">
          <el-input
            v-model="bankKeyword"
            placeholder="关键词搜题干"
            size="small"
            style="flex: 1; min-width: 140px"
            clearable
            @keyup.enter="onBankSearch"
          />
          <el-select v-model="bankType" placeholder="题型" size="small" style="width: 100px" clearable>
            <el-option label="选择" :value="1" />
            <el-option label="填空" :value="4" />
            <el-option label="解答" :value="5" />
          </el-select>
          <el-select v-model="bankDiff" placeholder="难度" size="small" style="width: 100px" clearable>
            <el-option label="★" :value="1" />
            <el-option label="★★" :value="2" />
            <el-option label="★★★" :value="3" />
            <el-option label="★★★★" :value="4" />
          </el-select>
          <el-button type="primary" size="small" @click="onBankSearch">搜索</el-button>
        </div>

        <div v-loading="bankLoading" class="qp-list">
          <div v-if="!bankLoading && bankList.length === 0" class="qp-empty">暂无题目</div>
          <div
            v-for="q in bankList"
            :key="q.id"
            class="qp-item"
            :class="{ on: isPicked(q.id), dim: isExcluded(q.id) }"
            @click="togglePick(metaFromQuestionItem(q))"
          >
            <el-checkbox
              :model-value="isPicked(q.id) || isExcluded(q.id)"
              :disabled="isExcluded(q.id)"
              class="qp-ck"
              @click.stop
              @change="togglePick(metaFromQuestionItem(q))"
            />
            <div class="qp-body">
              <div class="qp-meta">
                <span v-if="typeLabel(q.questionType)" class="qp-badge">{{ typeLabel(q.questionType) }}</span>
                <span v-if="q.difficult" class="qp-star">{{ '★'.repeat(q.difficult) }}</span>
                <span v-if="isExcluded(q.id)" class="qp-in">已在段内</span>
              </div>
              <QuestionContent
                :text="q.stemTextContent ?? q.stemText"
                :img-url="q.stemImg"
                alt="题干"
                img-max-height="80px"
              />
            </div>
          </div>
        </div>
        <div v-if="bankTotal > 0" class="qp-pager">
          <el-pagination
            :current-page="bankPage"
            :page-size="PAGE_SIZE"
            :total="bankTotal"
            layout="prev, pager, next"
            small
            @current-change="onBankPage"
          />
        </div>
      </el-tab-pane>

      <!-- tab2 私有题池 -->
      <el-tab-pane label="私有题池" name="pool">
        <div class="qp-filter">
          <el-input
            v-model="poolKeyword"
            placeholder="关键词"
            size="small"
            style="flex: 1; min-width: 120px"
            clearable
            @keyup.enter="onPoolSearch"
          />
          <el-input
            v-model="poolTopicTag"
            placeholder="专项标签"
            size="small"
            style="width: 130px"
            clearable
            @keyup.enter="onPoolSearch"
          />
          <el-select v-model="poolStar" placeholder="星级" size="small" style="width: 100px" clearable>
            <el-option label="★" value="1" />
            <el-option label="★★" value="2" />
            <el-option label="★★★" value="3" />
          </el-select>
          <el-button type="primary" size="small" @click="onPoolSearch">搜索</el-button>
        </div>

        <div v-loading="poolLoading" class="qp-list">
          <div v-if="!poolLoading && poolList.length === 0" class="qp-empty">
            私有题池为空（我创建且未公开的题）
          </div>
          <div
            v-for="q in poolList"
            :key="q.id"
            class="qp-item"
            :class="{ on: isPicked(q.id), dim: isExcluded(q.id) }"
            @click="togglePick(metaFromPoolItem(q))"
          >
            <el-checkbox
              :model-value="isPicked(q.id) || isExcluded(q.id)"
              :disabled="isExcluded(q.id)"
              class="qp-ck"
              @click.stop
              @change="togglePick(metaFromPoolItem(q))"
            />
            <div class="qp-body">
              <div class="qp-meta">
                <span v-if="typeLabel(q.questionType != null ? Number(q.questionType) : null)" class="qp-badge">
                  {{ typeLabel(q.questionType != null ? Number(q.questionType) : null) }}
                </span>
                <span v-if="starText(q.starLevel)" class="qp-star">{{ starText(q.starLevel) }}</span>
                <span v-if="q.topicTag" class="qp-tag">{{ q.topicTag }}</span>
                <span v-if="q.sourceRef" class="qp-src">{{ q.sourceRef }}</span>
                <span v-if="isExcluded(q.id)" class="qp-in">已在段内</span>
              </div>
              <QuestionContent :text="q.stem" alt="题干" img-max-height="80px" />
            </div>
          </div>
        </div>
        <div v-if="poolTotal > 0" class="qp-pager">
          <el-pagination
            :current-page="poolPage"
            :page-size="PAGE_SIZE"
            :total="poolTotal"
            layout="prev, pager, next"
            small
            @current-change="onPoolPage"
          />
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <span class="qp-foot-hint">已选 {{ pickedCount }} 题</span>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="pickedCount === 0" @click="confirm">
        加入选中（{{ pickedCount }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.qp-tabs { margin-top: -8px; }
/* BUG-014 上下文预筛 chips */
.qp-ctx { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.qp-ctx-label { font-size: 12px; color: #8ba09a; }
.qp-chip {
  font-size: 12px; line-height: 20px; padding: 0 10px; border-radius: 99px; cursor: pointer;
  border: 1px solid var(--bk-line); background: #fff; color: #5f716d; transition: all .15s;
}
.qp-chip:hover { border-color: var(--bk-teal); color: var(--bk-teal-deep); }
.qp-chip.on { border-color: var(--bk-teal); background: var(--bk-teal-soft); color: var(--bk-teal-deep); font-weight: 600; }
.qp-chip.clear { color: #ba3a2a; border-style: dashed; }
.qp-chip.clear:hover { border-color: #ba3a2a; color: #ba3a2a; }
.qp-filter { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.qp-list { min-height: 220px; max-height: 440px; overflow-y: auto; }
.qp-empty { text-align: center; color: #b7c4c0; padding: 44px 0; font-size: 13px; }
.qp-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--bk-line); border-radius: 9px; margin-bottom: 8px; background: #fff;
  cursor: pointer; transition: border-color .15s, background .15s;
}
.qp-item:hover { border-color: var(--bk-teal); }
.qp-item.on { border-color: var(--bk-teal); background: var(--bk-teal-soft); }
.qp-item.dim { opacity: .6; cursor: not-allowed; background: #fafcfb; }
.qp-ck { margin-top: 2px; flex: none; }
.qp-body { flex: 1; min-width: 0; }
.qp-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.qp-badge {
  font-size: 11px; color: var(--bk-teal-deep); background: var(--bk-teal-soft);
  border-radius: 5px; padding: 0 7px; line-height: 18px; font-weight: 600;
}
.qp-star { font-size: 12px; color: #b45309; font-weight: 700; }
.qp-tag, .qp-src { font-size: 11px; color: #8ba09a; background: #eef1f0; border-radius: 5px; padding: 0 7px; line-height: 18px; }
.qp-in { font-size: 11px; color: #ba3a2a; }
.qp-pager { display: flex; justify-content: center; padding-top: 10px; }
.qp-foot-hint { font-size: 12px; color: #8ba09a; margin-right: auto; }
:deep(.el-dialog__footer) { display: flex; align-items: center; gap: 10px; }
</style>
