const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')
const vue = require('vue')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function node(id, itemCount = 1, children = []) {
  return { id, bookId: 'book', name: id, itemCount, questionCount: itemCount, children, seq: 1 }
}

function outline(id = 'book', tree = [node('n1'), node('n2')]) {
  return { id, title: id, bookType: 'lecture', tree }
}

function page(rows = [], pageNum = 1, total = rows.length, hasMore = false) {
  return { rows, pageNum, total, pageSize: 20, hasMore }
}

function createReader(api) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../composables/useShelfReader.ts'),
    'utf8',
  )
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require: (name) => (name === 'vue' ? vue : api),
    AbortController,
    console: { warn() {} },
  })
  const scope = vue.effectScope()
  const reader = scope.run(() => module.exports.useShelfReader())
  return { reader, stop: () => scope.stop() }
}

test('outline contains navigation only; no body fetch until requested', async () => {
  let calls = 0
  const { reader, stop } = createReader({
    getBookOutline: async () => outline(),
    getNodeItems: async () => {
      calls++
      return page()
    },
  })
  await reader.load('book')
  assert.equal(calls, 0)
  assert.deepEqual(
    Array.from(reader.flatNodes.value, (row) => row.node.id),
    ['n1', 'n2'],
  )
  await reader.loadNode('n1')
  assert.equal(calls, 1)
  stop()
})

test('late old outline cannot replace a new book or its loading state', async () => {
  const old = deferred()
  const signals = []
  const { reader, stop } = createReader({
    getBookOutline: (id, signal) => {
      signals.push(signal)
      return id === 'old' ? old.promise : outline('new')
    },
  })
  const loadingOld = reader.load('old')
  await reader.load('new')
  assert.equal(signals[0].aborted, true)
  old.resolve(outline('old'))
  await loadingOld
  assert.equal(reader.book.value.id, 'new')
  assert.equal(reader.loading.value, false)
  stop()
})

test('observer bursts are deduplicated and serialized', async () => {
  const first = deferred()
  const calls = []
  const { reader, stop } = createReader({
    getBookOutline: async () => outline(),
    getNodeItems: async (_, id) => {
      calls.push(id)
      return id === 'n1' ? first.promise : page()
    },
  })
  await reader.load('book')
  const a = reader.loadNode('n1')
  const duplicate = reader.loadNode('n1')
  const b = reader.loadNode('n2')
  await Promise.resolve()
  assert.equal(a, duplicate)
  assert.deepEqual(calls, ['n1'])
  first.resolve(page())
  await a
  await b
  assert.deepEqual(calls, ['n1', 'n2'])
  stop()
})

test('node pages append in order; a failed page retries without losing preceding rows', async () => {
  const calls = []
  let fail = true
  const { reader, stop } = createReader({
    getBookOutline: async () => outline(),
    getNodeItems: async (_, id, params) => {
      calls.push(params.pageNum)
      if (params.pageNum === 1) return page([{ id: 'i1', nodeId: id }], 1, 2, true)
      if (fail) {
        fail = false
        throw new Error('offline')
      }
      return page([{ id: 'i2', nodeId: id }], 2, 2)
    },
  })
  await reader.load('book')
  await reader.loadNode('n1')
  await reader.loadNode('n1', true)
  assert.equal(reader.pages.value.n1.error, true)
  assert.equal(reader.pages.value.n1.rows.length, 1)
  await reader.loadNode('n1', true)
  assert.deepEqual(calls, [1, 2, 2])
  assert.deepEqual(
    Array.from(reader.pages.value.n1.rows, (row) => row.id),
    ['i1', 'i2'],
  )
  await reader.loadNode('n1', true)
  assert.equal(calls.length, 3)
  stop()
})

test('old in-flight node and queued node cannot leak into the new book', async () => {
  const old = deferred()
  const calls = []
  const { reader, stop } = createReader({
    getBookOutline: async (id) => outline(id),
    getNodeItems: async (id, nodeId) => {
      calls.push([id, nodeId])
      return old.promise
    },
  })
  await reader.load('old')
  const a = reader.loadNode('n1')
  const b = reader.loadNode('n2')
  await Promise.resolve()
  await reader.load('new')
  old.resolve(page([{ id: 'old' }]))
  await a
  await b
  assert.equal(Object.keys(reader.pages.value).length, 0)
  assert.deepEqual(calls, [['old', 'n1']])
  stop()
})

