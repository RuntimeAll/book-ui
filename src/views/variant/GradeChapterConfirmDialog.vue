<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-017 B3 ① — 母题「年级册 + 章」确认面（AC1 / G1 前端侧）。
//
// 母题每次必停（决策表「母题必停弹窗」）：收到 SSE needConfirm → 弹本面。
//   - 展示 nano 候选年级册+章（仅展示参考；nano 判章疑似人教版编号、题库浙教版 →
//     只作预填，老师人工确认纠）。
//   - 🔴 章 picker 取真 biz_subject 年级册(level1) + 章(level2) 树（复用既有 lazyTree
//     /teacher/question/lazyTree，整树返回）。按 nano 候选 name 模糊预选最近节点；老师选定
//     → 拿到【真 chapter_id + grade_book_id】（biz_subject 真节点 id）。
//   - 确认 → emit('confirm', {chapterId, gradeBookId, chapterName, gradeBookName})；
//     宿主经续聊回合的 agent_config.confirmed_chapter_id 回传 toolkit（接 B2 闸B）。
//   - 候选为空也能弹（让老师纯手选）。
//
// 数据形态：lazyTree 顶层 = 年级册（level1），其 children = 章（level2）。叶子（细知识点）
// 不在本面选——本面只到「章」这层（PRD 决策表「确认到 年级册 + 章」）。
// ---------------------------------------------------------------------------
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { lazyTree, type SubjectNode } from '@/api/question'
import type { VariantNeedConfirm } from '@/api/variant'

const props = defineProps<{
  modelValue: boolean
  /** SSE needConfirm 载荷（nano 候选年级册+章） */
  payload: VariantNeedConfirm | null
  /** 确认提交中（续聊回合发送中）→ 禁交互 */
  submitting: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 老师确认：回传真 chapter_id + grade_book_id（+ 名字供展示/留痕） */
  (
    e: 'confirm',
    value: { chapterId: string; gradeBookId: string; chapterName: string; gradeBookName: string }
  ): void
  /**
   * 🔴 PRD-A-018 A-4：取消/关闭确认面 → 宿主收口待确认态并给回路（重新贴图或回复年级章可继续）。
   *   原先只 emit update:modelValue=false，宿主无 @cancel → 取消即死路（BE 停 awaiting_mother_confirm、
   *   无母题卡/无重试入口）。本事件让宿主补回路。
   */
  (e: 'cancel'): void
}>()

const tree = ref<SubjectNode[]>([])
const loading = ref(false)
const gradeBookId = ref('') // 选中的年级册（level1）id
const chapterId = ref('') // 选中的章（level2）id

// 年级册下拉选项（lazyTree 顶层）
const gradeBooks = computed(() => tree.value)
// 当前年级册下的章（level2 children）
const chapters = computed<SubjectNode[]>(() => {
  const gb = tree.value.find((n) => String(n.id) === gradeBookId.value)
  return gb?.children ?? []
})

const selectedGradeBookName = computed(
  () => gradeBooks.value.find((n) => String(n.id) === gradeBookId.value)?.title ?? ''
)
const selectedChapterName = computed(
  () => chapters.value.find((n) => String(n.id) === chapterId.value)?.title ?? ''
)

/** 按 nano 候选 name 在节点列表里找最近匹配（含子串双向），找不到返回空 */
function matchByName(nodes: SubjectNode[], name: string | undefined | null): SubjectNode | null {
  const n = (name ?? '').trim()
  if (!n) return null
  // 先精确，再包含（题库册名常带「数学·七年级上」式，nano 给「七年级上」→ 子串命中）
  const exact = nodes.find((x) => (x.title ?? '') === n)
  if (exact) return exact
  const contains = nodes.find(
    (x) => (x.title ?? '').includes(n) || n.includes(x.title ?? '')
  )
  return contains ?? null
}

/** 按 nano 候选预选年级册 + 章（找不到则留空让老师手选） */
function presetFromNano() {
  const p = props.payload
  if (!p) return
  // 年级册：先用首选 name，再用候选列表第一个
  const gbName = p.gradeBook?.name || p.gradeCandidates[0]?.name
  const gb = matchByName(gradeBooks.value, gbName)
  if (gb) {
    gradeBookId.value = String(gb.id)
    // 章：在该册的 children 里按 nano 章名预选
    const chName = p.chapter?.name || p.chapterCandidates[0]?.name
    const ch = matchByName(gb.children ?? [], chName)
    if (ch) chapterId.value = String(ch.id)
  }
}

async function loadTree() {
  if (tree.value.length) {
    presetFromNano()
    return
  }
  loading.value = true
  try {
    const result = await lazyTree(0)
    if (Array.isArray(result)) tree.value = result
    else if (result && typeof result === 'object') tree.value = [result as unknown as SubjectNode]
    presetFromNano()
  } catch (e) {
    ElMessage.error(`年级册/章树加载失败：${e instanceof Error ? e.message : String(e)}（举一反三服务 :8090 未启动？）`)
  } finally {
    loading.value = false
  }
}

