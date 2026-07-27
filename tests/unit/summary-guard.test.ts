import { describe, expect, test } from "bun:test";
import { SessionSummarySchema } from "../../src/memory/schema.js";
import { isEmptySummary } from "../../src/memory/summary-guard.js";

describe("isEmptySummary", () => {
  test("treats an all-defaults husk as empty", () => {
    const husk = SessionSummarySchema.parse({});
    expect(isEmptySummary(husk)).toBe(true);
  });

  test("treats a garbage-parsed object as empty", () => {
    const husk = SessionSummarySchema.parse({ foo: "bar" });
    expect(isEmptySummary(husk)).toBe(true);
  });

  test("treats a summary with only the default one-liner as empty", () => {
    const husk = SessionSummarySchema.parse({ filesChanged: [] });
    expect(isEmptySummary(husk)).toBe(true);
  });

  test("keeps a summary carrying a real one-line summary", () => {
    const real = SessionSummarySchema.parse({
      oneLineSummary: "Fixed the OTel license gate",
    });
    expect(isEmptySummary(real)).toBe(false);
  });

  test("keeps a summary carrying only structured detail", () => {
    const real = SessionSummarySchema.parse({
      decisions: [{ text: "Switch to qwen2.5:3b", status: "done" }],
    });
    expect(isEmptySummary(real)).toBe(false);
  });

  test("keeps a summary carrying only filesChanged", () => {
    const real = SessionSummarySchema.parse({
      filesChanged: ["src/index.ts"],
    });
    expect(isEmptySummary(real)).toBe(false);
  });
});
