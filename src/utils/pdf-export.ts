// Q' 卡 §0.4 misikt 同源 PDF 工艺管线 — jsPDF + html2canvas
//
// 工艺铁律（按 misikt 真站铁证 / Q 卡踩过的坑反推）：
//   ① 等 MathJax typeset 完成 — 否则截图到原始 \frac 文本
//   ② 等所有 <img> onload 完成 — 否则截图到 broken image
//   ③ html2canvas scale=2 + useCORS:true + allowTaint:false — 高倍率 + 跨域 CDN 透传
//   ④ jsPDF a4 分页（按页高度切片 addImage）+ 每页内容区上下各留 10mm 边距
//   ⑤ pdf.save(`${paperName}.pdf`)
//
// jsPDF 实装版本 = 4.2.1（PRD §3.2 沉淀坑 #6），遵守 2.5.1 兼容子集 API：
//   new jsPDF({orientation,unit,format}) / addImage(canvas,'PNG',x,y,w,h) / save(filename)

import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { typesetPaperPreview } from './mathjax'

export interface PdfExportOptions {
  root: HTMLElement
  filename: string  // 不含 .pdf 后缀
  onProgress?: (msg: string) => void
}

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

  onProgress?.('等待公式渲染…')
  await typesetPaperPreview(root)

  onProgress?.('等待图片加载…')
  await waitAllImagesLoaded(root)

  onProgress?.('生成截图…')
  // 🔴 分页断点测量（必须在 html2canvas 之前，DOM 还在原位时取几何）：
  //   收集每道题 .pp-question 的「底部 Y」（css px，相对 root 顶）作为安全切页点，
  //   保证分页时不把一道题拦腰截断（旧版按固定 A4 高度硬切，跨页题被切断）。
  const rootRect = root.getBoundingClientRect()
  const questionEls = Array.from(root.querySelectorAll('.pp-question')) as HTMLElement[]
  const breakYsCss = questionEls
    .map(el => el.getBoundingClientRect().bottom - rootRect.top)
    .filter(y => y > 0)

  // 🔴 用户铁则（2026-05-23）：绝对禁压缩图片质量，除非用户明确同意
  //   scale=2 高分辨率截图（不擅自降）；PNG 无损编码（不擅自 JPEG）
  //   体积大可接受，质量损失绝对不可接受 — memory feedback_no_image_quality_compression
  const canvas = await html2canvas(root, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#ffffff',
    logging: false,
  })

  onProgress?.('生成 PDF…')
  // 🔴 用户铁则：禁压缩图片质量。
  // compress:true 是 jsPDF 对 PDF 流的 zlib 压缩（FlateDecode）— 完全无损，跟 PNG 的 zlib 一样
  // 不影响图像 quality（不是 JPEG 那种有损），只是把 PDF 容器里的字节流再 zlib 一次
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true })

  const a4WidthMm = 210
  const a4HeightMm = 297
  const marginMm = 10

  const imgWidthMm = a4WidthMm - marginMm * 2
  const pxPerMm = canvas.width / imgWidthMm
  const pageContentHeightMm = a4HeightMm - marginMm * 2
  const pageContentHeightPx = Math.floor(pageContentHeightMm * pxPerMm)

  // css px → canvas px 的缩放比（canvas 是 root 整体 scrollHeight × html2canvas scale）
  const cssToCanvas = canvas.height / root.scrollHeight
  const breakYsPx = breakYsCss
    .map(y => Math.round(y * cssToCanvas))
    .filter(y => y > 0 && y <= canvas.height)
    .sort((a, b) => a - b)

  // 给定一页起点 yStart，求该页终点：优先落在「最靠近一整页高度、又不超出」的题目边界上，
  // 不切断题目；若单题本身高于一整页（无边界可落）则只能硬切一整页（不可避免）。
  function nextPageEnd(yStart: number): number {
    const maxEnd = yStart + pageContentHeightPx
    if (maxEnd >= canvas.height) return canvas.height
    let chosen = -1
    for (const y of breakYsPx) {
      if (y > yStart && y <= maxEnd) chosen = y
      else if (y > maxEnd) break
    }
    return chosen > yStart ? chosen : maxEnd
  }

  let yOffsetPx = 0
  let pageIndex = 0

  // 🔴 用户铁则（2026-05-23）：PNG 无损编码，禁压缩图片质量
  //   toDataURL('image/png') 默认无损 — 体积大可接受，质量损失绝对不可接受
  //   memory feedback_no_image_quality_compression
  while (yOffsetPx < canvas.height) {
    const yEnd = nextPageEnd(yOffsetPx)
    const sliceHeightPx = yEnd - yOffsetPx

    const pageCanvas = document.createElement('canvas')
    pageCanvas.width = canvas.width
    pageCanvas.height = sliceHeightPx
    const ctx = pageCanvas.getContext('2d')
    if (!ctx) {
      throw new Error('canvas 2d context 不可用')
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    ctx.drawImage(canvas, 0, yOffsetPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx)

    const imgData = pageCanvas.toDataURL('image/png')
    const imgHeightMm = sliceHeightPx / pxPerMm

    if (pageIndex > 0) pdf.addPage()
    pdf.addImage(imgData, 'PNG', marginMm, marginMm, imgWidthMm, imgHeightMm)

    yOffsetPx = yEnd
    pageIndex++
  }

  onProgress?.('保存文件…')
  pdf.save(`${filename}.pdf`)
}
