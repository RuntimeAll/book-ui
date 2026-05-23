// MathJax 3.x typeset wrapper — Q' 卡 §0 用户拍板 LaTeX 走 MathJax 3.x（misikt 同源）
//
// 用法：
//   import { typesetPaperPreview } from '@/utils/mathjax'
//   await typesetPaperPreview(previewRoot.value)
//
// 配套：index.html 加载 MathJax 3 CDN + 全局 window.MathJax config（startup.typeset:false）

declare global {
  interface Window {
    MathJax?: {
      startup?: { promise?: Promise<void> }
      typesetPromise?: (elements?: HTMLElement[]) => Promise<void>
      typesetClear?: (elements?: HTMLElement[]) => void
    }
  }
}

export async function waitMathJaxReady(timeoutMs = 8000): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const start = Date.now()
  // CDN 异步加载，window.MathJax 可能晚于业务页 mounted 才注入
  while (!window.MathJax) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise(r => setTimeout(r, 100))
  }
  try {
    await window.MathJax.startup?.promise
    return true
  } catch (e) {
    console.warn('[mathjax] startup promise rejected', e)
    return false
  }
}

export async function typesetPaperPreview(root: HTMLElement): Promise<void> {
  const ready = await waitMathJaxReady()
  if (!ready || !window.MathJax) {
    console.warn('[mathjax] not ready, skip typeset')
    return
  }
  try {
    window.MathJax.typesetClear?.([root])
    await window.MathJax.typesetPromise?.([root])
  } catch (e) {
    console.error('[mathjax] typeset failed', e)
  }
}
