/**
 * 导航栏布局枚举
 * erasableSyntaxOnly 下禁 enum，改 const 对象 + 同名 type（值/类型两用，PRD-C-212 V0）
 */
export const NavTypeEnum = {
  /** 左侧导航 */
  LEFT: 'left',
  /** 顶部导航 */
  TOP: 'top',
  /** 混合导航 */
  MIX: 'mix'
} as const;
export type NavTypeEnum = (typeof NavTypeEnum)[keyof typeof NavTypeEnum];
