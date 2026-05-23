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
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const a4WidthMm = 210
  const a4HeightMm = 297
  const marginMm = 10

  const imgWidthMm = a4WidthMm - marginMm * 2
  const pxPerMm = canvas.width / imgWidthMm
  const pageContentHeightMm = a4HeightMm - marginMm * 2
  const pageContentHeightPx = Math.floor(pageContentHeightMm * pxPerMm)

  let yOffsetPx = 0
  let pageIndex = 0

  // 🔴 用户铁则（2026-05-23）：PNG 无损编码，禁压缩图片质量
  //   toDataURL('image/png') 默认无损 — 体积大可接受，质量损失绝对不可接受
  //   memory feedback_no_image_quality_compression
  while (yOffsetPx < canvas.height) {
    const sliceHeightPx = Math.min(pageContentHeightPx, canvas.height - yOffsetPx)

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

    yOffsetPx += sliceHeightPx
    pageIndex++
  }

  onProgress?.('保存文件…')
  pdf.save(`${filename}.pdf`)
}
