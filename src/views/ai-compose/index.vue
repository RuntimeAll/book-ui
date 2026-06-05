<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { streamChat } from '@/api/chat'
import type { ChatEvent, ChatPaper, ChatStreamHandle } from '@/api/chat'

// ---------------------------------------------------------------------------
// PRD-C-005 — 老师 vibe 聊天入口（双栏），SSE 全流式逐字渲染 V2
//
// 复用 C-004 双栏布局，只换接收/渲染层：从"一次性 await 拿 JSON"改成 SSE 流式逐字。
//   左栏 = 对话流：老师消息 + AI 思路（逐 token 打字机气泡）+ WF3 阶段步骤灯 + 人话 notes。
//   右栏 = 工作画布：出卷完成时填充（paper 标题 + 题目 / 提纲），空态占位。
//
// 入口就一个聊天输入框 + 发送，无 Agent 选择器 / 技能卡片（全自动语言路由的形）。
// 单轮即走：不存对话历史（对话流仅本次内存态，刷新清空）。
//
// 接口：POST /ai/chat {message,teacherId} → vite proxy 同源转 :8092/chat（SSE）。
//   事件协议见 @/api/chat：stage/intent/outline/notes/paper/needAsk/error/done。
//   发送后立刻进"接收中"态（左栏开始冒泡 + 阶段灯亮），不是转圈干等。
// ---------------------------------------------------------------------------

const userStore = useUserStore()
// teacherId：优先登录态老师 id；取不到兜底测试老师 5（与 G2/G3 验收口径一致）。
const teacherId = computed<number>(() => Number(userStore.userInfo?.id ?? 5))

// 内存态 userInfo 刷新会丢（[[feedback_fe_user_info_onmount_fallback]]），onMounted 兜底拉一次。
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[vibe-chat] getCurrentUser 兜底失败:', e)
    }
  }
})

// ---- 左栏：对话流 ----------------------------------------------------------
// echo  = AI 逐字思路气泡（intent/outline token 追加进当前 echo 气泡）
// ask   = 反问气泡；error = 兜底提示；info = 人话 notes 句子
type Msg =
  | { role: 'user'; text: string }
  | { role: 'ai'; kind: 'echo' | 'ask' | 'error' | 'info'; text: string }

const messages = ref<Msg[]>([])
const input = ref('')
const sending = ref(false)
const streamRef = ref<HTMLElement | null>(null)

// ---- 左栏：WF3 阶段步骤灯（stage 事件逐条出现 + running/done 状态）----------
interface StageItem {
  key: string
  label: string
  status: 'running' | 'done'
  detail?: string
}
const stages = ref<StageItem[]>([])

// ---- 右栏：工作画布 --------------------------------------------------------
const paper = ref<ChatPaper | null>(null)
const outline = ref<Array<Record<string, unknown>>>([])
const paperUrl = ref<string>('')

// 当前正在逐字追加的 AI 气泡下标（intent/outline token 流落点）；-1 = 尚未开气泡。
let echoIdx = -1
// 流控制句柄（组件卸载 / 重新发送时中止上一条）。
let handle: ChatStreamHandle | null = null

// paper 来自 RuoYi 真库（结构宽松），容错取标题 / 题目列表。
const paperTitle = computed(() => {
  const p = paper.value
  if (!p) return ''
  return String(p.title ?? p.name ?? '未命名试卷')
})
const paperQuestions = computed(() => {
  const p = paper.value
  if (!p || !Array.isArray(p.questions)) return []
  return p.questions
})

function questionText(q: Record<string, unknown>): string {
  return String(q.stem ?? q.content ?? q.title ?? q.questionStem ?? '（题干缺失）')
}

async function scrollToBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 把一段 token 逐字追加到"当前 AI 思路气泡"；没有则先开一个 echo 气泡。 */
function appendDelta(delta: string) {
  if (!delta) return
  if (echoIdx < 0) {
    messages.value.push({ role: 'ai', kind: 'echo', text: '' })
    echoIdx = messages.value.length - 1
  }
  const m = messages.value[echoIdx]
  if (m && m.role === 'ai') {
    m.text += delta
  }
  scrollToBottom()
}

