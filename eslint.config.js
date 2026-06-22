import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // The codebase intentionally types Supabase query results as `any`
      // ((supabase as any) / (data as any)) because the generated types don't
      // cover every view/RPC. As an ERROR this rule fires ~900 times across src
      // AND the edge functions and buries the handful of genuinely actionable
      // findings, so it's a WARNING — still visible/trackable, but it no longer
      // masks real lint. (Audit E1; note the audit's "~95% Deno-tier" estimate
      // was off — roughly three-quarters of these `any`s are in src/.)
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Supabase edge functions run on Deno, not the browser/React: a different
  // global (`Deno`) and no React component model. Lint them as their own tier so
  // React-specific rules don't fire and `Deno` isn't treated as undefined.
  {
    files: ["supabase/functions/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, Deno: "readonly" },
    },
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-refresh/only-export-components": "off",
      // Deno edge-function tier — lenient on cosmetic rules that fire on
      // legitimate edge-function idioms and would otherwise mean churning (and
      // re-deploying) deployed/critical functions for non-behavioral lint:
      //  - no-control-regex: the input sanitizers intentionally strip
      //    \x00-\x1f control characters from untrusted filenames / JSON.
      //  - no-useless-escape / prefer-const: defensive regex escapes and a few
      //    `let`s in deployed functions — not worth a redeploy to satisfy.
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
    },
  },
);
