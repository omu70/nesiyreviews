// =============================================================
// ESLint (flat config)
// File: /eslint.config.js
//
// Deliberately small. The value here is catching the mistakes that
// actually ship — an undefined variable, an unused import, a stray
// debugger — not enforcing a style opinion that a formatter should
// own. Two environments, because the storefront asset and the Remix
// server have completely different globals.
// =============================================================
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";

export default [
  {
    ignores: ["build/**", "node_modules/**", ".shopify/**", "tests/artifacts/**"],
  },

  // ---- Remix app + libs (Node, ESM, JSX) ----
  {
    files: ["app/**/*.{js,jsx}", "lib/**/*.js", "*.config.js", "tests/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react },
    rules: {
      ...js.configs.recommended.rules,
      // Without this, every Polaris component imported for JSX reads as
      // an unused variable to the core rule.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "no-console": ["warn", { allow: ["error", "warn", "log"] }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          // `catch (e) {}` where the error genuinely does not matter is
          // a deliberate pattern here, not an oversight.
          caughtErrors: "none",
        },
      ],
      "no-debugger": "error",
      eqeqeq: ["error", "smart"],
    },
  },

  // ---- Theme app extension asset (browser, ES5-era, no modules) ----
  {
    files: ["extensions/**/assets/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2018,
      sourceType: "script",
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
