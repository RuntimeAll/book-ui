<script setup lang="ts">
/**
 * PaperBasket — 试卷篮全局浮动按钮 + dialog 容器（R 卡段③ + 段③'）
 *
 * 设计：镜像 QuestionBasket，基于 usePaperBasket composable（module-scoped singleton），
 * 在 AppLayout 全局挂载一次，任意页面调 add/remove 实时联动 FAB 角标 + dialog 列表。
 *
 * 模板源：D:\workplace\book-ai\codeSpace\book-ui\src\components\business\QuestionBasket\index.vue
 * 差异：
 *   - 配色：试题栏蓝 → 试卷篮绿（#10b981 主，#059669 暗）
 *   - FAB 位置：right: 130px（试题栏 right: 40px，水平错开避免重叠）— PRD §12.1 Q7
 *   - dialog 列：卷名 / 题数 / 学科 / FreeTags / 创建时间 / 移除
 *   - 段③ 范围 = 基础 FAB+dialog
 *   - 段③' 范围 = footer 加 2 个批量按钮（批量合卷 / 批量导 PDF）+ ElMessageBox.prompt
 *     收新卷名 / 文件名 → emit 事件 → 段④' / 段⑤' worker 后续接真逻辑
 *
 * 段② 实际暴露的 API（usePaperBasket）：
 *   - count: ComputedRef<number>            (角标数量，对齐 useQuestionBasket)
 *   - items: ComputedRef<PaperListItem[]>   (篮内卷头列表，含 LS 缓存占位 + refreshFromServer 后补齐)
 *   - dialogVisible: Ref<boolean>           (全局 singleton dialog 显隐)
 *   - openDialog / closeDialog: () => void
 *   - add(paper) / remove(paperId) / clear(): Promise<void>
 *   - refreshFromServer(): Promise<void>    (dialog 打开时调，BE → _cache + _basketIds)
 *
 * 注：任务 prompt 字面 API 名 (cancel/queryBasket/empty/basketNum) 与段② 实装
 *   (remove/refreshFromServer/clear/count) 不一致 — 以 vue-tsc 编译真相为准。
 *
 * emit 事件契约 (段④' 后状态)：
 *   - export-pdf (payload: { fileName: string; paperIds: number[] })
 *     段⑤' worker 接：jsPDF 拼合多卷 → 单 PDF
 *   - merge-papers: 已于段④' 内化, 不再 emit (PRD §3.5 Q3 拍板 FE 编排
 *     queryBasket + 每卷 detail + create 三连, 组件内直接处理 + router.push + basket.clear)
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElLoading } from 'element-plus'
import { Tickets, Delete, Close, DocumentCopy, Download } from '@element-plus/icons-vue'
import { usePaperBasket } from '@/composables/usePaperBasket'
import FreeTagList, { type FreeTagItem } from '@/components/business/FreeTagList/index.vue'
import type { PaperListItem } from '@/api/paper/index'
import { createExamPaper } from '@/api/paper/index'
import { getPaperDetail, type PaperDetailVo, type PaperSourceQuestion } from '@/api/question/index'
import { exportPaperToPdf } from '@/utils/pdf-export'
import { proxyImage } from '@/utils/image-proxy'

// ── 段④'/⑤' 完工后, emit 全部内化, 组件不再 emit 任何事件 ─────────────
//   - merge-papers: 已于段④' 内化 (FE 编排 detail+create)
//   - export-pdf: 已于段⑤' 内化 (FE 编排 detail + exportPaperToPdf)

const basket = usePaperBasket()
const router = useRouter()
const loading = ref(false)

// ── 段③' header 概要：篮内 N 卷 / 预计 M 题 (sum questionCount) ──
// 让用户在点"批量合卷"前心里有数（合卷 BE 接口可能超时阈值 ~ 数百题）
const totalQuestions = computed(() =>
  basket.items.value.reduce((sum, p) => sum + (p.questionCount || 0), 0),
)

// dialog 打开时主动从 BE 拉真实卷头（补齐 LS 占位 + 软删卷消失）
async function handleOpen(): Promise<void> {
  basket.openDialog()
  loading.value = true
  try {
    await basket.refreshFromServer()
  } finally {
    loading.value = false
  }
}

function handleClose(): void {
  basket.closeDialog()
}

async function handleRemove(paperId: number): Promise<void> {
  try {
    await basket.remove(paperId)
  } catch (e) {
    console.warn('[paper-basket] remove failed', e)
    ElMessage.error('移除失败，请重试')
  }
}

// ── 段④' 批量合卷出口 A — STD Q3 拍板 FE 编排 (queryBasket→每卷detail→flatten去重→create) ─────
//   段③' 原本 emit 出去, 段④' 改成内部直接处理 (PRD §3.5 Q3: 先 FE 编排不动 BE 一站式)
//   流程: 确认弹窗 → ElLoading → 串行拉 N 卷 detail → flatten + Set 去重保首次顺序
//          → createExamPaper → router.push + basket.clear() + dialog 关闭
//   失败: ElMessageBox.alert + 不清空筐 (用户可重试)
async function handleMergePapers(): Promise<void> {
  if (basket.items.value.length === 0) {
    ElMessage.info('试卷篮已为空，请先加卷')
    return
  }
  const paperIds = basket.items.value.map((p) => p.id)
  const paperCount = paperIds.length
  const estimatedQuestions = totalQuestions.value

  // Step 0: 确认弹窗 — 让用户预知合卷规模 + 去重后题数可能少于此数
  try {
    await ElMessageBox.confirm(
      `将合并 ${paperCount} 卷，预计 ${estimatedQuestions} 题，去重后可能少于此数。是否继续？`,
      '批量合卷确认',
      {
        type: 'info',
        confirmButtonText: '继续',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return // 用户取消
  }

  // Step 1: 输入新卷名
  const defaultName = `合卷-${paperCount}卷-${new Date().toISOString().slice(0, 10)}`
  let nameResult: { value: string } | undefined
  try {
    nameResult = (await ElMessageBox.prompt('请输入新卷名', '批量合卷', {
      type: 'info',
      confirmButtonText: '合卷',
      cancelButtonText: '取消',
      inputValue: defaultName,
      inputValidator: (v: string) => {
        if (!v || !v.trim()) return '卷名不能为空'
        if (v.trim().length > 80) return '卷名不超过 80 字符'
        return true
      },
    })) as { value: string }
  } catch {
    return // 用户取消
  }
  const newName = (nameResult?.value || '').trim()
  if (!newName) return

  // Step 2-4: 拉详情串行 + flatten 去重 + create
  // ElLoading 全屏锁定, 文案实时反映进度 (拉取第 N/M → 合卷中 → 跳转中)
  const loadingInstance = ElLoading.service({
    lock: true,
    text: `正在拉取第 1/${paperCount} 卷...`,
    background: 'rgba(255, 255, 255, 0.85)',
  })

  try {
    // Step 2: 串行拉 N 卷 detail (顺序保证 — Promise.all 并发也可, 但串行更稳, 避免 BE 突发负载)
    const details: PaperDetailVo[] = []
    for (let i = 0; i < paperIds.length; i++) {
      loadingInstance.setText(`正在拉取第 ${i + 1}/${paperCount} 卷...`)
      try {
        const d = await getPaperDetail(paperIds[i])
        if (!d || !(d as { paperId?: unknown }).paperId) {
          throw new Error(`卷 ${paperIds[i]} 返回数据为空`)
        }
        details.push(d as PaperDetailVo)
      } catch (e) {
        loadingInstance.close()
        console.warn('[paper-basket] getPaperDetail failed', paperIds[i], e)
        await ElMessageBox.alert(
          `拉取第 ${i + 1}/${paperCount} 卷 (id=${paperIds[i]}) 详情失败，已中止合卷。试卷篮内容已保留，可稍后重试。`,
          '合卷失败',
          { type: 'error', confirmButtonText: '知道了' },
        )
        return
      }
    }

    // Step 3: flatten + Set 去重保首次出现顺序 (PRD §3.5 出口A 去重策略)
    loadingInstance.setText('正在合卷...')
    const seenIds = new Set<number>()
    const dedupedQuestionIds: number[] = []
    for (const d of details) {
      const sections = Array.isArray(d.sections) ? d.sections : []
      for (const section of sections) {
        const questions = Array.isArray(section.questions) ? section.questions : []
        for (const q of questions) {
          const qid = Number(q?.id)
          if (!qid || seenIds.has(qid)) continue
          seenIds.add(qid)
          dedupedQuestionIds.push(qid)
        }
      }
    }

    if (dedupedQuestionIds.length === 0) {
      loadingInstance.close()
      await ElMessageBox.alert(
        '所选试卷均无可用题目，无法生成合卷。',
        '合卷失败',
        { type: 'warning', confirmButtonText: '知道了' },
      )
      return
    }

    // Step 4: createExamPaper
    let createResult: { paperId: number; questionCount: number }
    try {
      createResult = await createExamPaper({
        name: newName,
        questionIds: dedupedQuestionIds,
      })
    } catch (e) {
      loadingInstance.close()
      console.warn('[paper-basket] createExamPaper failed', e)
      await ElMessageBox.alert(
        '合卷接口调用失败，请检查网络或稍后重试。试卷篮内容已保留。',
        '合卷失败',
        { type: 'error', confirmButtonText: '知道了' },
      )
      return
    }

    if (!createResult?.paperId) {
      loadingInstance.close()
      await ElMessageBox.alert(
        '合卷接口返回数据异常 (无 paperId)。试卷篮内容已保留。',
        '合卷失败',
        { type: 'error', confirmButtonText: '知道了' },
      )
      return
    }

    // Step 5: 成功 — 跳转 + 清空 + 关闭
    loadingInstance.setText('跳转中...')
    ElMessage.success(
      `合卷成功！新卷共 ${createResult.questionCount ?? dedupedQuestionIds.length} 题`,
    )
    try {
      await basket.clear()
    } catch (e) {
      console.warn('[paper-basket] clear after merge failed (non-blocking)', e)
    }
    basket.closeDialog()
    loadingInstance.close()
    router.push(`/papers/source/${createResult.paperId}`)
  } catch (e) {
    // 兜底捕获 (理论上各步已自处理)
    loadingInstance.close()
    console.error('[paper-basket] handleMergePapers unexpected error', e)
    ElMessage.error('合卷过程出现未知错误，试卷篮内容已保留')
  }
}

// ── 段③' 批量导 PDF：prompt 收文件名 → emit 'export-pdf' ──────
// ── 段⑤' 批量导 PDF 出口 B — STD Q3 拍板 FE 编排 + Q4 拍板单 PDF 拼合 ────────
//   段③' 原本 emit 出去, 段⑤' 改成内部直接处理 (复用 utils/pdf-export.ts Q' 卡工艺管线)
//   流程: 确认弹窗(N×10s 预警) → ElMessageBox.prompt 收文件名 → ElLoading
//          → 串行 getPaperDetail 拉 N 卷 (不去重 — 每卷独立 section)
//          → 建临时隐藏 DOM 渲染 N 卷 (每卷 page-break-before:always)
//          → exportPaperToPdf({root, filename}) 一锅拼单 PDF
//          → success: ElMessage.success + 不清空筐 (用户可重导/合卷)
//          → failure: ElMessageBox.alert + 不清空筐
//   铁则:
//     - 🔴 禁压缩图片质量 (用户 2026-05-23 铁则) — 不传 quality, 复用 pdf-export 现成无损管线
//     - jsPDF compress:true (Q' 卡 hotfix-7 沉淀, pdf-export.ts 已默认开)
//     - 不加新 npm 依赖 (jspdf + html2canvas Q' 卡已装)
async function handleExportPdf(): Promise<void> {
  if (basket.items.value.length === 0) {
    ElMessage.info('试卷篮已为空，请先加卷')
    return
  }
  const paperIds = basket.items.value.map((p) => p.id)
  const paperCount = paperIds.length
  const estimatedSeconds = paperCount * 10

  // Step 0: 确认弹窗 — 预警耗时 (每卷 ~10s 经验值, 含 typeset + img 等待 + html2canvas + jsPDF 分页)
  try {
    await ElMessageBox.confirm(
      `将导出 ${paperCount} 卷为单个 PDF，预计耗时 ${estimatedSeconds}s（${paperCount}×10s）。是否继续？`,
      '批量导 PDF 确认',
      {
        type: 'info',
        confirmButtonText: '继续',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return // 用户取消
  }

  // Step 1: 输入文件名 — 复用段③' 已验证的 inputValidator (非空/<=80字/禁 Windows 非法字符)
  let nameResult: { value: string } | undefined
  try {
    nameResult = (await ElMessageBox.prompt('请输入导出文件名（无需 .pdf 后缀）', '批量导 PDF', {
      type: 'info',
      confirmButtonText: '导出',
      cancelButtonText: '取消',
      inputValue: '试卷篮合集',
      inputValidator: (v: string) => {
        if (!v || !v.trim()) return '文件名不能为空'
        if (v.trim().length > 80) return '文件名不超过 80 字符'
        if (/[\\/:*?"<>|]/.test(v)) return '文件名不能含 \\ / : * ? " < > |'
        return true
      },
    })) as { value: string }
  } catch {
    return // 用户取消
  }
  const fileName = (nameResult?.value || '').trim()
  if (!fileName) return

  // Step 2: ElLoading 全屏 (锁定 + 实时刷文案)
  const loadingInstance = ElLoading.service({
    lock: true,
    text: `正在拉取第 1/${paperCount} 卷...`,
    background: 'rgba(255, 255, 255, 0.85)',
  })

  // Step 3-7: 串行拉 detail → 建隐藏 DOM → 导 PDF → 清理
  let pdfRoot: HTMLElement | null = null
  try {
    // Step 3: 串行 getPaperDetail (不去重 — 导 PDF 每卷独立 section, 跟合卷出口 A 语义不同)
    const details: PaperDetailVo[] = []
    for (let i = 0; i < paperIds.length; i++) {
      loadingInstance.setText(`正在拉取第 ${i + 1}/${paperCount} 卷...`)
      try {
        const d = await getPaperDetail(paperIds[i])
        if (!d || !(d as { paperId?: unknown }).paperId) {
          throw new Error(`卷 ${paperIds[i]} 返回数据为空`)
        }
        details.push(d as PaperDetailVo)
      } catch (e) {
        loadingInstance.close()
        console.warn('[paper-basket] getPaperDetail failed', paperIds[i], e)
        await ElMessageBox.alert(
          `拉取第 ${i + 1}/${paperCount} 卷 (id=${paperIds[i]}) 详情失败，已中止导出。试卷篮内容已保留，可稍后重试。`,
          '导出失败',
          { type: 'error', confirmButtonText: '知道了' },
        )
        return
      }
    }

    // Step 4: 建临时隐藏 DOM 容器 (off-screen, 不影响布局; MathJax typeset/html2canvas 看 DOM 节点不看 visibility)
    //   宽度 780px 模拟 A4 内容区宽 (210mm - 20mm 边距 = 190mm ≈ 780px @ scale≈4.1, 与 pdf-export 内部分页对齐)
    loadingInstance.setText('正在生成 PDF 渲染容器...')
    pdfRoot = document.createElement('div')
    pdfRoot.style.cssText = [
      'position:fixed',
      'left:-99999px',
      'top:0',
      'width:780px',
      'background:#ffffff',
      'padding:20px',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
      'color:#1d2129',
      'font-size:14px',
      'line-height:1.6',
    ].join(';')

    // Step 5: 拼 HTML — 每卷一个 section, 卷间 page-break-before:always 强制翻页
    //   纯图模式 (PRD §0.4 misikt 真站铁证, 与 PaperPreview 同源): stemImg + answerImg + explainImg
    //   不显示答案/解析 checkbox 状态 — 批量导默认全显 (PRD §3.5 出口 B 默认: 用户拿到完整教学版)
    //   图 URL 走 proxyImage 同源化 (hotfix-4, 避免 CORS canvas 污染) — 与 PaperPreview 同款
    pdfRoot.innerHTML = details.map((d, dIdx) => renderPaperHtml(d, dIdx)).join('')
    document.body.appendChild(pdfRoot)

    // Step 6: 调 exportPaperToPdf — 内部已处理 MathJax typeset + img onload 等待 + html2canvas + jsPDF 分页 + save
    //   onProgress 文案直接转发给 ElLoading
    loadingInstance.setText('正在渲染并生成 PDF...')
    await exportPaperToPdf({
      root: pdfRoot,
      filename: fileName,
      onProgress: (msg) => loadingInstance.setText(msg),
    })

    // Step 7: 成功 — 关 loading + toast + 不清空筐 (用户可能继续合卷 / 重导)
    loadingInstance.close()
    ElMessage.success('PDF 已下载')
  } catch (e) {
    loadingInstance.close()
    console.error('[paper-basket] handleExportPdf failed', e)
    const reason = e instanceof Error ? e.message : String(e)
    await ElMessageBox.alert(
      `PDF 导出失败：${reason}。试卷篮内容已保留，可稍后重试。`,
      '导出失败',
      { type: 'error', confirmButtonText: '知道了' },
    )
  } finally {
    // finally 清理临时 DOM (无论成败)
    if (pdfRoot && pdfRoot.parentNode) {
      pdfRoot.parentNode.removeChild(pdfRoot)
    }
  }
}

// ── PDF 渲染 helper — 单卷 → HTML 字符串 (纯图模式, 与 PaperPreview 同源) ────────
//   每卷为 <section>, 卷间 page-break-before:always 强制新页
//   题目按 sections[].questions 顺序 (BE 已按 sort 排序), 全卷连续编号
function renderPaperHtml(d: PaperDetailVo, dIdx: number): string {
  const pageBreak = dIdx > 0 ? 'page-break-before:always;' : ''
  const paperName = escapeHtml(d.paperName || `卷 ${d.paperId}`)
  let qGlobalIdx = 0
  const sectionsHtml = (Array.isArray(d.sections) ? d.sections : [])
    .map((section) => {
      const sectionTitle = escapeHtml(section.title || '')
      const questionsHtml = (Array.isArray(section.questions) ? section.questions : [])
        .map((q) => {
          qGlobalIdx++
          return renderQuestionHtml(q, qGlobalIdx)
        })
        .join('')
      return `<div style="margin-top:24px;">
        ${sectionTitle ? `<h3 style="font-size:16px;font-weight:600;margin:16px 0 12px;color:#1d2129;border-left:4px solid #10b981;padding-left:10px;">${sectionTitle}</h3>` : ''}
        ${questionsHtml}
      </div>`
    })
    .join('')
  return `<section style="${pageBreak}padding:16px 0;">
    <h2 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 8px;color:#1d2129;">${paperName}</h2>
    <div style="text-align:center;color:#86909c;font-size:12px;margin-bottom:16px;">共 ${d.questionCount || 0} 题</div>
    ${sectionsHtml}
  </section>`
}

// ── 单题 → HTML 字符串 (纯图模式) ──
//   stemImg 必显 (BE 端点已确保)
//   answerImg/explainImg 有则显, 无则占位 — 批量导默认全显
function renderQuestionHtml(q: PaperSourceQuestion, globalIdx: number): string {
  const typeLabel = questionTypeLabel(q.questionType)
  const stemImg = q.stemImg ? proxyImage(q.stemImg) : null
  const answerImg = q.answerImg ? proxyImage(q.answerImg) : null
  const explainImg = q.explainImg ? proxyImage(q.explainImg) : null
  return `<div style="margin-bottom:20px;padding:12px;border-bottom:1px solid #f2f3f5;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-weight:600;font-size:14px;color:#1d2129;">${globalIdx}.</span>
      <span style="font-size:12px;padding:2px 8px;background:#f4f4f5;color:#909399;border-radius:4px;">${escapeHtml(typeLabel)}</span>
    </div>
    <div style="margin:8px 0;">
      ${stemImg
        ? `<img src="${stemImg}" alt="题干图" crossorigin="anonymous" style="max-width:100%;height:auto;display:block;" />`
        : `<span style="color:#c9cdd4;font-size:12px;">（缺题干图）</span>`}
    </div>
    <div style="margin:8px 0;">
      <span style="font-weight:600;color:#1d2129;">【答案】</span>
      ${answerImg
        ? `<img src="${answerImg}" alt="答案图" crossorigin="anonymous" style="max-width:100%;height:auto;display:block;margin-top:4px;" />`
        : `<span style="color:#c9cdd4;font-size:12px;">（无答案图）</span>`}
    </div>
    <div style="margin:8px 0;">
      <span style="font-weight:600;color:#1d2129;">【解析】</span>
      ${explainImg
        ? `<img src="${explainImg}" alt="解析图" crossorigin="anonymous" style="max-width:100%;height:auto;display:block;margin-top:4px;" />`
        : `<span style="color:#c9cdd4;font-size:12px;">（无解析图）</span>`}
    </div>
  </div>`
}

// 题型 label — 与 PaperPreview 同源, 1=选择 2=判断 3=应用 4=填空 5=简答
function questionTypeLabel(type: number): string {
  if (type === 1) return '选择题'
  if (type === 2) return '判断题'
  if (type === 3) return '应用题'
  if (type === 4) return '填空题'
  if (type === 5) return '简答题'
  return `类型${type}`
}

// HTML escape — 防 paperName / sectionTitle 含 <>& 等字符破坏 innerHTML 结构
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function handleEmpty(): Promise<void> {
  if (basket.items.value.length === 0) {
    ElMessage.info('试卷篮已为空')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定清空试卷篮内 ${basket.items.value.length} 张试卷吗？`,
      '清空确认',
      {
        type: 'warning',
        confirmButtonText: '清空',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return // 用户取消
  }
  try {
    await basket.clear()
  } catch (e) {
    console.warn('[paper-basket] clear failed', e)
    ElMessage.error('清空失败，请重试')
  }
}

// ── PaperListItem 内可能含 freeTags 字段（BE PaperListItemVo 已附加，详 PRD §3.4 #3）
// PaperListItem 类型尚未声明 freeTags — 通过 helper 安全访问，避免动 src/api/paper/index.ts。
function getPaperFreeTags(paper: PaperListItem): FreeTagItem[] {
  const tags = (paper as unknown as { freeTags?: FreeTagItem[] | null }).freeTags
  return Array.isArray(tags) ? tags : []
}

// ── 展示 helper ─────────────────────────────────────────────
function formatCreateTime(t?: string | null): string {
  if (!t) return '-'
  // misikt 真站 createTime 形如 'YYYY-MM-DD'，已是字符串日期；不做时区转换。
  return t
}

function formatSubject(subjectId?: string | null): string {
  if (!subjectId) return '-'
  return subjectId
}
</script>

<template>
  <!-- ── FAB 试卷篮浮动按钮 ── -->
  <!-- 镜像 QuestionBasket 的 el-badge 包裹 + 绝对锚点策略；
       位置 right:130px（试题栏 right:40px → 水平错开 90px 避免重叠 + FAB 自身 64 宽留 26 间距）。
       PRD §12.1 Q7。 -->
  <el-badge
    class="paper-basket-fab-badge"
    :value="basket.count.value > 99 ? '99+' : basket.count.value"
    :hidden="basket.count.value === 0"
    :offset="[-10, 8]"
    type="danger"
  >
    <div
      class="paper-basket-fab"
      :class="{ 'has-items': basket.count.value > 0 }"
      @click="handleOpen"
    >
      <div class="fab-inner">
        <el-icon :size="20" color="#fff"><Tickets /></el-icon>
        <span class="fab-label">试卷篮</span>
      </div>
    </div>
  </el-badge>

  <!-- ── 试卷篮 dialog ── -->
  <el-dialog
    v-model="basket.dialogVisible.value"
    width="75%"
    :close-on-click-modal="false"
    class="paper-basket-dialog"
  >
    <template #header>
      <div class="paper-basket-dialog-header">
        <div class="paper-basket-dialog-title-area">
          <el-icon color="#10b981" :size="18"><Tickets /></el-icon>
          <span class="paper-basket-dialog-title">试卷篮</span>
          <el-tag type="success" size="small" round>{{ basket.items.value.length }} 卷</el-tag>
          <!-- 段③' 概要：让用户在批量合卷前心里有数（BE 合卷端点超时阈值 ~ 数百题） -->
          <span v-if="basket.items.value.length > 0" class="paper-basket-summary">
            篮内 {{ basket.items.value.length }} 卷 / 预计 {{ totalQuestions }} 题
          </span>
        </div>
      </div>
    </template>

    <div v-loading="loading" class="paper-basket-dialog-body">
      <el-empty
        v-if="!loading && basket.items.value.length === 0"
        description="试卷篮为空，请先在卷库中加卷"
      >
        <template #image>
          <el-icon style="font-size: 48px; color: #c9cdd4;"><Tickets /></el-icon>
        </template>
      </el-empty>
      <el-scrollbar v-else max-height="520px">
        <div
          v-for="paper in basket.items.value"
          :key="paper.id"
          class="paper-basket-item"
        >
          <div class="paper-basket-item-main">
            <div class="paper-basket-item-title">
              <span class="paper-name" :title="paper.name">{{ paper.name }}</span>
              <el-tag type="success" size="small" effect="plain" class="qcount-tag">
                {{ paper.questionCount }} 题
              </el-tag>
            </div>
            <div class="paper-basket-item-meta">
              <span class="meta-label">学科</span>
              <span class="meta-value">{{ formatSubject(paper.subjectId) }}</span>
              <span class="meta-divider">·</span>
              <span class="meta-label">创建</span>
              <span class="meta-value">{{ formatCreateTime(paper.createTime) }}</span>
            </div>
            <FreeTagList
              v-if="getPaperFreeTags(paper).length > 0"
              :tags="getPaperFreeTags(paper)"
              mode="list"
              class="paper-basket-item-tags"
            />
          </div>
          <div class="paper-basket-item-ops">
            <el-button
              size="small"
              type="danger"
              plain
              :loading="basket.isLoading(paper.id)"
              @click="handleRemove(paper.id)"
            >
              <el-icon><Close /></el-icon>移除
            </el-button>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <template #footer>
      <!-- 段③' footer 视觉分组：[批量合卷] [批量导PDF] | [清空] [关闭]
           左侧 = 业务操作（出口 A / B），右侧 = 收尾，用 el-divider 分隔 -->
      <div class="paper-basket-footer">
        <div class="paper-basket-footer-left">
          <el-button
            type="primary"
            :disabled="basket.count.value === 0"
            @click="handleMergePapers"
          >
            <el-icon><DocumentCopy /></el-icon>批量合卷
          </el-button>
          <el-button
            :disabled="basket.count.value === 0"
            @click="handleExportPdf"
          >
            <el-icon><Download /></el-icon>批量导 PDF
          </el-button>
        </div>
        <el-divider direction="vertical" class="paper-basket-footer-divider" />
        <div class="paper-basket-footer-right">
          <el-button
            :disabled="basket.count.value === 0"
            @click="handleEmpty"
          >
            <el-icon><Delete /></el-icon>清空
          </el-button>
          <el-button @click="handleClose">关闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ── FAB 浮动按钮（绿色，区分蓝色试题栏） ── */
