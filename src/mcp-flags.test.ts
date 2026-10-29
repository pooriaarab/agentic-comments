import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

// Ways `mcp --help` can fail: it exits 2 on an unknown flag, or it starts the server and waits on stdin.
// Each case runs the built bin with stdin left open and a bare environment (no principal).

const dist = (file: string) => join(process.cwd(), "dist", file);

function run(file: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist(file), ...args], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("help and version never start the server", () => {
  const cases: [string, string[], "help" | "version"][] = [
    ["cli.js", ["--help"], "help"],
    ["cli.js", ["--version"], "version"],
    ["cli.js", ["mcp", "--help"], "help"],
    ["cli.js", ["mcp", "-h"], "help"],
    ["cli.js", ["mcp", "--version"], "version"],
    ["cli.js", ["mcp", "-V"], "version"],
    ["cli.js", ["mcp", "-v"], "version"],
    ["mcp-bin.js", ["--help"], "help"],
    ["mcp-bin.js", ["--version"], "version"],
    ["mcp-bin.js", ["-V"], "version"],
    ["mcp-bin.js", ["-v"], "version"],
  ];
  for (const [file, args, kind] of cases) {
    test(`${file} ${args.join(" ")} exits 0 within 5 s`, async () => {
      const r = await run(file, args);
      expect([r.code, r.err]).toEqual([0, ""]);
      if (kind === "version") expect(r.out.trim()).toBe(VERSION);
      else expect(r.out).toContain("Usage");
    });
  }
});

// `--as kind:name` sets the principal, as it does in the CLI. Stdin is closed, so a started server exits.
function runWithPrincipalFlag(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist("mcp-bin.js"), ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, err });
    });
    child.stdin.end();
  });
}

describe("--as sets the principal of the MCP bin", () => {
  // Each refusal runs with a valid AGENTIC_COMMENTS_AS, so a fallback to the variable would start the server and fail these.
  const valid = { AGENTIC_COMMENTS_AS: "human:ada" };

  test("--as kind:name starts the server with no variable set", async () => {
    expect(await runWithPrincipalFlag(["--as", "human:ada"])).toEqual({ code: 0, err: "" });
  });

  test("--as overrides a variable that is not valid", async () => {
    expect(await runWithPrincipalFlag(["--as", "human:ada"], { AGENTIC_COMMENTS_AS: "nope" })).toEqual({ code: 0, err: "" });
  });

  test.each([[["--as"]], [["--as", "nope"]], [["--as", "-h"]]])("%j fails closed with INVALID_AUTHOR, exit 1 within 5 s, even with a valid variable", async (args) => {
    const r = await runWithPrincipalFlag(args, valid);
    expect(r.code).toBe(1);
    expect(r.err).toContain("INVALID_AUTHOR");
  });

  test.each([[["--as", "human:ada", "--as", "nope"]], [["--as=human:ada"]]])("%j is a usage error, exit 2, and never starts the server", async (args) => {
    const r = await runWithPrincipalFlag(args, valid);
    expect(r.code).toBe(2);
    expect(r.err).toContain('"USAGE"');
  });
});
