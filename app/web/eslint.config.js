import react from "eslint-plugin-react";
import globals from "globals";

// Correctness only: undefined names and undefined JSX components. No style rules.
export default [
  { ignores: ["dist/**", "node_modules/**", "e2e/test-results/**", "e2e/playwright-report/**"] },
  {
    files: ["src/**/*.{js,jsx}", "tests/**/*.{js,jsx}", "e2e/**/*.mjs", "*.mjs"],
    plugins: { react },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: { react: { version: "detect" } },
    rules: {
      "no-undef": "error",
      "react/jsx-no-undef": "error",
      "react/jsx-uses-vars": "error",
    },
  },
];
