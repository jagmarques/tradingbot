import { describe, it, expect } from "vitest";
import { withTimeout, TimeoutError } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves if promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError if promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50, "slow-op")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(slow, 50, "slow-op")).rejects.toThrow("slow-op timed out after 50ms");
  });

  it("propagates original error if promise rejects before timeout", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 1000, "test")).rejects.toThrow("boom");
  });
});
