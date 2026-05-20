<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getHealth, type HealthStatus } from '@/api/health/index'

const apiBase = import.meta.env.VITE_API_BASE_URL as string

const healthResult = ref<HealthStatus | null>(null)
const healthError = ref<string | null>(null)
const loading = ref(false)

async function checkHealth() {
  loading.value = true
  healthError.value = null
  healthResult.value = null
  try {
    const res = await getHealth()
    healthResult.value = res.data
    console.log('[book-ui] health response:', res.data)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    healthError.value = msg
    console.warn('[book-ui] health check failed (book-server may not be running yet):', msg)
  } finally {
    loading.value = false
  }
}

// Auto-call on mount
onMounted(() => {
  checkHealth()
})
</script>

<template>
  <div class="home">
    <h1>misikt 教师端复刻</h1>
    <p class="subtitle">book-ui scaffold — V0.0</p>

    <section class="health-card">
      <h2>book-server 连通性检测</h2>
      <p class="desc">
        目标端点：<code>{{ apiBase.replace(/\/api$/, '') }}/actuator/health</code>
      </p>

      <button :disabled="loading" @click="checkHealth">
        {{ loading ? '请求中…' : '重新检测' }}
      </button>

      <div v-if="healthResult" class="result success">
        <strong>状态：</strong>{{ healthResult.status }}
        <pre>{{ JSON.stringify(healthResult, null, 2) }}</pre>
      </div>

      <div v-else-if="healthError" class="result error">
        <strong>请求失败</strong>（book-server 可能尚未启动，等后端就绪后重试）
        <pre>{{ healthError }}</pre>
      </div>

      <div v-else-if="loading" class="result pending">
        检测中…
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 60px auto;
  padding: 0 20px;
}

h1 {
  font-size: 28px;
  font-weight: 700;
  color: #1a1a2e;
}

.subtitle {
  color: #888;
  margin-top: 6px;
  margin-bottom: 40px;
}

.health-card {
  background: #fff;
  border-radius: 10px;
  padding: 28px 32px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

h2 {
  font-size: 18px;
  margin-bottom: 10px;
}

.desc {
  color: #555;
  margin-bottom: 18px;
  font-size: 14px;
}

code {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}

button {
  background: #4f6ef7;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px 24px;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.15s;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

button:not(:disabled):hover {
  opacity: 0.88;
}

.result {
  margin-top: 20px;
  padding: 14px 18px;
  border-radius: 6px;
  font-size: 14px;
}

.result pre {
  margin-top: 10px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.success {
  background: #f0fff4;
  border: 1px solid #38a169;
  color: #276749;
}

.error {
  background: #fff5f5;
  border: 1px solid #e53e3e;
  color: #c53030;
}

.pending {
  background: #ebf8ff;
  border: 1px solid #63b3ed;
  color: #2b6cb0;
}
</style>
