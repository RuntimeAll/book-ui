<script setup lang="ts">
/**
 * 知识点讲义查看页（KG Lecture View）
 *
 * 将课时讲义 1:1 还原渲染：图文结合、标红、合并单元格表格、思维导图、内嵌例题、习题/巩固。
 * 接口：GET /teacher/kg/course/:courseId（先写死 901001002001）。
 * USE_MOCK=true 时用本地假数据（后端并行开发中，随时切 false 接真实接口）。
 * 视觉规格：参照 preview_full.html（深色课时条 > 橙色考点 > 虚线知识点 > 类型徽标 > 题卡）。
 */
import { ref, onMounted } from 'vue'
import { ElLoading } from 'element-plus'
import { getCourseDetail, USE_MOCK } from '@/api/kg/index'
import type { KgCourseResponse, KgBlock, KgExample, KgExercise } from '@/api/kg/index'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const COURSE_ID = '901001002001'

// 块类型 → 徽标配色
const BLOCK_TYPE_COLORS: Record<string, string> = {
  讲解: '#2563eb',
  名师解读: '#dc2626',
  表格: '#059669',
  思维导图: '#7c3aed',
}

// 题型码 → 中文
const QTYPE_LABEL: Record<number, string> = {
  1: '选择',
  4: '填空',
  5: '解答',
}

// ── 状态 ──────────────────────────────────────────────────────────────────────
const data = ref<KgCourseResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// ── 展开/折叠答案（key = qid，value = true=展开） ──────────────────────────────
const expandedAnswers = ref<Record<string, boolean>>({})

function toggleAnswer(qid: string) {
  expandedAnswers.value[qid] = !expandedAnswers.value[qid]
}

// ── 工具：获取徽标背景色 ──────────────────────────────────────────────────────
function blockTagColor(type: KgBlock['type']): string {
  return BLOCK_TYPE_COLORS[type] ?? '#64748b'
}

// ── 工具：获取题型中文标签 ──────────────────────────────────────────────────────
function qtypeLabel(type: KgExample['type'] | KgExercise['type']): string {
  return QTYPE_LABEL[type] ?? String(type)
}

// ── 数据加载 ──────────────────────────────────────────────────────────────────
async function loadCourse() {
  loading.value = true
  error.value = null
  const loadingInstance = ElLoading.service({
    text: '讲义加载中…',
    background: 'rgba(255,255,255,0.8)',
  })
  try {
    data.value = await getCourseDetail(COURSE_ID)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '加载失败'
    error.value = msg
  } finally {
    loading.value = false
    loadingInstance.close()
  }
}

onMounted(() => {
  loadCourse()
})
</script>

