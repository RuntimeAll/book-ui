const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse, compileScript } = require('vue/compiler-sfc')
const ts = require('typescript')
const vue = require('vue')
const directory = path.resolve(__dirname, '../src/views/m')

function evaluate(source, imports, extra = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => {
      if (!(name in imports)) throw Error(`Unexpected import: ${name}`)
      return imports[name]
    },
    ...extra,
  })
  return module.exports
}

const parser = evaluate(
  fs.readFileSync(path.join(directory, 'feedback-bulk-parser.ts'), 'utf8'),
  {},
)
const script = compileScript(
  parse(fs.readFileSync(path.join(directory, 'feedback.vue'), 'utf8')).descriptor,
  {
    id: 'feedback-bulk-test',
  },
).content

function setup({ confirm = async () => {}, getSheet = async (id) => ({ id, rows: [] }) } = {}) {
  const writes = []
  const imports = {
    vue: { ...vue, onMounted() {} },
    vant: { showConfirmDialog: confirm, showFailToast() {}, showSuccessToast() {}, showToast() {} },
    'vant/es/toast/style': {},
    'vant/es/dialog/style': {},
    '@/api/teacher/feedback': { getSheet, updateSheet: (...args) => writes.push(args) },
    '@/api/teacher/schedule': {},
    './components/MSheet.vue': {},
    './feedback-bulk-parser': parser,
    './shared': { todayStr: () => '2026-09-07' },
  }
  const component = evaluate(script, imports, { localStorage: { getItem: () => null }, console })
  const state = component.default.setup({}, { expose() {} })
  state.editOpen.value = true
  state.editDetail.value = { id: 'one' }
  state.editRows.value = [{ content: 'original' }]
  state.bulkOpen.value = true
  state.bulkText.value = '1. replacement'
  return { state, writes }
}

test('cancel leaves existing and pasted drafts unchanged', async () => {
  const { state, writes } = setup({
    confirm: async () => {
      throw Error('cancel')
    },
  })
  await state.applyBulk('replace')
  assert.equal(state.editRows.value[0].content, 'original')
  assert.equal(state.bulkText.value, '1. replacement')
  assert.equal(state.bulkApplying.value, false)
  assert.equal(writes.length, 0)
})

test('confirmed replacement changes only the draft', async () => {
  const { state, writes } = setup()
  await state.applyBulk('replace')
  assert.equal(state.editRows.value.length, 1)
  assert.equal(state.editRows.value[0].content, 'replacement')
  assert.equal(state.bulkText.value, '')
  assert.equal(state.bulkOpen.value, false)
  assert.equal(writes.length, 0)
})

test('append keeps existing content and never asks to replace', async () => {
  const { state } = setup({ confirm: () => assert.fail('Unexpected confirmation') })
  await state.applyBulk('append')
  assert.equal(state.editRows.value.length, 2)
  assert.equal(state.editRows.value[0].content, 'original')
  assert.equal(state.editRows.value[1].content, 'replacement')
})

test('late confirmation cannot change another sheet and double click is ignored', async () => {
  let resolve
  let confirmations = 0
  const { state } = setup({
    confirm: () => {
      confirmations++
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  const pending = state.applyBulk('replace')
  await state.applyBulk('replace')
  assert.equal(confirmations, 1)
  await state.openEdit('two')
  assert.equal(state.bulkText.value, '')
  resolve()
  await pending
  assert.equal(state.editDetail.value.id, 'two')
  assert.equal(state.editRows.value[0].content, '')
})

test('closing sheet cancels pending replacement', async () => {
  let resolve
  const { state } = setup({
    confirm: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  const pending = state.applyBulk('replace')
  state.editOpen.value = false
  resolve()
  await pending
  assert.equal(state.editRows.value[0].content, 'original')
})

test('old sheet response cannot overwrite the latest sheet', async () => {
  let resolveFirst
  const { state } = setup({
    getSheet: (id) =>
      id === 'first'
        ? new Promise((done) => {
            resolveFirst = done
          })
        : Promise.resolve({ id, rows: [{ content: 'latest' }] }),
  })
  const first = state.openEdit('first')
  await state.openEdit('second')
  resolveFirst({ id: 'first', rows: [{ content: 'stale' }] })
  await first
  assert.equal(state.editDetail.value.id, 'second')
  assert.equal(state.editRows.value[0].content, 'latest')
  assert.equal(state.editLoading.value, false)
})
