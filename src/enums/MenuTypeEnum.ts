// erasableSyntaxOnly 下禁 enum，改 const 对象 + 同名 type（值/类型两用，PRD-C-212 V0）
export const MenuTypeEnum = {
  /** 目录 */
  M: 'M',
  /** 菜单 */
  C: 'C',
  /** 按钮 */
  F: 'F'
} as const;
export type MenuTypeEnum = (typeof MenuTypeEnum)[keyof typeof MenuTypeEnum];
