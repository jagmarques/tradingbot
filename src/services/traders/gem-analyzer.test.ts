import { describe, it, expect, vi, beforeEach } from "vitest";
import { COPY_TRADE_CONFIG } from "./types.js";

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
  loadEnv: vi.fn(() => ({})),
}));

const mockDexScreenerFetch = vi.fn();
const mockDexScreenerFetchBatch = vi.fn();
vi.mock("../shared/dexscreener.js", () => ({
  dexScreenerFetch: (...args: unknown[]): unknown => mockDexScreenerFetch(...args),
  dexScreenerFetchBatch: (...args: unknown[]): unknown => mockDexScreenerFetchBatch(...args),
}));

const mockGetOpenCopyTrades = vi.fn();
const mockUpdateCopyTradePrice = vi.fn();
const mockCloseCopyTrade = vi.fn();
const mockUpdateCopyTradePeakPnl = vi.fn();
const mockUpdateCopyTradeTokenCreatedAt = vi.fn();
const mockIncrementRugCount = vi.fn();
vi.mock("./storage.js", () => ({
  getCachedGemAnalysis: vi.fn(() => null),
  saveGemAnalysis: vi.fn(),
  insertGemPaperTrade: vi.fn(),
  getGemPaperTrade: vi.fn(),
  getOpenGemPaperTrades: vi.fn(() => []),
  closeGemPaperTrade: vi.fn(),
  getTokenAddressForGem: vi.fn(),
  updateGemPaperTradePrice: vi.fn(),
  getInsiderStatsForToken: vi.fn(() => ({ insiderCount: 0, holdRate: 0, avgInsiderQuality: 0 })),
  getOpenCopyTrades: (...args: unknown[]): unknown => mockGetOpenCopyTrades(...args),
  updateCopyTradePrice: (...args: unknown[]): unknown => mockUpdateCopyTradePrice(...args),
  closeCopyTrade: (...args: unknown[]): unknown => mockCloseCopyTrade(...args),
  updateCopyTradePeakPnl: (...args: unknown[]): unknown => mockUpdateCopyTradePeakPnl(...args),
  updateCopyTradeTokenCreatedAt: (...args: unknown[]): unknown => mockUpdateCopyTradeTokenCreatedAt(...args),
  incrementRugCount: (...args: unknown[]): unknown => mockIncrementRugCount(...args),
  getRugCount: vi.fn(() => 0),
  updateCopyTradeHoldPrice: vi.fn(),
  getHoldableClosedTrades: vi.fn(() => []),
}));

const mockNotifyCopyTrade = vi.fn(() => Promise.resolve());
vi.mock("../telegram/notifications.js", () => ({
  notifyCopyTrade: (...args: unknown[]): unknown => mockNotifyCopyTrade(...args),
}));

const mockApproveAndSell1inch = vi.fn(() => ({ success: false }));
vi.mock("../evm/index.js", () => ({
  approveAndSell1inch: (...args: unknown[]): unknown => mockApproveAndSell1inch(...args),
  execute1inchSwap: vi.fn(),
  getNativeBalance: vi.fn(),
  isChainSupported: vi.fn(() => false),
}));

vi.mock("./watcher.js", () => ({
  estimatePriceImpactPct: vi.fn(() => 0),
}));

