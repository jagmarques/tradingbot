import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBinanceConnect = vi.fn().mockResolvedValue(undefined);
const mockBinanceDisconnect = vi.fn();
const mockBinanceIsConnected = vi.fn().mockReturnValue(true);
const mockBinanceOnPrice = vi.fn().mockReturnValue(() => {});
const mockBinanceGetPrice = vi.fn().mockReturnValue(50000);

const mockCoinbaseConnect = vi.fn().mockResolvedValue(undefined);
const mockCoinbaseDisconnect = vi.fn();
const mockCoinbaseIsConnected = vi.fn().mockReturnValue(true);
const mockCoinbaseOnPrice = vi.fn().mockReturnValue(() => {});
const mockCoinbaseGetPrice = vi.fn().mockReturnValue(50000);

vi.mock("./binance.js", () => ({
  connect: mockBinanceConnect,
  disconnect: mockBinanceDisconnect,
  isConnected: mockBinanceIsConnected,
  onPrice: mockBinanceOnPrice,
  getPrice: mockBinanceGetPrice,
}));

vi.mock("./coinbase.js", () => ({
  connect: mockCoinbaseConnect,
  disconnect: mockCoinbaseDisconnect,
  isConnected: mockCoinbaseIsConnected,
  onPrice: mockCoinbaseOnPrice,
  getPrice: mockCoinbaseGetPrice,
}));

describe("Price Feed Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should start and connect to both sources", async () => {
    const { start, stop } = await import("./manager.js");

    await start(["BTCUSDT", "ETHUSDT"]);

    expect(mockBinanceConnect).toHaveBeenCalledWith(["BTCUSDT", "ETHUSDT"]);
    expect(mockCoinbaseConnect).toHaveBeenCalledWith(["BTCUSDT", "ETHUSDT"]);
    expect(mockBinanceOnPrice).toHaveBeenCalled();
    expect(mockCoinbaseOnPrice).toHaveBeenCalled();

    stop();
  });

  it("should stop and disconnect from both sources", async () => {
    const { start, stop } = await import("./manager.js");

    await start(["BTCUSDT"]);
    stop();

    expect(mockBinanceDisconnect).toHaveBeenCalled();
    expect(mockCoinbaseDisconnect).toHaveBeenCalled();
  });

  it("should report healthy when at least one source connected", async () => {
    const { isHealthy } = await import("./manager.js");

    mockBinanceIsConnected.mockReturnValue(true);
    mockCoinbaseIsConnected.mockReturnValue(false);

    expect(isHealthy()).toBe(true);
  });

  it("should report unhealthy when no sources connected", async () => {
    const { isHealthy } = await import("./manager.js");

    mockBinanceIsConnected.mockReturnValue(false);
    mockCoinbaseIsConnected.mockReturnValue(false);

    expect(isHealthy()).toBe(false);
  });

  it("should return status with connection info", async () => {
    const { getStatus } = await import("./manager.js");

    mockBinanceIsConnected.mockReturnValue(true);
    mockCoinbaseIsConnected.mockReturnValue(false);

    const status = getStatus();

    expect(status.primary.source).toBe("binance");
    expect(status.primary.connected).toBe(true);
    expect(status.fallback.source).toBe("coinbase");
    expect(status.fallback.connected).toBe(false);
  });

  it("should register price callbacks", async () => {
    const { onPrice, stop } = await import("./manager.js");

    const callback = vi.fn();
    const unsubscribe = onPrice(callback);

    expect(typeof unsubscribe).toBe("function");

    stop();
  });

  it("should handle primary source connection failure gracefully", async () => {
    mockBinanceConnect.mockRejectedValueOnce(new Error("Connection failed"));

    const { start, stop } = await import("./manager.js");

    // Should not throw
    await start(["BTCUSDT"]);

    expect(mockCoinbaseConnect).toHaveBeenCalled();

    stop();
  });
});
