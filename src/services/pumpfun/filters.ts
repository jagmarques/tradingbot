import { getConnection } from "../solana/wallet.js";
import { TokenLaunch } from "./detector.js";
import { MAX_DEV_SUPPLY_PERCENTAGE, MIN_LIQUIDITY_SOL } from "../../config/constants.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export interface FilterResult {
  passed: boolean;
  reason?: string;
  score: number; // 0-100, higher is safer
}

export interface TokenAnalysis {
  launch: TokenLaunch;
  filters: {
    liquidity: FilterResult;
    devSupply: FilterResult;
    metadata: FilterResult;
    devHistory: FilterResult;
  };
  overallScore: number;
  recommendation: "BUY" | "SKIP" | "CAUTION";
}

// Check if token has minimum liquidity
export async function checkLiquidity(mint: string): Promise<FilterResult> {
  try {
    const connection = getConnection();

    // Get the token's bonding curve account (holds SOL liquidity)
    // In Pump.fun, liquidity is held in a PDA derived from the mint
    const [bondingCurve] = await import("@solana/web3.js").then(({ PublicKey }) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
        new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
      )
    );

    const balance = await connection.getBalance(bondingCurve);
    const solBalance = balance / LAMPORTS_PER_SOL;

    if (solBalance >= MIN_LIQUIDITY_SOL) {
      return {
        passed: true,
        score: Math.min(100, (solBalance / MIN_LIQUIDITY_SOL) * 50),
      };
    }

    return {
      passed: false,
      reason: `Liquidity too low: ${solBalance.toFixed(4)} SOL (min: ${MIN_LIQUIDITY_SOL})`,
      score: (solBalance / MIN_LIQUIDITY_SOL) * 50,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Failed to check liquidity: ${err}`,
      score: 0,
    };
  }
}

// Check developer token supply percentage
export async function checkDevSupply(
  mint: string,
  creator: string
): Promise<FilterResult> {
  try {
    const connection = getConnection();

    // Get token accounts for the creator
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      (await import("@solana/web3.js")).PublicKey.prototype.constructor(creator),
      { mint: (await import("@solana/web3.js")).PublicKey.prototype.constructor(mint) }
    );

    if (tokenAccounts.value.length === 0) {
      return { passed: true, score: 100 }; // Dev doesn't hold any tokens
    }

    // Calculate dev's percentage
    const devBalance = tokenAccounts.value.reduce((sum, account) => {
      const amount = account.account.data.parsed?.info?.tokenAmount?.uiAmount || 0;
      return sum + amount;
    }, 0);

    // Get total supply
    const mintInfo = await connection.getParsedAccountInfo(
      (await import("@solana/web3.js")).PublicKey.prototype.constructor(mint)
    );

    const totalSupply =
      (mintInfo.value?.data as { parsed?: { info?: { supply?: string } } })?.parsed?.info
        ?.supply || "0";
    const totalSupplyNum = parseInt(totalSupply) / 1e9; // Assuming 9 decimals

    const devPercentage = totalSupplyNum > 0 ? (devBalance / totalSupplyNum) * 100 : 0;

    if (devPercentage <= MAX_DEV_SUPPLY_PERCENTAGE) {
      return {
        passed: true,
        score: 100 - devPercentage,
      };
    }

    return {
      passed: false,
      reason: `Dev holds ${devPercentage.toFixed(1)}% (max: ${MAX_DEV_SUPPLY_PERCENTAGE}%)`,
      score: Math.max(0, 100 - devPercentage * 2),
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Failed to check dev supply: ${err}`,
      score: 50, // Neutral score on error
    };
  }
}

// Check token metadata for red flags
export function checkMetadata(launch: TokenLaunch): FilterResult {
  const redFlags: string[] = [];
  let score = 100;

  // Check for suspicious names
  const suspiciousPatterns = [
    /scam/i,
    /rug/i,
    /honeypot/i,
    /fake/i,
    /test/i,
    /airdrop/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(launch.name) || pattern.test(launch.symbol)) {
      redFlags.push(`Suspicious name/symbol pattern: ${pattern.source}`);
      score -= 30;
    }
  }

  // Check for empty or placeholder metadata
  if (!launch.name || launch.name.length < 2) {
    redFlags.push("Name too short or empty");
    score -= 20;
  }

  if (!launch.symbol || launch.symbol.length < 2) {
    redFlags.push("Symbol too short or empty");
    score -= 20;
  }

  if (!launch.uri || !launch.uri.startsWith("http")) {
    redFlags.push("Invalid or missing metadata URI");
    score -= 10;
  }

  score = Math.max(0, score);

  return {
    passed: redFlags.length === 0,
    reason: redFlags.length > 0 ? redFlags.join("; ") : undefined,
    score,
  };
}

// Check developer wallet history for rug patterns
export async function checkDevHistory(creator: string): Promise<FilterResult> {
  try {
    const connection = getConnection();
    const creatorPubkey = (await import("@solana/web3.js")).PublicKey.prototype.constructor(
      creator
    );

    // Get recent transactions
    const signatures = await connection.getSignaturesForAddress(creatorPubkey, {
      limit: 50,
    });

    if (signatures.length < 5) {
      return {
        passed: true,
        reason: "New wallet (limited history)",
        score: 60, // Lower score for new wallets
      };
    }

    // Count Pump.fun interactions
    let pumpfunCount = 0;
    const recentTxs = await Promise.all(
      signatures.slice(0, 20).map((sig) =>
        connection
          .getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
          .catch(() => null)
      )
    );

    for (const tx of recentTxs) {
      if (!tx) continue;
      const programIds = tx.transaction.message.accountKeys
        .filter((k) => typeof k !== "string" && "pubkey" in k)
        .map((k) => (k as { pubkey: { toBase58: () => string } }).pubkey.toBase58());

      if (programIds.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")) {
        pumpfunCount++;
      }
    }

    // High Pump.fun activity might indicate serial launcher
    if (pumpfunCount > 10) {
      return {
        passed: false,
        reason: `Serial launcher detected: ${pumpfunCount} Pump.fun transactions`,
        score: 20,
      };
    }

    return {
      passed: true,
      score: Math.max(50, 100 - pumpfunCount * 5),
    };
  } catch (err) {
    return {
      passed: true,
      reason: `Could not verify history: ${err}`,
      score: 50,
    };
  }
}

// Run all filters and produce analysis
export async function analyzeToken(launch: TokenLaunch): Promise<TokenAnalysis> {
  const [liquidity, devSupply, devHistory] = await Promise.all([
    checkLiquidity(launch.mint),
    checkDevSupply(launch.mint, launch.creator),
    checkDevHistory(launch.creator),
  ]);

  const metadata = checkMetadata(launch);

  const filters = { liquidity, devSupply, metadata, devHistory };

  // Calculate overall score (weighted average)
  const weights = { liquidity: 0.3, devSupply: 0.25, metadata: 0.2, devHistory: 0.25 };
  const overallScore =
    liquidity.score * weights.liquidity +
    devSupply.score * weights.devSupply +
    metadata.score * weights.metadata +
    devHistory.score * weights.devHistory;

  // Determine recommendation
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
    launch,
    filters,
    overallScore,
    recommendation,
  };
}
