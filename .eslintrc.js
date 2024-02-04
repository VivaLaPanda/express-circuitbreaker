module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["import"],
  ignorePatterns: ["dist/"],
  settings: {
    "import/resolver": {
      node: {
        extensions: [".js", ".jsx", ".ts", ".tsx"],
      },
      typescript: {
        alwaysTryTypes: true,
      },
    },
  },
  rules: {
    "import/no-absolute-path": 2,
    "import/no-unresolved": 2,
    "import/no-useless-path-segments": 2,
    "import/first": 2,
    "import/no-duplicates": 2,
    "import/order": 2,
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludedFiles: ["*.test.ts"],
      rules: {
        "no-console": "off",
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "CallExpression[callee.object.name='console'][callee.property.name=/^(log|debug|info|trace)$/]",
            message: "Do not use console.log. Use req.log instead.",
          },
        ],
      },
    },
  ],
};
