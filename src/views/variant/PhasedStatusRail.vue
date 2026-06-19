<script setup lang="ts">
// ---------------------------------------------------------------------------
// PhasedStatusRail —— PRD-A-017 批2d「分阶段状态条」（取代扁平 AiStageRail）。
//
// 视觉/交互 SSOT = artifacts/design/restyle.html（.pstat / .ps-* / TL_DING / TL_CHU）。
// 本组件只做「换渲染 + 前端 re-map」：入参仍是 props.stages: VariantStage[]（不破契约），
// 把后端旧 8 段 key（classify/knobs/figure/generate/gene_gate/verify/solution/persist）
// re-map 成「2 阶段 × 5 节点」展示，颜色一律 var(--xxx)（token 在 variant-theme.css）。
//
// 8key → 2阶段×5节点 映射：
//   定题中(ding)：读图锚定(classify) / 范围确认·需人工(classify await/warn) /
//                母题切图(figure[定题相]) / 确认母题·需人工(knobs|needConfirm)
//   出题中(chu) ：生成变式(generate) / 平行度比对(gene_gate) / 程序验算(verify) /
//                配图(figure[出题相]|solution) / 题组就绪(persist|assemble)
//
// 5 态：todo 待完成灰 / run 进行中紫呼吸 / done 已完成青 / err 异常红 / human 需人工橙。
// 底部 .ps-cast = 真值流式播报：取当前 run/human 节点的 stage.detail（R2 真子帧），
// 无 detail 时轮转节点标题或静默。播报随 detail 变化带 castin 进入动画。
// ---------------------------------------------------------------------------
import { computed, ref, watch } from 'vue'
import type { VariantStage } from '@/api/variant'

const props = defineProps<{ stages: VariantStage[] }>()

type NodeState = 'todo' | 'run' | 'done' | 'err' | 'human'

interface PsNode {
  label: string
  state: NodeState
  desc: string
}

const ST_LABEL: Record<NodeState, string> = {
  todo: '待完成',
  run: '进行中',
  done: '已完成',
  err: '异常',
  human: '需人工',
}

// 旧 8 key → 状态映射工具：同 key 的 stage.status → 节点态
function nodeStateFromStatus(s: VariantStage['status'] | undefined, fallback: NodeState): NodeState {
  if (!s) return fallback
  if (s === 'running') return 'run'
  if (s === 'done') return 'done'
  if (s === 'warn') return 'err'
  if (s === 'await') return 'human'
  return fallback
}

// 索引：key → stage（同 key 取最后一帧，与 onStage 原地更新语义一致）
const byKey = computed<Record<string, VariantStage>>(() => {
  const m: Record<string, VariantStage> = {}
  for (const s of props.stages) m[s.key] = s
  return m
})
function has(key: string): boolean {
  return key in byKey.value
}
function st(key: string): VariantStage | undefined {
  return byKey.value[key]
}

// 阶段判定：出现任一「出题相」key（generate/gene_gate/verify/solution/persist）→ 出题中；
// 否则停在定题中。这样母题确认前停定题，开始举一反三后切出题，符合 restyle 两阶段。
const CHU_KEYS = ['generate', 'gene_gate', 'verify', 'solution', 'persist', 'assemble']
const isChu = computed(() => CHU_KEYS.some((k) => has(k)))

// 「figure」key 在两阶段都可能出现：出题阶段时归「配图」，否则归定题「母题切图」。
const figureInChu = computed(() => isChu.value)

// ── 定题中 节点 ──
// 🔴 PRD-A-017 polish Fix-D：对齐设计稿 design-ref-02 的 3 节点 ding 布局
//   （读图锚定 / 母题切图 / 确认母题）。原「范围确认」拆成独立节点 → 设计稿无此节点，
//   将 classify 的 await/warn（考点范围待确认 / 候选）折进「读图锚定」自身的 human/err 态，
//   候选名走 detail 文案外显（如「考点范围还有 2 个候选，请确认: 对顶角相等 / 邻补角」）。
const dingNodes = computed<PsNode[]>(() => {
  const cls = st('classify')
  const knobs = st('knobs')
  const fig = !figureInChu.value ? st('figure') : undefined

  // ① 读图锚定（classify）：await→需人工（番人工，候选待确认）/ warn→异常 / done→已完成 / running→进行中
  const n1: PsNode = {
    label: '读图锚定',
    state:
      cls?.status === 'await'
        ? 'human'
        : cls?.status === 'warn'
          ? 'err'
          : nodeStateFromStatus(cls?.status, 'todo'),
    desc:
      cls?.status === 'await' || cls?.status === 'warn'
        ? (cls?.detail ?? '考点范围拿捏不准，请确认')
        : (cls?.detail ?? '识别题面、判年级·章、锚定考点'),
  }
  // ② 母题切图（figure[定题相]）
  const n2: PsNode = {
    label: '母题切图',
    state: nodeStateFromStatus(fig?.status, 'todo'),
    desc: fig?.detail ?? '从原图切出母题图形',
  }
  // ③ 确认母题·需人工（knobs await，或母题切图完成后浮现为待人工确认）
  const n3: PsNode = {
    label: '确认母题',
    state: knobs
      ? nodeStateFromStatus(knobs.status, 'todo')
      : fig?.status === 'done'
        ? 'human'
        : 'todo',
    desc: knobs?.detail ?? '母题已确认无误？点「开始举一反三」开始生成变式',
  }
  return [n1, n2, n3]
})

