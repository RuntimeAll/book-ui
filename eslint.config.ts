import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

/**
 * book-ui ESLint flat config（低门槛基线 · PRD-A-010 T2）
 * 参考 codeplace-B/book-admin。先不 fail-on-warn：规则放宽，let `pnpm lint` 只做格式 + 明显错误提示，
 * 不阻塞构建（构建门禁仍是 `vue-tsc -b` 类型检查）。后续再逐步收紧。
 */
export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,cjs,ts,mts,tsx,vue}'],
  },
  {
    name: 'app/files-to-ignore',
    ignores: [
      '**/dist/**',
      '**/dist-ssr/**',
      '**/coverage/**',
      '**/node_modules/**',
      'auto-imports.d.ts',
      'components.d.ts',
      'scripts/**', // 构建辅助脚本（.cjs 用 require），非业务代码
      '**/*.cjs',
    ],
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  skipFormatting,
  {
    rules: {
      // 低门槛：常见严格项先关，避免存量代码海量报错阻塞上线
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'vue/block-lang': 'off', // 存量个别 SFC 用 lang="js"，迁移期放宽
      'vue/multi-word-component-names': 'off',
      'vue/valid-define-props': 'off',
      'vue/no-v-model-argument': 'off',
      'prefer-rest-params': 'off',
    },
  },
)