/* 镜像 QuestionBasket 的 el-badge wrap fixed 锚点策略；
   right: 130px = 试题栏 right:40px + 自身 64 宽 + 26 间距，水平错开避免重叠 + 误点。 */
.paper-basket-fab-badge {
  position: fixed;
  bottom: 40px;
  right: 130px;
  z-index: 200;
  line-height: 0;
}

.paper-basket-fab {
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #10b981, #059669);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(16, 185, 129, 0.4);
  transition: all 0.25s ease;
}

.paper-basket-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(16, 185, 129, 0.5);
}

.fab-label {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.paper-basket-fab.has-items .fab-inner {
  animation: paper-fab-pulse 2s infinite;
}

@keyframes paper-fab-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(16, 185, 129, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(16, 185, 129, 0.6); }
}

/* ── 试卷篮 dialog ── */
.paper-basket-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-right: 32px;
}

.paper-basket-dialog-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.paper-basket-dialog-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

/* 段③' header 概要文本（紧贴 X 卷 tag 右侧）*/
.paper-basket-summary {
  margin-left: 12px;
  font-size: 12px;
  color: #86909c;
  white-space: nowrap;
}

.paper-basket-dialog-body {
  min-height: 120px;
  padding: 0 4px;
}

.paper-basket-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid #f2f3f5;
}

.paper-basket-item:last-child {
  border-bottom: none;
}

.paper-basket-item-main {
  flex: 1;
  min-width: 0; /* 防 flex item 撑爆 ellipsis 容器 */
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.paper-basket-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.paper-name {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qcount-tag {
  flex-shrink: 0;
}

.paper-basket-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #86909c;
  flex-wrap: wrap;
}

.meta-label {
  color: #c9cdd4;
}

.meta-value {
  color: #4e5969;
}

.meta-divider {
  color: #e5e6eb;
  margin: 0 4px;
}

.paper-basket-item-tags {
  margin-top: 2px;
}

.paper-basket-item-ops {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
}

/* 段③' footer 视觉分组：[批量合卷][批量导PDF] | [清空][关闭] */
.paper-basket-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.paper-basket-footer-left,
.paper-basket-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.paper-basket-footer-divider {
  height: 24px;
  margin: 0 4px;
}
</style>
