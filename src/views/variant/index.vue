<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import {
  fetchVariantArtifact,
  fetchVariantHistory,
  persistVariantGroup,
  streamVariant,
  uploadMotherImage,
} from '@/api/variant'
import type {
  ToolkitChatMessage,
  VariantArtifact,
  VariantStage,
  VariantStreamHandle,
} from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'
import AiStageRail from '@/components/AiStageRail.vue'
import ArtifactPanel from './ArtifactPanel.vue'

// 登录老师身份：入库 owner 走透传 token（agent_config.ruoyi_token），落老师本人个人题库。
const userStore = useUserStore()

// ---------------------------------------------------------------------------
// PRD-C-009/C-011 — 图片举一反三 agent（toolkit :8093 variant agent，/agent proxy）。
//
// PRD-C-011 Bucket3 双栏形态（DESIGN.md §14）：
//   左栏 = 「AI 命题搭子」聊天面板（气泡 markdown+LaTeX 叙述保留 + 思路条 + 输入）。
//   右栏 = 「变式题组 · N 道」卡片栅，数据源 = BE artifact 快照帧（铁律 2：FE 不
//          parse markdown 拼卡片），snapshot 全量整量替换。
//   🔴 统一指令通道（铁律 1）：卡片快捷键（换数字/换场景/答疑）与「全部入库」全部 =
//      utterance 预设句，走【现有 chat SSE 通道】（同 thread_id），零新增结构化端点。
//
// 思路条位置（用户反馈①）：消息流改为联合类型（气泡 | rail 锚点）。send 时 push 用户
// 气泡后立即 push 本轮 rail 锚点，onStage 只更新当前轮锚点 → 思路条钉在本轮头部
//（用户问下方、本轮 AI 产出上方），历史轮 rail 留存，不再永远沉底。
//
// 母题图入口（用户反馈②）：剪贴板 Ctrl+V 粘贴截图即传（页面级 paste 监听，复用
// uploadMotherImage + 同口径类型/10MB 校验）；「上传图片」按钮已删；URL 输入框保留。
//
// 渲染策略：agent 人话叙述仍走 AIMessage 文本块成左栏气泡（铁律 5 保留）；LLM 逐字
// token 期只显「思考中」动效，不外放原始 token（思考型模型 reasoning 不外放，有意为之）。
// ---------------------------------------------------------------------------

interface Bubble {
  type: 'bubble'
  role: 'user' | 'ai'
  kind?: 'normal' | 'error'
  text: string
}

/** 本轮思路条锚点（钉在该轮用户气泡之后、AI 产出之前；历史轮留存） */
interface RailItem {
  type: 'rail'
  stages: VariantStage[]
}

type StreamItem = Bubble | RailItem

const stream = ref<StreamItem[]>([])
const input = ref('')
const imageUrl = ref('') // 顶部待发送的 OSS 图 URL（首轮随消息带出，发后清空）
const motherImg = ref('') // 已发出的母题图，顶部缩略图常驻
const sending = ref(false)
const thinking = ref(false) // LLM token 流期的「思考中」动效
// 当前轮 rail 锚点（onStage 只更新它；新一轮 send 换新锚点，旧轮 rail 冻结留存）
const currentRail = ref<RailItem | null>(null)
// PRD-C-011：右栏卡片栅数据源 = artifact 快照帧（snapshot 全量，整量替换）
const artifact = ref<VariantArtifact | null>(null)
const streamRef = ref<HTMLElement | null>(null)

const currentRailEmpty = computed(
  () => !currentRail.value || currentRail.value.stages.length === 0
)

// ---------------------------------------------------------------------------
// 母题图：剪贴板粘贴上传（BE /teacher/variant/upload-image → 公读 OSS URL）
// ---------------------------------------------------------------------------
const uploading = ref(false)

const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

async function uploadPastedImage(file: File) {
  // 客户端先挡一道（BE 同口径再硬校验）；截图粘贴通常是 image/png
  if (!UPLOAD_TYPES.includes(file.type)) {
    ElMessage.error('仅支持 jpg / png / webp / gif 图片')
    return
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    ElMessage.error('图片不能超过 10MB')
    return
  }
  if (uploading.value) return
  uploading.value = true
  try {
    const { url } = await uploadMotherImage(file)
    imageUrl.value = url
    ElMessage.success('截图已上传，图链已填入，回车即可出题')
  } catch {
    // 失败 toast 由 http 拦截器统一弹，这里只收 loading
  } finally {
    uploading.value = false
  }
}