test('subtree selection reads every bounded page and child, independently of mounted rows', async () => {
  const calls = []
  const { reader, stop } = createReader({
    getBookOutline: async () =>
      outline('book', [node('parent', 0, [node('child', 101), node('empty', 0)])]),
    getNodeItems: async (_, id, params) => {
      calls.push({ id, ...params })
      const rows =
        params.pageNum === 1
          ? Array.from({ length: 100 }, (_, index) => ({ id: `item-${index + 1}` }))
          : [{ id: 'item-101' }]
      return page(rows, params.pageNum, 101, params.pageNum === 1)
    },
  })
  await reader.load('book')
  const items = []
  for await (const batch of reader.readSubtree('parent')) items.push(...batch)
  assert.deepEqual(
    items.map((row) => row.id),
    Array.from({ length: 101 }, (_, index) => `item-${index + 1}`),
  )
  assert.deepEqual(calls, [
    { id: 'child', pageNum: 1, pageSize: 100 },
    { id: 'child', pageNum: 2, pageSize: 100 },
  ])
  assert.equal(Object.keys(reader.pages.value).length, 0)
  stop()
})

test('subtree selection stops after switching books', async () => {
  const { reader, stop } = createReader({
    getBookOutline: async (id) => outline(id),
    getNodeItems: async () => page([{ id: 'one' }], 1, 2, true),
  })
  await reader.load('old')
  const iterator = reader.readSubtree('n1')
  await iterator.next()
  await reader.load('new')
  await assert.rejects(iterator.next(), /Book changed/)
  stop()
})

test('after editing, read back the resolved instance without mutating its neighbor or original', async () => {
  const question = { id: 'q1', stemText: 'original', blockJson: '{"original":true}' }
  const row = { id: 'i1', bookId: 'book', nodeId: 'n1', question, override: null }
  let calls = 0
  const { reader, stop } = createReader({
    getBookOutline: async () => outline(),
    getNodeItems: async () => {
      calls++
      return page(
        calls === 1
          ? [row, { ...row, id: 'i2' }]
          : [
              {
                ...row,
                override: { stem: '' },
                question: { ...question, stemText: '', blockJson: null },
              },
            ],
      )
    },
  })
  await reader.load('book')
  await reader.loadNode('n1')
  await reader.refreshItem(row)
  assert.equal(reader.pages.value.n1.rows[0].override.stem, '')
  assert.equal(reader.pages.value.n1.rows[1].override, null)
  assert.equal(reader.pages.value.n1.rows[0].question.blockJson, null)
  assert.equal(question.stemText, 'original')
  stop()
})

function createBookView() {
  const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
  const filename = path.resolve(__dirname, '../../views/shelf/book.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const source = compileScript(descriptor, { id: 'shelf-reader-test' }).content
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const scopes = []
  const keys = vue.ref(new Set())
  const api = {
    book: vue.ref(null),
    loading: vue.ref(false),
    error: vue.ref(false),
    pages: vue.ref({}),
    flatNodes: vue.ref([]),
    nodeById: vue.ref({}),
    load: async () => false,
  }
  const dependencies = {
    vue: { ...vue, onMounted() {}, onBeforeUnmount() {} },
    'vue-router': {
      useRoute: () => ({ params: { id: 'book' }, query: {} }),
      useRouter: () => ({}),
    },
    'element-plus': { ElMessage: {}, ElMessageBox: {} },
    '@/api/shelf': { BOOK_TYPE_LABEL: {} },
    '@/store/user': { useUserStore: () => ({ userInfo: {} }) },
    '@/composables/useShelfReader': { useShelfReader: () => api },
    '@/composables/useQuestionBasket': { useQuestionBasket: () => ({ basketIds: keys }) },
    '@/utils/blockSchema': { parseBlockDoc: (raw) => (raw ? JSON.parse(raw) : null) },
  }
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require: (name) => {
      if (name in dependencies) return dependencies[name]
      if (name.endsWith('.vue')) return {}
      throw new Error(`Unexpected import: ${name}`)
    },
    window: { clearTimeout() {}, setTimeout() {} },
    cancelAnimationFrame() {},
    console: { warn() {} },
  })
  const scope = vue.effectScope()
  scopes.push(scope)
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }))
  return { view, keys, stop: () => scopes.forEach((scope) => scope.stop()) }
}

