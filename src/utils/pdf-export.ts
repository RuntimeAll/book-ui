// Q' 卡 §0.4 misikt 同源 PDF 工艺管线 — jsPDF + html2canvas
//
// 工艺铁律（按 misikt 真站铁证 / Q 卡踩过的坑反推）：
//   ① 等 MathJax typeset 完成 — 否则截图到原始 \frac 文本
//   ② 等所有 <img> onload 完成 — 否则截图到 broken image
//   ③ html2canvas scale=2 + useCORS:true + allowTaint:false — 高倍率 + 跨域 CDN 透传
//   ④ jsPDF a4 分页 + 每页内容区上下各留 10mm 边距 + 不把一道题拦腰截断
//   ⑤ pdf.save(`${paperName}.pdf`)
//
// 🔴 2026-06-05 大卷+解析「内容空白」根因修复（用户排查：组卷好的大卷带解析导出，解析没兼容进来）：
//   旧版 = 单次 html2canvas 截整份 DOM。题量大 + 开解析时单题高度≈翻倍，整份 DOM 高度暴涨，
//   ×scale2 后超 Chrome canvas 最大维度 65535px（实测 87 题带解析 = 44688css×2 = 89376px），
//   Chrome 静默拒绝分配超限 canvas → html2canvas 产出「整张空白」画布 → PDF 整体/尾部全白。
//   「带解析才坏」是因为解析约让每题高度翻倍，正好把大卷推过 65535 阈值（不带解析时减半多能勉强不超）。
//   修法 = 把整份 DOM 按高度切成若干「带」（每带 ×scale 后 < 65535），逐带 html2canvas（scale 仍=2 不掉质量），
//   再把各带在 CSS 坐标系里无缝拼接，按 A4 页 + 题边界断点切页（跨带的页用两次 drawImage 拼）。
//   带数 = ceil(总高/带预算)，87 题→2 带、540 题→约 10 带，远比「逐题 87 次截图」快，也彻底绕开 65535。
//
// jsPDF 实装版本 = 4.2.1（PRD §3.2 沉淀坑 #6），遵守 2.5.1 兼容子集 API：
//   new jsPDF({orientation,unit,format}) / addImage(canvas,'PNG',x,y,w,h) / save(filename)
//
// 🔴 PRD-A-013 T4 (H-4)：jspdf + html2canvas 改 dynamic import，避免占首屏 chunk 530KB。
//   仅 type-only 静态 import 保留（编译期擦除，0 运行时影响 + 0 chunk 占用）。
//   配合 vite.config.ts manualChunks 'pdf-vendor' 把二者切到独立 chunk，
//   首次进入 home / workspace 等页面 Network 看不到 jspdf*，点导出 PDF 才按需加载。

import { typesetPaperPreview } from './mathjax'

export interface PdfExportOptions {
  root: HTMLElement
  filename: string  // 不含 .pdf 后缀
  onProgress?: (msg: string) => void
}

// 🔴 用户铁则（2026-05-23）：绝对禁压缩图片质量 — scale=2 高分辨率 + PNG 无损（memory feedback_no_image_quality_compression）
const SCALE = 2
// 单带 CSS 高度预算：×SCALE 后须 < Chrome 65535 维度上限，留足余量取 28000（×2=56000）。
const BAND_BUDGET_CSS = 28000

async function waitAllImagesLoaded(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map(img => {
      // 🔴 坑 #7：CORS fail 时 img.complete=true 但 naturalWidth=0，event 已发生不再触发 — 必须只判 complete
      if (img.complete) return Promise.resolve()
      return new Promise<void>(resolve => {
        const done = () => resolve()
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      })
    })
  )
}