<template>
  <div class="kg-lecture-page">
    <!-- 环境提示条（mock 模式时展示） -->
    <div v-if="USE_MOCK" class="mock-banner">
      当前为 Mock 数据模式（后端接口并行开发中）。将 <code>src/api/kg/index.ts</code> 中 <code>USE_MOCK</code> 改为 <code>false</code> 即可切换真实接口。
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="error-tip">{{ error }}</div>

    <!-- 主内容 -->
    <template v-if="data">
      <!-- ══ 课时标题（深色条） ══ -->
      <div class="h-course">{{ data.course.name }}</div>

      <!-- ══ 思维导图（顶部整图） ══ -->
      <template v-if="data.mindmapUrl">
        <div class="blk">
          <span class="tag" :style="{ background: BLOCK_TYPE_COLORS['思维导图'] }">思维导图</span>
          <div class="body">
            <img :src="data.mindmapUrl" alt="思维导图" style="max-width:100%" />
          </div>
        </div>
      </template>

      <!-- ══ 考点列表 ══ -->
      <template v-for="kaodian in data.kaodians" :key="kaodian.id">
        <!-- 考点标题（橙色左边框+浅黄底） -->
        <div class="h-kaodian">{{ kaodian.name }}</div>

        <!-- 知识点列表 -->
        <template v-for="kp in kaodian.kps" :key="kp.id">
          <!-- 知识点标题（虚线下划线） -->
          <div class="h-kp">{{ kp.name }}</div>

          <!-- 内容块 -->
          <template v-for="(block, bi) in kp.blocks" :key="bi">
            <div class="blk">
              <span class="tag" :style="{ background: blockTagColor(block.type) }">{{ block.type }}</span>
              <!-- v-safe-html 强制过滤，不用裸 v-html -->
              <div class="body" v-safe-html="block.content" />
            </div>
          </template>

          <!-- 记忆点胶囊（keyConcepts） -->
          <div v-if="kp.keyConcepts && kp.keyConcepts.length > 0" class="kc">
            <span class="kc-label">🔑 记忆点(速查)</span>
            <span v-for="kc in kp.keyConcepts" :key="kc" class="chip">{{ kc }}</span>
          </div>

          <!-- 内嵌例题卡 -->
          <template v-for="example in kp.examples" :key="example.qid">
            <div class="q-card">
              <div class="q-header">
                <span class="q-idx">例题</span>
                <span class="q-type-badge">{{ qtypeLabel(example.type) }}</span>
                <span v-if="example.source" class="q-source">{{ example.source }}</span>
              </div>
              <div class="q-stem" v-safe-html="example.stem" />
              <!-- 答案/详解折叠 -->
              <div class="q-toggle" @click="toggleAnswer(example.qid)">
                {{ expandedAnswers[example.qid] ? '收起' : '查看答案/详解' }}
              </div>
              <template v-if="expandedAnswers[example.qid]">
                <div class="q-answer">
                  <span class="q-answer-label">【答案】</span>
                  <span v-safe-html="example.answer" />
                </div>
                <div class="q-explain">
                  <span class="q-explain-label">【详解】</span>
                  <span v-safe-html="example.explain" />
                </div>
              </template>
            </div>
          </template>
        </template>
      </template>

      <!-- ══ 模块二：习题精练 ══ -->
      <template v-if="data.exercises && data.exercises.length > 0">
        <div class="h-module">模块二 · 习题精练</div>
        <div
          v-for="(ex, idx) in data.exercises"
          :key="ex.qid"
          class="q-card"
        >
          <div class="q-header">
            <span class="q-idx">{{ idx + 1 }}.</span>
            <span class="q-type-badge">{{ qtypeLabel(ex.type) }}</span>
            <span v-if="ex.source" class="q-source">{{ ex.source }}</span>
          </div>
          <div class="q-stem" v-safe-html="ex.stem" />
          <div class="q-toggle" @click="toggleAnswer('ex_' + ex.qid)">
            {{ expandedAnswers['ex_' + ex.qid] ? '收起' : '查看答案/详解' }}
          </div>
          <template v-if="expandedAnswers['ex_' + ex.qid]">
            <div class="q-answer">
              <span class="q-answer-label">【答案】</span>
              <span v-safe-html="ex.answer" />
            </div>
            <div class="q-explain">
              <span class="q-explain-label">【详解】</span>
              <span v-safe-html="ex.explain" />
            </div>
          </template>
        </div>
      </template>

      <!-- ══ 模块三：巩固提升 ══ -->
      <template v-if="data.boost && data.boost.length > 0">
        <div class="h-module">模块三 · 巩固提升</div>
        <div
          v-for="(ex, idx) in data.boost"
          :key="ex.qid"
          class="q-card"
        >
          <div class="q-header">
            <span class="q-idx">{{ idx + 1 }}.</span>
            <span class="q-type-badge">{{ qtypeLabel(ex.type) }}</span>
            <span v-if="ex.source" class="q-source">{{ ex.source }}</span>
          </div>
          <div class="q-stem" v-safe-html="ex.stem" />
          <div class="q-toggle" @click="toggleAnswer('boost_' + ex.qid)">
            {{ expandedAnswers['boost_' + ex.qid] ? '收起' : '查看答案/详解' }}
          </div>
          <template v-if="expandedAnswers['boost_' + ex.qid]">
            <div class="q-answer">
              <span class="q-answer-label">【答案】</span>
              <span v-safe-html="ex.answer" />
            </div>
            <div class="q-explain">
              <span class="q-explain-label">【详解】</span>
              <span v-safe-html="ex.explain" />
            </div>
          </template>
        </div>
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
  font-size: 24px;
  font-weight: 700;
  background: #1e293b;
  color: #fff;
  padding: 10px 16px;
  border-radius: 8px;
  margin: 16px 0;
}

