import { describe, expect, test } from "bun:test";
import { cosineSimilarity } from "../../src/memory/aging.js";

describe("cosineSimilarity", () => {
  test("identical vectors return 1", () => {
    const a = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors return 0", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors return -1", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("handles zero vectors", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("similar vectors return high similarity", () => {
    const a = [1, 2, 3];
    const b = [1.1, 2.1, 3.1];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  test("works with high-dimensional vectors", () => {
    const dim = 1024;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

describe("decay math", () => {
  test("decayRate^0 = 1 (no decay for just-accessed memories)", () => {
    const decayRate = 0.95;
    expect(Math.pow(decayRate, 0)).toBe(1.0);
  });

  test("decayRate^1 reduces score by 5%", () => {
    const decayRate = 0.95;
    const score = 0.8;
    expect(score * Math.pow(decayRate, 1)).toBeCloseTo(0.76, 5);
  });

  test("decayRate^30 significantly reduces score", () => {
    const decayRate = 0.95;
    const score = 1.0;
    const decayed = score * Math.pow(decayRate, 30);
    expect(decayed).toBeCloseTo(0.2146, 3);
  });

  test("decayRate^365 nearly zeroes score", () => {
    const decayRate = 0.95;
    const score = 1.0;
    const decayed = score * Math.pow(decayRate, 365);
    expect(decayed).toBeLessThan(0.001);
  });
});
