<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-015 批5·块① + 块④ U1 — 母题顶部横条（可整体折叠 ▼/▲，不占中栏）。
//
// D-merge4 布局：母题区 = 屏幕顶部一条横条（左母题题面缩略图 + 右 🧬 母题 DNA 面板），
// 下方保持「左聊天 / 右变式题组」双栏（在 index.vue 编排）。可一键折叠腾地方。
//
// 母题 DNA 面板分两段（§6.5）：
//   上段「守恒基准维·可改」= 副考点 / 考察类型 / 解法骨架最难步 / 难点
//     —— 改它们落 mother_dna.dna（组级共享，BE edit-dna 守恒维路由），下游变式回流 dirty。
//   下段「其余维·仅展示」= 主考点 / 年级（硬锚·改→立即重锚）+ 场景/难度（灰显·随变式调）
//     + 题型（三锚·头部确认）+ 模型 chips。
//
// 门控（D-merge7 确定性异常才停·非置信非硬锁）：mother_confirm.needs_confirm=true（副考点越界 /
// 考察类型出闭集 / 骨架为空 或 三锚没定死）→ 外显「合并确认面」让老师过/改；无异常直接出变式
// 不打扰。「过」= 纯 FE 关闭确认面（dismissed，非硬锁，不调后端）；「改」走各维 edit-dna。
//
// 🔴 母题守恒维数据源：BE _artifact_payload 的 header 暂未透传母题 DNA（仅每个 item.dna 含
// 组级共享维，变式继承母题）→ 本组件从 items[0].dna 取母题守恒基准维镜像（组级共享，最近真相）。
// 改母题守恒维 emit('edit-mother-dna', {field, value})，宿主调 editVariantDna(index=1, field)
// （落 mother_dna.dna，BE 守恒维路由组级生效）。
// ---------------------------------------------------------------------------
import { computed, ref } from 'vue'
import {
  EXAM_TYPES,
  MOTHER_CONFIRM_FLAG_LABEL,
  type DnaEditValue,
  type DnaField,
  type VariantArtifact,
  type VariantDna,
} from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'
import KpTreeDialog from './KpTreeDialog.vue'

const props = defineProps<{
  artifact: VariantArtifact | null
  /** 母题图（守恒锚缩略图，点开看大图） */
  motherImg?: string
  /** 发送中：禁用母题面板交互 */
  sending: boolean
}>()

const emit = defineEmits<{
  /** 改母题守恒维（副考点/考察类型/骨架/难点）→ 宿主调 editVariantDna(index=1, field)，落 mother_dna */
  (e: 'edit-mother-dna', payload: { field: DnaField; value: DnaEditValue }): void
  /** 老师「过」守恒维（非硬锁，纯关闭确认面）→ 宿主记本会话已过目 */
  (e: 'confirm-mother'): void
  /** 换母题图（缺口13，重置全新母题）→ 宿主复用贴图流程 */
  (e: 'swap-image'): void
  /** 点开看大图 */
  (e: 'preview', url: string): void
}>()

// 折叠态（默认展开，老师扫一眼即可收起；确定性异常时强制展开提示确认）
const collapsed = ref(false)

// 母题守恒维确认面是否已被老师「过」（本会话态，非硬锁；BE needs_confirm 仍为权威首发依据）
const confirmDismissed = ref(false)

// 母题 DNA = 组级共享维（从首个变式 item.dna 取镜像；变式继承母题，最近真相源）
const motherDna = computed<VariantDna | null>(() => {
  const it = props.artifact?.items?.[0]
  return it ? it.dna : null
})
const header = computed(() => props.artifact?.header ?? null)
const motherConfirm = computed(() => header.value?.motherConfirm ?? null)

