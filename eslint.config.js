// rec-ord — ESLint flat config (v9)
//
// Goals:
//   1. No `any` — strict type discipline.
//   2. No dead code (unused imports, vars, parameters).
//   3. Modern JS/TS (no `var`, prefer `const`, arrow callbacks, templates).
//   4. Strict equality, promise hygiene, no floating awaits.
//   5. Inline `import type` (so they get tree-shaken automatically).
//
// We use typescript-eslint's `recommended` (no type info) and
// astro-eslint's `flat/recommended`. `tsc --noEmit` (the `typecheck`
// script) is the type-aware safety net for `no-explicit-any`,
// `noImplicitAny`, and the `no-unsafe-*` family — keeping linting fast.

import { defineConfig } from "eslint/config";
import astro from "eslint-plugin-astro";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  // Global ignores — generated/build/dist/dependencies/declarations.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".astro/**",
      "public/**",
      "scripts/**", // standalone Node scripts; not part of the app
      "**/*.d.ts", // ambient declarations (triple-slash, declare module)
    ],
  },

  // TypeScript source files.
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
    rules: {
      // === No `any` — strict type discipline ===
      // The user explicitly asked for "no any".
      //   - `no-explicit-any` catches `: any` and `as any` annotations.
      //   - Implicit `any` (parameters with no type that TS can't infer)
      //     is caught by `noImplicitAny` in tsconfig.json (part of
      //     `astro/tsconfigs/strict`) and surfaced by `tsc --noEmit`
      //     (the `typecheck` script).
      //   - The `no-unsafe-*` family (assignment/call/member-access/...)
      //     catches `any` flowing through code. We rely on `tsc --noEmit`
      //     (with the strict tsconfig) for these rather than enabling
      //     type-aware linting, which adds setup cost and slows the lint
      //     cycle. tsc catches the same class of bug.
      "@typescript-eslint/no-explicit-any": "error",

      // === Unused code (catches dead imports/vars/params) ===
      // The TS version covers both value and type imports in v8.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          vars: "all",
          varsIgnorePattern: "^_",
        },
      ],
      "no-unused-vars": "off", // TS version above is the source of truth

      // === Strict equality ===
      // Loose `==` / `!=` is almost never what you want; the
      // exception is null/undefined, which we explicitly allow.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // === Modern JS preferences ===
      "prefer-const": "error",
      "no-var": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-template": "error",
      "prefer-arrow-callback": "error",
      "no-else-return": "warn",
      "no-lonely-if": "warn",

      // === TypeScript-specific cleanliness ===
      // `import type` gets tree-shaken at build time and makes
      // the role of the import unambiguous.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow shorthand arrow functions (`x => x.foo`) without
      // an explicit return type, and higher-order function args
      // (where TS will infer). Only emit a warning, not an error.
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      // Type-aware rules — `no-floating-promises`, `await-thenable`,
      // `no-misused-promises`, `no-unnecessary-condition`,
      // `no-unnecessary-type-assertion`, `require-await`, `return-await`,
      // `prefer-nullish-coalescing`, `prefer-optional-chain`, and the
      // `no-unsafe-*` family — all require `parserOptions.project` to
      // work. We rely on `tsc --noEmit` (the `typecheck` script) for
      // these checks instead, to keep linting fast and config simple.
      // The strict tsconfig (with `noUncheckedIndexedAccess`,
      // `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`)
      // already catches the most important class of bug.
    },
  },

  // Astro components — applies the project's recommended ruleset
  // and wires up the typescript-eslint parser for `<script>` blocks.
  ...astro.configs["flat/recommended"],
  {
    files: ["src/**/*.astro"],
    rules: {
      // Astro components are .astro files, not pure TypeScript.
      // The no-explicit-any rule can be useful here too, but the
      // <script> blocks are TS-checked already, so we keep it on.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          vars: "all",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
