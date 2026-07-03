// @umoteam/editor@10.2.1 无 .d.ts — 最小 ambient 声明（与 spike 验证 API 对齐）。
// 覆盖面：本项目用到的 UmoEditor 组件 + 样式副作用导入。
// 只要能让 vue-tsc 通过类型门禁，不求完整类型。
import type { DefineComponent } from 'vue'

declare module '@umoteam/editor' {
  // UmoEditor 实例方法（editorRef.value.xxx）
  export interface UmoEditorInstance {
    /** 返回底层 Tiptap Editor 实例 */
    useEditor(): import('@tiptap/core').Editor | undefined
    /** 获取当前文档的 Tiptap JSON */
    getJSON?(): object
    /** 设置只读模式 */
    setReadOnly?(readOnly: boolean): void
    /** 导出图片 */
    getImage?(format: 'png' | 'jpeg'): Promise<Blob | string>
  }

  // UmoEditor 接受的 props（最小集）
  export interface UmoEditorProps {
    extensions?: unknown[]
    document?: {
      title?: string
      readOnly?: boolean
      content?: string | object
      placeholder?: Record<string, string>
    }
    assistant?: boolean | object
    locale?: string
    [key: string]: unknown
  }

  // UmoEditor 组件（DefineComponent any 接收所有 props，ref 指向 UmoEditorInstance）
  export const UmoEditor: DefineComponent<UmoEditorProps> & {
    new (): UmoEditorInstance
  }
}

// 样式副作用导入（无类型，仅告知 tsc 模块存在）
declare module '@umoteam/editor/style' {}
