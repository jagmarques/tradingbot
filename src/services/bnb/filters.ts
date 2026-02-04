import { ethers } from "ethers";
import { NewPair } from "./detector.js";

// BNB Chain RPC
const BSC_RPC_URL = "https://bsc-dataseed1.binance.org";

// WBNB on BSC
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

// Minimum liquidity in BNB
const MIN_LIQUIDITY_BNB = 1.0;

// ERC20 ABI
const ERC20_ABI = [
  "function totalSupply() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function owner() external view returns (address)"
];

// Pair ABI
const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

export interface FilterResult {
  passed: boolean;
  reason?: string;
  score: number;
}

export interface TokenAnalysis {
  pair: NewPair;
  filters: {
    liquidity: FilterResult;
    tokenInfo: FilterResult;
    honeypot: FilterResult;
  };
  overallScore: number;
  recommendation: "BUY" | "SKIP" | "CAUTION";
  tokenSymbol?: string;
  tokenDecimals?: number;
}

let provider: ethers.JsonRpcProvider | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  }
  return provider;
}

// Check liquidity in the pair
export async function checkLiquidity(pair: NewPair): Promise<FilterResult> {
  try {
    const pairContract = new ethers.Contract(pair.pairAddress, PAIR_ABI, getProvider());

    const [reserves, token0] = await Promise.all([
      pairContract.getReserves(),
      pairContract.token0(),
    ]);

    // Determine which reserve is WBNB
    const isToken0Wbnb = token0.toLowerCase() === WBNB.toLowerCase();
    const wbnbReserve = isToken0Wbnb ? reserves[0] : reserves[1];
    const wbnbAmount = Number(wbnbReserve) / 1e18;

    if (wbnbAmount >= MIN_LIQUIDITY_BNB) {
      return {
        passed: true,
        score: Math.min(100, (wbnbAmount / MIN_LIQUIDITY_BNB) * 50),
      };
    }

    return {
      passed: false,
      reason: `Liquidity too low: ${wbnbAmount.toFixed(4)} BNB (min: ${MIN_LIQUIDITY_BNB})`,
      score: (wbnbAmount / MIN_LIQUIDITY_BNB) * 50,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Failed to check liquidity: ${err}`,
      score: 0,
    };
  }
}

// Check token info
export async function checkTokenInfo(tokenAddress: string): Promise<FilterResult & { symbol?: string; decimals?: number }> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      token.name().catch(() => ""),
      token.symbol().catch(() => ""),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => BigInt(0)),
    ]);

    let score = 100;
    const issues: string[] = [];

    // Suspicious patterns
    const suspiciousPatterns = [/scam/i, /rug/i, /honeypot/i, /fake/i, /test/i];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(name) || pattern.test(symbol)) {
        issues.push(`Suspicious name: ${pattern.source}`);
        score -= 30;
      }
    }

    if (!name || name.length < 2) {
      issues.push("Name too short");
      score -= 20;
    }

    if (!symbol || symbol.length < 2) {
      issues.push("Symbol too short");
      score -= 20;
    }

    const supplyNum = Number(totalSupply) / Math.pow(10, decimals);
    if (supplyNum > 1_000_000_000_000_000) {
      issues.push("Extremely large supply");
      score -= 10;
    }

    score = Math.max(0, score);

    return {
      passed: issues.length === 0,
      reason: issues.length > 0 ? issues.join("; ") : undefined,
      score,
      symbol,
      decimals,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Failed to check token info: ${err}`,
      score: 0,
    };
  }
}

// Basic honeypot check
export async function checkHoneypot(tokenAddress: string): Promise<FilterResult> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());

    try {
      const owner = await token.owner().catch(() => null);
      if (owner && owner !== ethers.ZeroAddress) {
        return {
          passed: true,
          reason: "Token has owner - potential risk",
          score: 70,
        };
      }
    } catch {
      // No owner function is fine
    }

    return {
      passed: true,
      score: 100,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Potential honeypot: ${err}`,
      score: 0,
    };
  }
}

// Run all filters
export async function analyzeToken(pair: NewPair): Promise<TokenAnalysis> {
  const [liquidity, tokenInfo, honeypot] = await Promise.all([
    checkLiquidity(pair),
    checkTokenInfo(pair.newToken),
    checkHoneypot(pair.newToken),
  ]);

  const filters = { liquidity, tokenInfo, honeypot };

  // Weighted score
  const weights = { liquidity: 0.4, tokenInfo: 0.3, honeypot: 0.3 };
  const overallScore =
    liquidity.score * weights.liquidity +
    tokenInfo.score * weights.tokenInfo +
    honeypot.score * weights.honeypot;

  let recommendation: "BUY" | "SKIP" | "CAUTION";
  const allPassed = Object.values(filters).every((f) => f.passed);

  if (allPassed && overallScore >= 70) {
    recommendation = "BUY";
  } else if (overallScore >= 50) {
    recommendation = "CAUTION";
  } else {
    recommendation = "SKIP";
  }

  return {
    pair,
    filters,
    overallScore,
    recommendation,
    tokenSymbol: tokenInfo.symbol,
    tokenDecimals: tokenInfo.decimals,
  };
}
