/**
 * useDesign — 统一 CSS 类名前缀生成
 * 抽取自 vue-element-plus-admin 模板最小子集
 * namespace 固定为 'v'（对齐模板 variables.module.less @adminNamespace: v）
 */

const NAMESPACE = 'v'

export const useDesign = () => {
  /**
   * 生成带命名空间前缀的类名
   * @param scope 类名（如 'icon', 'content-wrap'）
   * @returns 'v-icon', 'v-content-wrap' 等
   */
  const getPrefixCls = (scope: string) => {
    return `${NAMESPACE}-${scope}`
  }

  return {
    getPrefixCls
  }
}
