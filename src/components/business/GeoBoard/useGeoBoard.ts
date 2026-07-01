// useGeoBoard.ts — 交互式几何画板核心逻辑（Vue Composable）
//
// 谱系：移植自 codeplace-C/geometry-board/src/board-app.js（复现 SJEP 工具栏 + 构造→JSON）。
// 心智模型（学自 SJEP / JSXGraph）：
//   画板 = 一个「构造指令数组 ops」的视图。任何工具操作 = 往 ops push 一条 DSL，
//   然后用 GeoEngine.render 整体重放。① UI 画的和 agent 出的是同一份 JSON；② 撤销 = pop；
//   ③ 导出 = JSON.stringify(ops)；④ 标签避让每次重放都重算（autoPosition）。
//
// 三态：draw（工具栏从零画）/ edit（只拖已有点微调）/ readonly（静态展示）。
// 基础吸附（借 geomedit 思路）：放新点时优先吸到「已有顶点 / 线段中点 / 两线交点」，否则落 0.5 网格。

import { ref, type Ref } from 'vue'
import { renderDSL, exportPNG as engineExportPNG, exportSVG as engineExportSVG, type GeoBoard, type GeoReg, type GeoSpec } from '@/utils/geoEngine'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Op = Record<string, any>
type XY = [number, number]

export type GeoTool =
  | 'select' | 'point' | 'segment' | 'line' | 'ray' | 'vector' | 'polygon'
  | 'circle' | 'circumcircle' | 'midpoint' | 'perpendicular' | 'parallel'
  | 'anglebisector' | 'angle' | 'rightangle' | 'text' | 'delete'

export interface UseGeoBoardOptions {
  mode: Ref<'readonly' | 'edit' | 'draw'>
  axis: Ref<boolean>
  grid: Ref<boolean>
  autoLabel: Ref<boolean>
  snap: Ref<boolean>
  onChange?: (spec: GeoSpec) => void
}

const TOOL_HINTS: Record<GeoTool, string> = {
  select: '拖动点可移动；松手自动重排标签。',
  point: '点击画板放点（自动命名 A/B/C…）。',
  segment: '依次点两个点连线段。',
  line: '依次点两点画直线。',
  ray: '先点端点再点方向点。',
  vector: '先点起点再点终点。',
  polygon: '依次点顶点，点回第一个点闭合（≥3）。',
  circle: '先点圆心，再点圆上一点。',
  circumcircle: '点三个点定外接圆。',
  midpoint: '点两点取中点。',
  perpendicular: '先点一条线，再点一个点 → 过点垂线。',
  parallel: '先点一条线，再点一个点 → 过点平行线。',
  anglebisector: '点 A、B、C → ∠ABC 平分线。',
  angle: '点 A、B、C 标注 ∠ABC（B 为顶点）。',
  rightangle: '点 A、B、C 标直角小方块。',
  text: '点击位置后输入文本。',
  delete: '点击要删除的元素（级联删依赖它的对象）。'
}

const GRID = 0.5
const TWO: Record<string, number> = { segment: 1, line: 1, ray: 1, vector: 1, midpoint: 1, circle: 1 }
const THREE: Record<string, number> = { circumcircle: 1, anglebisector: 1, angle: 1, rightangle: 1 }

