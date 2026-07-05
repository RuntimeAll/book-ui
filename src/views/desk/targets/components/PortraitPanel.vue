<script setup lang="ts">
/**
 * PRD-C-213 FP20 · 学生 / 班级肖像面板（详情内 4 格 + 编辑）。
 * 四格 = 特点(traits) / 程度(level.desc) / 培养目标(level.target_layer) / 易错信号(error_signals)。
 * error_signals：pending「待确认」视觉区分（虚线琥珀 chip），可转正 / 删除 / 新增 / 改文案。
 * history（学习履历）+ env 亦可见可编辑（编辑弹窗内）。
 * 编辑后整体覆写 → emit('save', profileJson) 交父级调 updateTargetProfile。
 * 班级 = 班级肖像同构展示。
 */
import { ref, computed } from 'vue'
import {
  ERROR_SIGNAL_STATUS_LABEL,
  type ProfileJson,
  type ErrorSignal,
} from '@/api/teacher/schedule'

const props = defineProps<{
  profile: ProfileJson | null
  /** 展示文案：学生 / 班级 */
  kindLabel?: string
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: 'save', profile: ProfileJson): void
}>()

function normalize(src: ProfileJson | null): ProfileJson {
  return {
    traits: src?.traits ?? [],
    level: { desc: src?.level?.desc ?? '', target_layer: src?.level?.target_layer ?? '' },
    env: src?.env ?? '',
    history: src?.history ?? [],
    error_signals: src?.error_signals ?? [],
  }
}

function clone(src: ProfileJson): ProfileJson {
  return {
    traits: [...src.traits],
    level: { ...src.level },
    env: src.env,
    history: src.history.map((h) => ({ ...h })),
    error_signals: src.error_signals.map((e) => ({ ...e })),
  }
}

const p = computed<ProfileJson>(() => normalize(props.profile))

// —— 编辑弹窗 ——
const editVisible = ref(false)
const draft = ref<ProfileJson>(normalize(null))

function openEdit() {
  draft.value = clone(p.value)
  editVisible.value = true
}

// traits
const traitInput = ref('')
function addTrait() {
  const v = traitInput.value.trim()
  if (!v) return
  if (!draft.value.traits.includes(v)) draft.value.traits.push(v)
  traitInput.value = ''
}
function removeTrait(i: number) {
  draft.value.traits.splice(i, 1)
}

// error_signals
function todayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}
function addSignal() {
  draft.value.error_signals.push({
    tag: '',
    evidence: '',
    session_id: '',
    ts: todayStr(),
    by: 'teacher',
    status: 'confirmed',
  })
}
function removeSignal(i: number) {
  draft.value.error_signals.splice(i, 1)
}
function confirmSignal(sig: ErrorSignal) {
  sig.status = 'confirmed'
}

// history
const HISTORY_STATUS = ['吃透', '讲过未吃透']
function addHistory() {
  draft.value.history.push({ topic: '', status: '吃透', src: '' })
}
function removeHistory(i: number) {
  draft.value.history.splice(i, 1)
}

function save() {
  const out = clone(draft.value)
  out.error_signals = out.error_signals.filter((s) => s.tag.trim())
  out.history = out.history.filter((h) => h.topic.trim())
  out.traits = out.traits.map((t) => t.trim()).filter(Boolean)
  emit('save', out)
}

function close() {
  editVisible.value = false
}
defineExpose({ close })

const signalLabel = (s: ErrorSignal) => ERROR_SIGNAL_STATUS_LABEL[s.status] || s.status
const kind = computed(() => props.kindLabel || '学生')
</script>

