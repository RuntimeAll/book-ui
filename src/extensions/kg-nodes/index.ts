/**
 * PRD-C-205 课件编辑器 — 4 个 Tiptap 自定义节点定义。
 * 供 UmoEditor :extensions 和只读渲染两处复用，改节点定义只改这一文件。
 *
 * 每个节点：
 *   - group: 'block', atom: true（原子节点，整体选中，内部不可进入编辑）
 *   - parseHTML / renderHTML 用 data-* 属性双向配对（节点持久化约定）
 *   - addNodeView 返回 VueNodeViewRenderer
 *
 * 节点契约真相源：codeplace-C/暂存空间/知识图谱拓展预研/课件-Tiptap文档-节点契约.md
 */
import type { Component } from 'vue'
import type { NodeViewProps } from '@tiptap/core'
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import KgMindmapNodeView from './KgMindmapNodeView.vue'
import KgNoteNodeView from './KgNoteNodeView.vue'
import KgCalloutNodeView from './KgCalloutNodeView.vue'
import KgExampleNodeView from './KgExampleNodeView.vue'

// ─────────────────────────────────────────────────────────────────────────────
// kgMindmap — 思维导图节点
//   attrs.data = JSON.stringify(root)，root = { text, color?, detail?, children[] }
// ─────────────────────────────────────────────────────────────────────────────
export const KgMindmapExtension = Node.create({
  name: 'kgMindmap',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-kg-data') ?? '',
        renderHTML: (attrs) => ({ 'data-kg-data': attrs.data }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-kg-mindmap]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kg-mindmap': '' })]
  },

  addNodeView() {
    // vue-tsc strict: SFC DefineComponent<__VLS_Props> 不直接满足 Component<NodeViewProps>，
    // 用 as unknown as Component<NodeViewProps> 断言绕过（运行时无影响，Tiptap 内部正确处理）
    return VueNodeViewRenderer(KgMindmapNodeView as unknown as Component<NodeViewProps>)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// kgNote — 名师解读框
//   attrs.title = 短标题，attrs.text = 正文
// ─────────────────────────────────────────────────────────────────────────────
export const KgNoteExtension = Node.create({
  name: 'kgNote',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      title: {
        default: '名师解读',
        parseHTML: (el) => el.getAttribute('data-kg-title') ?? '名师解读',
        renderHTML: (attrs) => ({ 'data-kg-title': attrs.title }),
      },
      text: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-kg-text') ?? '',
        renderHTML: (attrs) => ({ 'data-kg-text': attrs.text }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-kg-note]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kg-note': '' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(KgNoteNodeView as unknown as Component<NodeViewProps>)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// kgCallout — 记忆框
//   attrs.lines = 各行 \n 拼接的字符串，attrs.color = 边框/字体颜色
// ─────────────────────────────────────────────────────────────────────────────
export const KgCalloutExtension = Node.create({
  name: 'kgCallout',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      lines: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-kg-lines') ?? '',
        renderHTML: (attrs) => ({ 'data-kg-lines': attrs.lines }),
      },
      color: {
        default: '#2563eb',
        parseHTML: (el) => el.getAttribute('data-kg-color') ?? '#2563eb',
        renderHTML: (attrs) => ({ 'data-kg-color': attrs.color }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-kg-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kg-callout': '' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(KgCalloutNodeView as unknown as Component<NodeViewProps>)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// kgExample — 例题卡
//   attrs.qid = 题目 ID（string，雪花），attrs.knowledgeId = 知识点 ID
//   NodeView mounted 时按 qid 调接口取题面，只存 qid 不存题目正文
// ─────────────────────────────────────────────────────────────────────────────
export const KgExampleExtension = Node.create({
  name: 'kgExample',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      qid: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-kg-qid') ?? '',
        renderHTML: (attrs) => ({ 'data-kg-qid': attrs.qid }),
      },
      knowledgeId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-kg-knowledge-id') ?? '',
        renderHTML: (attrs) => ({ 'data-kg-knowledge-id': attrs.knowledgeId }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-kg-example]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kg-example': '' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(KgExampleNodeView as unknown as Component<NodeViewProps>)
  },
})

/** 所有 KG 自定义节点，传给 UmoEditor :extensions */
export const KG_NODE_EXTENSIONS = [
  KgMindmapExtension,
  KgNoteExtension,
  KgCalloutExtension,
  KgExampleExtension,
]