/** 页面级 paste 监听：输入框 / 页面任意处 Ctrl+V 截图均可触发 */
function onPaste(e: ClipboardEvent) {
  if (sending.value) return
  const items = e.clipboardData?.items
  if (!items) return
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) {
        e.preventDefault()
        void uploadPastedImage(file)
      }
      return
    }
  }
}

onMounted(() => document.addEventListener('paste', onPaste))

// ---------------------------------------------------------------------------
// 会话注册表（用户反馈③④ 2026-06-11）：BE checkpointer（sqlite）一直按 thread_id
// 持久着全部对话 —— 缺的只是 FE 这边「记住 thread_id + 取回」。注册表落 localStorage
//（id/标题/时间/母题图），刷新恢复上次会话；历史会话可切换/删除（删的只是本地索引，
// BE checkpoint 不动）。气泡回放走 /history，右栏卡片重建走 /variant/artifact。
// ---------------------------------------------------------------------------

interface SessionMeta {
  id: string
  title: string
  at: number // 最近活跃时间戳
  img?: string // 母题图（列表缩略 + 恢复时回填顶部）
}

const SESSIONS_KEY = 'variant.sessions.v1'
const ACTIVE_KEY = 'variant.active.v1'
const SESSIONS_MAX = 50

function loadSessions(): SessionMeta[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is SessionMeta =>
        !!s && typeof (s as SessionMeta).id === 'string' && typeof (s as SessionMeta).title === 'string'
    )
  } catch {
    return []
  }
}

const sessions = ref<SessionMeta[]>(loadSessions())
const restoring = ref(false)

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.value.slice(0, SESSIONS_MAX)))
  } catch {
    /* 配额满等异常不影响主流程 */
  }
}

/** 本会话首条消息时登记 / 后续消息只刷活跃时间，并置顶 */
function touchSession(firstShownText?: string) {
  const idx = sessions.value.findIndex((s) => s.id === threadId.value)
  if (idx >= 0) {
    const s = sessions.value[idx]
    s.at = Date.now()
    if (motherImg.value && !s.img) s.img = motherImg.value
    sessions.value.splice(idx, 1)
    sessions.value.unshift(s)
  } else {
    const title =
      (firstShownText || '')
        .replace(/https?:\/\/[^\s)>'"]+/g, '')
        .replace(/🖼|🔁/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24) || '图片举一反三'
    sessions.value.unshift({ id: threadId.value, title, at: Date.now(), img: motherImg.value || undefined })
  }
  saveSessions()
  try {
    localStorage.setItem(ACTIVE_KEY, threadId.value)
  } catch {
    /* 同上 */
  }
}

// ---------------------------------------------------------------------------
// 会话 / 发送
// ---------------------------------------------------------------------------

// 会话级 thread_id：同会话所有 send 复用 → agent 记住当前题组。
// 刷新不再换新 —— onMounted 恢复上次活跃会话（用户反馈③）。ref 是为了
// 会话列表里 is-active 高亮能跟着切换走（模板里要响应式）。
const threadId = ref<string>(crypto.randomUUID())
let handle: VariantStreamHandle | null = null
// 「换一批」= 重发初始出题 utterance（PRD 开放问题方案 b：不动 agent 路由）
let firstComposeMessage: string | null = null
// 打字机气泡（用户反馈① 思维外放）：BE 只对人话型 LLM 输出（答疑等）放行 token
//（JSON 中间产物打 skip_stream 在服务端就被滤掉），所以这里收到的 token 可直接外放。
let typingBubble: Bubble | null = null

async function scrollToBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 思路条终态收口：流中途出错/异常断流时，把【当前轮】还在 running 的条目就地改成 warn
 *（标「已中断」）。历史轮 rail 已冻结不受影响；幂等，可重复调用。
 */
function settleStages() {
  const rail = currentRail.value
  if (!rail) return
  rail.stages = rail.stages.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'warn' as const, detail: s.detail ? `${s.detail}·已中断` : '已中断' }
      : s
  )
}

/**
 * 🔴 统一发送管道：输入框手打 / 卡片快捷键 / 全部入库 / 换一批最终都走这里
 *（同 thread_id 同 chat SSE 通道，agent 既有受约束分类器路由）。
 */
