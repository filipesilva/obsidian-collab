import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
  globalIgnores([
    'node_modules',
    'dist',
    'worker',
    'test',
    'scripts',
    'test-vaults',
    'vitest.config.ts',
    'esbuild.config.mjs',
    'version-bump.mjs',
    'versions.json',
    'main.js',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-base-to-string': ['error', { ignoredTypeNames: ['YText'] }],
      'obsidianmd/ui/sentence-case': ['warn', { acronyms: ['TURN', 'STUN', 'URL'] }],
    },
  },
  {
    // Tests run in a plain browser without Obsidian's DOM helpers.
    files: ['src/**/*.test.ts', 'src/test/**/*.ts'],
    rules: {
      'obsidianmd/prefer-create-el': 'off',
      'obsidianmd/prefer-window-timers': 'off',
    },
  },
);
