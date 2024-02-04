module.exports = {
  env: {
    browser: true,
    es2021: true,
  },
  extends: "standard-with-typescript",
  overrides: [
    {
      // Override for JS config files
      files: ["*.config.js", ".eslintrc.js"],
      parser: "espree",
      env: {
        node: true,
        browser: false,
      },
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "script",
      },
    },
    {
      env: {
        node: true,
      },
      files: [".eslintrc.{js,cjs}"],
      parserOptions: {
        sourceType: "script",
      },
    },
  ],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  rules: {},
};
