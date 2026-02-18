import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("../../config/env.js", () => ({
  loadEnv: vi.fn(() => ({
    POLYMARKET_API_KEY: "test-api-key",
    POLYMARKET_SECRET: "test-secret",
    POLYMARKET_PASSPHRASE: "test-passphrase",
  })),
}));

vi.mock("./wallet.js", () => ({
  getAddress: vi.fn(() => "0x1234567890123456789012345678901234567890"),
}));

describe("Polymarket CLOB Client", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should get orderbook", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          bids: [["0.55", "100"]],
          asks: [["0.57", "100"]],
        }),
    });

    const { getOrderbook } = await import("./polymarket.js");
    const book = await getOrderbook("token-123");

    expect(book).toBeDefined();
    expect(book?.bids[0][0]).toBe("0.55");
    expect(book?.asks[0][0]).toBe("0.57");
  });

  it("should calculate midpoint price", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          bids: [["0.50", "100"]],
          asks: [["0.60", "100"]],
        }),
    });

    const { getMidpointPrice } = await import("./polymarket.js");
    const midpoint = await getMidpointPrice("token-123");

    expect(midpoint).toBe(0.55);
  });

  it("should return null for empty orderbook", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          bids: [],
          asks: [],
        }),
    });

    const { getMidpointPrice } = await import("./polymarket.js");
    const midpoint = await getMidpointPrice("token-123");

    expect(midpoint).toBeNull();
  });

  it("should place order", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "order-123",
          status: "open",
          tokenId: "token-123",
          side: "BUY",
          price: "0.55",
          size: "10",
          sizeMatched: "0",
        }),
    });

    const { placeOrder } = await import("./polymarket.js");
    const order = await placeOrder({
      tokenId: "token-123",
      side: "BUY",
      price: "0.55",
      size: "10",
    });

    expect(order).toBeDefined();
    expect(order?.id).toBe("order-123");
  });

  it("should cancel order", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { cancelOrder } = await import("./polymarket.js");
    const result = await cancelOrder("order-123");

    expect(result).toBe(true);
  });

  it("should handle API errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const { getOrderbook } = await import("./polymarket.js");
    const result = await getOrderbook("token-123");

    expect(result).toBeNull();
  });

  it("should validate API connection", async () => {
    const { validateApiConnection } = await import("./polymarket.js");
    const isValid = await validateApiConnection();

    expect(isValid).toBe(true);
  });

  it("should fail API validation on auth error", async () => {
    const { loadEnv } = await import("../../config/env.js");
    vi.mocked(loadEnv).mockReturnValueOnce({
      POLYMARKET_API_KEY: "",
      POLYMARKET_SECRET: "test-secret",
      POLYMARKET_PASSPHRASE: "test-passphrase",
    } as unknown);

    const { validateApiConnection } = await import("./polymarket.js");
    const isValid = await validateApiConnection();

    expect(isValid).toBe(false);
  });

  it("should fail API validation on network error", async () => {
    const { loadEnv } = await import("../../config/env.js");
    vi.mocked(loadEnv).mockReturnValueOnce({
      POLYMARKET_API_KEY: "test-api-key",
      POLYMARKET_SECRET: "test-secret",
      POLYMARKET_PASSPHRASE: "",
    } as unknown);

    const { validateApiConnection } = await import("./polymarket.js");
    const isValid = await validateApiConnection();

    expect(isValid).toBe(false);
  });

  it("should get open orders", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "order-1", status: "open" },
          { id: "order-2", status: "open" },
        ]),
    });

    const { getOpenOrders } = await import("./polymarket.js");
    const orders = await getOpenOrders();

    expect(orders).toHaveLength(2);
  });
});