/** 重置一次会话的渲染态（新发送前清空，单轮即走不留历史）。 */
function resetStream() {
  messages.value = []
  stages.value = []
  paper.value = null
  outline.value = []
  paperUrl.value = ''
  echoIdx = -1
}

/** 按事件 type 渲染（协议见 @/api/chat / T1 后端）。 */
function handleEvent(ev: ChatEvent) {
  switch (ev.type) {
    // WF3 阶段灯：逐条出现 + running/done（同 key 更新而非重复追加）
    case 'stage': {
      const idx = stages.value.findIndex((s) => s.key === ev.key)
      const item: StageItem = {
        key: ev.key,
        label: ev.label,
        status: ev.status,
        detail: ev.detail,
      }
      if (idx >= 0) stages.value[idx] = item
      else stages.value.push(item)
      scrollToBottom()
      break
    }

    // LLM① 思路 token / LLM② 大纲 token → 逐字追加当前 AI 气泡（打字机）
    case 'intent':
      appendDelta(ev.delta)
      break
    case 'outline':
      if (ev.delta) appendDelta(ev.delta)
      // outline.items = 结构化大纲定型 → 右栏兜底预览（出卷前先有结构感知）
      if (Array.isArray(ev.items)) outline.value = ev.items
      break

    // 人话 notes：每句一个独立气泡（🔴 不再 JSON.stringify 裸吐）
    case 'notes': {
      echoIdx = -1 // notes 后若还有 token，另起新气泡
      const list = Array.isArray(ev.notes) ? ev.notes : []
      for (const s of list) {
        const sentence = String(s).trim()
        if (sentence) messages.value.push({ role: 'ai', kind: 'info', text: sentence })
      }
      scrollToBottom()
      break
    }

    // 出卷完成 → 右栏填充
    case 'paper':
      if (ev.paper) paper.value = ev.paper
      if (Array.isArray(ev.outline)) outline.value = ev.outline
      paperUrl.value = ev.paperUrl || ''
      scrollToBottom()
      break

    // 非组卷 / 范围说不清 → 反问气泡
    case 'needAsk':
      echoIdx = -1
      messages.value.push({
        role: 'ai',
        kind: 'ask',
        text: ev.ask || '我没太懂你的意思，能说得更具体些吗？',
      })
      scrollToBottom()
      break

    // 任一步失败 → 兜底提示气泡（不崩）
    case 'error':
      echoIdx = -1
      messages.value.push({
        role: 'ai',
        kind: 'error',
        text: ev.error || '抱歉，处理时出了点问题，请稍后再试。',
      })
      scrollToBottom()
      break

    case 'done':
      // 流自然结束（onClose 里收尾 sending），此处无需额外处理
      break
  }
}

function send() {
  const text = input.value.trim()
  if (!text || sending.value) return

  // 中止上一条未完流（防止并发气泡串台）
  handle?.abort()
  resetStream()

  messages.value.push({ role: 'user', text })
  input.value = ''
  sending.value = true
  scrollToBottom()

  handle = streamChat(
    { message: text, teacherId: teacherId.value },
    {
      onEvent: handleEvent,
      onError: (err) => {
        console.error('[vibe-chat] /chat 流异常:', err)
        echoIdx = -1
        messages.value.push({
          role: 'ai',
          kind: 'error',
          text: '网络或服务异常，未能完成本次请求，请确认 AI 服务已启动后重试。',
        })
        sending.value = false
        scrollToBottom()
      },
      onClose: () => {
        // 流正常结束：解除接收态
        sending.value = false
        scrollToBottom()
      },
    }
  )
}

// 组件卸载中止在途流，避免回调访问已卸载组件。
onBeforeUnmount(() => handle?.abort())
</script>