// 门控外显：BE needs_confirm=true 且老师未过目 → 弹合并确认面
const showConfirmFace = computed(
  () => !!motherConfirm.value?.needsConfirm && !confirmDismissed.value
)
// 异常原因（中文）+ 三锚未定提示
const confirmFlags = computed(() =>
  (motherConfirm.value?.flags ?? []).map((f) => MOTHER_CONFIRM_FLAG_LABEL[f] ?? f)
)
// 有母题数据才渲染横条（无 artifact / 无 items → 不显示，避免空横条占位）
const hasMother = computed(() => !!props.artifact && props.artifact.items.length > 0)

const examTypeOptions = EXAM_TYPES

// ---- 守恒维：副考点（知识点树多选 ≤3）----
const kpDialog = ref(false)
function onPickSecondaryKps(value: Array<{ id: string; name: string }>) {
  emit('edit-mother-dna', { field: 'secondary_kps', value })
  kpDialog.value = false
}

// ---- 守恒维：考察类型（闭集下拉）----
function onPickExamType(v: string) {
  if (!v || v === motherDna.value?.examType) return
  emit('edit-mother-dna', { field: 'exam_type', value: v })
}

// ---- 守恒维：解法骨架最难步（文本编辑）----
const skelEditing = ref(false)
const skelDraft = ref('')
function openSkelEdit() {
  if (props.sending) return
  skelDraft.value = motherDna.value?.skeleton || ''
  skelEditing.value = true
}
function saveSkel() {
  const v = skelDraft.value.trim()
  emit('edit-mother-dna', { field: 'skeleton', value: v })
  skelEditing.value = false
}

// ---- 守恒维：难点（文本编辑，多条按行）----
const hardEditing = ref(false)
const hardDraft = ref('')
function openHardEdit() {
  if (props.sending) return
  hardDraft.value = (motherDna.value?.hardPoints || []).join('\n')
  hardEditing.value = true
}
function saveHard() {
  const arr = hardDraft.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  emit('edit-mother-dna', { field: 'hard_points', value: arr })
  hardEditing.value = false
}

function dismissConfirm() {
  confirmDismissed.value = true
  emit('confirm-mother')
}
function swapImage() {
  if (props.sending) return
  emit('swap-image')
}
</script>

