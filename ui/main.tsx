// The demo page. By default it runs on an in-memory client, so it works with no token. With `#token=<bearer>` (and
// optionally `&doc=<id>`) it talks to the Worker that serves it.
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Select, ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import "agentic-design/styles.css";
import "../src/ui/panel.css";
import "./demo.css";
import { CommentsPanel, createClient, type PanelClient } from "../src/ui/index.js";
import { PRINCIPALS, createStore, memoryClient } from "./memory-client.js";

// Read once, at load: the token leaves the address bar, so a second read would find nothing.
const live = (() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token) history.replaceState(null, "", location.pathname + location.search);
  return token ? { token, doc: params.get("doc") ?? "demo" } : undefined;
})();

function Demo() {
  const [who, setWho] = useState("maya");
  const store = useMemo(createStore, []);
  const client: PanelClient = useMemo(() => (live ? createClient({ baseUrl: location.origin, token: live.token }) : memoryClient(store, PRINCIPALS[who]!)), [store, who]);
  return (
    <>
      <a className="agd-skip-link" href="#main">Skip to the comments</a>
      <main id="main" className="demo">
        {!live && (
          <div className="demo__who">
            <Select label="Signed in as" value={who} onChange={(e) => setWho(e.target.value)} hint="Pick a principal to see what the panel offers it.">
              <option value="maya">maya, a person</option>
              <option value="review-bot">review-bot, an agent that can accept</option>
              <option value="copy-editor">copy-editor, an agent that comments only</option>
            </Select>
          </div>
        )}
        <CommentsPanel client={client} docId={live?.doc ?? "demo"} title="Q3 report comments" />
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <Demo />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
