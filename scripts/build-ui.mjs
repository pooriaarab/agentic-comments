// Builds the demo page into public/ui. The Worker serves that folder as static assets. esbuild copies the fonts of the
// design package next to the page, so the page makes no call to another site.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "public/ui";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["ui/main.tsx"],
  outfile: `${out}/app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  loader: { ".woff2": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
cpSync("ui/index.html", `${out}/index.html`);
