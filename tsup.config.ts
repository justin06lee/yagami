import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: {
    entry: {
      index: "src/index.ts",
      server: "src/server.ts",
    },
  },
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
});
