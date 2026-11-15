import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8"));

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  clean: true,
  target: "node20",
  define: { __VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node" },
});
