import http from "http";
import { getRiskStatus, canTrade } from "../risk/manager.js";
import { isDbInitialized } from "../database/db.js";
import { isPaperMode } from "../../config/env.js";
import { isQuantKilled } from "../hyperliquid/risk-manager.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  timestamp: string;
  timestampUTC: string;
  version: string;
  mode: "paper" | "live";
  checks: {
    database: boolean;
    trading: boolean;
    killSwitch: boolean;
  };
}

let server: http.Server | null = null;
const startTime = Date.now();

export function getHealthStatus(): HealthStatus {
  let dbHealthy = false;
  let tradingEnabled = false;
  let killSwitchActive = false;

  try {
    dbHealthy = isDbInitialized();
  } catch {
    dbHealthy = false;
  }

  tradingEnabled = canTrade();
  killSwitchActive = isQuantKilled() || !canTrade();

  const allHealthy = dbHealthy && tradingEnabled && !killSwitchActive;
  const anyUnhealthy = !dbHealthy;

  return {
    status: anyUnhealthy ? "unhealthy" : allHealthy ? "healthy" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toLocaleString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    timestampUTC: new Date().toISOString(),
    version: "1.0.0",
    mode: isPaperMode() ? "paper" : "live",
    checks: {
      database: dbHealthy,
      trading: tradingEnabled,
      killSwitch: killSwitchActive,
    },
  };
}

export async function getHealthStatusAsync(): Promise<HealthStatus> {
  let dbHealthy = false;
  let tradingEnabled = false;
  let killSwitchActive = false;

  try {
    dbHealthy = isDbInitialized();
  } catch {
    dbHealthy = false;
  }

  try {
    const riskStatus = await getRiskStatus();
    tradingEnabled = riskStatus.tradingEnabled;
    killSwitchActive = riskStatus.killSwitchActive;
  } catch {
    tradingEnabled = false;
    killSwitchActive = true;
  }

  const allHealthy = dbHealthy && tradingEnabled && !killSwitchActive;
  const anyUnhealthy = !dbHealthy;

  return {
    status: anyUnhealthy ? "unhealthy" : allHealthy ? "healthy" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toLocaleString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    timestampUTC: new Date().toISOString(),
    version: "1.0.0",
    mode: isPaperMode() ? "paper" : "live",
    checks: {
      database: dbHealthy,
      trading: tradingEnabled,
      killSwitch: killSwitchActive,
    },
  };
}

export function startHealthServer(port: number = 3000): http.Server {
  server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/") {
      try {
        const health = await getHealthStatusAsync();
        const statusCode = health.status === "unhealthy" ? 503 : 200;

        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: String(err) }));
      }
    } else if (req.url === "/ready") {
      // Readiness probe - only returns 200 if fully ready
      try {
        const health = await getHealthStatusAsync();
        const ready = health.status === "healthy";

        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready: false }));
      }
    } else if (req.url === "/live") {
      // Liveness probe - always returns 200 if server is running
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ alive: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Server listening on port ${port}`);
  });

  return server;
}

export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log("[Health] Server stopped");
  }
}

