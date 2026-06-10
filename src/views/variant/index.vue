<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useUserStore } from '@/store/user'
import { streamVariant } from '@/api/variant'
import type { ToolkitChatMessage, VariantStreamHandle } from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'

// 登录老师身份：入库 owner 走透传 token（agent_config.ruoyi_token），落老师本人个人题库。
const userStore = useUserStore()

// ---------------------------------------------------------------------------
// PRD-C-009 — 图片举一反三 agent 入口（接 toolkit :8080 variant agent，走 /agent proxy）。
//
// 老师拍一张题目图 → 传 OSS 拿公网 URL → 贴进来 → agent 分析(年级/学科/考点) → 出代表性变式
// （默认 3 = 2 普通 + 1 难）→ 每道带解析 + ✓/⚠ 质量信号 → 老师说「可以了」入个人题库。
//
// 形态 = 有状态对话：agent 端着「当前题组」，老师每句话 = 一条编辑指令（删/改/补/换难度/答疑）。
// 多轮记忆靠 thread_id（同会话复用，刷新或「新母题」换新 thread）。
//
// 渲染策略：agent 全部用 AIMessage 文本块沟通（DNA 外显 / 题组带 ✓⚠ / 反问 / 入库回执都在
// message.content 文本里），逐块成气泡渲染；LLM 逐字 token 期只显「思考中」动效，不外放原始
// token（含 reasoning/JSON，噪声大），结果以 agent 自己 curate 的文本块为准。
// ---------------------------------------------------------------------------

interface Bubble {
  role: 'user' | 'ai'
  kind?: 'normal' | 'error'
  text: string
}

const messages = ref<Bubble[]>([])
const input = ref('')
const imageUrl = ref('') // 顶部待发送的 OSS 图 URL（首轮随消息带出，发后清空）
const motherImg = ref('') // 已发出的母题图，顶部缩略图常驻
const sending = ref(false)
const thinking = ref(false) // LLM token 流期的「思考中」动效
const streamRef = ref<HTMLElement | null>(null)

// 会话级 thread_id：同会话所有 send 复用 → agent 记住当前题组。新母题 / 刷新换新。
let threadId = crypto.randomUUID()
let handle: VariantStreamHandle | null = null

async function scrollToBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function send() {
  const text = input.value.trim()
  const url = imageUrl.value.trim()
  // 首轮必须有图；后续轮纯指令即可（text 非空）
  if (!url && !text) return
  if (sending.value) return

  handle?.abort()

  // 组消息：首轮把 OSS URL 拼进文本（agent 端从 human 文本抠 URL）
  const parts: string[] = []
  if (url) parts.push(url)
  if (text) parts.push(text)
  const message = parts.join('\n')

  // 顶部缩略图常驻；输入框 URL 发后清空，避免后续编辑轮重复触发分析
  if (url) {
    motherImg.value = url
    imageUrl.value = ''
  }

  // 展示用户气泡（带图首轮显示「[母题图] + 文字」）
  const shown = url ? (text ? `🖼 母题图\n${text}` : '🖼 母题图（开始举一反三）') : text
  messages.value.push({ role: 'user', text: shown })
  input.value = ''
  sending.value = true
  thinking.value = true
  scrollToBottom()

  handle = streamVariant(
    { message, thread_id: threadId, ruoyiToken: userStore.accessToken },
    {
      onToken: () => {
        // 只作「活着/思考中」信号，不外放原始 token
        if (!thinking.value) thinking.value = true
      },
      onMessage: (msg: ToolkitChatMessage) => {
        thinking.value = false
        messages.value.push({ role: 'ai', kind: 'normal', text: String(msg.content || '') })
        scrollToBottom()
        // 下一节点若继续跑会再来 token → 重新进思考态
        thinking.value = true
      },
      onServerError: (m) => {
        thinking.value = false
        messages.value.push({ role: 'ai', kind: 'error', text: m })
        scrollToBottom()
      },
      onError: (err) => {
        console.error('[variant] 流异常:', err)
        thinking.value = false
        sending.value = false
        messages.value.push({
          role: 'ai',
          kind: 'error',
          text: '网络或 AI 服务异常，未能完成本次请求。请确认举一反三服务（toolkit :8080）已启动后重试。',
        })
        scrollToBottom()
      },
      onClose: () => {
        sending.value = false
        thinking.value = false
        scrollToBottom()
      },
    }
  )
}

/** 新母题：换新 thread + 清空对话（当前题组丢弃） */
function resetSession() {
  handle?.abort()
  threadId = crypto.randomUUID()
  messages.value = []
  motherImg.value = ''
  imageUrl.value = ''
  input.value = ''
  sending.value = false
  thinking.value = false
}

onBeforeUnmount(() => handle?.abort())
</script>

