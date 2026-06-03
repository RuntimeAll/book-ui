<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ---------------------------------------------------------------------------
// AI 组卷（C 线 Dify WF3 工作流嵌入页）
//
// 把 Dify chatbot 以 iframe 嵌进来，并把【当前登录老师 id】自动注入给 Dify
// start 节点的 `teacher_id` 输入；WF3 末尾带 save=true+teacherId 调
// /teacher/paper/auto-generate，生成的卷直接落进该老师的「我的卷库」，对话里回一个
// 卷详情深链可一键打开。老师无感、无需手填。
//
// 🔴 注入机制（实测，2026-06-03）：这版 Dify 的分享 chatbot **不读明文 URL 参数**，
//    它要求 input 值经 Dify 官方约定的 `gzip + base64` 压缩编码（与 embed.min.js 的
//    compressAndEncodeBase64 一致），再以 query 形式带上：
//      chatbot/<token>?teacher_id=<base64(gzip(value))>
//    浏览器原生 CompressionStream("gzip") 即可生成，无需引第三方库。
//    明文 ?teacher_id=5 / ?inputs={...} 都不会预填（已验证）。
//
// 🔴 DIFY_CHATBOT_BASE 是 Dify 分享/嵌入地址，导入新版 yml 后 chatbot id 会变，
//    换成新地址即可（只需改这一行）。
// ---------------------------------------------------------------------------
const DIFY_CHATBOT_BASE = 'http://localhost/chatbot/XwecfzvWCWUHuGCL'

const userStore = useUserStore()
const teacherId = computed(() => userStore.userInfo?.id ?? null)

// Dify embed 约定：input 值 = btoa(gzip(utf8(value)))，与 embed.min.js 完全一致。
async function compressAndEncodeBase64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  const buf = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary)
}

const iframeSrc = ref('')

async function buildIframeSrc(id: string | number) {
  const sep = DIFY_CHATBOT_BASE.includes('?') ? '&' : '?'
  try {
    const enc = await compressAndEncodeBase64(String(id))
    iframeSrc.value = `${DIFY_CHATBOT_BASE}${sep}teacher_id=${encodeURIComponent(enc)}`
  } catch (e) {
    // CompressionStream 不可用等极端情况：退回明文（不会预填，但不至于白屏，老师可手填）。
    console.warn('[ai-compose] teacher_id 压缩编码失败，退回明文:', e)
    iframeSrc.value = `${DIFY_CHATBOT_BASE}${sep}teacher_id=${encodeURIComponent(String(id))}`
  }
}

// teacherId 就绪（含 onMounted 兜底拉到）后，异步编码并构造 iframe src。
watch(teacherId, (id) => {
  if (id != null) buildIframeSrc(id)
}, { immediate: true })

// 内存态 userInfo 刷新会丢（[[feedback_fe_user_info_onmount_fallback]]），onMounted 兜底拉一次。
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[ai-compose] getCurrentUser 兜底失败:', e)
    }
  }
})

const loaded = ref(false)
</script>

<template>
  <div class="ai-compose-page">
    <div class="ai-compose-head">
      <div class="title-group">
        <span class="title">AI 智能组卷</span>
        <span class="subtitle">和助手对话描述需求，生成的试卷会自动存入你的「我的卷库」</span>
      </div>
      <span v-if="teacherId != null" class="who">当前老师 id：{{ teacherId }}</span>
    </div>

    <div class="ai-compose-body">
      <div v-if="!iframeSrc" class="placeholder">
        正在获取登录信息…若长时间无响应，请重新登录后再进入本页。
      </div>
      <iframe
        v-else
        :src="iframeSrc"
        class="chat-frame"
        frameborder="0"
        allow="microphone"
        @load="loaded = true"
      />
    </div>
  </div>
</template>

<style scoped>
.ai-compose-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f0f2f5;
}

.ai-compose-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
  flex-shrink: 0;
}

.title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

.subtitle {
  font-size: 12px;
  color: #86909c;
}

.who {
  font-size: 12px;
  color: #4080ff;
  background: rgba(64, 128, 255, 0.08);
  padding: 4px 10px;
  border-radius: 6px;
}

.ai-compose-body {
  flex: 1;
  padding: 16px 24px;
  overflow: hidden;
}

.chat-frame {
  width: 100%;
  height: 100%;
  min-height: 600px;
  border: none;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #86909c;
  font-size: 14px;
}
</style>
