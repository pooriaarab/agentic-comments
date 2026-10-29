import { execFileSync } from "node:child_process";

/** The end-to-end tests run the built CLI and MCP server, so build first. */
export default function setup(): void {
  try {
    execFileSync("npx", ["tsup"], { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`the build failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}