function dispatch(message: string, shownText?: string) {
  if (sending.value) return
  handle?.abort()

  stream.value.push({ type: 'bubble', role: 'user', text: shownText ?? message })
  // 本轮思路条锚点：紧跟用户气泡 push，后续 AI 气泡追加在它下方 → rail 钉在本轮头部
  const rail = reactive<RailItem>({ type: 'rail', stages: [] })
  stream.value.push(rail)
  currentRail.value = rail
  touchSession(shownText ?? message) // 会话注册表：首条登记 / 后续刷活跃置顶

  sending.value = true
  thinking.value = true
  typingBubble = null
  scrollToBottom()

  handle = streamVariant(
    { message, thread_id: threadId.value, ruoyiToken: userStore.accessToken },
    {
      onToken: (delta) => {
        // 思维外放（用户反馈①）：BE 已在服务端滤掉 JSON 中间产物的 token
        //（skip_stream），到这里的都是人话（答疑/解释），打字机逐字渲染。
        thinking.value = false
        if (!typingBubble) {
          typingBubble = reactive<Bubble>({ type: 'bubble', role: 'ai', kind: 'normal', text: '' })
          stream.value.push(typingBubble)
        }
        typingBubble.text += delta
        scrollToBottom()
      },
      onStage: (stage: VariantStage) => {
        // 思路条：同 key 原地更新 status/detail，新 key 追加（保 BE 发出的阶段顺序）
        const idx = rail.stages.findIndex((s) => s.key === stage.key)
        if (idx >= 0) rail.stages[idx] = stage
        else rail.stages.push(stage)
        scrollToBottom()
      },
      onArtifact: (a: VariantArtifact) => {
        // 快照全量语义：整帧替换（assemble 每轮收尾 + persist 成功后各发一帧）。
        // PRD-C-012 P2：增量帧（partial=true，items=已完成题全量快照）同样整量替换 ——
        // partial / expectedTotal 随帧存进同一响应式 artifact，ArtifactPanel 据此渲染
        // 「生成中」占位骨架卡；定稿帧无 partial 键 → 占位卡自然消失。
        artifact.value = a
      },
      onMessage: (msg: ToolkitChatMessage) => {
        thinking.value = false
        // 整块消息是该 LLM 输出的终稿 → 替换打字机半成品气泡（避免同文重复两个气泡）
        if (typingBubble) {
          const i = stream.value.indexOf(typingBubble)
          if (i >= 0) stream.value.splice(i, 1)
          typingBubble = null
        }
        stream.value.push({
          type: 'bubble',
          role: 'ai',
          kind: 'normal',
          text: String(msg.content || ''),
        })
        scrollToBottom()
        // 下一节点若继续跑会再来 token → 重新进思考态
        thinking.value = true
      },
      onServerError: (m) => {
        thinking.value = false
        settleStages() // 思路条与错误气泡一致收口（running → warn·已中断）
        stream.value.push({ type: 'bubble', role: 'ai', kind: 'error', text: m })
        scrollToBottom()
      },
      onError: (err) => {
        console.error('[variant] 流异常:', err)
        thinking.value = false
        sending.value = false
        settleStages()
        stream.value.push({
          type: 'bubble',
          role: 'ai',
          kind: 'error',
          text: '网络或 AI 服务异常，未能完成本次请求。请确认举一反三服务（toolkit :8093）已启动后重试。',
        })
        scrollToBottom()
      },
      onClose: () => {
        sending.value = false
        thinking.value = false
        typingBubble = null // 半成品打字气泡留在原地（极少见：流断在 token 中途）
        settleStages() // 正常完成时无 running 条目 = no-op；异常断流时兜底收口
        scrollToBottom()
      },
    }
  )
}

/** 输入框发送（首轮把 OSS URL 拼进文本，agent 端从 human 文本抠 URL） */
function send() {
  const text = input.value.trim()
  const url = imageUrl.value.trim()
  // 首轮必须有图；后续轮纯指令即可（text 非空）
  if (!url && !text) return
  if (sending.value) return

  const parts: string[] = []
  if (url) parts.push(url)
  if (text) parts.push(text)
  const message = parts.join('\n')

  // 顶部缩略图常驻；输入框 URL 发后清空，避免后续编辑轮重复触发分析
  if (url) {
    motherImg.value = url
    imageUrl.value = ''
    firstComposeMessage = message // 「换一批」重发这条初始出题 utterance
  }

  const shown = url ? (text ? `🖼 母题图\n${text}` : '🖼 母题图（开始举一反三）') : text
  input.value = ''
  dispatch(message, shown)
}

