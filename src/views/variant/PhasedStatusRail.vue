<script setup lang="ts">
// ---------------------------------------------------------------------------
// PhasedStatusRail —— PRD-A-017 批2d「分阶段状态条」（取代扁平 AiStageRail）。
//
// 视觉/交互 SSOT = artifacts/design/restyle.html（.pstat / .ps-* / TL_DING / TL_CHU）。
// 本组件只做「换渲染 + 前端 re-map」：入参仍是 props.stages: VariantStage[]（不破契约），
// 把后端旧 8 段 key（classify/knobs/figure/generate/gene_gate/verify/solution/persist）
// re-map 成「2 阶段 × 5 节点」展示，颜色一律 var(--xxx)（token 在 variant-theme.css）。
//
// 8key → 2阶段×节点 映射：
//   定题中(ding) 3节点（🔴 2026-06-19 新 stage 帧契约，三节点各读独立 key，不再 classify+knobs 硬凑）：
//                读图锚定(classify) / 母题切图(figure[定题相]) / 确认母题(review)
//   出题中(chu) 5节点：生成变式(generate) / 平行度比对(gene_gate) / 程序验算(verify) /
//                配图(figure[出题相]|solution) / 题组就绪(persist|assemble)
//
// 5 态：todo 待完成灰 / run 进行中紫呼吸 / done 已完成青 / err 异常红 / human 需人工橙。
// 底部 .ps-cast = 真值流式播报：取当前 run/human 节点的 stage.detail（R2 真子帧），
// 无 detail 时轮转节点标题或静默。播报随 detail 变化带 castin 进入动画。
// ---------------------------------------------------------------------------
import { computed, ref, watch } from 'vue'
import type { VariantStage } from '@/api/variant'

// 🔴 PRD-A-018 C3(A-24)：starting = 已点「开始举一反三」/ 已发起一轮，但首帧（generate）还没到达的
//   过渡窗口。此态下若 stages 仍空，状态条显「启动中」而非「待机」——避免「系统在跑（sending=true、
//   母题卡还在）却显待机」的瞬态矛盾。宿主传 :starting="sending"。
const props = withDefaults(
  defineProps<{ stages: VariantStage[]; starting?: boolean }>(),
  { starting: false }
)

type NodeState = 'todo' | 'run' | 'done' | 'err' | 'human'

interface PsNode {
  label: string
  state: NodeState
  desc: string
  // 🔴 PRD-A-018 C1(A-10)：可选旁挂节点（如程序验算）——照常渲染自己的态，但不计入
  //   「题组就绪 / 全部完成」判定（allDone），也不让它的 await 把整条状态条挂在「需人工」。
  optional?: boolean
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

// ── 定题中 节点 ──
// 🔴 PRD-A-017（新 stage 帧契约，2026-06-19）：定题阶段三节点各读独立 stage key，
//   不再用 classify+knobs 两 key 硬凑（旧映射致三态自相矛盾，根因见组件顶注释更新）。
//   n1 读图锚定 ← classify、n2 母题切图 ← figure、n3 确认母题 ← review。
//   后端发帧契约：
//     ① classify：running（读图中）→ done（母题就绪，🔴 不再倒退成 await）/ await（仅低置信待确认年级章）。
//     ② figure：纯文本 → done（detail「无需切图·纯文本」）；带图 → running → done。
//        🔴 某轮确实没收到 figure 帧（旧数据/异常）→ 按「不适用·done」兜底，不恒挂待完成。
//     ③ review：进入待确认 → await（detail「待老师确认母题，点开始举一反三」）→ 此节点显需人工；
//        老师点「开始举一反三」→ review=done → 转 done。（knobs 仍存在但只代表「解析配方」，不驱动本节点）
const dingNodes = computed<PsNode[]>(() => {
  const cls = st('classify')
  // 🔴 PRD-A-018 C2(A-11)：母题切图节点读宿主 push 的 figure-mother（不再读裸 figure；裸 figure
  //   是历史混义 key，治标拆开后母题切图灯唯一 key = figure-mother，见 index.vue upsertFigureStage）。
  const fig = st('figure-mother')
  const review = st('review')

  // ① 读图锚定（classify）：await→需人工（仅低置信待确认年级章）/ warn→异常 / done→已完成 / running→进行中
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
        ? (cls?.detail ?? '年级·章拿捏不准，请确认')
        : (cls?.detail ?? '识别题面、判年级·章、锚定考点'),
  }
  // ② 母题切图（figure）：后端按帧渲染——running→done（带图）/ done（纯文本「无需切图」）。
  //   🔴 无 figure 帧（旧数据/异常）→ 按「不适用·done」兜底，不恒挂「待完成」卡住整条。
  const n2: PsNode = {
    label: '母题切图',
    state: fig ? nodeStateFromStatus(fig.status, 'done') : 'done',
    desc: fig?.detail ?? '无需切图 · 纯文本',
  }
  // ③ 确认母题（review）：await→需人工（真正等老师操作的 gate）/ done→已完成（点了「开始举一反三」）。
  //   🔴 数据源从 knobs 改成 review；无 review 帧时按 todo（母题就绪前还没到确认 gate）。
  const n3: PsNode = {
    label: '确认母题',
    state:
      review?.status === 'await'
        ? 'human'
        : nodeStateFromStatus(review?.status, 'todo'),
    desc: review?.detail ?? '母题已确认无误？点「开始举一反三」开始生成变式',
  }
  return [n1, n2, n3]
})

