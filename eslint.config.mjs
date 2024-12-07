import typescriptEslintPlugin from "@typescript-eslint/eslint-plugin";
import prettierPlugin from "eslint-plugin-prettier";
import js from "@eslint/js";
import typescriptParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

const { rules: tsEslintRules } = typescriptEslintPlugin.configs.recommended;

export default [
  {
    ignores: ["node_modules", "dist"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": typescriptEslintPlugin,
      prettier: prettierPlugin,
      import: importPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsEslintRules,
      "prettier/prettier": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "import/extensions": [
        "error",
        "always",
        { js: "never", ts: "never", tsx: "never" },
      ],
      "import/no-unresolved": [
        "error",
        {
          ignore: ["\\.js$"],
        },
      ],
      "import/no-absolute-path": "error",
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
        },
      },
    },
  },
];
