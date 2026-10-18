import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', '.cache', 'node_modules'] },
  {
    files: ['**/*.{ts,mjs,js}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: '只用具名导出：default 导出让每个调用点各起各的名字',
        },
      ],
    },
  },
  // 工具的配置文件按约定用 default 导出。
  {
    files: ['eslint.config.js', 'prettier.config.js', 'vitest.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
)
