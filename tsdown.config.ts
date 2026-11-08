import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["streamhold.ts"],
  outDir: ".",
  outExtensions: () => ({ js: ".js" }),
  format: "cjs",
  platform: "node",
  target: "es2023",
  clean: false,
  minify: true,
});
