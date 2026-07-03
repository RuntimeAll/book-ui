// erasableSyntaxOnly 下禁 enum，改 const 对象 + 同名 type（值/类型两用，PRD-C-212 V0）
export const LanguageEnum = {
  zh_CN: 'zh_CN',
  en_US: 'en_US'
} as const;
export type LanguageEnum = (typeof LanguageEnum)[keyof typeof LanguageEnum];
