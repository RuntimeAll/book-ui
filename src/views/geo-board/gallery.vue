<!--
  几何构件库 · 只读画廊（/geo-board/gallery）——小学+初中常用图形一页看全，全部构件 JSON 精确生成。
  移植自 geometry-board/gallery.html。每格 = <GeoBoard mode="readonly">（无圆点、只留字母=教科书样式）。
-->
<script setup lang="ts">
import { useRouter } from 'vue-router'
import GeoBoard from '@/components/business/GeoBoard/index.vue'

const router = useRouter()

const FAMILIES: Array<[string, Array<[string, Record<string, unknown>]>]> = [
  ['平面图形', [
    ['等边三角形', { build: [{ shape: 'triangle', kind: 'equilateral', side: 4 }] }],
    ['等腰三角形', { build: [{ shape: 'triangle', kind: 'isosceles', base: 5, leg: 4 }] }],
    ['直角三角形(直角C,3/4)', { build: [{ id: 'T', shape: 'triangle', kind: 'right', rightAt: 'C', legs: [3, 4], labels: ['A', 'B', 'C'] }, { mark: 'rightangle', of: 'T', at: 'C' }] }],
    ['三角形+斜边中线', { build: [{ id: 'T', shape: 'triangle', kind: 'right', rightAt: 'C', legs: [6, 8], labels: ['A', 'B', 'C'] }, { add: 'median', of: 'T', from: 'C', label: 'D' }, { mark: 'rightangle', of: 'T', at: 'C' }] }],
    ['正方形', { build: [{ shape: 'quad', kind: 'square', side: 4 }] }],
    ['矩形', { build: [{ shape: 'quad', kind: 'rectangle', width: 5, height: 3 }] }],
    ['平行四边形+对角线+交点O', { build: [{ id: 'Q', shape: 'quad', kind: 'parallelogram', base: 5, side: 3, angle: 60 }, { add: 'diagonal', of: 'Q', center: true, centerLabel: 'O' }] }],
    ['菱形', { build: [{ shape: 'quad', kind: 'rhombus', side: 4, angle: 70 }] }],
    ['等腰梯形+对角线', { build: [{ id: 'Q', shape: 'quad', kind: 'trapezoid', bottom: 6, top: 3, height: 3 }, { add: 'diagonal', of: 'Q' }] }],
    ['直角梯形', { build: [{ shape: 'quad', kind: 'trapezoid', bottom: 6, top: 3, height: 3, right: true }] }],
    ['正六边形', { build: [{ shape: 'regular', n: 6, side: 3 }] }],
    ['正五边形', { build: [{ shape: 'regular', n: 5, side: 3 }] }]
  ]],
  ['圆', [
    ['圆 ⊙O', { build: [{ shape: 'circle', kind: 'plain', r: 3 }] }],
    ['扇形', { build: [{ shape: 'circle', kind: 'sector', r: 3, start: 30, end: 150 }] }],
    ['圆+切线', { build: [{ shape: 'circle', kind: 'tangent', r: 3, atAngle: 50 }] }],
    ['三角形+外接圆', { build: [{ id: 'T', shape: 'triangle', kind: 'sss', sides: [6, 5, 5], labels: ['A', 'B', 'C'] }, { add: 'circumcircle', of: 'T' }] }],
    ['三角形+内切圆', { build: [{ id: 'T', shape: 'triangle', kind: 'equilateral', side: 6 }, { add: 'incircle', of: 'T' }] }],
    ['圆弧(心O+起A+终B)', { build: [{ shape: 'arc', center: [0, 0], r: 3, start: 20, end: 140, labels: ['O', 'A', 'B'] }] }],
    ['圆弧+半径', { build: [{ shape: 'arc', center: [0, 0], r: 3, start: -10, end: 80, labels: ['O', 'A', 'B'], radii: true }] }]
  ]],
  ['函数 / 坐标', [
    ['一次 y=2x-1', { build: [{ shape: 'function', kind: 'linear', k: 2, b: -1 }] }],
    ['二次 y=x²-2x-3', { build: [{ shape: 'function', kind: 'quadratic', a: 1, b: -2, c: -3 }] }],
    ['反比例 y=4/x', { build: [{ shape: 'function', kind: 'inverse', k: 4 }] }],
    ['坐标描点', { build: [{ shape: 'coordinate', points: [{ x: 1, y: 2, label: 'A' }, { x: 3, y: -1, label: 'B' }, { x: -2, y: 1, label: 'C' }], polygon: true }] }]
  ]],
  ['变换', [
    ['轴对称(过y轴)', { build: [{ id: 'T', shape: 'triangle', kind: 'right', legs: [3, 4], rightAt: 'C', labels: ['A', 'B', 'C'], at: [1.2, 0] }, { transform: 'reflect', axis: 'y', of: 'T' }] }],
    ['平移', { build: [{ id: 'T', shape: 'triangle', kind: 'equilateral', side: 3 }, { transform: 'translate', by: [4, 1], of: 'T', showMap: true }] }],
    ['旋转90°', { build: [{ id: 'T', shape: 'triangle', kind: 'right', legs: [3, 3], rightAt: 'C', labels: ['A', 'B', 'C'], at: [1, 1] }, { transform: 'rotate', center: [0, 0], angle: 90, of: 'T' }] }],
    ['中心对称', { build: [{ id: 'T', shape: 'triangle', kind: 'sss', sides: [5, 4, 3], labels: ['A', 'B', 'C'], at: [1, 1] }, { transform: 'central', center: [0, 0], of: 'T' }] }]
  ]],
  ['立体（斜二测）', [
    ['正方体', { build: [{ shape: 'solid', kind: 'cube', a: 3 }] }],
    ['长方体', { build: [{ shape: 'solid', kind: 'cuboid', l: 4, w: 2, h: 3 }] }],
    ['圆柱', { build: [{ shape: 'solid', kind: 'cylinder', r: 2, h: 4 }] }],
    ['圆锥', { build: [{ shape: 'solid', kind: 'cone', r: 2, h: 4 }] }],
    ['球', { build: [{ shape: 'solid', kind: 'sphere', r: 2.5 }] }],
    ['三棱柱', { build: [{ shape: 'solid', kind: 'prism', n: 3, side: 3, h: 4 }] }],
    ['四棱锥', { build: [{ shape: 'solid', kind: 'pyramid', n: 4, side: 3, h: 4 }] }]
  ]],
  ['统计图', [
    ['条形统计图', { build: [{ shape: 'chart', kind: 'bar', categories: ['一', '二', '三', '四'], values: [6, 9, 5, 8] }] }],
    ['折线统计图', { build: [{ shape: 'chart', kind: 'line', categories: ['周一', '周二', '周三', '周四'], values: [3, 7, 5, 8] }] }],
    ['扇形统计图', { build: [{ shape: 'chart', kind: 'pie', parts: [{ label: '语', value: 30 }, { label: '数', value: 45 }, { label: '英', value: 25 }] }] }],
    ['频数直方图', { build: [{ shape: 'chart', kind: 'histogram', edges: [0, 10, 20, 30, 40], freqs: [4, 9, 7, 3] }] }]
  ]],
  ['基础与角', [
    ['数轴标点', { build: [{ shape: 'numberline', min: -4, max: 4, points: [{ x: 2, label: 'A' }, { x: -3, label: 'B' }] }] }],
    ['不等式 x>2', { build: [{ shape: 'numberline', min: -5, max: 5, intervals: [{ from: 2, to: null, fromOpen: true }] }] }],
    ['不等式 -1≤x<3', { build: [{ shape: 'numberline', min: -4, max: 5, intervals: [{ from: -1, to: 3, fromOpen: false, toOpen: true }] }] }],
    ['标准角 50°', { build: [{ shape: 'angle', degrees: 50, showDegrees: true }] }],
    ['三角形标内角度数', { build: [{ id: 'T', shape: 'triangle', kind: 'sss', sides: [6, 5, 5], labels: ['A', 'B', 'C'] }, { mark: 'angle', of: 'T', at: 'A', showDegrees: true }, { mark: 'angle', of: 'T', at: 'B', showDegrees: true }, { mark: 'angle', of: 'T', at: 'C', showDegrees: true }] }],
    ['三线八角', { build: [{ shape: 'parallelCut', gap: 3, angle: 55 }] }]
  ]],
  ['小学专项', [
    ['钟面 3:00', { build: [{ shape: 'clock', hour: 3, minute: 0 }] }],
    ['钟面 9:30', { build: [{ shape: 'clock', hour: 9, minute: 30 }] }],
    ['分数饼 2/6', { build: [{ shape: 'fractionCircle', parts: 6, shaded: 2 }] }],
    ['分数条 3/4', { build: [{ shape: 'fractionBar', parts: 4, shaded: 3 }] }],
    ['方格面积(格点)', { build: [{ shape: 'grid', cols: 6, rows: 5, lattice: [[1, 1], [5, 1], [4, 4], [1, 3]] }] }],
    ['方格涂色', { build: [{ shape: 'grid', cols: 5, rows: 4, shadeCells: [[0, 0], [1, 0], [1, 1], [2, 2]] }] }]
  ]]
]
</script>