<template>
  <section v-if="hasMother" class="mother-bar-wrap" data-testid="variant-mother-bar">
    <!-- 横条头：折叠开关 + 标题 + 换母题图入口 -->
    <header class="mb-head">
      <button type="button" class="mb-toggle" @click="collapsed = !collapsed">
        {{ collapsed ? '▼' : '▲' }} 母题
      </button>
      <span class="mb-title">母题考点基准（变式的基准·改基准则下游回流）</span>
      <!-- 确定性异常未确认 → 卡头红点提示 -->
      <span v-if="showConfirmFace" class="mb-flag-dot" title="母题考点需确认">● 待确认</span>
      <span class="mb-spacer" />
      <button type="button" class="mb-swap" :disabled="sending" title="换母题图 = 全新母题（重置）" @click="swapImage">
        换母题图
      </button>
    </header>

    <!-- 折叠态隐藏正文（母题作参考用，扫一眼即可收起腾地方） -->
    <div v-show="!collapsed" class="mb-body">
      <!-- 左：母题题面缩略 + 缩略图 -->
      <div class="mb-thumb">
        <div
          v-if="motherImg"
          class="mb-img"
          title="当前母题·点开看大图"
          @click="emit('preview', motherImg)"
        >
          <img :src="motherImg" alt="母题" referrerpolicy="no-referrer" />
        </div>
        <div v-else class="mb-img mb-img-empty">🧮</div>
        <div class="mb-anchor">
          <span class="mb-anchor-k">主考点</span>
          <b>{{ header?.kp || '未锚定' }}</b>
        </div>
        <div class="mb-anchor">
          <span class="mb-anchor-k">年级</span>
          <b>{{ header?.grade || '未定' }}</b>
        </div>
      </div>

      <!-- 右：🧬 母题 DNA 面板（分两段） -->
      <div class="mb-dna">
        <!-- 合并确认面（D-merge7 确定性异常才停 + 缺口5 三锚+守恒维一次外显） -->
        <div v-if="showConfirmFace" class="mb-confirm">
          <p class="mb-confirm-title">⚠ 母题考点需确认（异常才打扰，过/改后再出变式）</p>
          <ul v-if="confirmFlags.length" class="mb-confirm-flags">
            <li v-for="(f, i) in confirmFlags" :key="i">{{ f }}</li>
          </ul>
          <p v-else class="mb-confirm-flags">年级 / 主考点 / 题型（三锚）未定死，请在下方核对考点基准。</p>
          <p class="mb-confirm-hint">
            一次核对：年级 + 主考点 + 题型（三锚）｜ 副考点 · 考察类型 · 骨架最难步 · 难点（考点不变）。
            下方逐维可改；没问题点「过，出变式」。
          </p>
          <button type="button" class="mb-confirm-go" :disabled="sending" @click="dismissConfirm">
            过，出变式
          </button>
        </div>

        <!-- 上段：守恒基准维（可改） -->
        <p class="mb-seg-title">考点基准 · 可改（改→下游变式回流待重生）</p>
        <div class="mb-grid">
          <!-- 副考点（多选 ≤3） -->
          <span class="mb-k">副考点</span>
          <span class="mb-v">
            <template v-if="motherDna?.secondaryKps.length">
              <span v-for="kp in motherDna.secondaryKps" :key="kp" class="mb-pill sec">{{ kp }}</span>
            </template>
            <span v-else class="mb-muted">未标</span>
            <button type="button" class="mb-min-btn" :disabled="sending" @click="kpDialog = true">
              {{ motherDna?.secondaryKps.length ? '改' : '＋ 选' }}
            </button>
          </span>

          <!-- 考察类型（闭集下拉） -->
          <span class="mb-k">考察类型</span>
          <span class="mb-v">
            <el-select
              :model-value="motherDna?.examType || ''"
              size="small"
              placeholder="选考察类型"
              class="mb-select"
              :disabled="sending"
              @change="onPickExamType"
            >
              <el-option v-for="t in examTypeOptions" :key="t" :label="t" :value="t" />
            </el-select>
          </span>

          <!-- 解法骨架最难步（文本编辑·有界） -->
          <span class="mb-k">骨架最难步</span>
          <span class="mb-v mb-full">
            <template v-if="!skelEditing">
              <span class="mb-text skel"><MarkdownMath :content="motherDna?.skeleton || '未标'" /></span>
              <button type="button" class="mb-min-btn" :disabled="sending" @click="openSkelEdit">改</button>
            </template>
            <div v-else class="mb-edit-box">
              <el-input
                v-model="skelDraft"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 5 }"
                resize="none"
                placeholder="解法骨架（【】包最难步考法；改它=换考法，下游变式重写解析）"
              />
              <div class="mb-edit-actions">
                <button type="button" class="mb-cancel" @click="skelEditing = false">取消</button>
                <button type="button" class="mb-save" @click="saveSkel">保存</button>
              </div>
            </div>
          </span>

          <!-- 难点（文本编辑·克制） -->
          <span class="mb-k">难点</span>
          <span class="mb-v mb-full">
            <template v-if="!hardEditing">
              <template v-if="motherDna?.hardPoints.length">
                <span v-for="hp in motherDna.hardPoints" :key="hp" class="mb-hard">{{ hp }}</span>
              </template>
              <span v-else class="mb-muted">无（基础题 · 宁空不凑）</span>
              <button type="button" class="mb-min-btn" :disabled="sending" @click="openHardEdit">改</button>
            </template>
            <div v-else class="mb-edit-box">
              <el-input
                v-model="hardDraft"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                resize="none"
                placeholder="难点（一行一条；基础题留空，宁空不凑）"
              />
              <div class="mb-edit-actions">
                <button type="button" class="mb-cancel" @click="hardEditing = false">取消</button>
                <button type="button" class="mb-save" @click="saveHard">保存</button>
              </div>
            </div>
          </span>
        </div>

        <!-- 下段：其余维（仅展示·随变式调） -->
        <p class="mb-seg-title mb-seg-muted">其余维 · 仅展示（随变式调 / 头部确认）</p>
        <div class="mb-grid mb-grid-muted">
          <span class="mb-k">主考点 / 年级</span>
          <span class="mb-v">
            <span class="mb-ro">{{ header?.kp || '未锚定' }} · {{ header?.grade || '未定' }}</span>
            <span class="mb-anchor-tag">硬锚 · 改→立即重锚</span>
          </span>
          <span class="mb-k">题型</span>
          <span class="mb-v">
            <span class="mb-ro">{{ motherDna?.examType ? '随变式' : '随变式' }}</span>
            <span class="mb-anchor-tag muted">三锚 · 头部确认</span>
          </span>
          <span class="mb-k">场景 / 难度</span>
          <span class="mb-v">
            <span class="mb-ro">{{ motherDna?.scene || '随变式换' }}</span>
            <span class="mb-anchor-tag muted">随变式调</span>
          </span>
          <span class="mb-k">模型</span>
          <span class="mb-v">
            <template v-if="motherDna?.models.length">
              <span v-for="m in motherDna.models" :key="m.id" class="mb-model">{{ m.name || m.id }}</span>
            </template>
            <span v-else class="mb-muted">未标</span>
            <span class="mb-anchor-tag rw">重写解析维 · 在变式卡改</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 副考点知识点树（多选 ≤3） -->
    <KpTreeDialog
      v-model="kpDialog"
      mode="multi"
      title="选择母题副考点（≤3）"
      :max="3"
      :preselected="[]"
      @pick-multi="onPickSecondaryKps"
    />
  </section>
