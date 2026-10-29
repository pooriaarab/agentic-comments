// The comments panel for a React page: `agentic-comments/ui`. Import `agentic-design/styles.css` and
// `agentic-comments/ui.css` too. React and react-dom are peer dependencies.
export { CommentsPanel, type CommentsPanelProps, type PanelClient } from "./panel.js";
export { holds, mayDecide, type Decision, type Need } from "./rules.js";
export { createClient, type CommentsClient, type Me } from "../client.js";