// 🔴 PRD-A-018 C2(A-11)：配图节点聚合源——收集所有配图灯 stage（figure-mother + figure-v{N}），
//   外加旧字段兜底（legacy 裸 figure / solution，向后兼容旧会话恢复帧）。宿主造每张图时
//   upsertFigureStage 各亮各灯（见 index.vue），这里聚合成单个「配图」节点真值。
const figureStages = computed<VariantStage[]>(() =>
  props.stages.filter(
    (s) => s.key === 'figure-mother' || s.key.startsWith('figure-v')
  )
)
// 旧兜底：无新式配图灯时，回看 legacy 裸 figure / solution（旧会话/旧后端帧）
const legacyFigStage = computed(() => st('figure') ?? st('solution'))

// ── 出题中 节点 ──
const chuNodes = computed<PsNode[]>(() => {
  const gen = st('generate')
  const gate = st('gene_gate')
  const ver = st('verify')
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
  // 🔴 PRD-A-018 C1(A-10)：程序验算 = 老师自选的可选旁挂步，从出题主干「必经链」摘出，
  //   不计入 coreDone / 题组就绪 / allDone（手动模式 BE 不再硬发 verify=done，而发 await/pending）。
  //   节点标「可选·待验算」——await→需人工提示（待老师点验算）、done→已完成、running→进行中、无帧→「可选·待验算」灰态。
  const n3: PsNode = {
    label: '程序验算',
    state:
      ver?.status === 'await'
        ? 'human'
        : nodeStateFromStatus(ver?.status, 'todo'),
    desc: ver?.detail ?? '可选 · 待老师点「验算」核对答案闭合（不影响题组就绪）',
    optional: true, // 🔴 C1：可选旁挂，不计入题组就绪/全部完成
  }
  // 🔴 C1：核心完成 = 生成 + 考点比对（不含验算）。验算摘出后题组就绪只依赖 generate+gate(+真配图)。
  const coreDone = gen?.status === 'done' && gate?.status === 'done'

  // 🔴 PRD-A-018 C2(A-11)：配图节点聚合所有 figure-v*(+figure-mother)——
  //   任一 running → run；全 done（含「沿用旧图」done、跳过 await）→ done；
  //   无任何配图灯且核心已完成 → 视为本组无需配图（跳过=done，不挂待完成卡住整条）。
  const figs = figureStages.value
  const legacyFig = legacyFigStage.value
  const figDoneOf = (s: VariantStage) => s.status === 'done' || s.status === 'await' // await=跳过/不适用=完成
  let n4State: NodeState
  let n4Desc: string
  if (figs.length > 0) {
    const anyRun = figs.some((s) => s.status === 'running')
    const anyErr = figs.some((s) => s.status === 'warn')
    const allDoneFig = figs.every(figDoneOf)
    n4State = anyRun ? 'run' : anyErr ? 'err' : allDoneFig ? 'done' : 'todo'
    n4Desc = anyRun
      ? '为带图变式造图…'
      : anyErr
        ? '部分图待补（可在卡上重新配图）'
        : allDoneFig
          ? '配图完成'
          : '为带图变式造图'
  } else if (legacyFig) {
    // 旧帧兜底（单个 legacy figure/solution stage）
    n4State = figDoneOf(legacyFig) ? 'done' : nodeStateFromStatus(legacyFig.status, 'todo')
    n4Desc = legacyFig.detail ?? '为带图变式造图'
  } else if (coreDone) {
    // 无任何配图灯 + 核心完成 → 本组无需配图（跳过=完成）
    n4State = 'done'
    n4Desc = '本组无需配图（已跳过）'
  } else {
    n4State = 'todo'
    n4Desc = '为带图变式造图'
  }
  const n4: PsNode = { label: '配图', state: n4State, desc: n4Desc }

  // 题组就绪：persist done → done；await → human；无 persist stage 但核心+配图都完成 → 收口为「就绪」。
  //   🔴 C1：不依赖验算（n3）；🔴 C2：依赖聚合后的配图（n4），任一变式图未完成则不显就绪。
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

// 当前活跃节点（run 优先，其次 human）—— 决定播报内容与 mini 摘要。
// 🔴 PRD-A-018 C1：先在「必经」节点里找活跃（在跑/需人工）；都没有再回看可选节点（程序验算 await）。
//   这样「核心+配图都完成、只剩可选验算待老师点」时，allDone 先收口为「全部完成」，
//   播报不被可选验算的 await 劫持成「待验算·像卡住」。
const activeNode = computed<PsNode | undefined>(() => {
  const core = nodes.value.filter((n) => !n.optional)
  return (
    core.find((n) => n.state === 'run') ??
    core.find((n) => n.state === 'human') ??
    nodes.value.find((n) => n.state === 'run') ??
    nodes.value.find((n) => n.state === 'human')
  )
})
const isAwait = computed(() => activeNode.value?.state === 'human')

// 🔴 BUG-10 + PRD-A-018 C1：全部「必经」节点完成即收口为「就绪」——只看非可选节点：
//   无必经节点在跑/待人工、无错误、至少一个必经节点已 done → 全部完成。可选节点（程序验算）
//   不计入（验算未点也能就绪=题组就绪秒到，不被从不到来的验算挂住）。
const allDone = computed(() => {
  if (isEmpty.value) return false
  const core = nodes.value.filter((n) => !n.optional)
  const hasActive = core.some((n) => n.state === 'run' || n.state === 'human')
  const hasErr = core.some((n) => n.state === 'err')
  const anyDone = core.some((n) => n.state === 'done')
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
// 🔴 C3：启动中空态（已发起一轮、首帧未到）——显「启动中」而非「待机」
const isStarting = computed(() => isEmpty.value && props.starting)

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
      <!-- 🔴 C3：启动中（已发起、首帧未到）显「启动中」，纯空态才显「待机」 -->
      <span class="ps-ph">{{ isStarting ? '启动中' : isEmpty ? '待机' : phaseTag }}</span>
      <span class="ps-name">{{ isStarting ? '定题中' : phaseName }}</span>
      <span class="ps-step">{{ isEmpty ? (isStarting ? '· · ·' : '0 / 2 阶段') : phaseStep }}</span>
    </div>

    <!-- 收起态一行摘要 -->
    <div v-if="!isEmpty" class="ps-mini" :class="{ h: miniHuman }">
      <span class="d" />
      <span class="mtx">{{ miniText }}</span>
    </div>

    <!-- 空态：🔴 C3 启动中（已发起、首帧未到）显「启动中」呼吸态，纯空态显「待机」引导 -->
    <div v-if="isEmpty" class="ps-stat-empty" :class="{ starting: isStarting }">
      <template v-if="isStarting">◌ 启动中 · 正在唤起 AI，马上开始读图…</template>
      <template v-else>○ 待机 · 拍一道题丢进来，自动开始读图锚定</template>
    </div>

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
/* 🔴 C3：启动中态——紫系呼吸，与「进行中」语义一致（区别于待机灰） */
.ps-stat-empty.starting {
  color: var(--violet-700);
  animation: ps-breathe 1.8s infinite ease-in-out;
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
