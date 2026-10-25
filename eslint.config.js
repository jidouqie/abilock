import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "build/**", "node_modules/**", "artifacts/**", "docs/research/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["src/security.ts", "src/proxy.ts", "src/protocols/git.ts"],
    rules: { "no-control-regex": "off" },
  },
  { files: ["*.js"], languageOptions: { globals: { process: "readonly" } } },
  {
    files: ["bin/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
