<script setup lang="ts">
/**
 * 首页（home）—— PRD-C-212 V2「首页门面 hero 实装」。
 *
 * 定位：宣传门面页（未登录也能看，V3 放白名单，本页零 API 请求）。
 * hero 区 1:1 移植自设计正本 `workplace/.prd_ccw/PRD-C/PRD-C-212/设计稿-V4-定稿.html`
 * 的 `.hero` 区块（方格纸底 + 三团极光 + 知识星图 canvas + 飞光 canvas + 打字组装演示），
 * 原稿是裸 JS/DOM 操作 + <style> 全局块，本文件做了 Vue 化改造：
 *   - getElementById/querySelector → 模板 ref
 *   - window resize 监听持有引用，onUnmounted 释放
 *   - 星图 / 飞光 / 数字滚动 3 处 RAF 循环各自持有 id，onUnmounted cancelAnimationFrame
 *   - play() 打字组装循环加 alive 守卫，onUnmounted 置 false，每个 await 之后检查，防卸载后写 DOM
 *   - prefers-reduced-motion：JS 一帧静态铺满 + CSS @media 降级两处都保留
 *
 * 设计稿的 .browser 假浏览器外框 + .mnav 假导航不移植（真实页面渲染在 AppLayout 导航之下）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import type { ComponentPublicInstance } from 'vue'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

// ══════════════════════════════════════════════════════════════
// CTA 分流（登录态兼容，零 API 请求 —— isLoggedIn 只读 store 内存态）
// ══════════════════════════════════════════════════════════════
interface CtaAction {
  text: string
  action: () => void
}

const ctaPrimary = computed<CtaAction>(() =>
  userStore.isLoggedIn
    ? { text: '开始组卷', action: () => router.push('/papers/workbench') }
    : { text: '免费注册', action: () => router.push('/register') },
)
const ctaSecondary = computed<CtaAction>(() =>
  userStore.isLoggedIn
    ? { text: '进入题库', action: () => router.push('/question/index') }
    : { text: '登录', action: () => router.push('/login') },
)

// ══════════════════════════════════════════════════════════════
// 场景卡片（纯静态，不调接口）
// ══════════════════════════════════════════════════════════════
const sceneCards = [
  { icon: '🔎', title: '找题组卷', desc: '说出你要的范围、难度和题量，备课帮从万题库里帮你选好、配好，直接成卷。' },
  { icon: '📘', title: '讲义备课', desc: '从知识点到例题，备课帮帮你搭好讲义骨架，你专心打磨每一页细节。' },
  { icon: '🔁', title: '举一反三', desc: '拿一道题，备课帮帮你变出一组同类训练，巩固练习更省心。' },
]

// ══════════════════════════════════════════════════════════════
// 滚动数字（写死展示值，TODO 接真实资产统计接口后替换 STAT_TARGETS）
// ══════════════════════════════════════════════════════════════
// TODO 接真实资产统计接口
const STAT_TARGETS = [10000, 60, 1300] as const
const STAT_LABELS = ['结构化题库', '真卷同步试卷', '知识点图谱']
const stat1 = ref('0')
const stat2 = ref('0')
const stat3 = ref('0')
const statRefs = [stat1, stat2, stat3]

let countRafId: number | null = null
function startCount(): void {
  const DURATION = 1400
  if (reducedMotion) {
    statRefs.forEach((s, i) => {
      s.value = STAT_TARGETS[i].toLocaleString() + '+'
    })
    return
  }
  const start = performance.now()
  function step(now: number): void {
    const k = Math.min(1, (now - start) / DURATION)
    const eased = 1 - Math.pow(1 - k, 3)
    statRefs.forEach((s, i) => {
      s.value = Math.round(STAT_TARGETS[i] * eased).toLocaleString() + '+'
    })
    if (k < 1) countRafId = requestAnimationFrame(step)
  }
  countRafId = requestAnimationFrame(step)
}

// ══════════════════════════════════════════════════════════════
// hero 区：DOM refs
// ══════════════════════════════════════════════════════════════
const heroEl = ref<HTMLElement | null>(null)
const kgCanvas = ref<HTMLCanvasElement | null>(null)
const fxCanvas = ref<HTMLCanvasElement | null>(null)
const qlineRefs = ref<(HTMLElement | null)[]>([])

function setQlineRef(el: Element | ComponentPublicInstance | null, i: number): void {
  qlineRefs.value[i] = (el as HTMLElement) ?? null
}

// ══════════════════════════════════════════════════════════════
// 知识星图（canvas #kg 等价物）
// ══════════════════════════════════════════════════════════════
interface KgNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  ph: number
  label: string | null
}

const LABELS = ['长度测量', '温度', '密度', '浮力', '压强', '光的反射', '凸透镜', '电路', '溶液', '细胞', '声音', '功与能']

let kgCtx: CanvasRenderingContext2D | null = null
let fxCtx: CanvasRenderingContext2D | null = null
let dpr = 1
let kgWidth = 0
let kgHeight = 0
let nodes: KgNode[] = []
let edges: Array<[number, number]> = []
let t = 0
let kgRafId: number | null = null
let fxRafId: number | null = null
let reducedMotion = false

function initKG(): void {
  if (!heroEl.value || !kgCanvas.value || !fxCanvas.value) return
  const r = heroEl.value.getBoundingClientRect()
  kgWidth = kgCanvas.value.width = r.width * dpr
  kgHeight = kgCanvas.value.height = r.height * dpr
  fxCanvas.value.width = kgWidth
  fxCanvas.value.height = kgHeight
  nodes = []
  const N = 30
  for (let i = 0; i < N; i++) {
    nodes.push({
      x: Math.random() * kgWidth,
      y: Math.random() * kgHeight,
      vx: (Math.random() - 0.5) * 0.1 * dpr,
      vy: (Math.random() - 0.5) * 0.1 * dpr,
      r: (Math.random() * 1.6 + 1) * dpr,
      ph: Math.random() * 7,
      label: i < LABELS.length && Math.random() > 0.4 ? LABELS[i] : null,
    })
  }
  edges = []
  for (let i = 0; i < N; i++) {
    const best: Array<[number, number]> = []
    for (let k = 0; k < N; k++) {
      if (k !== i) best.push([(nodes[i].x - nodes[k].x) ** 2 + (nodes[i].y - nodes[k].y) ** 2, k])
    }
    best.sort((a, b) => a[0] - b[0])
    edges.push([i, best[0][1]], [i, best[1][1]])
  }
}

function frameKG(): void {
  if (!kgCtx) return
  t++
  kgCtx.clearRect(0, 0, kgWidth, kgHeight)
  kgCtx.lineWidth = 0.7 * dpr
  for (const [a, b] of edges) {
    kgCtx.strokeStyle = 'rgba(20,184,166,.13)'
    kgCtx.beginPath()
    kgCtx.moveTo(nodes[a].x, nodes[a].y)
    kgCtx.lineTo(nodes[b].x, nodes[b].y)
    kgCtx.stroke()
  }
  for (const n of nodes) {
    n.x += n.vx
    n.y += n.vy
    if (n.x < 0 || n.x > kgWidth) n.vx *= -1
    if (n.y < 0 || n.y > kgHeight) n.vy *= -1
    const b = 0.5 + 0.5 * Math.sin(t * 0.018 + n.ph)
    const g = kgCtx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 5.5)
    g.addColorStop(0, `rgba(45,212,191,${0.3 * b})`)
    g.addColorStop(1, 'rgba(45,212,191,0)')
    kgCtx.fillStyle = g
    kgCtx.beginPath()
    kgCtx.arc(n.x, n.y, n.r * 5.5, 0, Math.PI * 2)
    kgCtx.fill()
    kgCtx.fillStyle = `rgba(15,118,110,${0.35 + 0.35 * b})`
    kgCtx.beginPath()
    kgCtx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    kgCtx.fill()
    if (n.label) {
      kgCtx.font = `${10 * dpr}px Consolas,monospace`
      kgCtx.fillStyle = `rgba(63,88,82,${0.22 + 0.2 * b})`
      kgCtx.fillText(n.label, n.x + 7 * dpr, n.y + 3 * dpr)
    }
  }
  if (!reducedMotion) kgRafId = requestAnimationFrame(frameKG)
}

function handleResize(): void {
  initKG()
  if (reducedMotion) frameKG()
}

// ══════════════════════════════════════════════════════════════
// 飞光层（canvas #fx 等价物）：贝塞尔火花 + 落点闪环
// ══════════════════════════════════════════════════════════════
interface FxSpark {
  kind: 'bezier'
  x0: number
  y0: number
  cx: number
  cy: number
  x1: number
  y1: number
  t: number
  sp: number
  trail: Array<[number, number]>
  hit: boolean
}
interface FxRing {
  kind: 'ring'
  x: number
  y: number
  t: number
  sp: number
}
type FxParticle = FxSpark | FxRing

let sparks: FxParticle[] = []

function flyTo(el: HTMLElement | null): void {
  if (reducedMotion || !el || !heroEl.value || nodes.length === 0) return
  const hr = heroEl.value.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  const tx = (er.left - hr.left + 30) * dpr
  const ty = (er.top - hr.top + er.height / 2) * dpr
  for (let i = 0; i < 3; i++) {
    const src = nodes[(Math.random() * nodes.length) | 0]
    const cxp = (src.x + tx) / 2 + (Math.random() - 0.5) * 160 * dpr
    const cyp = Math.min(src.y, ty) - (60 + Math.random() * 120) * dpr
    sparks.push({
      kind: 'bezier',
      x0: src.x,
      y0: src.y,
      cx: cxp,
      cy: cyp,
      x1: tx,
      y1: ty,
      t: 0,
      sp: 0.022 + Math.random() * 0.01,
      trail: [],
      hit: false,
    })
  }
}

function frameFX(): void {
  if (!fxCtx) return
  fxCtx.clearRect(0, 0, kgWidth, kgHeight)
  for (const s of sparks) {
    if (s.kind !== 'bezier') continue
    s.t += s.sp
    const u = Math.min(1, s.t)
    const v = 1 - u
    const x = v * v * s.x0 + 2 * v * u * s.cx + u * u * s.x1
    const y = v * v * s.y0 + 2 * v * u * s.cy + u * u * s.y1
    s.trail.push([x, y])
    if (s.trail.length > 9) s.trail.shift()
    for (let i = 0; i < s.trail.length; i++) {
      const [px, py] = s.trail[i]
      const a = (i / s.trail.length) * 0.5
      fxCtx.fillStyle = `rgba(45,212,191,${a})`
      fxCtx.beginPath()
      fxCtx.arc(px, py, (1 + i * 0.35) * dpr, 0, Math.PI * 2)
      fxCtx.fill()
    }
    const g = fxCtx.createRadialGradient(x, y, 0, x, y, 10 * dpr)
    g.addColorStop(0, 'rgba(94,234,212,.95)')
    g.addColorStop(1, 'rgba(94,234,212,0)')
    fxCtx.fillStyle = g
    fxCtx.beginPath()
    fxCtx.arc(x, y, 10 * dpr, 0, Math.PI * 2)
    fxCtx.fill()
    if (u >= 1 && !s.hit) {
      s.hit = true
      sparks.push({ kind: 'ring', x: s.x1, y: s.y1, t: 0, sp: 0.08 })
    }
  }
  for (const s of sparks) {
    if (s.kind !== 'ring') continue
    s.t += s.sp
    const rr = s.t * 26 * dpr
    fxCtx.strokeStyle = `rgba(45,212,191,${Math.max(0, 0.7 - s.t)})`
    fxCtx.lineWidth = 1.6 * dpr
    fxCtx.beginPath()
    fxCtx.arc(s.x, s.y, rr, 0, Math.PI * 2)
    fxCtx.stroke()
  }
  sparks = sparks.filter((s) => (s.kind === 'ring' ? s.t < 1 : s.t < 1 || !s.hit))
  if (!reducedMotion) fxRafId = requestAnimationFrame(frameFX)
}

// ══════════════════════════════════════════════════════════════
// 打字 → 逐题组装演示
// ══════════════════════════════════════════════════════════════
type QLineType = 'sec' | 'item' | 'ai'
interface QLine {
  type: QLineType
  no?: string
  text: string
  pts: string
}
const questionLines: QLine[] = [
  { type: 'sec', text: '一、选择题', pts: '6 题 × 5 分' },
  { type: 'item', no: '1.', text: '实验室常用温度计是根据液体____的性质制成的', pts: '易' },
  { type: 'item', no: '2.', text: '读数时视线应与温度计内液面____', pts: '易' },
  { type: 'item', no: '3.', text: '体温计可以离开人体读数，原因是____', pts: '中' },
  { type: 'sec', text: '二、填空题', pts: '4 题 × 10 分' },
  { type: 'item', no: '7.', text: '图示温度计量程____，分度值____℃', pts: '中' },
  { type: 'ai', no: '8.', text: '俯视读数测量值偏____，说明原因', pts: '' },
]

const ASK = '王老师：出一份《温度的测量》同步练习——10 题，选择×6 填空×4，中等难度，带 1 道变式拔高。'
const PHASES = [
  'AI 正在从 10,000+ 题中选题…',
  '按难度配比 6:3:1 调整中…',
  '生成变式拔高题…',
  '排版与答案页整理…',
]

const askText = ref('')
const showLines = ref<boolean[]>(questionLines.map(() => false))
const shineKeys = ref<number[]>(questionLines.map(() => 0))
const assembling = ref(false)
const asmVisible = ref(true)
const asmText = ref(PHASES[0])
const stampOn = ref(false)

let alive = true

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resetPlay(): void {
  askText.value = ''
  stampOn.value = false
  asmVisible.value = true
  showLines.value = questionLines.map(() => false)
}

async function play(): Promise<void> {
  if (!alive) return
  if (reducedMotion) {
    askText.value = ASK
    showLines.value = questionLines.map(() => true)
    asmVisible.value = false
    stampOn.value = true
    return
  }
  resetPlay()
  assembling.value = true
  for (let i = 0; i < ASK.length; i++) {
    if (!alive) return
    askText.value += ASK[i]
    await sleep(ASK[i] === '—' ? 110 : 32 + Math.random() * 38)
  }
  if (!alive) return
  await sleep(420)
  for (let i = 0; i < questionLines.length; i++) {
    if (!alive) return
    asmText.value = PHASES[Math.min(PHASES.length - 1, Math.floor(i / 2))]
    flyTo(qlineRefs.value[i])
    await sleep(300)
    if (!alive) return
    showLines.value[i] = true
    shineKeys.value[i]++
    await sleep(questionLines[i].type === 'sec' ? 420 : 330)
  }
  if (!alive) return
  await sleep(320)
  assembling.value = false
  asmVisible.value = false
  stampOn.value = true
  await sleep(3800)
  if (!alive) return
  play()
}

// ══════════════════════════════════════════════════════════════
// 生命周期
// ══════════════════════════════════════════════════════════════
onMounted(() => {
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  dpr = window.devicePixelRatio || 1
  kgCtx = kgCanvas.value?.getContext('2d') ?? null
  fxCtx = fxCanvas.value?.getContext('2d') ?? null

  initKG()
  frameKG()
  frameFX()
  window.addEventListener('resize', handleResize)

  startCount()
  play()
})

onUnmounted(() => {
  alive = false
  window.removeEventListener('resize', handleResize)
  if (kgRafId !== null) cancelAnimationFrame(kgRafId)
  if (fxRafId !== null) cancelAnimationFrame(fxRafId)
  if (countRafId !== null) cancelAnimationFrame(countRafId)
})
</script>

<template>
  <div class="home-page">
    <!-- ══ Hero：方格纸 × 极光 × 星图 × 飞光组装演示 ══ -->
    <section ref="heroEl" class="hero">
      <div class="grid-paper"></div>
      <div class="aurora a1"></div>
      <div class="aurora a2"></div>
      <div class="aurora a3"></div>
      <canvas ref="kgCanvas" class="kg-canvas"></canvas>

      <div class="hero-in">
        <div class="hero-left">
          <span class="eyebrow"><span class="dot2"></span>老师的 AI 备课搭档</span>
          <h1>把一节课说出来，<br />剩下的交给 <em>AI·备课帮</em></h1>
          <p class="lead">
            像聊天一样描述你要的试卷、专项、讲义——AI 从万题题库和知识图谱里帮你组好、配好、排好版，你只管过目和微调。
          </p>
          <div class="stats">
            <div v-for="(label, i) in STAT_LABELS" :key="label">
              <b>{{ statRefs[i].value }}</b>
              <span>{{ label }}</span>
            </div>
          </div>
          <div class="cta">
            <button class="primary" @click="ctaPrimary.action()">{{ ctaPrimary.text }}</button>
            <button class="ghost" @click="ctaSecondary.action()">{{ ctaSecondary.text }}</button>
          </div>
        </div>

        <div class="vibe">
          <div class="say">
            <span class="avatar">王</span>
            <div class="bubble"><span>{{ askText }}</span><span class="cursor"></span></div>
          </div>
          <div class="sheet" :class="{ assembling }">
            <div class="scan"></div>
            <div class="shead">
              <b>《温度的测量》同步练习</b>
              <span>科学 · 七年级上 · 满分 100 · 建议 40 分钟</span>
            </div>
            <div
              v-for="(line, i) in questionLines"
              :key="i"
              :ref="(el) => setQlineRef(el, i)"
              class="qline"
              :class="{ show: showLines[i] }"
            >
              <span v-if="line.type === 'sec'" class="sec">{{ line.text }}</span>
              <template v-else>
                <span class="no">{{ line.no }}</span>{{ line.text }}
              </template>
              <span class="pts">
                <template v-if="line.type === 'ai'">
                  <span class="ai-badge">✦AI 变式</span> <span class="checkmark">✓</span>
                </template>
                <template v-else>{{ line.pts }}</template>
              </span>
              <span v-if="showLines[i]" :key="'shine-' + i + '-' + shineKeys[i]" class="shine"></span>
            </div>
            <div v-show="asmVisible" class="assembling-hint">
              <span class="spin"></span><span>{{ asmText }}</span>
            </div>
            <div class="stamp" :class="{ on: stampOn }">✓ 组卷完成</div>
          </div>
        </div>
      </div>

      <canvas ref="fxCanvas" class="fx-canvas"></canvas>
    </section>

    <!-- ══ 场景区（静态卡片，不调接口）══ -->
    <section class="scenes">
      <h2 class="scenes-title">日常备课，这样更省心</h2>
      <div class="scenes-grid">
        <div v-for="card in sceneCards" :key="card.title" class="scene-card">
          <span class="scene-icon">{{ card.icon }}</span>
          <h3>{{ card.title }}</h3>
          <p>{{ card.desc }}</p>
        </div>
      </div>
    </section>

    <!-- ══ 底部 CTA ══ -->
    <section class="final-cta">
      <p class="final-cta-slogan">把重复的备课时间，还给你的课堂。</p>
      <button class="final-cta-btn" @click="ctaPrimary.action()">{{ ctaPrimary.text }}</button>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  --ink: #13312b;
  --ink-2: #3f5852;
  --teal: #0f766e;
  --teal-deep: #0b5d56;
  --teal-soft: #e6f3f1;
  --amber: #d97706;
  --paper: #fffdf9;
  --card: #ffffff;
  --line: #e5ebe9;
  --bg: #f2f6f5;
  --glow: #2dd4bf;
  --red-pen: #e0526b;
  --mono: 'Cascadia Code', Consolas, monospace;

  max-width: 1200px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

/* ══════════════════ HERO：亮色全息 ══════════════════ */
.hero {
  position: relative;
  overflow: hidden;
  background: #f7fcfa;
  border-radius: 20px;
  box-shadow: 0 12px 32px rgba(15, 118, 110, 0.12);
}