vi.mock("../copy/filter.js", () => ({
  getApproxUsdValue: vi.fn(() => 3000),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { refreshCopyTradePrices, checkGoPlusForOpenTrades, isGoPlusKillSwitch } from "./gem-analyzer.js";

function makeTrade(overrides: Partial<{
  walletAddress: string;
  tokenAddress: string;
  chain: string;
  tokenSymbol: string;
  liquidityUsd: number;
  buyPriceUsd: number;
  currentPriceUsd: number;
  status: string;
}> = {}): import("./types.js").CopyTrade {
  return {
    id: `${overrides.walletAddress ?? "0xwallet1"}_${overrides.tokenAddress ?? "0xabc"}_base_${Date.now()}`,
    walletAddress: overrides.walletAddress ?? "0xwallet1",
    tokenSymbol: overrides.tokenSymbol ?? "PERP",
    tokenAddress: overrides.tokenAddress ?? "0xabc",
    chain: overrides.chain ?? "base",
    pairAddress: "0xpair",
    side: "buy",
    buyPriceUsd: overrides.buyPriceUsd ?? 0.001,
    currentPriceUsd: overrides.currentPriceUsd ?? 0.0005,
    amountUsd: 10,
    pnlPct: -50,
    status: (overrides.status ?? "open") as "open" | "closed" | "skipped",
    liquidityOk: true,
    liquidityUsd: overrides.liquidityUsd ?? 10000,
    skipReason: null,
    buyTimestamp: Date.now() - 1000,
    tokenCreatedAt: null,
    closeTimestamp: null,
    exitReason: null,
    insiderCount: 1,
    peakPnlPct: 0,
    walletScoreAtBuy: 80,
    exitDetail: null,
  };
}

function makeDexPair(priceUsd: string, liquidityUsd: number): import("../shared/dexscreener.js").DexPair {
  return {
    priceUsd,
    liquidity: { usd: liquidityUsd },
    chainId: "base",
    pairAddress: "0xpair",
    fdv: 50000,
    volume: { h24: 1000 },
    priceChange: { h24: -80 },
  };
}

describe("refreshCopyTradePrices - liquidity rug check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Advance time so the 30s throttle does not block
    vi.advanceTimersByTime(31_000);
  });

  it("exits trade when liquidity drops to zero", async () => {
    const trade = makeTrade({ liquidityUsd: 10000, tokenAddress: "0xabc", chain: "base", buyPriceUsd: 0.001, currentPriceUsd: 0.0005 });
    mockGetOpenCopyTrades.mockReturnValue([trade]);

    const pair = makeDexPair("0.0001", 0);
    mockDexScreenerFetchBatch.mockResolvedValue(new Map([["0xabc", pair]]));
    mockCloseCopyTrade.mockReturnValue(true);

    await refreshCopyTradePrices();

    expect(mockCloseCopyTrade).toHaveBeenCalledWith(
      trade.walletAddress,
      trade.tokenAddress,
      trade.chain,
      "liquidity_rug",
      expect.any(Number),
      expect.any(Number),
      "liquidity_rug",
      undefined
    );
    expect(mockIncrementRugCount).toHaveBeenCalledWith("0xabc", "base");
    expect(mockNotifyCopyTrade).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "liquidity rug" })
    );
  });

  it("exits trade when liquidity drops 30%+ from entry", async () => {
    const trade = makeTrade({ liquidityUsd: 20000, tokenAddress: "0xdef", chain: "base", buyPriceUsd: 0.002 });
    mockGetOpenCopyTrades.mockReturnValue([trade]);

    // 50% drop from 20000 -> 10000
    const pair = makeDexPair("0.001", 10000);
    mockDexScreenerFetchBatch.mockResolvedValue(new Map([["0xdef", pair]]));
    mockCloseCopyTrade.mockReturnValue(true);

    await refreshCopyTradePrices();

    expect(mockCloseCopyTrade).toHaveBeenCalledWith(
      expect.any(String),
      trade.tokenAddress,
      trade.chain,
      "liquidity_rug",
      expect.any(Number),
      expect.any(Number),
      "liquidity_rug",
      undefined
    );
  });

  it("does NOT exit when liquidity is still healthy", async () => {
    const trade = makeTrade({ liquidityUsd: 10000, tokenAddress: "0xghi", chain: "base" });
    mockGetOpenCopyTrades.mockReturnValue([trade]);

    // 18% drop - should not trigger
    const pair = makeDexPair("0.0009", 8200);
    mockDexScreenerFetchBatch.mockResolvedValue(new Map([["0xghi", pair]]));

    await refreshCopyTradePrices();

    expect(mockCloseCopyTrade).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "liquidity_rug",
      expect.any(Number),
      expect.any(Number),
      "liquidity_rug",
      undefined
    );
  });

  it("exits multiple trades for same rugged token and calls incrementRugCount once", async () => {
    const trade1 = makeTrade({ walletAddress: "0xwallet1", tokenAddress: "0xabc", liquidityUsd: 10000 });
    const trade2 = makeTrade({ walletAddress: "0xwallet2", tokenAddress: "0xabc", liquidityUsd: 10000 });
    // First call: price loop (returns both trades). Second call: trailing-stop section (returns empty - trades closed by rug exit).
    mockGetOpenCopyTrades.mockReturnValueOnce([trade1, trade2]).mockReturnValue([]);

    const pair = makeDexPair("0.0001", 0);
    mockDexScreenerFetchBatch.mockResolvedValue(new Map([["0xabc", pair]]));
    mockCloseCopyTrade.mockReturnValue(true);

    await refreshCopyTradePrices();

    expect(mockCloseCopyTrade).toHaveBeenCalledTimes(2);
    expect(mockIncrementRugCount).toHaveBeenCalledTimes(1);
    expect(mockIncrementRugCount).toHaveBeenCalledWith("0xabc", "base");
  });

  it("interval is 30 seconds", () => {
    expect(COPY_TRADE_CONFIG.PRICE_REFRESH_INTERVAL_MS).toBe(30_000);
  });
});

