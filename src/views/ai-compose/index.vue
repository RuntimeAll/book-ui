<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { postChat } from '@/api/chat'
import type { ChatPaper, ChatResponse } from '@/api/chat'

// ---------------------------------------------------------------------------
// PRD-C-004 — 老师 vibe 聊天入口（双栏）
//
// 替换原 Dify chatbot 嵌入壳（Dify 已弃用）。贴北极星 vibe coding：
//   左栏 = 对话流：老师消息 + AI 回复（intentEcho 思路回显 / needAsk 反问）。
//   右栏 = 工作画布：渲染组卷结果（paper 标题 + outline / 题目列表），空态占位。
//
// 入口就一个聊天输入框 + 发送，无 Agent 选择器 / 技能卡片 / 下拉（全自动语言路由的形）。
// 单轮即走：不存对话历史（对话流仅本次内存态，刷新清空）。
//
// 接口：POST /ai/chat {message, teacherId} → vite proxy 同源转 :8092/chat。
//   组卷命中: {ok,route:'compose',intentEcho,paperId,outline,paper,paperUrl,notes}
//   非组卷  : {ok,needAsk:true,ask}
//   异常    : {ok:false,error}
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
type Msg =
  | { role: 'user'; text: string }
  | { role: 'ai'; kind: 'echo' | 'ask' | 'error' | 'info'; text: string }

const messages = ref<Msg[]>([])
const input = ref('')
const sending = ref(false)
const streamRef = ref<HTMLElement | null>(null)

// ---- 右栏：工作画布 --------------------------------------------------------
const paper = ref<ChatPaper | null>(null)
const outline = ref<Array<Record<string, unknown>>>([])
const paperUrl = ref<string>('')

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

function applyResult(res: ChatResponse) {
  // 兜底澄清：左栏渲染反问，不动右栏画布。
  if (res.needAsk) {
    messages.value.push({
      role: 'ai',
      kind: 'ask',
      text: res.ask || '我没太懂你的意思，能说得更具体些吗？',
    })
    return
  }

  // 异常：左栏报错（不崩页面）。
  if (!res.ok) {
    messages.value.push({
      role: 'ai',
      kind: 'error',
      text: res.error || '抱歉，处理时出了点问题，请稍后再试。',
    })
    return
  }

  // 组卷命中：左栏出思路回显，右栏出卷。
  if (res.intentEcho) {
    messages.value.push({ role: 'ai', kind: 'echo', text: res.intentEcho })
  }
  if (res.notes) {
    messages.value.push({ role: 'ai', kind: 'info', text: res.notes })
  }

  if (res.paper) paper.value = res.paper
  outline.value = Array.isArray(res.outline)
    ? (res.outline as Array<Record<string, unknown>>)
    : []
  paperUrl.value = res.paperUrl || ''

  if (!res.paper && outline.value.length === 0) {
    // 路由成组卷但既无 paper 又无 outline → 给个温和提示，别让右栏空着没解释。
    messages.value.push({
      role: 'ai',
      kind: 'info',
      text: '已识别为组卷意图，但这次没拿到卷子内容，可以换个说法再试一次。',
    })
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return

  messages.value.push({ role: 'user', text })
  input.value = ''
  sending.value = true
  scrollToBottom()

  // 思考中占位（拿到结果后移除）。
  messages.value.push({ role: 'ai', kind: 'info', text: '正在理解你的需求并组卷…' })
  const thinkingIdx = messages.value.length - 1
  scrollToBottom()

  try {
    const res = await postChat({ message: text, teacherId: teacherId.value })
    messages.value.splice(thinkingIdx, 1) // 去掉思考占位
    applyResult(res)
  } catch (e) {
    messages.value.splice(thinkingIdx, 1)
    console.error('[vibe-chat] /chat 调用失败:', e)
    messages.value.push({
      role: 'ai',
      kind: 'error',
      text: '网络或服务异常，未能完成本次请求，请确认 AI 服务已启动后重试。',
    })
  } finally {
    sending.value = false
    scrollToBottom()
  }
}
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
