<!--
  几何画板 Studio（/geo-board）——老师从零画 / 拖调 agent 出的图 / 只读预览。
  · 左：GeoBoard（三态切换）  · 右：模式 + 示例 + 构件 JSON 粘贴渲染（agent 输出直接贴进来看效果）
  引擎 = JSXGraph 统一引擎；构件层 figure-builder（高层 build:[...] → 精确坐标，agent 不盲打）。
-->
<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import GeoBoard from '@/components/business/GeoBoard/index.vue'
import type { GeoSpec } from '@/utils/geoEngine'

const router = useRouter()
const mode = ref<'draw' | 'edit' | 'readonly'>('draw')
const axis = ref(false)
const grid = ref(false)
const spec = ref<GeoSpec | Record<string, unknown> | null>(null)
const jsonText = ref('')
const boardRef = shallowRef<InstanceType<typeof GeoBoard> | null>(null)

// 示例（高层构件 DSL——agent 就出这种）
const EXAMPLES: Array<{ name: string; spec: Record<string, unknown> }> = [
  { name: '直角三角形 + 斜边中线', spec: { build: [
    { id: 'T', shape: 'triangle', kind: 'right', rightAt: 'C', legs: [6, 8], labels: ['A', 'B', 'C'] },
    { add: 'median', of: 'T', from: 'C', label: 'D' },
    { mark: 'rightangle', of: 'T', at: 'C' }
  ] } },
  { name: '平行四边形 + 对角线 + 交点O', spec: { build: [
    { id: 'Q', shape: 'quad', kind: 'parallelogram', base: 5, side: 3, angle: 60 },
    { add: 'diagonal', of: 'Q', center: true, centerLabel: 'O' }
  ] } },
  { name: '⊙O + 切线', spec: { build: [{ shape: 'circle', kind: 'tangent', r: 3, atAngle: 50 }] } },
  { name: '三角形标内角度数', spec: { build: [
    { id: 'T', shape: 'triangle', kind: 'sss', sides: [6, 5, 5], labels: ['A', 'B', 'C'] },
    { mark: 'angle', of: 'T', at: 'A', showDegrees: true },
    { mark: 'angle', of: 'T', at: 'B', showDegrees: true },
    { mark: 'angle', of: 'T', at: 'C', showDegrees: true }
  ] } },
  { name: '二次函数 y=x²-2x-3', spec: { build: [{ shape: 'function', kind: 'quadratic', a: 1, b: -2, c: -3 }] } },
  { name: '圆柱（斜二测）', spec: { build: [{ shape: 'solid', kind: 'cylinder', r: 2, h: 4 }] } },
  { name: '扇形统计图', spec: { build: [{ shape: 'chart', kind: 'pie', parts: [
    { label: '语', value: 30 }, { label: '数', value: 45 }, { label: '英', value: 25 }
  ] } ] } },
  { name: '不等式 x>2（数轴）', spec: { build: [{ shape: 'numberline', min: -3, max: 6, intervals: [{ from: 2, to: null, fromOpen: true }] }] } }
]

function loadExample(idx: number) {
  const ex = EXAMPLES[idx]
  if (!ex) return
  jsonText.value = JSON.stringify(ex.spec, null, 1)
  spec.value = JSON.parse(JSON.stringify(ex.spec))
  boardRef.value?.loadSpec(spec.value as GeoSpec)
}

function renderJSON() {
  try {
    const o = JSON.parse(jsonText.value)
    spec.value = o
    boardRef.value?.loadSpec(o)
    ElMessage.success('已渲染')
  } catch (e) {
    ElMessage.error('JSON 解析失败：' + (e as Error).message)
  }
}
function pullCurrent() {
  const s = boardRef.value?.getSpec()
  if (s) jsonText.value = JSON.stringify(s, null, 1)
}
function exportPNG() { void boardRef.value?.exportPNG(2) }
</script>

<template>
  <div class="geo-studio">
    <header class="gs-head">
      <div>
        <h1>几何画板</h1>
        <p class="sub">老师从零画 / 拖调 AI 出的图 / 只读预览 · 构件 JSON 精确出图（字母不压线，几何由代码保证）</p>
      </div>
      <el-button text type="primary" @click="router.push('/geo-board/gallery')">只读画廊（看全部图形）→</el-button>
    </header>

    <div class="gs-body">
      <main class="gs-canvas">
        <GeoBoard
          ref="boardRef"
          :spec="spec"
          :mode="mode"
          :axis="axis"
          :grid="grid"
          :height="'62vh'"
        />
      </main>

      <aside class="gs-side">
        <section class="panel">
          <div class="panel-title">模式</div>
          <el-radio-group v-model="mode" size="small">
            <el-radio-button value="draw">画（工具栏）</el-radio-button>
            <el-radio-button value="edit">拖调</el-radio-button>
            <el-radio-button value="readonly">只读</el-radio-button>
          </el-radio-group>
          <div class="opts">
            <el-checkbox v-model="axis" size="small">坐标轴</el-checkbox>
            <el-checkbox v-model="grid" size="small">网格</el-checkbox>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title">示例（高层构件，AI 就出这种）</div>
          <div class="examples">
            <el-button
              v-for="(ex, i) in EXAMPLES"
              :key="ex.name"
              size="small"
              plain
              @click="loadExample(i)"
            >{{ ex.name }}</el-button>
          </div>
        </section>

        <section class="panel grow">
          <div class="panel-title">
            构件 / 几何 JSON
            <span class="tip">贴 AI 输出的 build JSON 或低层 DSL，点渲染</span>
          </div>
          <el-input
            v-model="jsonText"
            type="textarea"
            :rows="10"
            resize="none"
            placeholder='{"build":[{"shape":"triangle","kind":"equilateral","side":4}]}'
          />
          <div class="panel-actions">
            <el-button type="primary" size="small" @click="renderJSON">渲染</el-button>
            <el-button size="small" @click="pullCurrent">读取当前</el-button>
            <el-button size="small" @click="exportPNG">导出 PNG</el-button>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.geo-studio { padding: 16px 20px; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
.gs-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.gs-head h1 { margin: 0; font-size: 18px; }
.gs-head .sub { margin: 4px 0 0; font-size: 12px; color: #8a93a6; }
.gs-body { display: flex; gap: 14px; flex: 1; min-height: 0; }
.gs-canvas { flex: 1; min-width: 0; }
.gs-side { width: 300px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
.panel { background: #fff; border: 1px solid #e6e9ef; border-radius: 10px; padding: 10px 12px; }
.panel.grow { display: flex; flex-direction: column; }
.panel-title { font-size: 13px; font-weight: 600; color: #333; margin-bottom: 8px; }
.panel-title .tip { display: block; font-size: 11px; font-weight: 400; color: #9aa2b1; margin-top: 2px; }
.opts { margin-top: 8px; display: flex; gap: 12px; }
.examples { display: flex; flex-wrap: wrap; gap: 6px; }
.examples :deep(.el-button) { margin: 0; }
.panel-actions { margin-top: 8px; display: flex; gap: 6px; }
</style>
