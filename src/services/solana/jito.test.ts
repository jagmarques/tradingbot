import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

vi.mock("../../config/env.js", () => ({
  loadEnv: vi.fn(() => ({
    JITO_TIP_AMOUNT: 0.001,
    HELIUS_API_KEY: "test-key",
    SOLANA_PRIVATE_KEY: "4wBqpZM9kbgHoXxDySNNTgLvmXxrPmL5PmDNL2hLvvSdpRQxqZvtxDBNQ8sVyF1NVEqPqRNLqmRNpgeLAXJRWQQA",
    MIN_SOL_RESERVE: 0.1,
  })),
}));

vi.mock("./wallet.js", () => ({
  getConnection: vi.fn(() => ({
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "test-blockhash",
      lastValidBlockHeight: 12345,
    }),
  })),
  loadKeypair: vi.fn(() => ({
    publicKey: new PublicKey("11111111111111111111111111111111"),
    secretKey: new Uint8Array(64).fill(1),
  })),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Jito Bundle Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create tip instruction with correct amount", async () => {
    const { createTipInstruction } = await import("./jito.js");
    const payer = new PublicKey("11111111111111111111111111111111");
    const tipIx = createTipInstruction(payer);

    expect(tipIx.programId.equals(SystemProgram.programId)).toBe(true);
    expect(tipIx.keys[0].pubkey.equals(payer)).toBe(true);
  });

  it("should submit bundle and return bundle ID", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ result: "bundle-id-123" }),
    });

    const { submitBundle } = await import("./jito.js");
    const result = await submitBundle([]);

    expect(result).toBe("bundle-id-123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("jito.wtf"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("should return null on bundle submission error", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ error: { message: "Test error" } }),
    });

    const { submitBundle } = await import("./jito.js");
    const result = await submitBundle([]);

    expect(result).toBeNull();
  });

  it("should get bundle status", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          result: { value: [{ bundle_id: "test-id", status: "Landed" }] },
        }),
    });

    const { getBundleStatus } = await import("./jito.js");
    const status = await getBundleStatus("test-id");

    expect(status).toBe("Landed");
  });

  it("should return null on status check error", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ error: { message: "Not found" } }),
    });

    const { getBundleStatus } = await import("./jito.js");
    const status = await getBundleStatus("invalid-id");

    expect(status).toBeNull();
  });

  it("should wait for bundle confirmation", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          result: { value: [{ bundle_id: "test-id", status: "Landed" }] },
        }),
    });

    const { waitForBundleConfirmation } = await import("./jito.js");
    const confirmed = await waitForBundleConfirmation("test-id", 3, 10);

    expect(confirmed).toBe(true);
  });

  it("should return false on bundle failure", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          result: { value: [{ bundle_id: "test-id", status: "Failed" }] },
        }),
    });

    const { waitForBundleConfirmation } = await import("./jito.js");
    const confirmed = await waitForBundleConfirmation("test-id", 3, 10);

    expect(confirmed).toBe(false);
  });
});
