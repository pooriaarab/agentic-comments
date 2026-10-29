import { execFileSync } from "node:child_process";

/** The end-to-end tests run the built CLI and MCP server, so build first. */
export default function setup(): void {
  execFileSync("npx", ["tsup"], { stdio: "ignore" });
}
