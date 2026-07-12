<script setup lang="ts">
/**
 * 专项编辑器（PRD-003 P4）—— /special/:id/edit。
 *
 * 专项的结构与题目全在这 CRUD。结构 = 区块（sec）→ 难度档（tier）→ 题。
 *  - 区块 CRUD：＋区块 / 改名 / 删 / 拖排；区块下 ＋难度档 / 改名(含★/档名 meta) / 删。
 *  - 题目：＋题（从试题栏批量入 / pick）、删、答题留空高度选择、override 改题（只影响本专项链路）、
 *    节点内拖动排序（sortablejs）。
 *  - 顶栏：课次绑定 chip（备课上下文）、预览、导出 PDF（P5 对话框）。
 *
 * 🔴 卷面纪律：sec/tier 的 name 老师自填干净知识点名；★/档名存 tier.meta，导出勾选才显。
 */
import { ref, reactive, computed, onMounted, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import Sortable from 'sortablejs'
import {
  getSpecialDetail,
  createSpecialNode,
  updateSpecialNode,
  deleteSpecialNode,
  reorderSpecialNodes,
  addSpecialItem,
  updateSpecialItem,
  deleteSpecialItem,
  reorderSpecialItems,
  type SpecialDetail,
  type SpecialItemVO,
} from '@/api/special'
import { getQuestionDetail, type QuestionItem } from '@/api/question/index'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useSpecialStore } from '@/store/special'
import { useSpecialExportStore } from '@/store/specialExport'
import QuestionContent from '@/components/business/QuestionContent/index.vue'

const route = useRoute()
const router = useRouter()
const qBasket = useQuestionBasket()
const specialStore = useSpecialStore()
const exportStore = useSpecialExportStore()

const specialId = computed(() => String(route.params.id ?? ''))
const detail = ref<SpecialDetail | null>(null)
const loading = ref(false)

// 题干缓存（questionId → QuestionItem）
const qCache = reactive<Record<string, QuestionItem>>({})

// 留空高度选项（mm）
const GAP_OPTIONS = [
  { value: 0, label: '不留空' },
  { value: 24, label: '留空 24mm' },
  { value: 34, label: '留空 34mm' },
  { value: 48, label: '留空 48mm' },
]

// ── 加载 ─────────────────────────────────────────────────────────────
async function load() {
  if (!specialId.value) return
  loading.value = true
  try {
    const d = await getSpecialDetail(specialId.value)
    detail.value = d
    void loadStems()
  } catch (e) {
    console.warn('[special-editor] load failed', e)
    detail.value = null
  } finally {
    loading.value = false
  }
}

function allItems(): SpecialItemVO[] {
  const out: SpecialItemVO[] = []
  for (const sec of detail.value?.secs ?? []) {
    out.push(...(sec.items ?? []))
    for (const t of sec.tiers ?? []) out.push(...(t.items ?? []))
  }
  return out
}

async function loadStems() {
  const ids = new Set<string>()
  for (const it of allItems()) {
    if (it.questionId && !qCache[it.questionId]) ids.add(it.questionId)
  }
  await Promise.allSettled(
    [...ids].map(async (id) => {
      try {
        qCache[id] = await getQuestionDetail(id)
      } catch {
        /* 缺题静默 */
      }
    }),
  )
}

function stemOf(it: SpecialItemVO): { text: string | null; img: string | null } {
  // override.stem 优先（本专项改题）
  const ov = it.override as Record<string, unknown> | null
  const ovStem = ov && typeof ov.stem === 'string' ? (ov.stem as string) : null
  const q = it.questionId ? qCache[it.questionId] : undefined
  const text = ovStem || q?.stemTextContent || q?.stemText || null
  return { text, img: q?.stemImg ?? null }
}

// ── 顶栏动作 ─────────────────────────────────────────────────────────
function goBack() {
  router.back()
}
function openExport() {
  if (!detail.value) return
  exportStore.open(specialId.value, detail.value.title)
}