export function useGeoBoard(container: Ref<HTMLElement | null>, opts: UseGeoBoardOptions) {
  const tool = ref<GeoTool>('select')
  const ops = ref<Op[]>([])
  const bbox = ref<[number, number, number, number]>([-8, 7, 8, -6])
  const hint = ref('')
  const status = ref('')

  let view: { board: GeoBoard; reg: GeoReg } | null = null
  let buffer: string[] = [] // 多点工具暂存已选 id
  let seq = 0
  let promptText: (msg: string) => Promise<string | null> = async (msg) => window.prompt(msg, '') // 可被组件替换成 Element Plus 弹窗

  const JXG = () => (window as any).JXG
  const isDraw = () => opts.mode.value === 'draw'
  const isEdit = () => opts.mode.value === 'edit'
  const isReadonly = () => opts.mode.value === 'readonly'

  /* ---------- spec / 渲染 ---------- */
  function spec(): GeoSpec {
    return {
      bbox: bbox.value,
      axis: opts.axis.value,
      grid: opts.grid.value,
      label: { autoPosition: opts.autoLabel.value },
      exportable: true,
      readonly: isReadonly(),
      objects: ops.value
    }
  }

  async function render() {
    const el = container.value
    if (!el) return
    if (view && view.board) { try { JXG().JSXGraph.freeBoard(view.board) } catch { /* noop */ } }
    // draw/edit 都要点可拖：draw 靠工具锁点、select 时拖；edit 直接拖。
    const editable = isDraw() || isEdit()
    view = await renderDSL(el, spec() as Record<string, unknown>, { editable })
    bindBoard()
    applyToolMode()
    emitChange()
  }

  // 工具非 select 时锁点（点击=选取，防被拖走）
  function applyToolMode() {
    if (!view) return
    const locked = isDraw() && tool.value !== 'select'
    Object.keys(view.reg.obj).forEach((id) => {
      const g: any = view!.reg.obj[id]
      if (g && g.elType === 'point') { try { g.setAttribute({ fixed: locked }) } catch { /* noop */ } }
    })
    if (container.value) container.value.style.cursor = (!isDraw() || tool.value === 'select') ? 'default' : 'crosshair'
  }

  /* ---------- 坐标 / 命中 ---------- */
  function screenOf(e: Event): XY {
    const abs = JXG().getPosition(e)
    const c = (view!.board as any).getCoordsTopLeftCorner()
    return [abs[0] - c[0], abs[1] - c[1]]
  }
  function usrOf(e: Event): XY {
    const s = screenOf(e)
    const u = new (JXG().Coords)(JXG().COORDS_BY_SCREEN, s, view!.board).usrCoords
    return [u[1], u[2]]
  }
  function gridSnap(v: number) { return Math.round(v / GRID) * GRID }

  function pointUnder(e: Event): string | null {
    const s = screenOf(e)
    let best: string | null = null, bd = 1e9
    Object.keys(view!.reg.obj).forEach((id) => {
      const g: any = view!.reg.obj[id]
      if (!g || g.elType !== 'point' || !g.visProp.visible) return
      const sc = g.coords.scrCoords, d = Math.hypot(sc[1] - s[0], sc[2] - s[1])
      if (d < 14 && d < bd) { bd = d; best = id }
    })
    return best
  }
  function lineUnder(e: Event): string | null {
    const s = screenOf(e)
    const ids = Object.keys(view!.reg.obj)
    for (const id of ids) {
      const g: any = view!.reg.obj[id]
      if (g && (g.elType === 'line' || g.elType === 'segment') && g.hasPoint && g.hasPoint(s[0], s[1])) return id
    }
    return null
  }
  function elementUnder(e: Event): string | null {
    return pointUnder(e) || lineUnder(e) || (() => {
      const s = screenOf(e), ids = Object.keys(view!.reg.obj)
      for (const id of ids) {
        const g: any = view!.reg.obj[id]
        if (g && g.hasPoint && g.hasPoint(s[0], s[1])) return id
      }
      return null
    })()
  }

  /* ---------- 基础吸附：顶点 / 中点 / 交点 ---------- */
  // 已有 point 的 id→坐标（从 ops 直接取，稳定不依赖渲染）
  function pointCoordMap(): Record<string, XY> {
    const m: Record<string, XY> = {}
    ops.value.forEach((o) => { if (o.type === 'point' && Array.isArray(o.coords)) m[o.id] = o.coords as XY })
    return m
  }
  function segEndpoints(): Array<[XY, XY]> {
    const m = pointCoordMap(), out: Array<[XY, XY]> = []
    ops.value.forEach((o) => {
      if ((o.type === 'segment' || o.type === 'line' || o.type === 'ray' || o.type === 'vector') && o.points) {
        const a = m[o.points[0]], b = m[o.points[1]]
        if (a && b) out.push([a, b])
      }
    })
    return out
  }
  function lineIntersect(a: XY, b: XY, c: XY, d: XY): XY | null {
    const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1], x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1]
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if (Math.abs(den) < 1e-9) return null
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
  }
  // 吸附候选（用户坐标）：线段中点 + 两线交点
  function featureCandidates(): XY[] {
    const segs = segEndpoints(), cands: XY[] = []
    segs.forEach(([a, b]) => cands.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]))
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const p = lineIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])
        if (p) cands.push(p)
      }
    }
    return cands
  }
  // 用户坐标 → 屏幕坐标（量吸附半径用）
  function usrToScr(u: XY): XY {
    const c = new (JXG().Coords)(JXG().COORDS_BY_USER, u, view!.board).scrCoords
    return [c[1], c[2]]
  }
  // 放新点时的落点：优先吸中点/交点（12px 内），否则网格
  function snapUser(u: XY): XY {
    if (!opts.snap.value) return [gridSnap(u[0]), gridSnap(u[1])]
    const us = usrToScr(u)
    let best: XY | null = null, bd = 12
    featureCandidates().forEach((cand) => {
      const cs = usrToScr(cand), d = Math.hypot(cs[0] - us[0], cs[1] - us[1])
      if (d < bd) { bd = d; best = cand }
    })
    if (best) return [Math.round((best as XY)[0] * 100) / 100, Math.round((best as XY)[1] * 100) / 100]
    return [gridSnap(u[0]), gridSnap(u[1])]
  }

  /* ---------- id / 标签 ---------- */
  function newId() { return 'o' + (++seq) }
  function nextLabel() {
    const used: Record<string, number> = {}
    ops.value.forEach((o) => { if (o.label) used[o.label] = 1 })
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (let k = 0; k < 100; k++) {
      const lab = A[k % 26] + (k < 26 ? '' : Math.floor(k / 26))
      if (!used[lab]) return lab
    }
    return 'P' + (++seq)
  }
  function ensurePoint(e: Event): string {
    const hit = pointUnder(e)
    if (hit) return hit
    const s = snapUser(usrOf(e)), id = newId()
    ops.value.push({ id, type: 'point', coords: s, label: nextLabel() })
    return id
  }

  /* ---------- 工具动作 ---------- */
  async function onDown(e: any) {
    if (!view || !isDraw()) return       // readonly/edit：交给 JSXGraph 原生（edit 可拖）
    if (tool.value === 'select') return
    e && e.preventDefault && e.preventDefault()

    if (tool.value === 'point') { ensurePoint(e); buffer = []; await render(); return }

    if (tool.value === 'text') {
      const u = usrOf(e), txt = await promptText('文本内容：')
      if (txt) { ops.value.push({ id: newId(), type: 'text', x: gridSnap(u[0]), y: gridSnap(u[1]), text: txt }); await render() }
      return
    }
    if (tool.value === 'delete') {
      const del = elementUnder(e); if (del) removeOp(del); return
    }
    if (tool.value === 'polygon') {
      const first = buffer[0], hit = pointUnder(e)
      if (hit && hit === first && buffer.length >= 3) { emitPolygon(); return }
      buffer.push(ensurePoint(e)); await render(); return
    }
    if (tool.value === 'perpendicular' || tool.value === 'parallel') {
      if (buffer.length === 0) {
        const ln = lineUnder(e)
        if (!ln) { flash('请先点一条已有的线段/直线'); return }
        buffer.push(ln); flash('再点一个点'); return
      }
      const pid = ensurePoint(e)
      ops.value.push({ id: newId(), type: tool.value, line: buffer[0], point: pid })
      buffer = []; await render(); return
    }
    // 通用：收集 N 个点
    const need = TWO[tool.value] ? 2 : (THREE[tool.value] ? 3 : 0)
    if (need) {
      buffer.push(ensurePoint(e)); await render()
      if (buffer.length === need) emitMulti()
    }
  }

  function emitMulti() {
    const b = buffer.slice(); buffer = []
    const t = tool.value
    if (t === 'circle') ops.value.push({ id: newId(), type: 'circle', center: b[0], through: b[1] })
    else if (t === 'angle') ops.value.push({ id: newId(), type: 'angle', points: b })
    else if (t === 'rightangle') ops.value.push({ id: newId(), type: 'angle', points: b, right: true })
    else if (t === 'midpoint') ops.value.push({ id: newId(), type: 'midpoint', points: b, label: nextLabel() })
    else if (t === 'circumcircle') ops.value.push({ id: newId(), type: 'circumcircle', points: b })
    else if (t === 'anglebisector') ops.value.push({ id: newId(), type: 'anglebisector', points: b })
    else ops.value.push({ id: newId(), type: t, points: b })
    void render()
  }
  function emitPolygon() {
    ops.value.push({ id: newId(), type: 'polygon', points: buffer.slice() })
    buffer = []; void render()
  }

  // 删除某 op + 级联删引用它的（防悬挂）
  function removeOp(id: string) {
    const gone: Record<string, number> = { [id]: 1 }
    let changed = true
    while (changed) {
      changed = false
      ops.value.forEach((o) => {
        if (gone[o.id]) return
        const refs = ([] as any[]).concat(o.points || [], o.center || [], o.through || [], o.line || [], o.point || [], o.of || [], o.at || [], o.on || [])
        if (refs.some((r) => gone[r])) { gone[o.id] = 1; changed = true }
      })
    }
    ops.value = ops.value.filter((o) => !gone[o.id])
    void render()
  }

  /* ---------- 拖动回写 ---------- */
  function bindBoard() {
    if (!view) return
    const bd = view.board as any
    bd.on('down', onDown)
    bd.on('up', () => {
      if (!view) return
      if (isDraw() && tool.value !== 'select') return
      let dirty = false
      ops.value.forEach((o) => {
        if (o.type === 'point' && view!.reg.obj[o.id]) {
          const g: any = view!.reg.obj[o.id]
          const nx = gridSnap(g.X()), ny = gridSnap(g.Y())
          if (nx !== o.coords[0] || ny !== o.coords[1]) { o.coords = [nx, ny]; dirty = true }
        }
      })
      try { bbox.value = bd.getBoundingBox().map((v: number) => Math.round(v * 100) / 100) as any } catch { /* noop */ }
      if (dirty) void render(); else emitChange()
    })
  }

  /* ---------- 对外 ---------- */
  function emitChange() { opts.onChange?.(getSpec()) }
  function getSpec(): GeoSpec {
    return { bbox: bbox.value, axis: opts.axis.value, grid: opts.grid.value, objects: JSON.parse(JSON.stringify(ops.value)) }
  }
  function loadSpec(input: GeoSpec | { build?: unknown[] } | null) {
    let o: any = input ? JSON.parse(JSON.stringify(input)) : { objects: [] }
    if (o.build && (window as any).FigureBuilder) o = (window as any).FigureBuilder.expand(o) // 高层构件→低层可编辑图元
    ops.value = o.objects || []
    if (o.bbox) bbox.value = o.bbox
    seq = 0
    ops.value.forEach((op) => { const m = /^o(\d+)$/.exec(op.id || ''); if (m) seq = Math.max(seq, +m[1]) })
    buffer = []
    void render()
  }
  function setTool(t: GeoTool) {
    tool.value = t; buffer = []
    hint.value = TOOL_HINTS[t] || ''
    applyToolMode()
  }
  function undo() { if (buffer.length) buffer.pop(); else ops.value.pop(); void render() }
  function clear() { ops.value = []; buffer = []; void render() }
  function flash(msg: string, cls = '') { status.value = msg; void cls }
  function setPrompt(fn: (msg: string) => Promise<string | null>) { promptText = fn }

  async function exportPNG(scale = 2): Promise<string> {
    if (!view) throw new Error('board 未就绪')
    return engineExportPNG(view.board, scale)
  }
  function exportSVG(): string {
    if (!view) throw new Error('board 未就绪')
    return engineExportSVG(view.board)
  }
  function destroy() { if (view && view.board) { try { JXG().JSXGraph.freeBoard(view.board) } catch { /* noop */ } } view = null }

  return {
    // 状态
    tool, ops, bbox, hint, status,
    // 生命周期
    render, destroy,
    // 交互
    setTool, undo, clear, loadSpec, getSpec, setPrompt,
    // 导出
    exportPNG, exportSVG,
    // 元信息
    TOOL_HINTS
  }
}