<template>
  <div class="variant-page">
    <section class="variant-chat">
      <header class="chat-head">
        <span class="dot" />
        <span class="chat-title">举一反三 · 图片变式</span>
        <span class="chat-sub">拍题 → 贴 OSS 图链 → 自动出代表性变式（默认 2 普通 + 1 难）</span>
        <el-button text size="small" class="reset-btn" :disabled="sending" @click="resetSession">
          新母题
        </el-button>
      </header>

      <!-- 顶部：母题图入口 + 外显默认 -->
      <div class="mother-bar">
        <div v-if="motherImg" class="mother-thumb">
          <img :src="motherImg" alt="母题图" referrerpolicy="no-referrer" />
          <span class="thumb-tag">母题</span>
        </div>
        <div class="mother-input">
          <el-input
            v-model="imageUrl"
            size="default"
            placeholder="粘贴题目图的 OSS / 公网图片地址（http…），首轮必填"
            :disabled="sending"
            clearable
          >
            <template #prepend>🖼 母题图</template>
          </el-input>
          <p class="default-hint">
            默认配方：守考点 + 年级 + 难度，换数字 / 情境，出 3 道（2 普通 1 难）。
            你也可以说「换场景」「转题型」「难一点」「补2道同第3」「为什么第2题选B」，最后说「可以了」入库。
          </p>
        </div>
      </div>

      <div ref="streamRef" class="chat-stream">
        <div v-if="messages.length === 0" class="chat-empty">
          <div class="empty-emoji">🧮</div>
          <p class="empty-title">贴一张题目图，开始举一反三</p>
          <p class="empty-tip">
            AI 会先分析这道母题的年级 / 考点 / 题型，再出 3 道考点一致、只换数字情境的变式题，
            每道附解析与质量信号。你随时可以删 / 改 / 补 / 调难度 / 答疑。
          </p>
        </div>

        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg-row"
          :class="m.role === 'user' ? 'is-user' : 'is-ai'"
        >
          <div class="bubble" :class="m.role === 'ai' ? `ai-${m.kind}` : ''">
            <!-- AI 气泡走富文本（markdown + LaTeX）；用户气泡纯文本 -->
            <MarkdownMath v-if="m.role === 'ai' && m.kind !== 'error'" :content="m.text" />
            <span v-else class="bubble-text">{{ m.text }}</span>
          </div>
        </div>

        <!-- 思考中动效（token 流期） -->
        <div v-if="thinking" class="msg-row is-ai">
          <div class="bubble ai-normal thinking">
            <span class="dot-pulse" /><span class="dot-pulse" /><span class="dot-pulse" />
            <span class="thinking-text">AI 正在分析 / 出题…（出 3 道含解析，稍候）</span>
          </div>
        </div>
      </div>

      <footer class="chat-input">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="贴好图后回车「出3道」，或直接说编辑指令（删第2 / 难一点 / 补2道 / 可以了）…"
          :disabled="sending"
          @keyup.enter.exact.prevent="send"
        />
        <el-button
          type="primary"
          class="send-btn"
          :loading="sending"
          :disabled="!input.trim() && !imageUrl.trim()"
          @click="send"
        >
          发送
        </el-button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.variant-page {
  display: flex;
  height: 100%;
  min-height: 600px;
  background: #f0f2f5;
  padding: 12px;
  box-sizing: border-box;
}

.variant-chat {
  flex: 1;
  max-width: 880px;
  margin: 0 auto;
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
}
.reset-btn {
  margin-left: auto;
}

/* 母题图入口 */
.mother-bar {
  display: flex;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid #f5f5f5;
  background: #fafbfc;
  flex-shrink: 0;
}
.mother-thumb {
  position: relative;
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #e5e6eb;
}
.mother-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-tag {
  position: absolute;
  left: 0;
  bottom: 0;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  padding: 1px 6px;
}
.mother-input {
  flex: 1;
}
.default-hint {
  margin: 8px 2px 0;
  font-size: 12px;
  line-height: 1.6;
  color: #86909c;
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
  max-width: 420px;
  line-height: 1.7;
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
  max-width: 86%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.is-user .bubble {
  background: #4080ff;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.ai-normal {
  background: #f2f3f5;
  color: #1d2129;
  border-bottom-left-radius: 4px;
}
.ai-error {
  background: #fff1f0;
  border: 1px solid #ffccc7;
  color: #cf1322;
  border-bottom-left-radius: 4px;
}

/* 思考中动效 */
.thinking {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4080ff;
  animation: dot-pulse 1.2s infinite ease-in-out;
}
.dot-pulse:nth-child(2) {
  animation-delay: 0.2s;
}
.dot-pulse:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes dot-pulse {
  0%,
  80%,
  100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}
.thinking-text {
  font-size: 12px;
  color: #86909c;
  margin-left: 4px;
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
</style>
