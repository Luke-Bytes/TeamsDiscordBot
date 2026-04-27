import typescriptEslintPlugin from "@typescript-eslint/eslint-plugin";
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
      import: importPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsEslintRules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "import/extensions": "off",
      "import/no-unresolved": [
        "error",
        {
          ignore: ["\\.js$", "\\.json$"],
        },
      ],
      "import/no-absolute-path": "error",
      "no-undef": "off",
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
        },
      },
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "import/no-unresolved": "off",
      "import/extensions": "off",
    },
  },
];
