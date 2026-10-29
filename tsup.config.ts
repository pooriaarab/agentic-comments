import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    local: "src/local.ts",
    anchoring: "src/anchoring.ts",
    worker: "src/worker.ts",
    client: "src/client.ts",
    cli: "src/cli.ts",
    "mcp-bin": "src/mcp-bin.ts",
    // The React panel: `agentic-comments/ui`. React and agentic-design stay the host's, as peer and dependency.
    ui: "src/ui/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
