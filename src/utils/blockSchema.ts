/**
 * blockSchema.ts — 结构化网格块 schema 类型 + 解析/校验（PRD-A-015 §10.1）
 *
 * 🔒 共享契约（A-015 ∥ C-100 双分支锁定，不得私改；改动须同步三处见 PRD §10.1）：
 *   整题一份版本化 JSON：{ v:1, rows:[ { cells:[ <block> ] } ] }
 *   block 三型：
 *     text   { type:'text',   md:string }
 *     image  { type:'image',  url:string(https OSS), width:1-100, align:'left'|'center'|'right' }
 *     option { type:'option', label:string, content:(text|image)[] }
 *   布局语义：选项 N 列 = 一行放 N 个 option 块；图片位置 = 其在 rows/cells 次序；不存绝对坐标。
 */

export const BLOCK_SCHEMA_VERSION = 1

export type ImageAlign = 'left' | 'center' | 'right'

export interface TextBlock {
  type: 'text'
  md: string
}

export interface ImageBlock {
  type: 'image'
  url: string
  width: number // 1-100，占容器宽百分比
  align: ImageAlign
  caption?: string // 可选图序号，如"图①"/"图（1）"，多图题由数据侧回填
}

export interface OptionBlock {
  type: 'option'
  label: string // A|B|C|D|...
  content: Array<TextBlock | ImageBlock>
}

export type Block = TextBlock | ImageBlock | OptionBlock

export interface BlockRow {
  cells: Block[]
}

export interface QuestionBlockDoc {
  v: number
  rows: BlockRow[]
}

export const ALIGNS: readonly ImageAlign[] = ['left', 'center', 'right'] as const

/** 空文档（编辑器初始态） */
export function emptyDoc(): QuestionBlockDoc {
  return { v: BLOCK_SCHEMA_VERSION, rows: [] }
}

function isTextBlock(b: any): b is TextBlock {
  return b && b.type === 'text' && typeof b.md === 'string'
}

function isImageBlock(b: any): b is ImageBlock {
  return (
    b &&
    b.type === 'image' &&
    typeof b.url === 'string' &&
    typeof b.width === 'number' &&
    ALIGNS.includes(b.align)
  )
}

function isOptionBlock(b: any): b is OptionBlock {
  return (
    b &&
    b.type === 'option' &&
    typeof b.label === 'string' &&
    Array.isArray(b.content) &&
    b.content.every((c: any) => isTextBlock(c) || isImageBlock(c))
  )
}

function isBlock(b: any): b is Block {
  return isTextBlock(b) || isImageBlock(b) || isOptionBlock(b)
}

/**
 * 严格校验：返回问题列表（空数组 = 合法）。供编辑器保存前/契约测使用。
 * 注意：仅做结构校验；url 的 OSS 域白名单由后端按部署环境兜底（FE 不硬编码域名）。
 */
export function validateBlockDoc(doc: any): string[] {
  const errs: string[] = []
  if (!doc || typeof doc !== 'object') return ['文档不是对象']
  if (typeof doc.v !== 'number') errs.push('缺少版本号 v')
  if (!Array.isArray(doc.rows)) {
    errs.push('rows 必须是数组')
    return errs
  }
  doc.rows.forEach((row: any, ri: number) => {
    if (!row || !Array.isArray(row.cells)) {
      errs.push(`第 ${ri + 1} 行缺少 cells 数组`)
      return
    }
    row.cells.forEach((cell: any, ci: number) => {
      if (!isBlock(cell)) errs.push(`第 ${ri + 1} 行第 ${ci + 1} 块非法 block (type=${cell?.type})`)
      if (isImageBlock(cell) && (cell.width < 1 || cell.width > 100))
        errs.push(`第 ${ri + 1} 行第 ${ci + 1} 图片 width 须 1-100`)
    })
  })
  return errs
}

/**
 * 宽松解析：接受对象或 JSON 字符串；合法则返回规整文档，否则 null。
 * 渲染端用（坏数据不渲染、回落旧内容），不抛异常。
 */
export function parseBlockDoc(input: QuestionBlockDoc | string | null | undefined): QuestionBlockDoc | null {
  if (!input) return null
  let obj: any = input
  if (typeof input === 'string') {
    const s = input.trim()
    if (!s) return null
    try {
      obj = JSON.parse(s)
    } catch {
      return null
    }
  }
  if (validateBlockDoc(obj).length > 0) return null
  // 规整：只保留 schema 内字段，图片 width 夹取 1-100
  const rows: BlockRow[] = (obj.rows as any[]).map((row) => ({
    cells: (row.cells as any[]).map((cell) => normalizeBlock(cell)),
  }))
  return { v: obj.v ?? BLOCK_SCHEMA_VERSION, rows }
}

function normalizeBlock(b: any): Block {
  if (b.type === 'text') return { type: 'text', md: String(b.md ?? '') }
  if (b.type === 'image') {
    const img: ImageBlock = {
      type: 'image',
      url: String(b.url),
      width: Math.min(100, Math.max(1, Math.round(Number(b.width) || 100))),
      align: ALIGNS.includes(b.align) ? b.align : 'left',
    }
    if (typeof b.caption === 'string' && b.caption.trim()) img.caption = b.caption.trim()
    return img
  }
  // option
  return {
    type: 'option',
    label: String(b.label ?? ''),
    content: (b.content as any[]).map((c) => normalizeBlock(c) as TextBlock | ImageBlock),
  }
}
