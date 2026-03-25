import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const numericString = (defaultVal: string) =>
  z.string().default(defaultVal).transform(Number).pipe(z.number().positive());

const envSchema = z.object({
  // Mode
  TRADING_MODE: z.enum(["paper", "hybrid", "live"]).default("paper"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

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

  // AI (Cerebras / Groq for news classification)
  CEREBRAS_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),

  // Risk Limits
  DAILY_LOSS_LIMIT_USD: numericString("25"),

  // Quant Trading (Hyperliquid)
  HYPERLIQUID_PRIVATE_KEY: z.string().min(1).optional(),
  HYPERLIQUID_WALLET_ADDRESS: z.string().min(1).optional(),
  QUANT_ENABLED: z.enum(["true", "false"]).default("false"),
  QUANT_VIRTUAL_BALANCE: numericString("100"),
  ALCHEMY_API_KEY: z.string().min(1).optional(),

  // Lighter DEX
  LIGHTER_PRIVATE_KEY: z.string().min(1).optional(),
  LIGHTER_API_KEY_INDEX: z.string().min(1).optional().transform(v => v ? Number(v) : undefined),
  LIGHTER_ACCOUNT_INDEX: z.string().min(1).optional().transform(v => v ? Number(v) : undefined),


  // Explorer API keys (optional, improves rate limits)
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  SNOWTRACE_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;
let tradingModeOverride: "paper" | "hybrid" | "live" | null = null;

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

export type TradingMode = "paper" | "hybrid" | "live";

export function setTradingMode(mode: TradingMode): void {
  tradingModeOverride = mode;
  console.log(`[Env] Trading mode set to ${mode.toUpperCase()} (runtime override)`);
}

export function getTradingMode(): TradingMode {
  if (tradingModeOverride !== null) return tradingModeOverride;
  return loadEnv().TRADING_MODE;
}

export function isPaperMode(): boolean {
  return getTradingMode() === "paper";
}

export function isHybridMode(): boolean {
  return getTradingMode() === "hybrid";
}

export function isLiveMode(): boolean {
  return getTradingMode() === "live";
}