// ── 出题中 节点 ──
const chuNodes = computed<PsNode[]>(() => {
  const gen = st('generate')
  const gate = st('gene_gate')
  const ver = st('verify')
  const fig = st('figure')
  const sol = st('solution')
  const persist = st('persist') ?? st('assemble')

  const n1: PsNode = {
    label: '生成变式',
    state: nodeStateFromStatus(gen?.status, 'todo'),
    desc: gen?.detail ?? '按出题设置生成变式',
  }
  const n2: PsNode = {
    label: '考点一致比对',
    state: nodeStateFromStatus(gate?.status, 'todo'),
    desc: gate?.detail ?? '逐道与母题对照考点',
  }
  const n3: PsNode = {
    label: '程序验算',
    state: nodeStateFromStatus(ver?.status, 'todo'),
    desc: ver?.detail ?? '代入数值核对答案闭合',
  }
  // 🔴 BUG-10：配图节点收口。配图是「适用才做」的节点（纯文本题不需配图）——不能让它
  //   永久挂「待完成」把整条状态条卡住。判定：
  //   ① figure/solution stage 显式 done/skipped → done（收到 done/skipped 即视为完成）；
  //   ② 无 figure/solution stage，但生成/比对/验算三个核心节点都已完成 → 视为「本组无需配图」
  //      → done（跳过即完成，不挂待完成）。
  //   ③ 否则按 stage 状态（running/todo）走。
  const coreDone =
    gen?.status === 'done' && gate?.status === 'done' && ver?.status === 'done'
  const figStage = fig ?? sol
  const figStatus = figStage?.status
  const figDone = figStatus === 'done' || figStatus === 'await' // await（toolkit 对「不适用/跳过」也发 await）= 跳过=完成
  const n4: PsNode = {
    label: '配图',
    state: figDone
      ? 'done'
      : !figStage && coreDone
        ? 'done' // 核心都完成、本组无配图 stage → 视为无需配图（跳过=完成）
        : nodeStateFromStatus(figStatus, 'todo'),
    desc: figStage?.detail ?? (!figStage && coreDone ? '本组无需配图（已跳过）' : '为带图变式造图'),
  }
  // 题组就绪：persist done → done；await → human；🔴 BUG-10：无 persist stage 但核心+配图都完成
  //   → 整组收口为「就绪」（不再等一个从不到来的 persist 帧把它永久挂在「待完成」）。
  const groupReady = coreDone && n4.state === 'done'
  const n5: PsNode = {
    label: '题组就绪',
    state: persist
      ? persist.status === 'done'
        ? 'done'
        : nodeStateFromStatus(persist.status, 'todo')
      : groupReady
        ? 'done'
        : 'todo',
    desc: persist?.detail ?? (groupReady ? '全部完成 · 可换数字 / 换场景 / 重生这道 / 入库' : '可换数字 / 换场景 / 重生这道 / 入库'),
  }
  return [n1, n2, n3, n4, n5]
})

const phase = computed(() => (isChu.value ? 'chu' : 'ding'))
const nodes = computed<PsNode[]>(() => (isChu.value ? chuNodes.value : dingNodes.value))
const phaseName = computed(() => (isChu.value ? '出题中' : '定题中'))
const phaseTag = computed(() => (isChu.value ? '阶段 ②' : '阶段 ①'))
const phaseStep = computed(() => (isChu.value ? '2 / 2 阶段' : '1 / 2 阶段'))

