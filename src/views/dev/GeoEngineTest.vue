<!-- PRD-C-110 B1 · geo-engine 引擎自检页
     验 renderDSL(平面几何/函数/数轴) 渲出 SVG 活图 + exportPNG 出图。
     免登录、懒加载（首次进页才下 ~1MB JSXGraph）；纯自检页，不接举一反三主流程（那是 B2）。 -->
<template>
  <div class="geo-test">
    <h2>geo-engine 自检（PRD-C-110 B1）</h2>
    <p class="hint">
      引擎来源 = PRD-A-100 geo-dsl-render.js（JSXGraph / LGPL）。三份中性 DSL → 客户端实时 SVG。
    </p>
    <div class="row">
      <div v-for="c in cases" :key="c.id" class="cell">
        <div class="cap">{{ c.title }}</div>
        <div :id="c.id" class="board" :style="{ width: c.w + 'px', height: c.h + 'px' }"></div>
        <div class="status" :class="{ ok: c.svgOk, fail: c.svgOk === false }">
          SVG: {{ c.svgOk === null ? '…' : c.svgOk ? '✅' : '❌' }}
        </div>
      </div>
    </div>
    <div class="png-test">
      <button type="button" @click="doExportPng">测试 exportPNG（用第 1 个图）</button>
      <span class="status" :class="{ ok: pngOk, fail: pngOk === false }">
        {{ pngState }}
      </span>
      <img v-if="pngUrl" :src="pngUrl" alt="exportPNG 产物" class="png-preview" />
    </div>
    <pre class="log">{{ log }}</pre>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { renderDSL, exportPNG, type GeoBoard, type GeoSpec } from '@/utils/geoEngine'

interface Case {
  id: string
  title: string
  w: number
  h: number
  spec: GeoSpec
  svgOk: boolean | null
}

// 三类至少各一：平面几何 / 函数 / 数轴
const cases = reactive<Case[]>([
  {
    id: 'geo-geom',
    title: '平面几何（三角形 + 外接圆，可拖红点）',
    w: 300,
    h: 280,
    svgOk: null,
    spec: {
      bbox: [-5, 5, 6, -3],
      objects: [
        { id: 'A', type: 'point', coords: [-2, -1], draggable: true, label: 'A' },
        { id: 'B', type: 'point', coords: [3, -1.5], draggable: true, label: 'B' },
        { id: 'C', type: 'point', coords: [0.5, 3], draggable: true, label: 'C' },
        { id: 't', type: 'polygon', points: ['A', 'B', 'C'], style: { color: '#0FB488' } },
        { id: 'M', type: 'midpoint', points: ['A', 'B'], style: { color: '#2563eb' } },
        { id: 'oc', type: 'circumcircle', points: ['A', 'B', 'C'], style: { color: '#F59E0B' } }
      ]
    }
  },
  {
    id: 'geo-func',
    title: '函数（二次函数 + 滑点 + 切线）',
    w: 300,
    h: 280,
    svgOk: null,
    spec: {
      bbox: [-3, 3, 5, -5],
      axis: true,
      objects: [
        { id: 'f', type: 'functiongraph', expr: 'x^2-2*x-3', from: -2, to: 4, style: { color: '#0FB488' } },
        { id: 'P', type: 'glider', on: 'f', coords: [1.2, 0], draggable: true, style: { color: '#e11' } },
        { id: 'tan', type: 'tangent', at: 'P', style: { color: '#F59E0B' } }
      ]
    }
  },
  {
    id: 'geo-num',
    title: '数轴（标点 -3 / 0 / 2）',
    w: 520,
    h: 110,
    svgOk: null,
    spec: {
      bbox: [-5, 1.4, 5, -1.7],
      keepAspect: false,
      objects: [
        { id: 'nl', type: 'numberline', xmin: -4, xmax: 4, ticks: [-4, -3, -2, -1, 0, 1, 2, 3, 4] },
        { id: 'P', type: 'point', coords: [2, 0], label: 'P' },
        { id: 'Q', type: 'point', coords: [-3, 0], label: 'Q' }
      ]
    }
  }
])

const log = ref('')
const pngOk = ref<boolean | null>(null)
const pngUrl = ref('')
const pngState = ref('未测试')
// 保留第 1 个图的 board 供 exportPNG
let firstBoard: GeoBoard | null = null

function append(msg: string): void {
  log.value += msg + '\n'
}

onMounted(async () => {
  for (const c of cases) {
    try {
      const { board } = await renderDSL(c.id, c.spec)
      // 渲染后容器内应出现 <svg>
      const el = document.getElementById(c.id)
      const svg = el?.querySelector('svg')
      c.svgOk = !!svg
      if (c.id === 'geo-geom') firstBoard = board
      append(`[${c.id}] render ok, svg=${!!svg}`)
    } catch (e) {
      c.svgOk = false
      append(`[${c.id}] render FAIL: ${(e as Error).message}`)
    }
  }
})

async function doExportPng(): Promise<void> {
  pngState.value = '导出中…'
  pngOk.value = null
  try {
    if (!firstBoard) throw new Error('第 1 个图未就绪')
    const url = await exportPNG(firstBoard, 2)
    pngUrl.value = url
    pngOk.value = url.startsWith('data:image/png')
    pngState.value = pngOk.value ? '✅ 出图成功' : '❌ 非 PNG dataURL'
    append(`[exportPNG] len=${url.length} head=${url.slice(0, 22)}`)
  } catch (e) {
    pngOk.value = false
    pngState.value = '❌ ' + (e as Error).message
    append(`[exportPNG] FAIL: ${(e as Error).message}`)
  }
}
</script>

<style scoped>
.geo-test {
  padding: 18px;
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
}
.hint {
  font-size: 12px;
  color: #6b7280;
  margin: 6px 0 14px;
}
.row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.cell {
  text-align: center;
  font-size: 12px;
}
.cap {
  margin-bottom: 4px;
}
.board {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 8px;
}
.status {
  margin-top: 4px;
  color: #6b7280;
}
.status.ok {
  color: #16a34a;
}
.status.fail {
  color: #dc2626;
}
.png-test {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.png-preview {
  max-width: 160px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}
.log {
  margin-top: 14px;
  font-size: 12px;
  background: #111;
  color: #9ae6b4;
  padding: 10px;
  border-radius: 6px;
  max-height: 200px;
  overflow: auto;
}
</style>