export async function exportPaperToPdf(options: PdfExportOptions): Promise<void> {
  const { root, filename, onProgress } = options

  // 🔴 PRD-A-013 T4 (H-4)：jspdf + html2canvas 动态加载（首屏免背 530KB）。
  // Promise.all 并行下载两个 chunk（pdf-vendor 已被 vite manualChunks 合到一起，实际只 1 个 HTTP 请求）。
  onProgress?.('加载导出引擎…')
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ])

  onProgress?.('等待公式渲染…')
  await typesetPaperPreview(root)

  onProgress?.('等待图片加载…')
  await waitAllImagesLoaded(root)

  // ── 几何测量（CSS px，相对 root 顶）──────────────────────────────────────────
  const rootRect = root.getBoundingClientRect()
  const rootWidthCss = root.scrollWidth || rootRect.width
  const rootHeightCss = root.scrollHeight

  // 题边界断点（每道题底部 Y）= 安全切页点，保证分页不把一道题拦腰截断
  const questionEls = Array.from(root.querySelectorAll('.pp-question')) as HTMLElement[]
  const breakYsCss = questionEls
    .map(el => el.getBoundingClientRect().bottom - rootRect.top)
    .filter(y => y > 0 && y <= rootHeightCss)
    .sort((a, b) => a - b)

  // ── 逐带 html2canvas（每带 ×SCALE 后 < 65535，规避整份单 canvas 超限）──────────
  onProgress?.('生成截图…')
  const bandCount = Math.max(1, Math.ceil(rootHeightCss / BAND_BUDGET_CSS))
  interface Band { startCss: number; endCss: number; canvas: HTMLCanvasElement }
  const bands: Band[] = []
  for (let b = 0; b < bandCount; b++) {
    const startCss = b * BAND_BUDGET_CSS
    const endCss = Math.min((b + 1) * BAND_BUDGET_CSS, rootHeightCss)
    const heightCss = endCss - startCss
    if (heightCss <= 0) continue
    if (bandCount > 1) onProgress?.(`生成截图… (${b + 1}/${bandCount})`)
    // eslint-disable-next-line no-await-in-loop
    const canvas = await html2canvas(root, {
      scale: SCALE,
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#ffffff',
      logging: false,
      // 关键：x/y/width/height 把输出 canvas 裁到「带」尺寸 → 分配的 canvas 仅带高，绝不超 65535
      x: 0,
      y: startCss,
      width: rootWidthCss,
      height: heightCss,
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
    })
    bands.push({ startCss, endCss, canvas })
  }
  if (bands.length === 0) throw new Error('试卷内容为空，无法导出')

  // CSS px → canvas px 比例（各带统一 scale，用第一带反推，避免 0 高度带误差）
  const cssToCanvas = bands[0].canvas.height / (bands[0].endCss - bands[0].startCss)
  const canvasWidthPx = bands[0].canvas.width

  // ── jsPDF A4 分页 ───────────────────────────────────────────────────────────
  onProgress?.('生成 PDF…')
  const a4WidthMm = 210
  const a4HeightMm = 297
  const marginMm = 10
  const contentWidthMm = a4WidthMm - marginMm * 2   // 190
  const contentHeightMm = a4HeightMm - marginMm * 2 // 277
  // 一页内容区对应的 CSS 高度（整份宽度 = contentWidthMm，故 cssPerMm = rootWidthCss/contentWidthMm）
  const pageContentHeightCss = contentHeightMm * (rootWidthCss / contentWidthMm)

  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true })
  // compress:true 仅对 PDF 字节流做 zlib（FlateDecode，无损）— 不是 JPEG 有损，守住「禁压缩图片质量」铁则

  // 给定页起点（CSS），求页终点：落在「最靠近一整页、又不超」的题边界上；单题高于整页则只能硬切
  function nextPageEndCss(startCss: number): number {
    const maxEnd = startCss + pageContentHeightCss
    if (maxEnd >= rootHeightCss) return rootHeightCss
    let chosen = -1
    for (const y of breakYsCss) {
      if (y > startCss + 1 && y <= maxEnd) chosen = y
      else if (y > maxEnd) break
    }
    return chosen > startCss ? chosen : maxEnd
  }

  // 把 CSS 区间 [startCss,endCss] 从相关带拷进一张页 canvas（跨带则多次 drawImage 拼接）
  function renderPageCanvas(startCss: number, endCss: number): HTMLCanvasElement {
    const sliceHeightPx = Math.max(1, Math.round((endCss - startCss) * cssToCanvas))
    const pageCanvas = document.createElement('canvas')
    pageCanvas.width = canvasWidthPx
    pageCanvas.height = sliceHeightPx
    const ctx = pageCanvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context 不可用')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    for (const band of bands) {
      const ovStart = Math.max(startCss, band.startCss)
      const ovEnd = Math.min(endCss, band.endCss)
      if (ovEnd <= ovStart) continue
      const srcY = Math.round((ovStart - band.startCss) * cssToCanvas)
      const srcH = Math.round((ovEnd - ovStart) * cssToCanvas)
      const destY = Math.round((ovStart - startCss) * cssToCanvas)
      if (srcH <= 0) continue
      ctx.drawImage(band.canvas, 0, srcY, canvasWidthPx, srcH, 0, destY, canvasWidthPx, srcH)
    }
    return pageCanvas
  }

  let pageStartCss = 0
  let pageIndex = 0
  while (pageStartCss < rootHeightCss - 0.5) {
    const pageEndCss = nextPageEndCss(pageStartCss)
    const sliceCss = pageEndCss - pageStartCss
    if (sliceCss <= 0) break

    const pageCanvas = renderPageCanvas(pageStartCss, pageEndCss)
    // 🔴 PNG 无损编码，禁压缩图片质量（memory feedback_no_image_quality_compression）
    const imgData = pageCanvas.toDataURL('image/png')
    const imgHeightMm = sliceCss * (contentWidthMm / rootWidthCss)

    if (pageIndex > 0) pdf.addPage()
    pdf.addImage(imgData, 'PNG', marginMm, marginMm, contentWidthMm, imgHeightMm)

    pageStartCss = pageEndCss
    pageIndex++
  }

  onProgress?.('保存文件…')
  pdf.save(`${filename}.pdf`)
}
