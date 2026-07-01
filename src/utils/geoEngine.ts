// geoEngine.ts — JSXGraph 中性几何 DSL 渲染引擎 · 懒加载封装（PRD-C-110 B1）
//
// 背景：举一反三配图从 GeoGebra 无头出 PNG（服务端数百 MB 内存 + 商用授权风险）切到
//   JSXGraph（LGPL 免费可商用、~1MB、客户端渲染）。引擎 = PRD-A-100 封装产物
//   `geo-dsl-render.js`（中性 JSON DSL → JSXGraph，零 eval 注入），已验 demo 7 图全通。
//
// 落点：引擎 3 个静态文件放 public/geo-engine/（jsxgraphcore.js ~1MB + jsxgraph.css + geo-dsl-render.js）。
//   本模块**懒加载**——首屏不下载 ~1MB，第一次真正要渲带图题时才动态注入 <link>+<script>，
//   注入只做一次（幂等，并发调用共享同一 Promise）。
//
// 用法：
//   import { ensureGeoEngine, renderDSL, exportPNG, exportState } from '@/utils/geoEngine'
//   const { board, reg } = await renderDSL(elOrId, spec)   // spec = 中性 JSON DSL
//   const png = await exportPNG(board)                     // data:image/png;base64,...（可上 OSS）
//   const state = exportState(reg)                         // 拖动后几何状态（存 blockJson）
//
// 契约：DSL schema 事实源 = geo-dsl-render.js 的 switch(o.type)（25 type 白名单）。
//   functiongraph.expr 走数学白名单（引擎内 new Function 限定单参 x，无任意 eval）。

/** 引擎暴露的全局对象形状（geo-dsl-render.js 挂在 window.GeoEngine）。 */
export interface GeoBoard {
  renderer: { svgRoot: SVGSVGElement }
  [k: string]: unknown
}
export interface GeoReg {
  obj: Record<string, unknown>
  exp: Record<string, () => [number, number]>
}
/** 渲染选项。editable=true → 几何点可拖编辑模式；readonly=true → 只读（藏几何顶点圆点，只留字母=教科书样式）。 */
export interface GeoRenderOpts {
  editable?: boolean
  readonly?: boolean
}
export interface GeoEngineGlobal {
  render(
    containerId: string | HTMLElement,
    spec: GeoSpec,
    opts?: GeoRenderOpts
  ): { board: GeoBoard; reg: GeoReg }
  exportState(reg: GeoReg): Record<string, [number, number]>
  exportPNG(board: GeoBoard, scale?: number): Promise<string>
  exportSVG(board: GeoBoard): string
  relabel(board: GeoBoard): void
}

/** 中性几何 DSL（宽松类型——schema 由引擎 switch 在运行期校验；这里只给上层最小约束）。
 *  可传低层 DSL（objects）或高层「构件 DSL」（build:[...]，由 window.FigureBuilder 展开）。 */
export interface GeoSpec {
  bbox?: [number, number, number, number]
  axis?: boolean
  grid?: boolean
  keepAspect?: boolean
  exportable?: boolean
  readonly?: boolean
  objects?: Array<Record<string, unknown>>
  /** 高层构件项数组（{ shape|add|mark|transform ... }）；非空则引擎自动经 FigureBuilder 展开成低层 objects。 */
  build?: Array<Record<string, unknown>>
  solid3d?: Record<string, unknown>
  [k: string]: unknown
}

/** window.FigureBuilder（figure-builder.js）——高层构件 DSL 展开器，可选依赖。 */
export interface FigureBuilderGlobal {
  expand(spec: GeoSpec): GeoSpec
}

declare global {
  interface Window {
    GeoEngine?: GeoEngineGlobal
    FigureBuilder?: FigureBuilderGlobal
    JXG?: unknown
  }
}

const BASE = '/geo-engine'
let loadPromise: Promise<GeoEngineGlobal> | null = null

function injectCss(href: string): void {
  if (document.querySelector(`link[data-geo-engine="${href}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.geoEngine = href
  document.head.appendChild(link)
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-geo-engine="${src}"]`) as HTMLScriptElement | null
    if (existing) {
      if (existing.dataset.loaded === '1') resolve()
      else {
        existing.addEventListener('load', () => resolve())
        existing.addEventListener('error', () => reject(new Error(`load fail: ${src}`)))
      }
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = false // 保序：jsxgraphcore 必须先于 geo-dsl-render 执行
    s.dataset.geoEngine = src
    s.addEventListener('load', () => {
      s.dataset.loaded = '1'
      resolve()
    })
    s.addEventListener('error', () => reject(new Error(`load fail: ${src}`)))
    document.head.appendChild(s)
  })
}

/**
 * 懒加载 JSXGraph + geo-dsl-render，返回 window.GeoEngine。
 * 幂等：多次调用共享同一 Promise；脚本/样式只注入一次。首次 ~1MB 下载在这里发生。
 */
export function ensureGeoEngine(): Promise<GeoEngineGlobal> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('geoEngine: no window (SSR)'))
  }
  if (window.GeoEngine) return Promise.resolve(window.GeoEngine)
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    injectCss(`${BASE}/jsxgraph.css`)
    await injectScript(`${BASE}/jsxgraphcore.js`) // 保序：core 必须先于 figure-builder / geo-dsl-render
    await injectScript(`${BASE}/figure-builder.js`) // 高层构件展开器（挂 window.FigureBuilder）
    await injectScript(`${BASE}/geo-dsl-render.js`)
    if (!window.GeoEngine) {
      loadPromise = null // 允许后续重试
      throw new Error('geoEngine: GeoEngine 未挂载（脚本加载异常）')
    }
    return window.GeoEngine
  })()
  return loadPromise
}

/**
 * 渲染一份中性 DSL 到容器（id 字符串或 HTMLElement）。返回 { board, reg }。
 * 容器须先有非零宽高（JSXGraph 按容器尺寸建板）。
 * 🔴 Bug③-b：opts.editable=true → 几何点可拖（编辑模式）；默认（不传）静态查看，不冒泡可拖圆点。
 */
export async function renderDSL(
  container: string | HTMLElement,
  spec: GeoSpec,
  opts?: GeoRenderOpts
): Promise<{ board: GeoBoard; reg: GeoReg }> {
  const engine = await ensureGeoEngine()
  return engine.render(container, spec, opts)
}

/** 导出当前画板 → PNG dataURL（客户端出图，可上 OSS 当题图）。 */
export async function exportPNG(board: GeoBoard, scale = 2): Promise<string> {
  const engine = await ensureGeoEngine()
  return engine.exportPNG(board, scale)
}

/** 导出拖动后的几何状态（存 blockJson）。 */
export function exportState(reg: GeoReg): Record<string, [number, number]> {
  if (!window.GeoEngine) throw new Error('geoEngine: 未加载，先 await ensureGeoEngine()')
  return window.GeoEngine.exportState(reg)
}

/** 导出当前画板 SVG 字符串（矢量图，可存题图/下载）。 */
export function exportSVG(board: GeoBoard): string {
  if (!window.GeoEngine) throw new Error('geoEngine: 未加载，先 await ensureGeoEngine()')
  return window.GeoEngine.exportSVG(board)
}

/** 重新跑一遍标签避让（拖动元素后手动校位用）。 */
export function relabel(board: GeoBoard): void {
  if (window.GeoEngine) window.GeoEngine.relabel(board)
}