.hero .grid-paper {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(rgba(15, 118, 110, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(15, 118, 110, 0.05) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: radial-gradient(720px 480px at 62% 40%, #000 30%, transparent 78%);
}

.aurora {
  position: absolute;
  width: 560px;
  height: 560px;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.5;
  mix-blend-mode: multiply;
  animation: drift 16s ease-in-out infinite alternate;
}
.a1 {
  background: radial-gradient(circle, #8ff0e0, transparent 62%);
  top: -220px;
  right: -90px;
}
.a2 {
  background: radial-gradient(circle, #c9f3ea, transparent 60%);
  bottom: -260px;
  left: -140px;
  animation-delay: -6s;
}
.a3 {
  background: radial-gradient(circle, #ffe9c7, transparent 65%);
  top: 30%;
  left: 38%;
  width: 420px;
  height: 420px;
  opacity: 0.42;
  animation-delay: -11s;
}
@keyframes drift {
  to {
    transform: translate(46px, 30px) scale(1.12);
  }
}

.kg-canvas,
.fx-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.fx-canvas {
  z-index: 5;
  pointer-events: none;
}

.hero-in {
  position: relative;
  z-index: 4;
  display: grid;
  grid-template-columns: 1.02fr 0.98fr;
  gap: 34px;
  padding: 52px 48px 56px;
}
@media (max-width: 760px) {
  .hero-in {
    grid-template-columns: 1fr;
  }
}

.hero .eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--teal-deep);
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(20, 184, 166, 0.35);
  border-radius: 999px;
  padding: 4px 14px;
  box-shadow: 0 0 22px -4px rgba(45, 212, 191, 0.5);
}
.hero .eyebrow .dot2 {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--glow);
  box-shadow: 0 0 10px var(--glow);
  animation: pulse 1.6s ease infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.hero h1 {
  font-size: 39px;
  line-height: 1.32;
  margin: 18px 0 12px;
  color: var(--ink);
  font-weight: 800;
}
.hero h1 em {
  font-style: normal;
  background: linear-gradient(94deg, var(--teal) 10%, #14b8a6 45%, #2dd4bf 80%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 0 38px rgba(45, 212, 191, 0.35);
}
.hero .lead {
  font-size: 15px;
  color: var(--ink-2);
  max-width: 44ch;
  margin: 0;
}

.stats {
  display: flex;
  gap: 34px;
  margin: 24px 0 26px;
}
.stats b {
  display: block;
  font-size: 27px;
  font-family: var(--mono);
  color: var(--teal-deep);
  text-shadow: 0 0 20px rgba(45, 212, 191, 0.4);
}
.stats span {
  font-size: 12px;
  color: #7d928c;
}

.cta {
  display: flex;
  gap: 12px;
}
.cta button {
  cursor: pointer;
  font-family: inherit;
}
.cta .primary {
  position: relative;
  background: linear-gradient(94deg, var(--teal), #14b8a6);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 12px 28px;
  font-weight: 800;
  font-size: 14px;
  box-shadow: 0 12px 30px -8px rgba(20, 184, 166, 0.65);
  overflow: hidden;
}
.cta .primary::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 46px;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  transform: skewX(-20deg);
  animation: sheen 3.2s ease infinite;
  left: -60px;
}
@keyframes sheen {
  18% {
    left: 120%;
  }
  100% {
    left: 120%;
  }
}
.cta .ghost {
  border: 1.5px solid var(--line);
  background: rgba(255, 255, 255, 0.82);
  color: var(--ink-2);
  border-radius: 10px;
  padding: 12px 22px;
  font-size: 14px;
}

/* ── 演示：气泡 + 发光组装的试卷 ── */
.vibe {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-self: center;
  min-width: 0;
  position: relative;
  z-index: 4;
}
.say {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.say .avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--teal-soft);
  color: var(--teal-deep);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 13px;
  flex-shrink: 0;
  border: 1.5px solid rgba(15, 118, 110, 0.25);
}
.bubble {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--line);
  border-radius: 4px 14px 14px 14px;
  padding: 10px 14px;
  font-size: 13.5px;
  color: var(--ink);
  box-shadow: 0 6px 18px -10px rgba(19, 49, 43, 0.18);
  min-height: 44px;
  backdrop-filter: blur(4px);
}
.bubble .cursor {
  display: inline-block;
  width: 2px;
  height: 15px;
  background: var(--teal);
  vertical-align: -2px;
  animation: blink 0.9s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}

.sheet {
  position: relative;
  background: var(--paper);
  border: 1px solid #e8e4d8;
  border-radius: 10px;
  box-shadow: 0 22px 44px -20px rgba(19, 49, 43, 0.3);
  padding: 18px 22px 20px;
  background-image: repeating-linear-gradient(180deg, transparent 0 27px, rgba(19, 49, 43, 0.045) 27px 28px);
}
.sheet::before {
  content: '';
  position: absolute;
  left: 34px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(224, 82, 107, 0.25);
}
.sheet.assembling::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 12px;
  padding: 2px;
  background: linear-gradient(115deg, transparent 25%, rgba(45, 212, 191, 0.85) 50%, transparent 75%);
  background-size: 240% 100%;
  animation: borderflow 2.8s linear infinite;
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
@keyframes borderflow {
  to {
    background-position: -240% 0;
  }
}
.scan {
  position: absolute;
  left: 6px;
  right: 6px;
  height: 34px;
  background: linear-gradient(
    180deg,
    transparent,
    rgba(45, 212, 191, 0.14) 45%,
    rgba(45, 212, 191, 0.28) 50%,
    rgba(45, 212, 191, 0.14) 55%,
    transparent
  );
  border-radius: 6px;
  top: 40px;
  opacity: 0;
  pointer-events: none;
}
.sheet.assembling .scan {
  opacity: 1;
  animation: scanmove 2.4s ease-in-out infinite;
}
@keyframes scanmove {
  0% {
    top: 44px;
  }
  50% {
    top: calc(100% - 70px);
  }
  100% {
    top: 44px;
  }
}
.sheet .shead {
  text-align: center;
  border-bottom: 1.5px solid #e3ded0;
  padding-bottom: 8px;
  margin-bottom: 10px;
  position: relative;
  z-index: 2;
}
.sheet .shead b {
  font-size: 14.5px;
  letter-spacing: 0.06em;
}
.sheet .shead span {
  display: block;
  font-size: 10.5px;
  color: #98a29b;
  margin-top: 2px;
}
.qline {
  position: relative;
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-2);
  line-height: 27px;
  height: 27px;
  overflow: hidden;
  opacity: 0;
  transform: translateY(6px);
  padding-left: 22px;
  z-index: 2;
}
.qline.show {
  opacity: 1;
  transform: none;
  transition: all 0.4s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.qline.show .shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(95deg, transparent 20%, rgba(45, 212, 191, 0.28) 50%, transparent 80%);
  animation: lineshine 0.8s ease forwards;
}
@keyframes lineshine {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}
.qline .no {
  color: var(--teal-deep);
  font-weight: 700;
  font-family: var(--mono);
  flex-shrink: 0;
}
.qline .sec {
  color: var(--ink);
  font-weight: 800;
}
.qline .pts {
  margin-left: auto;
  color: #b3beb8;
  font-size: 10.5px;
  font-family: var(--mono);
  flex-shrink: 0;
}
.ai-badge {
  color: #b7791f;
  background: #fdf3e0;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 700;
}
.assembling-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-left: 22px;
  font-size: 11.5px;
  color: var(--teal-deep);
  position: relative;
  z-index: 2;
}
.assembling-hint .spin {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--glow);
  border-radius: 50%;
  animation: rot 1s linear infinite;
  box-shadow: 0 0 10px rgba(45, 212, 191, 0.4);
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
.stamp {
  position: absolute;
  right: 16px;
  bottom: 14px;
  color: var(--red-pen);
  border: 2.5px solid var(--red-pen);
  border-radius: 8px;
  padding: 2px 12px;
  font-size: 13px;
  font-weight: 800;
  transform: rotate(-8deg) scale(0);
  letter-spacing: 0.1em;
  opacity: 0.9;
  z-index: 3;
}
.stamp.on {
  animation: stampin 0.4s cubic-bezier(0.2, 1.6, 0.4, 1) forwards;
}
@keyframes stampin {
  to {
    transform: rotate(-8deg) scale(1);
  }
}
.checkmark {
  color: var(--red-pen);
  font-weight: 900;
}

@media (prefers-reduced-motion: reduce) {
  .assembling-hint .spin,
  .bubble .cursor,
  .aurora,
  .scan,
  .sheet.assembling::after,
  .cta .primary::after {
    animation: none;
  }
}

/* ══════════════════ 场景区 ══════════════════ */
.scenes {
  margin-top: 48px;
}
.scenes-title {
  font-size: 20px;
  font-weight: 800;
  color: var(--ink);
  margin: 0 0 18px;
}
.scenes-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
@media (max-width: 760px) {
  .scenes-grid {
    grid-template-columns: 1fr;
  }
}
.scene-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 22px 20px;
}
.scene-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--teal-soft);
  font-size: 20px;
  margin-bottom: 12px;
}
.scene-card h3 {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 8px;
}
.scene-card p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2);
  margin: 0;
}

/* ══════════════════ 底部 CTA ══════════════════ */
.final-cta {
  margin-top: 48px;
  text-align: center;
  background: var(--teal-soft);
  border-radius: 16px;
  padding: 40px 24px;
}
.final-cta-slogan {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 18px;
}
.final-cta-btn {
  cursor: pointer;
  font-family: inherit;
  background: linear-gradient(94deg, var(--teal), #14b8a6);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 13px 32px;
  font-weight: 800;
  font-size: 14px;
  box-shadow: 0 12px 30px -8px rgba(20, 184, 166, 0.5);
}
</style>