// 换年级册 → 清掉旧章选择（避免章 id 挂错册）
function onChangeGradeBook() {
  chapterId.value = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      gradeBookId.value = ''
      chapterId.value = ''
      void loadTree()
    }
  }
)

function close() {
  emit('update:modelValue', false)
  // 🔴 PRD-A-018 A-4：通知宿主收口待确认态 + 给回路（取消≠死路）。
  emit('cancel')
}

/** el-dialog 自身关闭（X / ESC / 点遮罩）→ 同样视为取消，走 close 给回路（A-4）。 */
function onDialogUpdate(v: boolean) {
  if (!v) {
    close()
  } else {
    emit('update:modelValue', v)
  }
}

function onConfirm() {
  if (!chapterId.value) {
    ElMessage.warning('请先选定「章」（章是后续打标锚定的范围）')
    return
  }
  emit('confirm', {
    chapterId: chapterId.value,
    gradeBookId: gradeBookId.value,
    chapterName: selectedChapterName.value,
    gradeBookName: selectedGradeBookName.value,
  })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="确认母题的年级册 + 章"
    width="520px"
    append-to-body
    :close-on-click-modal="false"
    data-testid="variant-grade-chapter-confirm"
    @update:model-value="onDialogUpdate"
  >
    <p class="gc-intro">
      举一反三前请先确认母题所属的<b>年级册</b>与<b>章</b>——这是后续 AI 解题打标的锚定范围，
      确认对了后面才不会跑偏。
    </p>

    <!-- nano 候选参考（仅展示，提醒老师人工核对） -->
    <div v-if="payload" class="gc-nano">
      <span class="gc-nano-k">AI 初判（仅供参考，可能版本/编号不符，请以下方手选为准）：</span>
      <span class="gc-nano-v">
        年级册「{{ payload.gradeBook.name || '未判出' }}」· 章「{{ payload.chapter.name || '未判出' }}」
        <template v-if="payload.confidence != null">（置信 {{ (payload.confidence * 100).toFixed(0) }}%）</template>
      </span>
    </div>

    <div v-loading="loading" class="gc-pick">
      <div class="gc-row">
        <label class="gc-label">年级册</label>
        <el-select
          v-model="gradeBookId"
          filterable
          placeholder="选年级册（biz_subject 顶层）"
          class="gc-select"
          :disabled="submitting"
          @change="onChangeGradeBook"
        >
          <el-option v-for="gb in gradeBooks" :key="gb.id" :label="gb.title" :value="String(gb.id)" />
        </el-select>
      </div>
      <div class="gc-row">
        <label class="gc-label">章</label>
        <el-select
          v-model="chapterId"
          filterable
          placeholder="先选年级册，再选章"
          class="gc-select"
          :disabled="submitting || !gradeBookId"
          no-data-text="该年级册下无章节"
        >
          <el-option v-for="ch in chapters" :key="ch.id" :label="ch.title" :value="String(ch.id)" />
        </el-select>
      </div>
      <p v-if="!loading && gradeBooks.length === 0" class="gc-empty">
        年级册/章树为空（举一反三服务 :8090 未启动？）—— 无法选章，请确认服务后重开本面。
      </p>
    </div>

    <p v-if="chapterId" class="gc-confirmed">
      将锚定到：<b>{{ selectedGradeBookName }}</b> / <b>{{ selectedChapterName }}</b>
      <span class="gc-chid">（chapter_id: {{ chapterId }}）</span>
    </p>

    <template #footer>
      <el-button :disabled="submitting" @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!chapterId" @click="onConfirm">
        确认，开始解题打标
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gc-intro {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: #4e5969;
}
.gc-intro b {
  color: #0f6e6e;
}
.gc-nano {
  background: #fdf4e3;
  border: 1px solid #ecc98f;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  font-size: 12px;
  line-height: 1.6;
}
.gc-nano-k {
  color: #92590f;
  font-weight: 600;
}
.gc-nano-v {
  color: #b8741a;
}
.gc-pick {
  min-height: 120px;
}
.gc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.gc-label {
  flex: 0 0 56px;
  font-size: 13px;
  font-weight: 600;
  color: #33464c;
}
.gc-select {
  flex: 1;
}
.gc-empty {
  font-size: 12px;
  color: #c0392b;
  line-height: 1.6;
  margin: 8px 0 0;
}
.gc-confirmed {
  margin: 4px 0 0;
  font-size: 13px;
  color: #16302f;
}
.gc-confirmed b {
  color: #0f6e6e;
}
.gc-chid {
  font-size: 11px;
  color: #9fb0ad;
}
</style>
