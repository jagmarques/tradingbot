import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const numericString = (defaultVal: string) =>
  z.string().default(defaultVal).transform(Number).pipe(z.number().positive());

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const numericStringMax1 = (defaultVal: string) =>
  z.string().default(defaultVal).transform(Number).pipe(z.number().positive().max(1));

const envSchema = z.object({
  // Mode
  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Polygon / Polymarket
  POLYMARKET_API_KEY: z.string().min(1, "POLYMARKET_API_KEY is required"),
  POLYMARKET_SECRET: z.string().min(1, "POLYMARKET_SECRET is required"),
  POLYMARKET_PASSPHRASE: z.string().default(""),
  POLYGON_PRIVATE_KEY: z.string().min(1, "POLYGON_PRIVATE_KEY is required"),

  // EVM chains (Base, Arbitrum, Avalanche) - uses same key for all EVM chains
  PRIVATE_KEY_EVM: z.string().min(1).optional(),

  // RPC URLs (with public defaults - use private RPCs in production)
  RPC_URL_POLYGON: z.string().url().default("https://polygon-bor-rpc.publicnode.com"),
  RPC_URL_BASE: z.string().url().default("https://mainnet.base.org"),
  RPC_URL_ARBITRUM: z.string().url().default("https://arb1.arbitrum.io/rpc"),
  RPC_URL_AVALANCHE: z.string().url().default("https://api.avax.network/ext/bc/C/rpc"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),
  TIMEZONE: z.string().default("UTC").catch("UTC"),

  // Google Sheets (optional)
  GOOGLE_SHEETS_ID: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),

  // AI (DeepSeek for Polymarket betting)
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_DAILY_BUDGET: numericString("1.00"),

  // AI Betting Config
  AIBETTING_ENABLED: z.enum(["true", "false"]).default("false"),
  AIBETTING_MAX_BET: numericString("10"),
  AIBETTING_MAX_EXPOSURE: numericString("50"),
  AIBETTING_MAX_POSITIONS: numericString("5"),
  AIBETTING_MIN_EDGE: numericStringMax1("0.08"),
  AIBETTING_MIN_CONFIDENCE: numericStringMax1("0.60"),
  AIBETTING_SCAN_INTERVAL: numericString("1800000"), // 30 min (markets resolve in days)
  AIBETTING_BAYESIAN_WEIGHT: numericStringMax1("0.50"),
  AIBETTING_TAKE_PROFIT: numericStringMax1("0.40"),
  AIBETTING_STOP_LOSS: numericStringMax1("0.15"), // Used as negative threshold in evaluator (-0.15 = -15% P&L)
  AIBETTING_HOLD_RESOLUTION_DAYS: numericString("7"),

  // Risk Limits
  MAX_POLYMARKET_BET_USDC: numericString("20"),
  DAILY_LOSS_LIMIT_USD: numericString("25"),
  MAX_SLIPPAGE_POLYMARKET: numericStringMax1("0.005"),

  // Quant Trading (Hyperliquid)
  HYPERLIQUID_PRIVATE_KEY: z.string().min(1).optional(),
  HYPERLIQUID_WALLET_ADDRESS: z.string().min(1).optional(),
  QUANT_ENABLED: z.enum(["true", "false"]).default("false"),
  QUANT_VIRTUAL_BALANCE: numericString("10"),
  ALCHEMY_API_KEY: z.string().min(1).optional(),

  // Explorer API keys (optional, improves rate limits)
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  SNOWTRACE_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;
let tradingModeOverride: "paper" | "live" | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${errors}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function setTradingMode(mode: "paper" | "live"): void {
  tradingModeOverride = mode;
  console.log(`[Env] Trading mode set to ${mode.toUpperCase()} (runtime override)`);
}

export function getTradingMode(): "paper" | "live" {
  if (tradingModeOverride !== null) return tradingModeOverride;
  return loadEnv().TRADING_MODE;
}

export function isPaperMode(): boolean {
  if (tradingModeOverride !== null) return tradingModeOverride === "paper";
  return loadEnv().TRADING_MODE === "paper";
}
