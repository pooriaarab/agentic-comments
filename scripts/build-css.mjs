// Copies the panel stylesheet to dist/ui.css, the file that `agentic-comments/ui.css` points at.
import { copyFileSync } from "node:fs";

copyFileSync("src/ui/panel.css", "dist/ui.css");