<template>
  <div class="geo-gallery">
    <header class="gg-head">
      <div>
        <h1>几何构件库 · 只读画廊</h1>
        <p class="sub">小学 + 初中常用图形一页看全 · 只读呈现（无可编辑圆点，只留字母）· 全部由构件 JSON 代码精确生成</p>
      </div>
      <el-button text type="primary" @click="router.push('/geo-board')">← 回画板</el-button>
    </header>

    <section v-for="[fam, items] in FAMILIES" :key="fam" class="fam">
      <h2>{{ fam }}</h2>
      <div class="grid">
        <div v-for="[name, spec] in items" :key="name" class="cell">
          <GeoBoard :spec="spec" mode="readonly" :height="150" :toolbar="false" :export-bar="false" />
          <div class="cap">{{ name }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.geo-gallery { padding: 16px 20px 40px; }
.gg-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.gg-head h1 { margin: 0; font-size: 18px; }
.gg-head .sub { margin: 4px 0 0; font-size: 12px; color: #8a93a6; }
.fam { margin: 8px 0; }
.fam h2 { font-size: 14px; color: #5b3fe0; margin: 18px 0 8px; padding-left: 6px; border-left: 3px solid #7c5cfa; }
.grid { display: flex; flex-wrap: wrap; gap: 10px; }
.cell { width: 232px; background: #fff; border: 1px solid #e6e9ef; border-radius: 10px; padding: 4px; box-shadow: 0 3px 12px rgba(40, 50, 90, .04); }
.cell :deep(.geo-board) { border: none; }
.cap { font-size: 12px; text-align: center; color: #333; padding: 4px 2px 2px; }
</style>
