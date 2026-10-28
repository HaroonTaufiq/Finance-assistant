import { describe, expect, it } from "vitest";
import { parseCutbacksOutput } from "./cutbacks";

describe("parseCutbacksOutput", () => {
  it("parses valid JSON and fenced JSON into validated suggestions", () => {
    const suggestions = parseCutbacksOutput(`\`\`\`json
      [{"title":"Review streaming","detail":"Two monthly charges","monthly_savings_cents":1200,"category":"subscriptions"}]
    \`\`\``);

    expect(suggestions).toEqual([
      {
        title: "Review streaming",
        detail: "Two monthly charges",
        monthly_savings_cents: 1200,
        category: "subscriptions",
      },
    ]);
  });

  it("rejects malformed or ungrounded output instead of returning empty suggestions", () => {
    expect(() => parseCutbacksOutput("not JSON")).toThrow("invalid JSON");
    expect(() => parseCutbacksOutput('[{"title":"Save money"}]')).toThrow("invalid shape");
  });
});