// ── 区块（sec）CRUD ──────────────────────────────────────────────────
async function addSec() {
  let name = ''
  try {
    const r = await ElMessageBox.prompt('区块名（卷面可见，写干净知识点名，禁内部词）', '添加区块', {
      confirmButtonText: '添加',
      cancelButtonText: '取消',
      inputValidator: (v: string) => (v && v.trim() ? true : '区块名不能为空'),
    })
    name = (r.value || '').trim()
  } catch {
    return
  }
  try {
    await createSpecialNode(specialId.value, { name })
    ElMessage.success('区块已添加')
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

async function renameNode(nodeId: string, current: string) {
  let name = ''
  try {
    const r = await ElMessageBox.prompt('新名称', '改名', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: current,
      inputValidator: (v: string) => (v && v.trim() ? true : '名称不能为空'),
    })
    name = (r.value || '').trim()
  } catch {
    return
  }
  try {
    await updateSpecialNode(nodeId, { name })
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

async function removeNode(nodeId: string, name: string, isSec: boolean) {
  try {
    await ElMessageBox.confirm(
      `删除${isSec ? '区块' : '难度档'}「${name}」？${isSec ? '（含其下难度档与题）' : '（含其下题）'}`,
      '删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await deleteSpecialNode(nodeId)
    ElMessage.success('已删除')
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

// ── 难度档（tier）CRUD ───────────────────────────────────────────────
async function addTier(secId: string) {
  let name = ''
  let star = 1
  try {
    const r = await ElMessageBox.prompt('难度档名（如 热身 / 进阶 / 挑战）', '添加难度档', {
      confirmButtonText: '添加',
      cancelButtonText: '取消',
      inputValidator: (v: string) => (v && v.trim() ? true : '档名不能为空'),
    })
    name = (r.value || '').trim()
  } catch {
    return
  }
  try {
    const s = await ElMessageBox.prompt('星级（1/2/3，仅老师侧元数据，导出勾选才显示★）', '难度星级', {
      confirmButtonText: '确定',
      cancelButtonText: '不设',
      inputValue: '1',
      inputPattern: /^[123]$/,
      inputErrorMessage: '请输入 1 / 2 / 3',
    })
    star = Number(s.value) || 1
  } catch {
    star = 0
  }
  try {
    await createSpecialNode(specialId.value, {
      name,
      parentId: secId,
      nodeType: 'tier',
      meta: star ? { star, label: name } : { label: name },
    })
    ElMessage.success('难度档已添加')
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

// ── 题目 CRUD ────────────────────────────────────────────────────────
// ＋题：把当前试题栏（useQuestionBasket）题批量入本节点
async function addItemsFromBasket(nodeId: string) {
  const items = qBasket.items.value
  if (!items.length) {
    ElMessage.warning('试题栏为空——先去题库把题加入试题栏，再回来「＋题」')
    return
  }
  try {
    for (const it of items) {
      await addSpecialItem(nodeId, { questionId: it.id })
    }
    ElMessage.success(`已加入 ${items.length} 题`)
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

async function removeItem(itemId: string) {
  try {
    await deleteSpecialItem(itemId)
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

async function changeGap(item: SpecialItemVO, gap: number) {
  try {
    await updateSpecialItem(item.id, { gap })
    item.gap = gap
  } catch {
    /* 拦截器已弹错 */
  }
}

// override 改题（简版：改题干文本，只影响本专项链路）
const overrideDlg = reactive<{ visible: boolean; itemId: string; stem: string; answer: string; analysis: string; clearOptions: boolean }>(
  { visible: false, itemId: '', stem: '', answer: '', analysis: '', clearOptions: false },
)
function openOverride(item: SpecialItemVO) {
  const ov = (item.override as Record<string, unknown>) || {}
  overrideDlg.itemId = item.id
  overrideDlg.stem = typeof ov.stem === 'string' ? ov.stem : ''
  overrideDlg.answer = typeof ov.answer === 'string' ? ov.answer : ''
  overrideDlg.analysis = typeof ov.analysis === 'string' ? ov.analysis : ''
  // options 显式覆盖为空数组 = 已清空源选项
  overrideDlg.clearOptions = Array.isArray(ov.options) && (ov.options as unknown[]).length === 0
  overrideDlg.visible = true
}
async function saveOverride() {
  const ov: Record<string, unknown> = {}
  if (overrideDlg.stem.trim()) ov.stem = overrideDlg.stem.trim()
  if (overrideDlg.answer.trim()) ov.answer = overrideDlg.answer.trim()
  if (overrideDlg.analysis.trim()) ov.analysis = overrideDlg.analysis.trim()
  // 勾选「清空源选项」→ options=[] 显式覆盖，导出时不带原选择题 A/B/C/D（改编题防自相矛盾）
  if (overrideDlg.clearOptions) ov.options = []
  try {
    await updateSpecialItem(overrideDlg.itemId, { overrideJson: Object.keys(ov).length ? ov : null })
    overrideDlg.visible = false
    ElMessage.success('已保存（仅本专项）')
    await load()
  } catch {
    /* 拦截器已弹错 */
  }
}

// ── 拖排（sortablejs）─────────────────────────────────────────────────
const sortables: Sortable[] = []
function destroySortables() {
  while (sortables.length) sortables.pop()?.destroy()
}
function initSortables() {
  destroySortables()
  void nextTick(() => {
    // 节点内题目拖排
    document.querySelectorAll<HTMLElement>('[data-item-list]').forEach((el) => {
      const nodeId = el.dataset.itemList
      if (!nodeId) return
      sortables.push(
        Sortable.create(el, {
          handle: '.q-drag',
          animation: 150,
          draggable: '.q-mini',
          onEnd: async () => {
            const ids: string[] = []
            el.querySelectorAll<HTMLElement>('[data-item-id]').forEach((n) => {
              if (n.dataset.itemId) ids.push(n.dataset.itemId)
            })
            try {
              await reorderSpecialItems(nodeId, ids)
            } catch {
              await load()
            }
          },
        }),
      )
    })
    // 区块拖排
    const secList = document.querySelector<HTMLElement>('[data-sec-list]')
    if (secList) {
      sortables.push(
        Sortable.create(secList, {
          handle: '.sec-drag',
          animation: 150,
          draggable: '.sec-blk',
          onEnd: async () => {
            const ids: string[] = []
            secList.querySelectorAll<HTMLElement>('[data-sec-id]').forEach((n) => {
              if (n.dataset.secId) ids.push(n.dataset.secId)
            })
            try {
              await reorderSpecialNodes(specialId.value, ids)
            } catch {
              await load()
            }
          },
        }),
      )
    }
  })
}

onMounted(async () => {
  await load()
  await specialStore.ensureLoaded()
  initSortables()
})
onBeforeUnmount(destroySortables)

// 每次结构变化后重挂拖排
function reInitAfter(fn: () => Promise<void>) {
  return async () => {
    await fn()
    initSortables()
  }
}
const loadAndSort = reInitAfter(load)
</script>

<template>
  <div class="sp-editor" v-loading="loading">
    <template v-if="detail">
      <!-- 顶栏 -->
      <div class="ed-head">
        <el-button link @click="goBack">‹ 返回</el-button>
        <span class="ed-name">{{ detail.title }}</span>
        <span class="ed-tag">专项</span>
        <span v-if="specialStore.prepLabel" class="ed-bind">📎 {{ specialStore.prepLabel }}</span>
        <span class="ed-sp"></span>
        <el-button type="primary" @click="openExport">导出 PDF</el-button>
      </div>

      <!-- 结构树 -->
      <div class="ed-body">
        <el-empty
          v-if="detail.secs.length === 0"
          description="还没有区块。点下方「＋区块」开始搭结构，再从试题栏「＋题」"
          :image-size="80"
        />
        <div data-sec-list>
          <div v-for="sec in detail.secs" :key="sec.id" class="sec-blk" :data-sec-id="sec.id">
            <div class="sec-bar">
              <span class="sec-drag" title="拖动排序">⠿</span>
              <span class="sec-name">📖 {{ sec.name }}</span>
              <span class="blk-ops">
                <el-button size="small" @click="addItemsFromBasket(sec.id)">＋题</el-button>
                <el-button size="small" @click="addTier(sec.id)">＋难度档</el-button>
                <el-button size="small" @click="renameNode(sec.id, sec.name)">改名</el-button>
                <el-button size="small" type="danger" link @click="removeNode(sec.id, sec.name, true)">删</el-button>
              </span>
            </div>

            <!-- 直挂 sec 的题 -->
            <div class="q-list" :data-item-list="sec.id">
              <div v-for="item in sec.items" :key="item.id" class="q-mini" :data-item-id="item.id">
                <span class="q-drag" title="拖动排序">⠿</span>
                <div class="q-stem">
                  <QuestionContent :text="stemOf(item).text" :img-url="stemOf(item).img" img-max-height="80px" />
                  <span v-if="item.override" class="q-ov">已改题</span>
                </div>
                <el-select
                  :model-value="item.gap ?? 0"
                  size="small"
                  class="q-gap"
                  @update:model-value="(v: number) => changeGap(item, v)"
                >
                  <el-option v-for="g in GAP_OPTIONS" :key="g.value" :label="g.label" :value="g.value" />
                </el-select>
                <el-button size="small" link @click="openOverride(item)">✎</el-button>
                <el-button size="small" link type="danger" @click="removeItem(item.id)">✕</el-button>
              </div>
              <p v-if="sec.items.length === 0 && sec.tiers.length === 0" class="q-empty">
                空区块——「＋题」从试题栏加，或「＋难度档」分档
              </p>
            </div>

            <!-- 难度档 tier -->
            <div v-for="tier in sec.tiers" :key="tier.id" class="tier-blk">
              <div class="tier-bar">
                <span class="tier-name">
                  <span v-if="tier.meta && tier.meta.star" class="tier-star">{{ '★'.repeat(Number(tier.meta.star)) }}</span>
                  {{ tier.name }}（{{ tier.items.length }} 题）
                </span>
                <span class="blk-ops">
                  <el-button size="small" @click="addItemsFromBasket(tier.id)">＋题</el-button>
                  <el-button size="small" @click="renameNode(tier.id, tier.name)">改名</el-button>
                  <el-button size="small" type="danger" link @click="removeNode(tier.id, tier.name, false)">删</el-button>
                </span>
              </div>
              <div class="q-list" :data-item-list="tier.id">
                <div v-for="item in tier.items" :key="item.id" class="q-mini" :data-item-id="item.id">
                  <span class="q-drag" title="拖动排序">⠿</span>
                  <div class="q-stem">
                    <QuestionContent :text="stemOf(item).text" :img-url="stemOf(item).img" img-max-height="80px" />
                    <span v-if="item.override" class="q-ov">已改题</span>
                  </div>
                  <el-select
                    :model-value="item.gap ?? 0"
                    size="small"
                    class="q-gap"
                    @update:model-value="(v: number) => changeGap(item, v)"
                  >
                    <el-option v-for="g in GAP_OPTIONS" :key="g.value" :label="g.label" :value="g.value" />
                  </el-select>
                  <el-button size="small" link @click="openOverride(item)">✎</el-button>
                  <el-button size="small" link type="danger" @click="removeItem(item.id)">✕</el-button>
                </div>
                <p v-if="tier.items.length === 0" class="q-empty">空档——「＋题」从试题栏加</p>
              </div>
            </div>
          </div>
        </div>

        <div class="ed-foot">
          <el-button @click="addSec">＋区块</el-button>
          <span class="ed-foot-hint">题从「试题栏」批量入：先去题库把题加入试题栏，回来点区块/难度档的「＋题」</span>
        </div>
      </div>
    </template>

    <el-empty v-else-if="!loading" description="专项不存在或无权访问" />

    <!-- override 改题对话框 -->
    <el-dialog v-model="overrideDlg.visible" title="改题（仅影响本专项，不改题库源题）" width="560px" append-to-body>
      <div class="ov-form">
        <label>题干覆盖（留空=用源题）</label>
        <el-input v-model="overrideDlg.stem" type="textarea" :rows="3" placeholder="支持 $...$ LaTeX" />
        <label>答案覆盖</label>
        <el-input v-model="overrideDlg.answer" type="textarea" :rows="2" />
        <label>解析覆盖</label>
        <el-input v-model="overrideDlg.analysis" type="textarea" :rows="2" />
        <el-checkbox v-model="overrideDlg.clearOptions" style="margin-top: 8px">
          清空源选项（改编题干时勾选，导出不带原选择题 A/B/C/D）
        </el-checkbox>
      </div>
      <template #footer>
        <el-button @click="overrideDlg.visible = false">取消</el-button>
        <el-button type="primary" @click="saveOverride">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sp-editor { max-width: 960px; margin: 0 auto; padding: 8px 16px 40px; }
.ed-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  position: sticky;
  top: 0;
  background: var(--bk-bg, #fff);
  z-index: 5;
  border-bottom: 1px solid #eef3f1;
}
.ed-name { font-size: 17px; font-weight: 800; color: #1d2a2e; }
.ed-tag { font-size: 11px; font-weight: 700; color: #0a8e6a; background: #e6f7f1; border-radius: 5px; padding: 2px 8px; }
.ed-bind { font-size: 12px; color: #86909c; }
.ed-sp { flex: 1; }
.ed-body { padding-top: 14px; }
.sec-blk { margin-bottom: 18px; }
.sec-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'SimHei', 'Microsoft YaHei', sans-serif;
  color: #1268b3;
  font-size: 15px;
  font-weight: 700;
  padding: 6px 0;
  border-bottom: 1px solid #e6eef6;
}
.sec-drag, .q-drag { cursor: grab; color: #b8c4c0; user-select: none; }
.sec-name, .tier-name { flex: 1; }
.blk-ops { display: flex; gap: 4px; align-items: center; }
.tier-blk { margin: 10px 0 6px; padding-left: 6px; }
.tier-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'SimHei', 'Microsoft YaHei', sans-serif;
  color: #b8860b;
  font-size: 13.5px;
  font-weight: 700;
  border-bottom: 1px dashed #e2cf9a;
  padding-bottom: 3px;
  margin-bottom: 6px;
}
.tier-star { margin-right: 4px; }
.q-list { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; }
.q-mini {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #eef3f1;
  border-radius: 8px;
  background: #fcfefe;
}
.q-mini .q-drag { margin-top: 2px; }
.q-stem { flex: 1; min-width: 0; font-size: 13px; color: #303133; }
.q-ov { display: inline-block; margin-top: 3px; font-size: 10.5px; color: #c47d0e; background: #fff6e5; border-radius: 4px; padding: 0 6px; }
.q-gap { width: 120px; flex: none; }
.q-empty { font-size: 12.5px; color: #a6b2b6; margin: 4px 0; }
.ed-foot { margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ed-foot-hint { font-size: 12px; color: #a6b2b6; }
.ov-form { display: flex; flex-direction: column; gap: 6px; }
.ov-form label { font-size: 12.5px; color: #5f716d; font-weight: 600; }
</style>
