import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const mockGetBalance = vi.fn().mockResolvedValue(5 * LAMPORTS_PER_SOL);
const mockGetSlot = vi.fn().mockResolvedValue(123456789);

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    Connection: class MockConnection {
      getBalance = mockGetBalance;
      getSlot = mockGetSlot;
    },
  };
});

// Generate a valid keypair and get its base58 secret key for testing
const testKeypair = Keypair.generate();
const testSecretKey = Buffer.from(testKeypair.secretKey).toString("base64");

vi.mock("bs58", () => ({
  default: {
    decode: () => testKeypair.secretKey,
  },
}));

vi.mock("../../config/env.js", () => ({
  loadEnv: vi.fn(() => ({
    HELIUS_API_KEY: "test-helius-key",
    SOLANA_PRIVATE_KEY: "mock-key-will-be-decoded-by-bs58-mock",
    MIN_SOL_RESERVE: 0.1,
  })),
}));

describe("Solana Wallet", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should create connection", async () => {
    const { getConnection } = await import("./wallet.js");
    const connection = getConnection();
    expect(connection).toBeDefined();
  });

  it("should load keypair from private key", async () => {
    const { loadKeypair } = await import("./wallet.js");
    const keypair = loadKeypair();
    expect(keypair).toBeDefined();
    expect(keypair.publicKey).toBeDefined();
  });

  it("should get public key", async () => {
    const { getPublicKey } = await import("./wallet.js");
    const pubkey = getPublicKey();
    expect(pubkey).toBeDefined();
    expect(pubkey.toBase58()).toBeTruthy();
  });

  it("should get SOL balance as BigInt", async () => {
    const { getSolBalance } = await import("./wallet.js");
    const balance = await getSolBalance();
    expect(typeof balance).toBe("bigint");
    expect(balance).toBe(BigInt(5 * LAMPORTS_PER_SOL));
  });

  it("should format SOL balance", async () => {
    const { getSolBalanceFormatted } = await import("./wallet.js");
    const formatted = await getSolBalanceFormatted();
    expect(formatted).toBe("5.0000");
  });

  it("should check minimum SOL reserve", async () => {
    const { hasMinimumSolReserve } = await import("./wallet.js");
    const hasReserve = await hasMinimumSolReserve();
    expect(hasReserve).toBe(true);
  });

  it("should validate connection", async () => {
    const { validateConnection } = await import("./wallet.js");
    const isValid = await validateConnection();
    expect(isValid).toBe(true);
  });

  it("should reset connection", async () => {
    const { getConnection, resetConnection } = await import("./wallet.js");
    const conn1 = getConnection();
    resetConnection();
    const conn2 = getConnection();
    // After reset, we get a new connection instance
    expect(conn1).not.toBe(conn2);
  });
});