<template>
  <div class="vibe-page">
    <!-- 左栏：对话流 -->
    <section class="vibe-chat">
      <header class="chat-head">
        <span class="dot" />
        <span class="chat-title">老师 AI 命题助手</span>
        <span class="chat-sub">说人话，例如「出5道一元二次方程选择题」</span>
      </header>

      <div ref="streamRef" class="chat-stream">
        <div v-if="messages.length === 0" class="chat-empty">
          <div class="empty-emoji">💬</div>
          <p class="empty-title">直接说出你想要的卷子</p>
          <p class="empty-tip">AI 会先回显它对你需求的理解，再去真题库出卷，右侧画布给你结果。</p>
        </div>

        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg-row"
          :class="m.role === 'user' ? 'is-user' : 'is-ai'"
        >
          <div
            class="bubble"
            :class="m.role === 'ai' ? `ai-${m.kind}` : ''"
          >
            <span v-if="m.role === 'ai' && m.kind === 'echo'" class="bubble-tag">思路</span>
            <span v-else-if="m.role === 'ai' && m.kind === 'ask'" class="bubble-tag ask">反问</span>
            <span v-else-if="m.role === 'ai' && m.kind === 'error'" class="bubble-tag err">提示</span>
            <span class="bubble-text">{{ m.text }}</span>
            <!-- 接收中 + 正在逐字追加的当前气泡 → 打字机光标 -->
            <span
              v-if="sending && m.role === 'ai' && m.kind === 'echo' && i === messages.length - 1"
              class="type-caret"
            />
          </div>
        </div>

        <!-- WF3 阶段步骤灯：逐条出现 + running(转圈) / done(✓) -->
        <div v-if="stages.length" class="stage-panel">
          <div
            v-for="s in stages"
            :key="s.key"
            class="stage-item"
            :class="s.status === 'done' ? 'is-done' : 'is-running'"
          >
            <span class="stage-icon">
              <span v-if="s.status === 'done'">✓</span>
              <span v-else class="stage-spin" />
            </span>
            <span class="stage-label">{{ s.label }}</span>
            <span v-if="s.detail" class="stage-detail">{{ s.detail }}</span>
          </div>
        </div>
      </div>

      <!-- 入口：唯一一个输入框 + 发送，无 Agent 选择器 / 技能卡片 -->
      <footer class="chat-input">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="一句话描述你要的卷子，回车发送…"
          :disabled="sending"
          @keyup.enter.exact.prevent="send"
        />
        <el-button
          type="primary"
          class="send-btn"
          :loading="sending"
          :disabled="!input.trim()"
          @click="send"
        >
          发送
        </el-button>
      </footer>
    </section>

    <!-- 右栏：工作画布 -->
    <section class="vibe-canvas">
      <header class="canvas-head">
        <span class="canvas-title">工作画布</span>
        <a
          v-if="paperUrl"
          class="canvas-link"
          :href="paperUrl"
          target="_blank"
          rel="noopener"
        >打开卷详情 ↗</a>
      </header>

      <!-- 空态占位 -->
      <div v-if="!paper && outline.length === 0" class="canvas-empty">
        <div class="empty-emoji">📄</div>
        <p class="empty-title">还没有卷子</p>
        <p class="empty-tip">在左侧说一句组卷需求，出好的卷子会出现在这里。</p>
      </div>

      <!-- 卷子结果 -->
      <div v-else class="canvas-body">
        <div class="paper-head">
          <h2 class="paper-title">{{ paperTitle || '组卷结果' }}</h2>
          <span v-if="paperQuestions.length" class="paper-meta">共 {{ paperQuestions.length }} 题</span>
        </div>

        <!-- 题目列表（优先）：paper.questions -->
        <ol v-if="paperQuestions.length" class="q-list">
          <li v-for="(q, i) in paperQuestions" :key="i" class="q-item">
            <span class="q-no">{{ i + 1 }}.</span>
            <span class="q-stem">{{ questionText(q) }}</span>
          </li>
        </ol>

        <!-- 提纲（兜底）：outline，当没有展开题目时给到结构感知 -->
        <div v-else-if="outline.length" class="outline-box">
          <p class="outline-title">组卷提纲</p>
          <ul class="outline-list">
            <li v-for="(o, i) in outline" :key="i" class="outline-item">
              <span class="o-subject">{{ o.subjectName ?? o.subjectId ?? '考点' }}</span>
              <span class="o-count">×{{ o.count ?? '?' }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.vibe-page {
  display: flex;
  height: 100%;
  min-height: 600px;
  background: #f0f2f5;
  gap: 12px;
  padding: 12px;
  box-sizing: border-box;
}

/* ===== 左栏 ===== */
.vibe-chat {
  flex: 0 0 42%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
}
.chat-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}
.chat-sub {
  font-size: 12px;
  color: #86909c;
  margin-left: auto;
}

