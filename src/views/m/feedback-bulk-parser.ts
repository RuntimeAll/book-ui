export interface FeedbackDraftRow {
  module?: string
  content?: string
  mastery?: string
  weakness?: string
  kp_id?: string | null
}

export interface ParsedBulkRow {
  module: string
  content: string
  mastery: string
  weakness: string
  kp_id: null
}

export type BulkApplyMode = 'replace' | 'append'

// Punctuation is required after the number so dates, times, decimals, and other numeric text stay plain.
// Only an explicit lesson header may precede a numbered line.
const NUMBERED_LINE =
  /^\s*(?:[^:：]*第[零一二三四五六七八九十百两\d]+次课[:：]\s*)?(\d{1,2})([.、．：:）)])(?!\d)\s*(.*?)\s*$/

function splitModule(text: string): Pick<ParsedBulkRow, 'module' | 'content'> {
  for (const separator of ['|', '｜']) {
    const index = text.indexOf(separator)
    if (index > 0) {
      const module = text.slice(0, index).trim()
      const content = text.slice(index + 1).trim()
      if (module && content) return { module, content }
    }
  }
  return { module: '', content: text }
}

function toParsedRow(text: string): ParsedBulkRow {
  const { module, content } = splitModule(text)
  return { module, content, mastery: '', weakness: '', kp_id: null }
}

/** Parse each non-empty line independently, retaining source order and repeated numbers. */
export function parseFeedbackBulk(text: string): ParsedBulkRow[] {
  const rows: ParsedBulkRow[] = []
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const numbered = NUMBERED_LINE.exec(rawLine)
    const content = numbered ? numbered[3].trim() : line
    if (content) rows.push(toParsedRow(content))
  }
  return rows
}

export function hasFeedbackContent(row: FeedbackDraftRow): boolean {
  return Boolean(row.module || row.content || row.mastery || row.weakness)
}

/** Return a fresh draft list; callers decide whether replacement has been confirmed. */
export function mergeBulkRows(
  existing: readonly FeedbackDraftRow[],
  incoming: readonly ParsedBulkRow[],
  mode: BulkApplyMode,
): FeedbackDraftRow[] {
  const retained = mode === 'replace' ? [] : existing.filter(hasFeedbackContent)
  return [...retained, ...incoming].map((row) => ({ ...row }))
}