describe("checkGoPlusForOpenTrades - GoPlus periodic re-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits trade flagged as honeypot by GoPlus", async () => {
    const trade = makeTrade({ tokenAddress: "0xhoney", chain: "base", buyPriceUsd: 0.001, currentPriceUsd: 0.0005 });
    mockGetOpenCopyTrades.mockReturnValue([trade]);
    mockCloseCopyTrade.mockReturnValue(true);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 1,
        result: {
          "0xhoney": { is_honeypot: "1", buy_tax: "0", sell_tax: "0", honeypot_with_same_creator: "0" }
        }
      }),
    });

    await checkGoPlusForOpenTrades();

    expect(mockCloseCopyTrade).toHaveBeenCalledWith(
      trade.walletAddress,
      trade.tokenAddress,
      trade.chain,
      "honeypot",
      expect.any(Number),
      expect.any(Number),
      "honeypot",
      undefined
    );
    expect(mockIncrementRugCount).toHaveBeenCalledWith("0xhoney", "base");
  });

  it("does NOT exit when GoPlus returns safe data", async () => {
    const trade = makeTrade({ tokenAddress: "0xsafe", chain: "base" });
    mockGetOpenCopyTrades.mockReturnValue([trade]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 1,
        result: {
          "0xsafe": { is_honeypot: "0", buy_tax: "0.01", sell_tax: "0.02", honeypot_with_same_creator: "0", cannot_sell_all: "0", transfer_pausable: "0", is_mintable: "0", owner_change_balance: "0", can_take_back_ownership: "0", hidden_owner: "0", selfdestruct: "0", is_blacklisted: "0", slippage_modifiable: "0", anti_whale_modifiable: "0", cannot_buy: "0", is_whitelisted: "0", is_airdrop_scam: "0" }
        }
      }),
    });

    await checkGoPlusForOpenTrades();

    expect(mockCloseCopyTrade).not.toHaveBeenCalled();
    expect(mockIncrementRugCount).not.toHaveBeenCalled();
  });

  it("does NOT exit when GoPlus is unavailable (fetch fails)", async () => {
    const trade = makeTrade({ tokenAddress: "0xfail", chain: "base" });
    mockGetOpenCopyTrades.mockReturnValue([trade]);

    mockFetch.mockRejectedValueOnce(new Error("network error"));

    await checkGoPlusForOpenTrades();

    expect(mockCloseCopyTrade).not.toHaveBeenCalled();
    expect(mockIncrementRugCount).not.toHaveBeenCalled();
  });
});

describe("isGoPlusKillSwitch - LP concentration", () => {
  const baseData = {
    is_honeypot: "0",
    buy_tax: "0",
    sell_tax: "0",
    honeypot_with_same_creator: "0",
    is_mintable: "0",
    owner_change_balance: "0",
    can_take_back_ownership: "0",
    hidden_owner: "0",
    selfdestruct: "0",
    is_blacklisted: "0",
    slippage_modifiable: "0",
    transfer_pausable: "0",
    anti_whale_modifiable: "0",
    cannot_sell_all: "0",
    cannot_buy: "0",
    is_whitelisted: "0",
    is_airdrop_scam: "0",
  };

  it("triggers when single unlocked LP holder holds 85%", () => {
    const data = {
      ...baseData,
      lp_holders: [
        { percent: "0.8523", is_locked: "0", address: "0xdev", tag: "" },
        { percent: "0.1477", is_locked: "1", address: "0xdead", tag: "dead wallet" },
      ],
    };
    expect(isGoPlusKillSwitch(data)).toBe(true);
  });

  it("does NOT trigger when largest holder is locked (90%)", () => {
    const data = {
      ...baseData,
      lp_holders: [
        { percent: "0.90", is_locked: "1", address: "0xlocked", tag: "" },
        { percent: "0.10", is_locked: "0", address: "0xsmall", tag: "" },
      ],
    };
    expect(isGoPlusKillSwitch(data)).toBe(false);
  });

  it("does NOT trigger when unlocked holder is only 40%", () => {
    const data = {
      ...baseData,
      lp_holders: [
        { percent: "0.40", is_locked: "0", address: "0xdev1", tag: "" },
        { percent: "0.35", is_locked: "0", address: "0xdev2", tag: "" },
        { percent: "0.25", is_locked: "1", address: "0xlocked", tag: "" },
      ],
    };
    expect(isGoPlusKillSwitch(data)).toBe(false);
  });

  it("does NOT trigger when lp_holders is an empty array", () => {
    const data = { ...baseData, lp_holders: [] };
    expect(isGoPlusKillSwitch(data)).toBe(false);
  });

  it("does NOT trigger when lp_holders field is missing", () => {
    expect(isGoPlusKillSwitch(baseData)).toBe(false);
  });

  it("triggers at exactly 51% (above threshold)", () => {
    const data = {
      ...baseData,
      lp_holders: [
        { percent: "0.51", is_locked: "0", address: "0xdev", tag: "" },
        { percent: "0.49", is_locked: "1", address: "0xlocked", tag: "" },
      ],
    };
    expect(isGoPlusKillSwitch(data)).toBe(true);
  });

  it("does NOT trigger at exactly 50% (not strictly greater)", () => {
    const data = {
      ...baseData,
      lp_holders: [
        { percent: "0.50", is_locked: "0", address: "0xdev", tag: "" },
        { percent: "0.50", is_locked: "1", address: "0xlocked", tag: "" },
      ],
    };
    expect(isGoPlusKillSwitch(data)).toBe(false);
  });
});
