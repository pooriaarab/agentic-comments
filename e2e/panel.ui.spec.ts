import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADA, BOSS, SCRIBE } from "./tokens.js";

const TEXT = "Revenue grew 12 percent in the third quarter. Churn stayed flat. Headcount is 41.";
const call = (request: APIRequest, token: string, method: "get" | "post" | "delete", path: string, data?: unknown) =>
  request[method](`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` }, data });
type APIRequest = APIRequestContext;

let counter = 0;
/** A fresh document with one thread (a person and an agent wrote in it) and two suggestions: one by an agent, one by a person. */
async function seed(request: APIRequest) {
  const doc = `ui-${Date.now()}-${counter++}`;
  const made = await call(request, ADA, "post", "/docs", { id: doc, text: TEXT });
  expect(made.status(), await made.text()).toBe(201);
  const thread = await (await call(request, ADA, "post", `/docs/${doc}/threads`, { anchor: { type: "text", quote: "Revenue grew 12 percent" }, body: "Which regions drove this?" })).json();
  expect((await call(request, BOSS, "post", `/docs/${doc}/threads/${thread.id}/replies`, { body: "Europe drove most of it." })).ok()).toBe(true);
  const byAgent = await call(request, BOSS, "post", `/docs/${doc}/suggestions`, { anchor: { type: "text", quote: "Churn stayed flat" }, change: { replace: "Churn fell 2 percent" }, summary: "Use the exact churn figure." });
  expect(byAgent.ok()).toBe(true);
  const byPerson = await call(request, ADA, "post", `/docs/${doc}/suggestions`, { anchor: { type: "text", quote: "Headcount is 41" }, change: { replace: "Headcount is 43" }, summary: "The people page says 43." });
  expect(byPerson.ok()).toBe(true);
  return { doc, agentSuggestion: (await byAgent.json()).id as string, personSuggestion: (await byPerson.json()).id as string };
}

const open = async (page: Page, token: string, doc: string) => {
  await page.goto(`/#token=${token}&doc=${doc}`);
  await expect(page.getByRole("heading", { level: 1, name: "Q3 report comments" })).toBeVisible();
  await expect(page.getByText("Which regions drove this?")).toBeVisible();
};

const suggestionCard = (page: Page, summary: string) => page.getByRole("listitem").filter({ hasText: summary });

test("a person reads a thread, sees the agent mark, replies, resolves, and reopens", async ({ page, request }) => {
  const { doc } = await seed(request);
  await open(page, ADA, doc);
  await expect(page.locator("blockquote").first()).toHaveText("Revenue grew 12 percent");
  await expect(page.getByText("Comment by an agent")).toBeVisible(); // the reply by an agent says so in words
  await page.getByLabel("Reply").first().fill("Thanks, that helps.");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText("Thanks, that helps.")).toBeVisible();
  await page.getByRole("button", { name: /^Resolve thread/ }).click();
  await expect(page.getByText("No open threads.")).toBeVisible();
  await page.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(page.getByText("Reopen this thread to reply.")).toBeVisible();
  await expect(page.getByLabel("Reply")).toHaveCount(0);
  await page.getByRole("button", { name: /^Reopen thread/ }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByLabel("Reply").first()).toBeVisible();
});

test("a person starts a thread on a quote, and a bad quote shows the error", async ({ page, request }) => {
  const { doc } = await seed(request);
  await open(page, ADA, doc);
  await page.getByLabel("Quote to comment on").fill("Not in the document");
  await page.getByLabel("Comment", { exact: true }).fill("Where is this?");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByRole("alert")).toContainText(/:/); // the error code leads the message
  await page.getByLabel("Quote to comment on").fill("Churn stayed flat");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Where is this?")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a person accepts an agent suggestion, and can reject a suggestion", async ({ page, request }) => {
  const { doc } = await seed(request);
  await open(page, ADA, doc);
  const card = suggestionCard(page, "Use the exact churn figure.");
  await expect(card.getByText("Suggested by an agent")).toBeVisible();
  await card.getByRole("button", { name: "Accept suggestion" }).click();
  await expect(card.getByText("Accepted")).toHaveCount(2); // the pill and the line with who decided
  await expect(card.getByRole("button", { name: /Accept|Reject/ })).toHaveCount(0);
  const text = await (await call(request, ADA, "get", `/docs/${doc}`)).json();
  expect(text.text).toContain("Churn fell 2 percent");
  // a person can also reject
  const other = suggestionCard(page, "The people page says 43.");
  await other.getByRole("button", { name: "Reject suggestion" }).click();
  await expect(other.getByText(/^Rejected/).first()).toBeVisible();
});

