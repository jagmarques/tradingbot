import { describe, it, expect } from "vitest";
import { evalBalanceGuard } from "./hft-fade-engine.js";

const MIN = 200;
const LABEL = "HFT-Regime";

describe("evalBalanceGuard", () => {
  it("ok when equity above threshold and not halted", () => {
    const r = evalBalanceGuard(250, false, MIN, LABEL);
    expect(r.ok).toBe(true);
    expect(r.newHalted).toBe(false);
    expect(r.alertMsg).toBeNull();
    expect(r.logMsg).toBeNull();
  });

  it("halts and sends alert on first breach", () => {
    const r = evalBalanceGuard(150, false, MIN, LABEL);
    expect(r.ok).toBe(false);
    expect(r.newHalted).toBe(true);
    expect(r.alertMsg).toContain("⛔ HFT LIVE STOPPED");
    expect(r.alertMsg).toContain("150.00");
    expect(r.alertMsg).toContain("automatically resume");
    expect(r.logMsg).toContain("halting live trading");
  });

  it("stays halted on repeated breach — no duplicate alert", () => {
    const r = evalBalanceGuard(150, true, MIN, LABEL);
    expect(r.ok).toBe(false);
    expect(r.newHalted).toBe(true);
    expect(r.alertMsg).toBeNull(); // no telegram spam
    expect(r.logMsg).toContain("still below");
  });

  it("auto-resets when balance recovers", () => {
    const r = evalBalanceGuard(210, true, MIN, LABEL);
    expect(r.ok).toBe(true);
    expect(r.newHalted).toBe(false);
    expect(r.alertMsg).toBeNull();
    expect(r.logMsg).toContain("recovered");
    expect(r.logMsg).toContain("210.00");
  });

  it("exact threshold boundary: equity === min is ok", () => {
    const r = evalBalanceGuard(200, false, MIN, LABEL);
    expect(r.ok).toBe(true);
    expect(r.newHalted).toBe(false);
  });

  it("one cent below threshold triggers halt", () => {
    const r = evalBalanceGuard(199.99, false, MIN, LABEL);
    expect(r.ok).toBe(false);
    expect(r.newHalted).toBe(true);
    expect(r.alertMsg).not.toBeNull();
  });

  it("uses config label in log messages", () => {
    const r = evalBalanceGuard(100, false, MIN, "HFT-Smart");
    expect(r.logMsg).toContain("HFT-Smart");
    const r2 = evalBalanceGuard(100, true, MIN, "HFT-Smart");
    expect(r2.logMsg).toContain("HFT-Smart");
    const r3 = evalBalanceGuard(300, true, MIN, "HFT-Smart");
    expect(r3.logMsg).toContain("HFT-Smart");
  });
});
