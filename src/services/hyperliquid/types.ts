export interface QuantPosition {
  id: string;
  pair: string; // e.g. "BTC"
  direction: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
  unrealizedPnl: number;
  mode: "paper" | "live";
  openedAt: string; // ISO date
  closedAt: string | undefined;
  exitPrice: number | undefined;
  realizedPnl: number | undefined;
  exitReason: string | undefined;
  status: "open" | "closed";
}

export interface QuantTrade {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number | undefined;
  size: number;
  leverage: number;
  pnl: number;
  fees: number;
  mode: "paper" | "live";
  status: "open" | "closed" | "failed";
  aiConfidence: number | undefined;
  aiReasoning: string | undefined;
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
}

export interface QuantAccountState {
  balance: number;
  equity: number;
  unrealizedPnl: number;
  positions: QuantPosition[];
}

export interface QuantHyperliquidConfig {
  walletAddress: string;
  enableWs: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId: string | undefined;
  error: string | undefined;
}