test("an agent never gets accept or reject for its own suggestion, and the server refuses it too", async ({ page, request }) => {
  const { doc, agentSuggestion } = await seed(request);
  await open(page, BOSS, doc);
  const own = suggestionCard(page, "Use the exact churn figure.");
  await expect(own.getByRole("button", { name: /Accept|Reject/ })).toHaveCount(0);
  await expect(own.getByText("An agent cannot accept or reject its own suggestion.", { exact: false })).toBeVisible();
  // the person's suggestion: the agent holds the accept right, so both buttons show
  const theirs = suggestionCard(page, "The people page says 43.");
  await expect(theirs.getByRole("button", { name: "Accept suggestion" })).toBeVisible();
  await expect(theirs.getByRole("button", { name: "Reject suggestion" })).toBeVisible();
  for (const action of ["accept", "reject"]) {
    const refused = await call(request, BOSS, "post", `/docs/${doc}/suggestions/${agentSuggestion}/${action}`);
    expect(refused.status()).toBe(403);
  }
});

test("an agent with no accept right sees no decision buttons", async ({ page, request }) => {
  const { doc } = await seed(request);
  await open(page, SCRIBE, doc);
  await expect(page.getByRole("button", { name: /Accept|Reject/ })).toHaveCount(0);
  await expect(page.getByText("Your access cannot accept or reject suggestions.").first()).toBeVisible();
});

test("a failed call shows its code, and the panel does not retry", async ({ page, request }) => {
  const { doc } = await seed(request);
  await open(page, ADA, doc);
  const id = (await (await call(request, ADA, "get", `/docs/${doc}/threads`)).json())[0].id;
  // Someone resolves the thread after the page loaded. The reply is now refused: reopen first.
  expect((await call(request, ADA, "post", `/docs/${doc}/threads/${id}/resolve`)).ok()).toBe(true);
  const replies: string[] = [];
  page.on("request", (r) => r.url().endsWith("/replies") && replies.push(r.url()));
  await page.getByLabel("Reply").first().fill("Late reply");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/^[A-Z_]+: /);
  await page.waitForTimeout(300);
  expect(replies).toHaveLength(1);
  // The error stays, and the panel reads again: the thread is resolved, so the open view no longer lists it.
  await expect(page.getByText("No open threads.")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds no WCAG 2.2 AA problem in the ${scheme} theme`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { doc } = await seed(request);
    await open(page, ADA, doc);
    await page.getByRole("button", { name: "All", exact: true }).click();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`)).toEqual([]);
  });
}

test("the page fits 390px with no sideways scroll, and passes axe there", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { doc } = await seed(request);
  await open(page, ADA, doc);
  await page.getByRole("button", { name: "All", exact: true }).click();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const culprits = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 390.5).map((e) => `${e.tagName}.${e.className}`).slice(0, 5));
  expect(culprits).toEqual([]);
  expect(wide).toBeLessThanOrEqual(0);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations).toEqual([]);
});

test("the demo page works with no token and follows the rule for each principal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Q3 report comments" })).toBeVisible();
  const own = suggestionCard(page, "Use the exact figure from the sales table.");
  await expect(own.getByRole("button", { name: "Accept suggestion" })).toBeVisible(); // maya, a person
  await page.getByLabel("Signed in as").selectOption("review-bot");
  await expect(own.getByRole("button", { name: /Accept|Reject/ })).toHaveCount(0); // its own suggestion
  await expect(suggestionCard(page, "Say which dates the quarter covers.").getByRole("button", { name: "Accept suggestion" })).toBeVisible();
  await page.getByLabel("Signed in as").selectOption("copy-editor");
  await expect(page.getByRole("button", { name: /Accept|Reject/ })).toHaveCount(0);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations).toEqual([]);
});

test("screenshots", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=1 to write the PR screenshots");
  for (const [name, width, height, scheme] of [["panel-light", 1280, 1400, "light"], ["panel-dark", 1280, 1400, "dark"], ["panel-390", 390, 2200, "light"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByText("Can we say which regions drove this?")).toBeVisible();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true });
  }
});
