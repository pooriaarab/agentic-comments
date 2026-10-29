// Three bearer tokens for the UI tests. The Worker reads them from the static list that the test config turns on.
export const ADA = `ada-${"a".repeat(40)}`; // a person
export const BOSS = `boss-${"b".repeat(40)}`; // an agent that holds the accept right
export const SCRIBE = `scribe-${"c".repeat(40)}`; // an agent that only comments
export const TOKENS = {
  [ADA]: { as: "human:ada", scopes: ["comments:admin"] },
  [BOSS]: { as: "agent_of_human:boss", scopes: ["comments:admin"] },
  [SCRIBE]: { as: "agent_of_human:scribe", scopes: ["comments:comment"] },
};
