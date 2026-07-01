<script setup lang="ts">
/**
 * 知识点讲义查看页（KG Lecture View）— 结构化积木渲染版
 *
 * 渲染层级：
 *   课时(h4) → 思维导图(Mindmap) → 考点(h5) → 知识点(h6) → KgBlock 按 seq 顺序渲染 → keyConcepts 速查
 *
 * 数据契约：GET /api/teacher/kg/course/{courseId}（misikt envelope，code===1 取 response）
 * payload 已是对象，不再 JSON.parse。
 *
 * USE_MOCK=true 时用 mock_data.json（kg_contract_sample.json），false 走真接口。
 */
import { ref, onMounted } from 'vue'
import { ElLoading } from 'element-plus'
import { getCourseDetail, USE_MOCK } from '@/api/kg/index'
import type { KgCourseResponse } from '@/api/kg/index'
import Mindmap from './components/Mindmap.vue'
import KgBlock from './components/KgBlock.vue'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const COURSE_ID = '901001002001'

// ── 状态 ──────────────────────────────────────────────────────────────────────
const data = ref<KgCourseResponse | null>(null)
const errorMsg = ref<string | null>(null)

// ── 数据加载 ──────────────────────────────────────────────────────────────────
async function loadCourse() {
  errorMsg.value = null
  const loadingInstance = ElLoading.service({
    text: '讲义加载中…',
    background: 'rgba(255,255,255,0.85)',
  })
  try {
    data.value = await getCourseDetail(COURSE_ID)
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : '加载失败，请刷新重试'
  } finally {
    loadingInstance.close()
  }
}

onMounted(() => {
  loadCourse()
})
</script>

<template>
  <div class="kg-lecture-page">

    <!-- Mock 提示横幅 -->
    <div v-if="USE_MOCK" class="mock-banner">
      当前为 Mock 数据模式。将 <code>src/api/kg/index.ts</code> 中 <code>USE_MOCK</code> 改为 <code>false</code> 即可切换真实接口。
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="error-tip">{{ errorMsg }}</div>

    <!-- 主内容 -->
    <template v-if="data">

      <!-- ══ 课时标题 ══ -->
      <h4 class="h-course">{{ data.course.name }}</h4>

      <!-- ══ 思维导图（课时标题下、考点内容之上） ══ -->
      <Mindmap
        v-if="data.mindmap && data.mindmap.length > 0"
        :nodes="data.mindmap"
      />

      <!-- ══ 考点列表 ══ -->
      <template v-for="kaodian in data.kaodians" :key="kaodian.id">

        <!-- 考点标题（橙色左边框） -->
        <h5 class="h-kaodian">{{ kaodian.name }}</h5>

        <!-- 知识点列表 -->
        <template v-for="kp in kaodian.kps" :key="kp.id">

          <!-- 知识点标题（虚线下划线） -->
          <h6 class="h-kp">{{ kp.name }}</h6>

          <!-- blocks 按 seq 顺序渲染 -->
          <KgBlock
            v-for="block in kp.blocks"
            :key="block.seq"
            :block="block"
          />

          <!-- 记忆点速查胶囊 -->
          <div
            v-if="kp.keyConcepts && kp.keyConcepts.length > 0"
            class="kc-bar"
          >
            <span class="kc-label">记忆点速查</span>
            <span
              v-for="kc in kp.keyConcepts"
              :key="kc"
              class="kc-chip"
            >{{ kc }}</span>
          </div>

        </template>
      </template>

      <!-- ══ 习题精练（占位，本课时暂空，保留字段） ══ -->
      <template v-if="data.exercises && data.exercises.length > 0">
        <div class="h-module">模块二 · 习题精练</div>
        <!-- exercises 结构待后续扩展 -->
      </template>

      <!-- ══ 巩固提升（占位） ══ -->
      <template v-if="data.boost && data.boost.length > 0">
        <div class="h-module">模块三 · 巩固提升</div>
        <!-- boost 结构待后续扩展 -->
      </template>

    </template>
  </div>
</template>

<style scoped>
/* ── 页面容器 ── */
.kg-lecture-page {
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  max-width: 920px;
  margin: 0 auto;
  padding: 24px;
  color: #222;
  line-height: 1.9;
}

/* ── Mock 提示横幅 ── */
.mock-banner {
  background: #fef3c7;
  border-left: 4px solid #f59e0b;
  padding: 8px 12px;
  font-size: 13px;
  color: #92400e;
  margin-bottom: 16px;
  border-radius: 4px;
}
.mock-banner code {
  background: #fde68a;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}

/* ── 错误提示 ── */
.error-tip {
  background: #fef2f2;
  border-left: 4px solid #dc2626;
  padding: 8px 12px;
  font-size: 14px;
  color: #991b1b;
  margin-bottom: 16px;
  border-radius: 4px;
}

/* ── 课时标题（深色条） ── */
.h-course {
  font-size: 22px;
  font-weight: 700;
  background: #1e293b;
  color: #fff;
  padding: 10px 16px;
  border-radius: 8px;
  margin: 16px 0 12px;
}

/* ── 考点标题（橙色左边框 + 浅黄底） ── */
.h-kaodian {
  font-size: 18px;
  font-weight: 700;
  color: #1e293b;
  border-left: 5px solid #f59e0b;
  padding: 4px 12px;
  margin: 24px 0 10px;
  background: #fffbeb;
}

/* ── 知识点标题（虚线下划线） ── */
.h-kp {
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
  margin: 16px 0 6px;
  border-bottom: 2px dashed #cbd5e1;
  padding-bottom: 3px;
}

/* ── 模块标题 ── */
.h-module {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  background: #f59e0b;
  padding: 8px 14px;
  border-radius: 6px;
  margin: 26px 0 12px;
}

/* ── 记忆点速查胶囊 ── */
.kc-bar {
  background: #ecfeff;
  border: 1px dashed #06b6d4;
  border-radius: 6px;
  padding: 6px 10px;
  margin: 6px 0 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.kc-label {
  color: #0891b2;
  font-weight: 600;
  font-size: 12px;
  margin-right: 4px;
  white-space: nowrap;
}

.kc-chip {
  display: inline-block;
  background: #0891b2;
  color: #fff;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}
</style>
