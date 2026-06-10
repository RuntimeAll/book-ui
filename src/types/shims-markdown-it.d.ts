// markdown-it@14 npm 包不带类型、项目也未装 @types/markdown-it（不引新依赖，按门禁约定走本地 shim）。
// 没有这个声明 vue-tsc 在 MarkdownMath.vue 报 TS7016（implicit any），类型门禁过不去。
// 只声明本项目用到的最小面：构造 + render + use（katex 插件）。
declare module 'markdown-it' {
  interface MarkdownItOptions {
    html?: boolean
    breaks?: boolean
    linkify?: boolean
    typographer?: boolean
    [k: string]: unknown
  }

  class MarkdownIt {
    constructor(options?: MarkdownItOptions)
    render(src: string): string
    renderInline(src: string): string
    use(plugin: (...args: unknown[]) => void, ...params: unknown[]): this
  }

  export default MarkdownIt
}

declare module '@traptitech/markdown-it-katex' {
  const katexPlugin: (...args: unknown[]) => void
  export default katexPlugin
}