/** 卡片快捷键（换数字/换场景/答疑，需要 LLM）：预设句走 chat 通道，用户气泡照常显示（铁律 1） */
function sendUtterance(text: string) {
  if (sending.value) return
  dispatch(text)
}

/**
 * 全部入库（2026-06-11 用户拍板）：确定性动作直连 BE /variant/persist，不绕 LLM
 * 分类器（省一次 LLM + 零误判）。回执作为 AI 气泡进对话（BE 已同步写回 checkpointer
 * 历史，刷新恢复也能看到），artifact 整量替换刷新「已收录」徽章。
 */
async function persistAll() {
  if (sending.value) return
  stream.value.push({ type: 'bubble', role: 'user', text: '📥 全部入库' })
  touchSession('全部入库')
  sending.value = true
  scrollToBottom()
  try {
    const res = await persistVariantGroup(threadId.value, userStore.accessToken)
    if (res.reply) stream.value.push({ type: 'bubble', role: 'ai', kind: 'normal', text: res.reply })
    if (res.artifact) artifact.value = res.artifact
  } catch (e) {
    stream.value.push({
      type: 'bubble',
      role: 'ai',
      kind: 'error',
      text: `入库失败：${e instanceof Error ? e.message : String(e)}`,
    })
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

/** 换一批：重发初始出题 utterance（整组重新出，agent 重新分析母题） */
function regenerate() {
  if (sending.value || !firstComposeMessage) return
  // PRD-C-011 line 102 方案 b =「清空当前卡 + 重发初始出题 utterance」：先清画布，
  // 骨架卡接管重出期（约数十秒），避免老师把滞留的旧卡当成结果抄题
  artifact.value = null
  dispatch(firstComposeMessage, '🔁 换一批（按原母题重新出一组）')
}

/** 清空画布到「空会话」视觉态（新建 / 切换会话共用） */
function clearCanvas() {
  handle?.abort()
  stream.value = []
  currentRail.value = null
  artifact.value = null
  motherImg.value = ''
  imageUrl.value = ''
  input.value = ''
  sending.value = false
  thinking.value = false
  typingBubble = null
  firstComposeMessage = null
}

/** 新会话（原「新母题」）：换新 thread；首条消息发出时才登记进会话列表 */
function resetSession() {
  clearCanvas()
  threadId.value = crypto.randomUUID()
  try {
    localStorage.setItem(ACTIVE_KEY, '')
  } catch {
    /* noop */
  }
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s)>'"]+/

/** 恢复 / 切换到历史会话：/history 回放气泡 + /variant/artifact 重建右栏卡片 */
async function restoreSession(id: string) {
  clearCanvas()
  threadId.value = id
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* noop */
  }
  restoring.value = true
  try {
    const [msgs, art] = await Promise.all([
      fetchVariantHistory(id),
      fetchVariantArtifact(id).catch(() => null),
    ])
    for (const m of msgs) {
      const text = String(m.content || '').trim()
      if (!text) continue
      if (m.type === 'human') {
        const um = text.match(URL_IN_TEXT_RE)
        if (um) {
          // 第一条带图 URL 的 human = 母题轮：回填顶部缩略图 +「换一批」基准
          if (!motherImg.value) motherImg.value = um[0]
          firstComposeMessage = firstComposeMessage ?? text
        }
        stream.value.push({
          type: 'bubble',
          role: 'user',
          text: text.replace(URL_IN_TEXT_RE, '🖼 母题图').trim(),
        })
      } else if (m.type === 'ai') {
        stream.value.push({ type: 'bubble', role: 'ai', kind: 'normal', text })
      }
      // tool/custom 帧不回放（stage 思路条是过程态，历史会话无需重演）
    }
    if (art) artifact.value = art
    const meta = sessions.value.find((s) => s.id === id)
    if (meta?.img && !motherImg.value) motherImg.value = meta.img
  } catch (e) {
    console.warn('[variant] 历史会话恢复失败:', e)
    ElMessage.warning('历史会话拉取失败（举一反三服务 :8093 未启动？），已开新会话')
    threadId.value = crypto.randomUUID()
  } finally {
    restoring.value = false
  }
  scrollToBottom()
}

/** 删除会话（只删本地索引，BE checkpoint 不动）；删的是当前会话则顺手开新会话 */
function deleteSession(id: string) {
  sessions.value = sessions.value.filter((s) => s.id !== id)
  saveSessions()
  if (id === threadId.value) resetSession()
}

function sessionTime(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 刷新恢复上次活跃会话（用户反馈③：聊天记录持久化的 FE 半边）
onMounted(() => {
  const active = (() => {
    try {
      return localStorage.getItem(ACTIVE_KEY) || ''
    } catch {
      return ''
    }
  })()
  if (active && sessions.value.some((s) => s.id === active)) {
    void restoreSession(active)
  }
})

onBeforeUnmount(() => {
  handle?.abort()
  document.removeEventListener('paste', onPaste)
})
</script>

<template>
  <div class="variant-page">
    <!-- 左栏：AI 命题搭子（对话 + 思路条 + 输入） -->
    <section class="variant-chat" data-testid="variant-chat-panel">
      <header class="chat-head">
        <span class="head-spark">✦</span>
        <span class="chat-title">AI 命题搭子</span>
        <span class="chat-sub">举一反三 · 图片变式</span>
        <!-- 会话管理（用户反馈④）：历史会话列表（切换/删除）+ 新会话 -->
        <el-popover placement="bottom-end" :width="300" trigger="click">
          <template #reference>
            <el-button text size="small" class="sessions-btn" :disabled="sending">
              历史会话<span v-if="sessions.length"> · {{ sessions.length }}</span>
            </el-button>
          </template>
          <div class="session-list">
            <p v-if="sessions.length === 0" class="session-empty">
              还没有历史会话，发出第一条消息后会自动记录
            </p>
            <div
              v-for="s in sessions"
              :key="s.id"
              class="session-item"
              :class="{ 'is-active': s.id === threadId }"
              @click="s.id !== threadId && !sending && restoreSession(s.id)"
            >
              <img v-if="s.img" :src="s.img" class="session-thumb" referrerpolicy="no-referrer" />
              <span v-else class="session-thumb session-thumb-empty">🧮</span>
              <span class="session-title">{{ s.title }}</span>
              <span class="session-time">{{ sessionTime(s.at) }}</span>
              <el-button
                text
                size="small"
                class="session-del"
                :disabled="sending"
                @click.stop="deleteSession(s.id)"
              >
                ✕
              </el-button>
            </div>
          </div>
        </el-popover>
        <el-button text size="small" class="reset-btn" :disabled="sending" @click="resetSession">
          ＋新会话
        </el-button>
      </header>

      <!-- 顶部：母题图入口（Ctrl+V 粘贴截图 / 贴 URL） -->
      <div class="mother-bar">
        <div v-if="motherImg" class="mother-thumb">
          <img :src="motherImg" alt="母题图" referrerpolicy="no-referrer" />
          <span class="thumb-tag">母题</span>
        </div>
        <div class="mother-input">
          <el-input
            v-model="imageUrl"
            size="default"
            placeholder="可直接 Ctrl+V 粘贴截图，或贴 OSS / 公网图片地址（http…），首轮必填"
            :disabled="sending || uploading"
            clearable
          >
            <template #prepend>🖼 母题图</template>
          </el-input>
          <p v-if="uploading" class="uploading-hint">截图上传中…</p>
          <p class="default-hint">
            默认配方：守考点 + 年级 + 难度，换数字 / 情境，出 3 道（2 普通 1 难）。
            出题后可直接点右侧卡片上的「换数字 / 换场景 / 答疑」，或在这里说
            「删第2」「难一点」「补2道同第3」，最后说「可以了」入库。
          </p>
        </div>
      </div>

      <div ref="streamRef" class="chat-stream">
        <div v-if="restoring" class="chat-empty">
          <div class="empty-emoji">⏳</div>
          <p class="empty-title">正在恢复上次会话…</p>
        </div>
        <div v-else-if="stream.length === 0" class="chat-empty">
          <div class="empty-emoji">🧮</div>
          <p class="empty-title">贴一张题目图，开始举一反三</p>
          <p class="empty-tip">
            AI 会先分析这道母题的年级 / 考点 / 题型，再出 3 道考点一致、只换数字情境的变式题。
            题组会以卡片形式出现在右侧画布，左侧保留 AI 的分析与解释。
          </p>
        </div>

        <template v-for="(item, i) in stream" :key="i">
          <!-- 气泡（用户 / AI 叙述 / 错误） -->
          <div
            v-if="item.type === 'bubble'"
            class="msg-row"
            :class="item.role === 'user' ? 'is-user' : 'is-ai'"
          >
            <div class="bubble" :class="item.role === 'ai' ? `ai-${item.kind}` : ''">
              <!-- AI 气泡走富文本（markdown + LaTeX）；用户气泡纯文本 -->
              <MarkdownMath
                v-if="item.role === 'ai' && item.kind !== 'error'"
                :content="item.text"
              />
              <span v-else class="bubble-text">{{ item.text }}</span>
            </div>
          </div>

          <!-- 本轮思路条锚点（钉在该轮用户气泡之后、AI 产出之前；历史轮留存） -->
          <div v-else-if="item.stages.length > 0" class="msg-row is-ai">
            <AiStageRail class="stage-rail-wrap" :stages="item.stages" />
          </div>
        </template>

        <!-- 思考中动效（token 流期）：仅作本轮首条 stage 到来前的兜底 -->
        <div v-if="thinking && currentRailEmpty" class="msg-row is-ai">
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

    <!-- 右栏：变式题组画布（artifact 快照帧驱动；动作全部冒泡回左栏 chat 通道） -->
    <ArtifactPanel
      class="variant-artifact"
      :artifact="artifact"
      :sending="sending"
      :can-regenerate="!!firstComposeMessage || !!motherImg"
      @utterance="sendUtterance"
      @regenerate="regenerate"
      @persist="persistAll"
    />
  </div>
</template>

<style scoped>
/* DESIGN token：bg-50 #F5F8F8 / card #FFF / border #E3E9E9 / ink-900 #1D2A2E
   violet-600 #7B6CF0（AI 在场）/ teal-600 #1E8A8A（老师拍板） */
.variant-page {
  display: flex;
  gap: 12px;
  height: 100%;
  min-height: 600px;
  background: #f5f8f8; /* bg-50 */
  padding: 12px;
  box-sizing: border-box;
}

/* 左栏 ~420px（min 360 不塌），右栏自适应（min-width:0 防内容撑破） */
.variant-chat {
  flex: 0 1 420px;
  min-width: 360px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #e3e9e9;
  border-radius: 12px;
  overflow: hidden;
}
.variant-artifact {
  flex: 1;
  min-width: 0;
  border: 1px solid #e3e9e9;
}

/* 小屏（<1024px）上下堆叠，各自内部滚动 */
@media (max-width: 1024px) {
  .variant-page {
    flex-direction: column;
    height: auto;
  }
  .variant-chat {
    flex: none;
    min-width: 0;
    height: 70vh;
  }
  .variant-artifact {
    flex: none;
    height: 60vh;
  }
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #e3e9e9;
  flex-shrink: 0;
}
.head-spark {
  color: #7b6cf0; /* violet-600：AI 在场 */
  font-size: 15px;
}
.chat-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2a2e; /* ink-900 */
}
.chat-sub {
  font-size: 12px;
  color: #86909c;
}
.sessions-btn {
  margin-left: auto;
}
.reset-btn {
  margin-left: 0;
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
  min-width: 0;
}
.uploading-hint {
  margin: 6px 2px 0;
  font-size: 12px;
  color: #7b6cf0;
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

/* 思路条在消息流里的占宽（视觉本体在 AiStageRail 组件内） */
.stage-rail-wrap {
  max-width: 86%;
  min-width: 300px;
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
  background: #7b6cf0; /* violet-600：AI 在场 */
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
  border-top: 1px solid #e3e9e9;
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

/* 会话列表（popover 内容由本组件模板渲染，scoped 样式可达） */
.session-list {
  max-height: 320px;
  overflow-y: auto;
}
.session-empty {
  font-size: 12px;
  color: #a0a8b3;
  text-align: center;
  padding: 12px 0;
  margin: 0;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.session-item:hover {
  background: #f5f8f8;
}
.session-item.is-active {
  background: #f1eeff; /* violet 浅底：当前会话 */
  cursor: default;
}
.session-thumb {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid #e5e6eb;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.session-thumb-empty {
  background: #f2f3f5;
}
.session-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #1d2a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-time {
  font-size: 11px;
  color: #a0a8b3;
  flex-shrink: 0;
}
.session-del {
  padding: 2px 4px;
  color: #c0c6cf;
}
.session-del:hover {
  color: #cf1322;
}
</style>