<template>
  <div class="portrait-wrap">
    <div class="pt-head">
      <span class="pt-eyebrow">{{ kind }}肖像</span>
      <el-button size="small" text bg @click="openEdit">编辑肖像</el-button>
    </div>

    <!-- 四格 -->
    <div class="portrait">
      <div class="pt-box">
        <h4>特点</h4>
        <p v-if="p.traits.length" class="pt-chips">
          <span v-for="(t, i) in p.traits" :key="'t' + i" class="tag">{{ t }}</span>
        </p>
        <p v-else class="pt-empty">未记录</p>
      </div>
      <div class="pt-box">
        <h4>程度</h4>
        <p v-if="p.level.desc">{{ p.level.desc }}</p>
        <p v-else class="pt-empty">未记录</p>
      </div>
      <div class="pt-box">
        <h4>培养目标</h4>
        <p v-if="p.level.target_layer">{{ p.level.target_layer }}</p>
        <p v-else class="pt-empty">未记录</p>
      </div>
      <div class="pt-box">
        <h4>易错信号</h4>
        <p v-if="p.error_signals.length" class="pt-chips">
          <span
            v-for="(s, i) in p.error_signals"
            :key="'s' + i"
            class="tag"
            :class="{ pending: s.status === 'pending' }"
            :title="s.evidence"
          >
            <span v-if="s.status === 'pending'" class="pd-flag">待确认</span>{{ s.tag }}
          </span>
        </p>
        <p v-else class="pt-empty">暂无</p>
        <p class="pt-note">课后回收自动沉淀 · 老师可随手补充</p>
      </div>
    </div>

    <!-- 学习履历 + 进度环境 -->
    <div class="pt-extra" v-if="p.history.length || p.env">
      <div class="pt-extra-col" v-if="p.history.length">
        <span class="pt-eyebrow">学习履历</span>
        <ul class="hist-list">
          <li v-for="(h, i) in p.history" :key="'h' + i">
            <b>{{ h.topic }}</b>
            <span class="hist-st" :class="{ warn: h.status === '讲过未吃透' }">{{ h.status }}</span>
            <span class="hist-src" v-if="h.src">· {{ h.src }}</span>
          </li>
        </ul>
      </div>
      <div class="pt-extra-col" v-if="p.env">
        <span class="pt-eyebrow">进度环境</span>
        <p class="env-text">{{ p.env }}</p>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog
      v-model="editVisible"
      :title="`编辑${kind}肖像`"
      width="640px"
      append-to-body
      top="6vh"
    >
      <div class="edit-body">
        <div class="ef-block">
          <label class="ef-label">特点</label>
          <div class="trait-editor">
            <el-tag
              v-for="(t, i) in draft.traits"
              :key="'et' + i"
              closable
              type="info"
              @close="removeTrait(i)"
              >{{ t }}</el-tag
            >
            <el-input
              v-model="traitInput"
              size="small"
              placeholder="输入后回车"
              style="width: 160px"
              @keyup.enter="addTrait"
            />
          </div>
        </div>

        <div class="ef-row">
          <div class="ef-block ef-half">
            <label class="ef-label">程度</label>
            <el-input v-model="draft.level.desc" type="textarea" :rows="2" placeholder="当前水平描述" />
          </div>
          <div class="ef-block ef-half">
            <label class="ef-label">培养目标</label>
            <el-input
              v-model="draft.level.target_layer"
              type="textarea"
              :rows="2"
              placeholder="培养方向 / 层级目标"
            />
          </div>
        </div>

        <div class="ef-block">
          <label class="ef-label">进度环境</label>
          <el-input v-model="draft.env" placeholder="外部班课 / 校内进度等" />
        </div>

        <div class="ef-block">
          <div class="ef-label-row">
            <label class="ef-label">易错信号</label>
            <el-button size="small" text type="primary" @click="addSignal">+ 新增信号</el-button>
          </div>
          <div v-if="!draft.error_signals.length" class="ef-empty">暂无信号</div>
          <div
            v-for="(s, i) in draft.error_signals"
            :key="'sig' + i"
            class="sig-row"
            :class="{ pending: s.status === 'pending' }"
          >
            <el-input v-model="s.tag" size="small" placeholder="信号标签" style="width: 150px" />
            <el-input v-model="s.evidence" size="small" placeholder="证据 / 说明" style="flex: 1" />
            <span class="sig-status" :class="s.status">{{ signalLabel(s) }}</span>
            <el-button
              v-if="s.status === 'pending'"
              size="small"
              text
              type="primary"
              @click="confirmSignal(s)"
              >转正</el-button
            >
            <el-button size="small" text type="danger" @click="removeSignal(i)">删除</el-button>
          </div>
          <p class="ef-hint">回收自动沉淀的信号为「待确认」，老师转正或删除；也可手动新增。</p>
        </div>

        <div class="ef-block">
          <div class="ef-label-row">
            <label class="ef-label">学习履历</label>
            <el-button size="small" text type="primary" @click="addHistory">+ 新增履历</el-button>
          </div>
          <div v-if="!draft.history.length" class="ef-empty">暂无履历</div>
          <div v-for="(h, i) in draft.history" :key="'his' + i" class="his-row">
            <el-input v-model="h.topic" size="small" placeholder="主题" style="flex: 1" />
            <el-select v-model="h.status" size="small" style="width: 130px">
              <el-option v-for="st in HISTORY_STATUS" :key="st" :value="st" :label="st" />
            </el-select>
            <el-input v-model="h.src" size="small" placeholder="来源" style="width: 130px" />
            <el-button size="small" text type="danger" @click="removeHistory(i)">删除</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存肖像</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.portrait-wrap {
  background: #fcfdfd;
  border-bottom: 1px solid var(--bk-line);
}
.pt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 2px;
}
.pt-eyebrow {
  font-size: 11px;
  color: #8ba09a;
  letter-spacing: 0.14em;
  font-weight: 700;
}
.portrait {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 4px 0 8px;
}
@media (max-width: 1000px) {
  .portrait {
    grid-template-columns: 1fr 1fr;
  }
}
.pt-box {
  padding: 8px 16px 11px;
  border-left: 1px solid #eef3f1;
}
.pt-box:first-child,
.portrait > .pt-box:nth-child(5) {
  border-left: none;
}
.pt-box h4 {
  font-size: 11px;
  color: #8ba09a;
  letter-spacing: 0.14em;
  font-weight: 700;
  margin: 0 0 5px;
}
.pt-box p {
  font-size: 12.5px;
  color: #5f716d;
  line-height: 1.6;
  margin: 0;
}
.pt-box p b {
  color: var(--bk-ink);
}
.pt-empty {
  color: #b7c4c0 !important;
  font-style: italic;
}
.pt-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: #5f716d;
  background: #eef1f0;
  border-radius: 6px;
  padding: 1px 8px;
  line-height: 19px;
}
.tag.pending {
  color: #b45309;
  background: #fdf3e7;
  border: 1px dashed #e6b980;
}
.pd-flag {
  font-size: 10px;
  background: #b45309;
  color: #fff;
  border-radius: 4px;
  padding: 0 4px;
  line-height: 14px;
}
.pt-note {
  font-size: 11px !important;
  color: #8ba09a !important;
  margin-top: 5px !important;
}
.pt-extra {
  display: flex;
  gap: 28px;
  padding: 8px 16px 14px;
  border-top: 1px dashed #eef3f1;
  flex-wrap: wrap;
}
.pt-extra-col {
  min-width: 220px;
}
.hist-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}
.hist-list li {
  font-size: 12px;
  color: #5f716d;
  padding: 2px 0;
}
.hist-list b {
  color: var(--bk-ink);
}
.hist-st {
  font-size: 11px;
  color: var(--bk-teal-deep);
  margin-left: 6px;
}
.hist-st.warn {
  color: #b45309;
}
.hist-src {
  color: #8ba09a;
  margin-left: 4px;
}
.env-text {
  font-size: 12px;
  color: #5f716d;
  margin: 6px 0 0;
  line-height: 1.6;
}
/* 编辑弹窗 */
.edit-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 64vh;
  overflow-y: auto;
  padding-right: 4px;
}
.ef-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ef-row {
  display: flex;
  gap: 16px;
}
.ef-half {
  flex: 1;
}
.ef-label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--bk-ink);
}
.ef-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.trait-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.sig-row,
.his-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #eef3f1;
  border-radius: 8px;
  margin-bottom: 6px;
}
.sig-row.pending {
  border-color: #e6b980;
  border-style: dashed;
  background: #fffaf3;
}
.sig-status {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  flex: none;
}
.sig-status.pending {
  color: #b45309;
  background: #fdf3e7;
}
.sig-status.confirmed {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.ef-empty {
  font-size: 12px;
  color: #b7c4c0;
  padding: 4px 0;
}
.ef-hint {
  font-size: 11.5px;
  color: #8ba09a;
  margin: 2px 0 0;
}
</style>
