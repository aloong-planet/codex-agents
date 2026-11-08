import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist/", "playwright-report/", "test-results/"] },
  {
    files: ["src/public/**/*.js"],
    languageOptions: {
      globals: {
        addEventListener: "readonly",
        clearTimeout: "readonly",
        document: "readonly",
        fetch: "readonly",
        innerHeight: "readonly",
        innerWidth: "readonly",
        location: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  },
);