</template>

<style scoped>
/* v3 设计语言：深青 #0F6E6E + 暖纸白 #FBFAF6 + 暖琥珀 #B8741A */
.mother-bar-wrap {
  background: #fff;
  border: 1px solid #e7e3da;
  border-radius: 14px;
  overflow: hidden;
  margin-bottom: 14px;
  flex-shrink: 0;
}
.mb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  background: #f3f8f7;
  border-bottom: 1px solid #e7e3da;
}
.mb-toggle {
  font-size: 13px;
  font-weight: 700;
  color: #0f6e6e;
  background: #e7f3f1;
  border: 1px solid #cfe6e3;
  border-radius: 8px;
  padding: 3px 12px;
  cursor: pointer;
}
.mb-toggle:hover {
  background: #dcefec;
}
.mb-title {
  font-size: 13px;
  font-weight: 600;
  color: #33464c;
}
.mb-flag-dot {
  font-size: 12px;
  color: #c0392b;
  background: #fdecea;
  border: 1px solid #f0b8b1;
  border-radius: 6px;
  padding: 1px 8px;
  font-weight: 700;
}
.mb-spacer {
  flex: 1;
}
.mb-swap {
  font-size: 12px;
  color: #176e6e;
  background: #fff;
  border: 1px solid #b9d8d8;
  border-radius: 8px;
  padding: 3px 12px;
  cursor: pointer;
}
.mb-swap:hover:not(:disabled) {
  background: #e6f2f2;
}
.mb-swap:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mb-body {
  display: flex;
  gap: 18px;
  padding: 14px 18px;
}
.mb-thumb {
  flex: 0 0 200px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mb-img {
  width: 200px;
  height: 120px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #7fc0bd;
  cursor: zoom-in;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f8f8;
}
.mb-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mb-img-empty {
  font-size: 32px;
  cursor: default;
}
.mb-anchor {
  font-size: 12px;
  color: #6b817e;
  display: flex;
  gap: 6px;
  align-items: center;
}
.mb-anchor-k {
  flex-shrink: 0;
}
.mb-anchor b {
  color: #0f6e6e;
}

.mb-dna {
  flex: 1;
  min-width: 0;
}

/* 合并确认面（确定性异常时外显） */
.mb-confirm {
  background: #fdf4e3;
  border: 1px solid #ecc98f;
  border-radius: 10px;
  padding: 10px 13px;
  margin-bottom: 12px;
}
.mb-confirm-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: #92590f;
}
.mb-confirm-flags {
  margin: 0 0 6px;
  padding-left: 18px;
  font-size: 12px;
  color: #b8741a;
  line-height: 1.6;
}
.mb-confirm-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6b817e;
  line-height: 1.6;
}
.mb-confirm-go {
  font-size: 12px;
  color: #fff;
  background: #1e8a8a;
  border: 1px solid #1e8a8a;
  border-radius: 8px;
  padding: 4px 16px;
  cursor: pointer;
}
.mb-confirm-go:hover:not(:disabled) {
  background: #176e6e;
}
.mb-confirm-go:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mb-seg-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
  color: #0f6e6e;
}
.mb-seg-title.mb-seg-muted {
  color: #9fb0ad;
  margin-top: 12px;
}
.mb-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 9px 14px;
  font-size: 13px;
  align-items: baseline;
}
.mb-grid-muted {
  opacity: 0.78;
}
.mb-k {
  color: #6b817e;
  white-space: nowrap;
}
.mb-v {
  color: #16302f;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.mb-v.mb-full {
  flex-direction: row;
}
.mb-text {
  flex: 1;
  min-width: 0;
}
.mb-text.skel :deep(p) {
  margin: 0;
  display: inline;
}
.mb-muted {
  color: #9fb0ad;
  font-size: 12.5px;
}
.mb-ro {
  color: #33464c;
}
.mb-pill {
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 9px;
}
.mb-pill.sec {
  background: #fff;
  color: #0f6e6e;
  border: 1px solid #7fc0bd;
}
.mb-hard {
  font-size: 12px;
  background: #fbeed6;
  color: #b8741a;
  border-radius: 5px;
  padding: 1px 8px;
  font-weight: 600;
}
.mb-model {
  font-size: 12px;
  background: #f2f0fe;
  color: #5b4fd6;
  border: 1px solid #cfc7f3;
  border-radius: 999px;
  padding: 2px 9px;
}
.mb-min-btn {
  font-size: 12px;
  color: #0f6e6e;
  background: #fff;
  border: 1px solid #7fc0bd;
  border-radius: 8px;
  padding: 2px 10px;
  cursor: pointer;
}
.mb-min-btn:hover:not(:disabled) {
  background: #e7f3f1;
}
.mb-min-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mb-select {
  width: 150px;
}
/* 四分流标记（其余维段） */
.mb-anchor-tag {
  font-size: 9.5px;
  color: #c0392b;
  background: #fdecea;
  border: 1px solid #f0b8b1;
  border-radius: 4px;
  padding: 0 5px;
  font-weight: 600;
}
.mb-anchor-tag.muted {
  color: #6b817e;
  background: #eef1f3;
  border-color: #d9dfe1;
}
.mb-anchor-tag.rw {
  color: #5b4fd6;
  background: #f2f0fe;
  border-color: #cfc7f3;
}

/* 守恒维内联编辑框 */
.mb-edit-box {
  flex-basis: 100%;
  background: #f7faf9;
  border: 1px solid #e7e3da;
  border-radius: 8px;
  padding: 8px;
}
.mb-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.mb-cancel,
.mb-save {
  font-size: 12px;
  border-radius: 8px;
  padding: 3px 14px;
  cursor: pointer;
}
.mb-cancel {
  color: #5b6770;
  background: #fff;
  border: 1px solid #e7e3da;
}
.mb-save {
  color: #fff;
  background: #1e8a8a;
  border: 1px solid #1e8a8a;
}
.mb-save:hover {
  background: #176e6e;
}

@media (max-width: 1024px) {
  .mb-body {
    flex-direction: column;
  }
  .mb-thumb {
    flex: none;
    flex-direction: row;
    align-items: center;
  }
  .mb-img {
    width: 120px;
    height: 80px;
  }
}
</style>
