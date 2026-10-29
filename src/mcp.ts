import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CommentsError } from "./errors.js";
import type { FileStore } from "./file-store.js";
import type { Actor } from "./principal.js";
import { CommentsService } from "./service.js";
import { VERSION } from "./version.js";

const anchor = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("text"), quote: z.string().describe("Exact text to anchor to."), occurrence: z.number().int().min(1).optional().describe("Which match, when the quote occurs more than once.") }).strict(),
    z.object({ type: z.literal("cell"), key: z.string() }).strict(),
    z.object({ type: z.literal("slide"), elementId: z.string() }).strict(),
    z.object({ type: z.literal("canvas"), elementId: z.string() }).strict(),
  ])
  .describe("Where the thread or suggestion points.");

const id = z.string().describe("The thread or suggestion id.");
const body = z.string().describe("The message text. Write @handle to mention someone.");
const mentions = z.array(z.string()).optional().describe("Extra handles to mention.");

function ok(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const known = error instanceof CommentsError;
  return { content: [{ type: "text", text: JSON.stringify({ error: { code: known ? error.code : "INTERNAL", message: error instanceof Error ? error.message : String(error) } }) }], isError: true };
}

/**
 * The server acts as one principal, fixed when the operator starts it. No tool takes an author or a scope,
 * so an agent that calls a tool cannot pick its own kind or rights.
 */
export function createMcpServer(store: FileStore, actor: Actor): McpServer {
  const service = new CommentsService(store, actor);
  const server = new McpServer({ name: "agentic-comments", version: VERSION });
  // The SDK serves tools/list from these schemas. Calls go through one handler below, so every input error
  // comes back as JSON with a code, the same as the CLI, and a key a tool does not list is refused.
  const tools = new Map<string, { strict: z.ZodTypeAny; run: (input: unknown) => unknown }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (name: string, description: string, shape: z.ZodRawShape, readOnly: boolean, run: (input: any) => unknown) => {
    const strict = z.object(shape).strict();
    tools.set(name, { strict, run });
    server.registerTool(name, { description, inputSchema: strict as never, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, (() => {
      throw new Error("calls are handled by the server");
    }) as never);
  };

  const state = z.enum(["attached", "edited", "orphaned", "unknown"]).optional();
  tool("list_threads", "List comment threads. Each has an anchorState: an orphaned thread lost its content but stays readable.", { status: z.enum(["open", "resolved"]).optional(), anchorState: state, mentioning: z.string().optional() }, true, (i) => service.threads(i));
  tool("get_thread", "Read one thread with its messages.", { id }, true, (i) => service.thread(i.id));
  tool("add_comment", "Start a thread on text, a cell, a slide element, or a canvas element.", { anchor, body, mentions }, false, (i) => service.comment(i));
  tool("reply_to_thread", "Reply to an open thread. Reopen a resolved thread first.", { id, body, mentions }, false, (i) => service.reply(i.id, { body: i.body, mentions: i.mentions }));
  tool("resolve_thread", "Resolve a thread.", { id }, false, (i) => service.resolve(i.id));
  tool("reopen_thread", "Reopen a resolved thread.", { id }, false, (i) => service.reopen(i.id));
  tool("relocate_thread", "Move a text anchor to its quote when the quote occurs exactly once.", { id }, false, (i) => service.relocate(i.id));
  tool("list_suggestions", "List suggested changes.", { status: z.enum(["pending", "accepted", "rejected"]).optional(), anchorState: state }, true, (i) => service.suggestions(i));
  tool(
    "suggest_change",
    'Suggest a change. For a text anchor the change is {"replace": "new text"}. For another anchor it is {"value": <JSON>}.',
    { anchor, change: z.union([z.object({ replace: z.string() }).strict(), z.object({ value: z.unknown() }).strict()]), summary: z.string().optional() },
    false,
    (i) => service.suggest(i),
  );
  tool("accept_suggestion", "Accept a suggestion. Needs the accept scope for an agent, and never works on your own suggestion.", { id }, false, (i) => service.accept(i.id));
  tool("reject_suggestion", "Reject a suggestion. Same rights as accept.", { id }, false, (i) => service.reject(i.id));
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const entry = tools.get(request.params.name);
    if (!entry) return failure(new CommentsError("INVALID_INPUT", `there is no tool named ${JSON.stringify(request.params.name.slice(0, 60))}`));
    try {
      const checked = entry.strict.safeParse(request.params.arguments ?? {});
      if (!checked.success) {
        const where = checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        throw new CommentsError("INVALID_INPUT", `the tool input is refused: ${where.slice(0, 400)}`);
      }
      return ok(entry.run(checked.data));
    } catch (error) {
      return failure(error);
    }
  });
  return server;
}

export async function startMcp(store: FileStore, actor: Actor): Promise<void> {
  const server = createMcpServer(store, actor);
  await server.connect(new StdioServerTransport());
}
