import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "jest.config.js",
      "**/*.js",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/__tests__/**",
      "src/tests/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
        ...globals.jest,
      },
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "preserve-caught-error": "off",
      "prefer-const": "off",
      "no-case-declarations": "off",
      "no-useless-assignment": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