// 当前活跃节点（run 优先，其次 human）—— 决定播报内容与 mini 摘要
const activeNode = computed<PsNode | undefined>(() => {
  return nodes.value.find((n) => n.state === 'run') ?? nodes.value.find((n) => n.state === 'human')
})
const isAwait = computed(() => activeNode.value?.state === 'human')

// 🔴 BUG-10：全部「适用」节点完成即收口为「就绪」——没有 run/human 节点（无在跑、无待人工），
//   且至少有一个节点已 done（已开过工，非纯待机）→ 视为全部完成。此态停转圈、播报「全部完成」。
//   不被「不适用/已跳过」节点永久挂起（配图/题组就绪已在 chuNodes 收口为 done）。
const allDone = computed(() => {
  if (isEmpty.value) return false
  const hasActive = nodes.value.some((n) => n.state === 'run' || n.state === 'human')
  const hasErr = nodes.value.some((n) => n.state === 'err')
  const anyDone = nodes.value.some((n) => n.state === 'done')
  return !hasActive && !hasErr && anyDone
})

// 收起态摘要
const miniText = computed(() => {
  if (allDone.value) return '题组就绪 · 全部完成' // 🔴 BUG-10
  const n = activeNode.value
  if (!n) return '待机'
  return `${n.label} · ${ST_LABEL[n.state]}`
})
const miniHuman = computed(() => activeNode.value?.state === 'human')

// 空态（无任何 stage）
const isEmpty = computed(() => props.stages.length === 0)

// ── 真值流式播报：取活跃节点的 detail 作播报文案 ──
const castText = computed(() => {
  // 🔴 BUG-10：全部完成 → 播报「就绪」，停止转圈
  if (allDone.value) return '全部完成 · 题组就绪'
  const n = activeNode.value
  if (!n) return ''
  // 真值优先：活跃节点 desc 即来自 stage.detail（R2 子帧）；无 detail 时退节点标题
  return n.desc || n.label
})

// detail 变化时触发进入动画（castin）：用一个 key 强制 transition 重放
const castAnimKey = ref(0)
watch(castText, () => {
  castAnimKey.value++
})

// 收起/展开
const collapsed = ref(false)
function toggleCollapse() {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <div class="pstat" :class="{ collapsed }">
    <!-- 头部：可点收起 -->
    <div class="ps-head" @click="toggleCollapse">
      <span v-if="!isEmpty" class="ps-caret">▾</span>
      <span class="ps-ph">{{ isEmpty ? '待机' : phaseTag }}</span>
      <span class="ps-name">{{ phaseName }}</span>
      <span class="ps-step">{{ isEmpty ? '0 / 2 阶段' : phaseStep }}</span>
    </div>

    <!-- 收起态一行摘要 -->
    <div v-if="!isEmpty" class="ps-mini" :class="{ h: miniHuman }">
      <span class="d" />
      <span class="mtx">{{ miniText }}</span>
    </div>

    <!-- 空态 -->
    <div v-if="isEmpty" class="ps-stat-empty">○ 待机 · 拍一道题丢进来，自动开始读图锚定</div>

    <template v-else>
      <!-- 节点列 -->
      <div class="ps-nodes">
        <div
          v-for="(n, i) in nodes"
          :key="`${phase}-${i}`"
          class="ps-node"
          :class="n.state"
        >
          <span class="ps-dot" />
          <div class="ps-main">
            <div class="ps-t">
              {{ n.label }}
              <span class="ps-st">{{ ST_LABEL[n.state] }}</span>
            </div>
            <div class="ps-desc">{{ n.desc }}</div>
          </div>
        </div>
      </div>

      <!-- 底部流式播报：取活跃节点真值 detail，detail 更新带 castin 动画。
           🔴 BUG-10：全部完成 → 显青 ✓ + 「就绪」、不转圈（done 态覆盖 spinner）。 -->
      <div class="ps-cast" :class="{ await: isAwait, done: allDone }">
        <span class="sp">{{ allDone ? '✓' : isAwait ? '⏸' : '' }}</span>
        <span :key="castAnimKey" class="txt">{{ castText }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── 分阶段状态条（定题中 / 出题中）+ 底部流式播报 ── */
/* 颜色一律 var(--xxx)，token 来自祖先 .variant-page（variant-theme.css）。 */
.pstat {
  background: var(--violet-50);
  border: 1px solid var(--violet-line);
  border-left: 2px solid var(--violet);
  border-radius: 4px 11px 11px 4px;
  margin: 0 0 2px;
  overflow: hidden;
}
.ps-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 13px 7px;
  border-bottom: 1px solid var(--violet-line);
  cursor: pointer;
  user-select: none;
}
.ps-ph {
  font-size: 10.5px;
  font-weight: 700;
  color: #fff;
  background: var(--violet);
  border-radius: 5px;
  padding: 1px 7px;
  font-family: var(--mono);
}
.ps-name {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--violet-700);
}
.ps-step {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
}
.ps-caret {
  font-size: 10px;
  color: var(--violet-700);
  transition: transform 0.2s;
  display: inline-block;
}
.pstat.collapsed .ps-caret {
  transform: rotate(-90deg);
}
.pstat.collapsed .ps-nodes,
.pstat.collapsed .ps-cast {
  display: none;
}