test('book-to-basket uses resolved text/blocks, all answer media, and shelf instance key', () => {
  const { view, stop } = createBookView()
  const row = {
    id: '2090000000000000001',
    bookId: '2090000000000000002',
    nodeId: 'n1',
    kind: 'question',
    questionId: '2090000000000000003',
    override: { stem: 'raw override must not be reapplied by FE' },
    question: {
      id: '2090000000000000003',
      questionType: 1,
      difficult: null,
      stemTextContent: 'resolved by codec',
      stemImg: null,
      blockJson: '{"v":1,"rows":[{"cells":[{"type":"text","md":"resolved by codec"}]}]}',
      answerTextContent: 'answer',
      analyzeTextContent: 'analysis',
      answerImg: 'answer.png',
      explainImg: 'analysis.png',
      answerBlockJson: 'answer-block',
      analyzeBlockJson: 'analysis-block',
    },
  }
  const question = view.itemToBasketQ(row)
  assert.equal(question.id, row.questionId)
  assert.equal(question.entryKey, `shelf:${row.id}`)
  assert.equal(question.sourceBookId, row.bookId)
  assert.equal(question.sourceItemId, row.id)
  assert.equal(question.stemTextContent, 'resolved by codec')
  assert.equal(question.blockJson, row.question.blockJson)
  assert.equal(question.answerImg, 'answer.png')
  assert.equal(question.answerBlockJson, 'answer-block')
  assert.equal(question.analyzeTextContent, 'analysis')
  assert.equal(question.analyzeBlockJson, 'analysis-block')
  stop()
})

test('two shelf instances of one question have independent basket button states', () => {
  const { view, keys, stop } = createBookView()
  keys.value.add('shelf:one')
  assert.equal(view.inBasket({ id: 'one', questionId: 'shared' }), true)
  assert.equal(view.inBasket({ id: 'two', questionId: 'shared' }), false)
  assert.equal(
    view.itemToBasketQ({ kind: 'question', questionId: 'missing', question: null }),
    null,
  )
  stop()
})

test('explicit cleared stem does not fall back to original text or blocks in the book', () => {
  const { view, stop } = createBookView()
  const row = {
    id: 'i1',
    questionId: 'q1',
    kind: 'question',
    override: { stem: null },
    originalStemText: 'must remain hidden',
    question: {
      id: 'q1',
      questionType: 1,
      stemText: null,
      stemTextContent: null,
      stemImg: null,
      blockJson: null,
    },
  }
  assert.equal(view.itemStemText(row), null)
  assert.equal(view.itemBlockJson(row), null)
  assert.equal(view.isEdited(row), true)
  stop()
})

test('next-page responses and edit readback preserve one another in either completion order', async () => {
  for (const readbackFirst of [true, false]) {
    const nextPage = deferred()
    const readback = deferred()
    let firstRead = true
    const row = { id: 'i1', bookId: 'book', nodeId: 'n1', question: { stemText: 'old' } }
    const { reader, stop } = createReader({
      getBookOutline: async () => outline(),
      getNodeItems: async (_, __, params) => {
        if (params.pageNum === 2) return nextPage.promise
        if (firstRead) {
          firstRead = false
          return page([row], 1, 2, true)
        }
        return readback.promise
      },
    })
    await reader.load('book')
    await reader.loadNode('n1')
    const append = reader.loadNode('n1', true)
    const refresh = reader.refreshItem(row)
    const updated = page([{ ...row, question: { stemText: 'saved' } }], 1, 2, true)
    const tail = page([{ id: 'i2', bookId: 'book', nodeId: 'n1' }], 2, 2)
    if (readbackFirst) {
      readback.resolve(updated)
      await refresh
      nextPage.resolve(tail)
      await append
    } else {
      nextPage.resolve(tail)
      await append
      readback.resolve(updated)
      await refresh
    }
    assert.equal(reader.pages.value.n1.rows.length, 2)
    assert.equal(reader.pages.value.n1.rows[0].question.stemText, 'saved')
    stop()
  }
})

test('book template compiles with paged node content and explicit failure states', () => {
  const { parse, compileScript, compileTemplate } = createRequire(require.resolve('vue'))(
    '@vue/compiler-sfc',
  )
  const filename = path.resolve(__dirname, '../../views/shelf/book.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'shelf-reader-test' })
  const result = compileTemplate({
    id: 'shelf-reader-test',
    filename,
    source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(result.errors, [])
})

test('whole-chapter selection reports a changing total instead of silently omitting items', async () => {
  const { reader, stop } = createReader({
    getBookOutline: async () => outline(),
    getNodeItems: async (_, __, params) =>
      params.pageNum === 1 ? page([{ id: 'first' }], 1, 2, true) : page([{ id: 'last' }], 2, 3),
  })
  await reader.load('book')
  const iterator = reader.readSubtree('n1')
  await iterator.next()
  await assert.rejects(iterator.next(), /Chapter contents changed/)
  stop()
})
