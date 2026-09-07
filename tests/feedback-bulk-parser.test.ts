import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasFeedbackContent,
  mergeBulkRows,
  parseFeedbackBulk,
  type FeedbackDraftRow,
} from '../src/views/m/feedback-bulk-parser.ts'

test('keeps mixed numbered and plain lines in source order', () => {
  const rows = parseFeedbackBulk('1. 同类项\n先复习括号\n2、合并同类项\n1. 同类项复习')

  assert.deepEqual(
    rows.map((row) => row.content),
    ['同类项', '先复习括号', '合并同类项', '同类项复习'],
  )
})

test('keeps duplicate numbers instead of overwriting or sorting them', () => {
  const rows = parseFeedbackBulk('3. 第一次\n1. 第二次\n3. 第三次')

  assert.deepEqual(
    rows.map((row) => row.content),
    ['第一次', '第二次', '第三次'],
  )
})

test('does not treat numeric text, decimals, or times as numbered rows', () => {
  const rows = parseFeedbackBulk('2026年复习计划\n2 个题目\n1.5 小时\n2:30 到校\n3）真正的第三条')

  assert.deepEqual(
    rows.map((row) => row.content),
    ['2026年复习计划', '2 个题目', '1.5 小时', '2:30 到校', '真正的第三条'],
  )
})

test('keeps the existing lesson-header prefix support when the suffix is clearly numbered', () => {
  const rows = parseFeedbackBulk('乐乐第十次课：1. 同类项')

  assert.deepEqual(
    rows.map((row) => row.content),
    ['同类项'],
  )
})

test('preserves ambiguous colon prefixes', () => {
  const rows = parseFeedbackBulk('比例：1. 第一项\n备注：2. 第二项')
  assert.deepEqual(
    rows.map((row) => row.content),
    ['比例：1. 第一项', '备注：2. 第二项'],
  )
})

test('splits only explicit non-empty module/content parts', () => {
  const rows = parseFeedbackBulk('数与代数 | 同类项\n带竖线但不完整 |\n模糊文本')

  assert.deepEqual(rows, [
    { module: '数与代数', content: '同类项', mastery: '', weakness: '', kp_id: null },
    { module: '', content: '带竖线但不完整 |', mastery: '', weakness: '', kp_id: null },
    { module: '', content: '模糊文本', mastery: '', weakness: '', kp_id: null },
  ])
})

test('removes only blank lines and supports CRLF input', () => {
  const rows = parseFeedbackBulk('\r\n1. 第一条\r\n\r\n第二条\r\n')

  assert.deepEqual(
    rows.map((row) => row.content),
    ['第一条', '第二条'],
  )
})

test('replacement and append merge drafts without mutating the current rows', () => {
  const existing: FeedbackDraftRow[] = [
    { module: '旧模块', content: '旧内容' },
    { module: '', content: '' },
  ]
  const incoming = parseFeedbackBulk('1. 新内容\n2. 新内容二')

  const replaced = mergeBulkRows(existing, incoming, 'replace')
  const appended = mergeBulkRows(existing, incoming, 'append')

  assert.deepEqual(
    replaced.map((row) => row.content),
    ['新内容', '新内容二'],
  )
  assert.deepEqual(
    appended.map((row) => row.content),
    ['旧内容', '新内容', '新内容二'],
  )
  assert.deepEqual(existing, [
    { module: '旧模块', content: '旧内容' },
    { module: '', content: '' },
  ])
})

test('non-empty detection includes all editable feedback columns', () => {
  assert.equal(hasFeedbackContent({ mastery: '已掌握' }), true)
  assert.equal(hasFeedbackContent({ weakness: '需加强' }), true)
  assert.equal(hasFeedbackContent({ module: '', content: '', mastery: '', weakness: '' }), false)
})