/* ── 考点标题（橙色左边框 + 浅黄底） ── */
.h-kaodian {
  font-size: 20px;
  font-weight: 700;
  color: #1e293b;
  border-left: 6px solid #f59e0b;
  padding: 4px 12px;
  margin: 22px 0 10px;
  background: #fffbeb;
}

/* ── 知识点标题（虚线下划线） ── */
.h-kp {
  font-size: 17px;
  font-weight: 700;
  color: #0f172a;
  margin: 16px 0 6px;
  border-bottom: 2px dashed #cbd5e1;
  padding: 3px 0;
}

/* ── 模块标题（橙色区块） ── */
.h-module {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  background: #f59e0b;
  padding: 8px 14px;
  border-radius: 6px;
  margin: 26px 0 12px;
}

/* ── 内容块（tag + body） ── */
.blk {
  margin: 8px 0 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.tag {
  flex-shrink: 0;
  color: #fff;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  margin-top: 3px;
  white-space: nowrap;
}

.body {
  flex: 1;
  min-width: 0;
}

/* 防浮动溢出 */
.body::after {
  content: '';
  display: block;
  clear: both;
}

/* ── mark 标红 ── */
:deep(mark) {
  background: none;
  color: #dc2626;
  font-weight: 600;
}

/* ── 表格样式 ── */
:deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

:deep(th) {
  background: #f97316;
  color: #fff;
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  font-size: 14px;
  text-align: left;
  vertical-align: top;
}

:deep(td) {
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  font-size: 14px;
  text-align: left;
  vertical-align: top;
}

/* 表格内图片 */
:deep(td img),
:deep(th img) {
  max-width: 100%;
  margin: 3px 6px 3px 0;
  vertical-align: top;
}

/* ── 图片 ── */
:deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 3px;
  vertical-align: top;
}

/* ── 记忆点胶囊 ── */
.kc {
  background: #ecfeff;
  border: 1px dashed #06b6d4;
  border-radius: 6px;
  padding: 6px 10px;
  margin: 6px 0 10px;
}

.kc-label {
  color: #0891b2;
  font-weight: 600;
  font-size: 13px;
  margin-right: 6px;
}

.chip {
  display: inline-block;
  background: #0891b2;
  color: #fff;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  margin: 2px 3px;
}

/* ── 题卡 ── */
.q-card {
  border: 1px solid #e2e8f0;
  border-left: 3px solid #3b82f6;
  border-radius: 6px;
  padding: 10px 14px;
  margin: 8px 0 12px;
  background: #f8fafc;
}

.q-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.q-idx {
  font-weight: 600;
  color: #334155;
  font-size: 13px;
}

.q-type-badge {
  background: #3b82f6;
  color: #fff;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 8px;
}

.q-source {
  color: #64748b;
  font-size: 12px;
}

/* 题干 */
.q-stem {
  font-size: 14px;
  color: #1e293b;
  line-height: 1.8;
  margin-bottom: 6px;
}

/* 展开/折叠按钮 */
.q-toggle {
  display: inline-block;
  cursor: pointer;
  font-size: 12px;
  color: #2563eb;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  padding: 2px 10px;
  margin-bottom: 4px;
  user-select: none;
  transition: background 0.15s;
}
.q-toggle:hover {
  background: #eff6ff;
}

/* 答案 */
.q-answer {
  color: #1d4ed8;
  font-size: 14px;
  margin-top: 4px;
  line-height: 1.7;
}

.q-answer-label {
  font-weight: 600;
}

/* 详解 */
.q-explain {
  color: #b91c1c;
  font-size: 14px;
  margin-top: 2px;
  line-height: 1.7;
}

.q-explain-label {
  font-weight: 600;
}
</style>