.chat-stream {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-empty {
  margin: auto;
  text-align: center;
  color: #86909c;
}
.empty-emoji {
  font-size: 36px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #4e5969;
  margin: 8px 0 4px;
}
.empty-tip {
  font-size: 12px;
  color: #a0a8b3;
  max-width: 280px;
  line-height: 1.6;
}

.msg-row {
  display: flex;
}
.is-user {
  justify-content: flex-end;
}
.is-ai {
  justify-content: flex-start;
}

.bubble {
  max-width: 84%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.is-user .bubble {
  background: #4080ff;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.is-ai .bubble {
  background: #f2f3f5;
  color: #1d2129;
  border-bottom-left-radius: 4px;
}
.ai-echo {
  background: #eef4ff !important;
  border: 1px solid #d6e4ff;
}
.ai-ask {
  background: #fff7e6 !important;
  border: 1px solid #ffe1a8;
}
.ai-error {
  background: #fff1f0 !important;
  border: 1px solid #ffccc7;
  color: #cf1322 !important;
}
.ai-info {
  color: #86909c;
  font-size: 13px;
  font-style: italic;
}
.bubble-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  color: #4080ff;
  margin-right: 6px;
}
.bubble-tag.ask {
  color: #d48806;
}
.bubble-tag.err {
  color: #cf1322;
}

/* 打字机光标（接收中的当前思路气泡末尾闪烁竖线） */
.type-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: #4080ff;
  animation: caret-blink 1s steps(1) infinite;
}
@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

/* ===== WF3 阶段步骤灯 ===== */
.stage-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: #f7f9fc;
  border: 1px solid #eef1f6;
  border-radius: 10px;
}
.stage-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}
.stage-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.stage-item.is-done .stage-icon {
  color: #22c55e;
  font-weight: 700;
}
.stage-spin {
  width: 12px;
  height: 12px;
  border: 2px solid #c9d6ee;
  border-top-color: #4080ff;
  border-radius: 50%;
  animation: stage-rotate 0.7s linear infinite;
}
@keyframes stage-rotate {
  to {
    transform: rotate(360deg);
  }
}
.stage-item.is-running .stage-label {
  color: #4080ff;
  font-weight: 600;
}
.stage-item.is-done .stage-label {
  color: #4e5969;
}
.stage-detail {
  color: #a0a8b3;
  font-size: 12px;
}

.chat-input {
  flex-shrink: 0;
  padding: 12px 14px;
  border-top: 1px solid #f0f0f0;
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.chat-input :deep(.el-textarea) {
  flex: 1;
}
.send-btn {
  height: 56px;
  padding: 0 22px;
}

/* ===== 右栏 ===== */
.vibe-canvas {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.canvas-head {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}
.canvas-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}
.canvas-link {
  margin-left: auto;
  font-size: 13px;
  color: #4080ff;
  text-decoration: none;
}
.canvas-link:hover {
  text-decoration: underline;
}

.canvas-empty {
  margin: auto;
  text-align: center;
  color: #86909c;
}

.canvas-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
.paper-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px dashed #e5e6eb;
}
.paper-title {
  font-size: 18px;
  font-weight: 700;
  color: #1d2129;
  margin: 0;
}
.paper-meta {
  font-size: 13px;
  color: #86909c;
}

.q-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.q-item {
  display: flex;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid #f5f5f5;
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
}
.q-no {
  flex-shrink: 0;
  font-weight: 700;
  color: #4080ff;
}
.q-stem {
  white-space: pre-wrap;
  word-break: break-word;
}

.outline-box {
  background: #fafbfc;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 16px 18px;
}
.outline-title {
  font-size: 13px;
  font-weight: 600;
  color: #4e5969;
  margin: 0 0 10px;
}
.outline-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.outline-item {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
  color: #1d2129;
}
.o-count {
  color: #4080ff;
  font-weight: 600;
}
</style>