.ps-nodes {
  padding: 8px 13px 5px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ps-node {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.ps-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  margin-top: 4px;
  background: #c5cfcc;
}
.ps-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.ps-t {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-2);
}
.ps-st {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ps-desc {
  font-size: 11px;
  color: var(--faint);
  line-height: 1.5;
  word-break: break-word;
}

/* 5 态 */
.ps-node.todo .ps-dot {
  background: #c5cfcc;
}
.ps-node.todo .ps-t {
  color: #9ba7a4;
  font-weight: 500;
}
.ps-node.todo .ps-st {
  color: #b5bfbc;
}
.ps-node.run .ps-dot {
  background: var(--violet);
  box-shadow: 0 0 0 3px var(--violet-100);
  animation: ps-pulse 1.4s infinite ease-in-out;
}
.ps-node.run .ps-t {
  color: var(--violet-700);
}
.ps-node.run .ps-st {
  color: var(--violet);
}
.ps-node.run .ps-desc {
  color: var(--violet-700);
}
.ps-node.done .ps-dot {
  background: var(--teal);
}
.ps-node.done .ps-t {
  color: var(--ink);
}
.ps-node.done .ps-st {
  color: var(--teal-700);
}
.ps-node.err .ps-dot {
  background: var(--red);
  box-shadow: 0 0 0 3px var(--red-50);
}
.ps-node.err .ps-t {
  color: var(--red);
}
.ps-node.err .ps-st {
  color: var(--red);
}
.ps-node.err .ps-desc {
  color: var(--red);
}
.ps-node.human .ps-dot {
  background: var(--amber);
  box-shadow: 0 0 0 3px var(--amber-50);
  animation: ps-breathe 2.2s infinite ease-in-out;
}
.ps-node.human .ps-t {
  color: var(--amber);
}
.ps-node.human .ps-st {
  color: var(--amber);
}
.ps-node.human .ps-desc {
  color: #b07a1e;
}

/* 底部流式播报 */
.ps-cast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border-top: 1px dashed var(--violet-line);
  background: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  color: var(--violet-700);
  min-height: 15px;
}
.ps-cast .sp {
  width: 12px;
  height: 12px;
  flex: none;
  border: 1.6px solid var(--violet-100);
  border-top-color: var(--violet);
  border-radius: 50%;
  animation: ps-spin 0.85s linear infinite;
}
.ps-cast.await {
  color: #b07a1e;
}
.ps-cast.await .sp {
  border: none;
  width: auto;
  height: auto;
  animation: none;
  color: var(--amber);
  font-size: 12px;
}
/* 🔴 BUG-10：全部完成态 —— 青 ✓、不转圈 */
.ps-cast.done {
  color: var(--teal-700);
}
.ps-cast.done .sp {
  border: none;
  width: auto;
  height: auto;
  animation: none;
  color: var(--teal);
  font-size: 12px;
  font-weight: 700;
}
.ps-cast .txt {
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: ps-castin 0.35s ease;
}

.ps-stat-empty {
  padding: 8px 13px;
  font-size: 11px;
  color: var(--faint);
  font-family: var(--mono);
}

/* 收起态摘要 */
.ps-mini {
  display: none;
  padding: 7px 13px;
  font-size: 11.5px;
  color: var(--violet-700);
  align-items: center;
  gap: 8px;
}
.pstat.collapsed .ps-mini {
  display: flex;
}
.ps-mini .d {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--violet);
  animation: ps-pulse 1.4s infinite ease-in-out;
}
.ps-mini.h .d {
  background: var(--amber);
  animation: ps-breathe 2.2s infinite ease-in-out;
}
.ps-mini .mtx {
  font-weight: 600;
}

@keyframes ps-pulse {
  0%,
  100% {
    transform: scale(0.72);
    opacity: 0.5;
  }
  50% {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes ps-breathe {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
@keyframes ps-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes ps-castin {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
