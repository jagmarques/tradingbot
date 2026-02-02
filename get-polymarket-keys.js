#!/usr/bin/env node

/**
 * Get Polymarket CLOB API keys and secret
 * Usage: node get-polymarket-keys.js <polygon_private_key>
 */

import fetch from "node-fetch";
import crypto from "crypto";

async function getPolymarketKeys() {
  const privateKey = process.argv[2];

  if (!privateKey) {
    console.error("Usage: node get-polymarket-keys.js <polygon_private_key>");
    console.error("\nExample: node get-polymarket-keys.js 58e4db9616cd46f35f8e6f53a6d6f001633f4d48fdd339ea7de5c1bd458f80ce");
    process.exit(1);
  }

  try {
    console.log("[*] Deriving Polymarket API credentials from private key...");
    console.log("[*] This will use the Polymarket API to derive your credentials");

    // For now, provide manual instructions since the automated method has compatibility issues
    console.log("\n📝 To get your Polymarket CLOB API credentials, follow these steps:\n");

    console.log("1. Install the Python client:");
    console.log("   pip install py-clob-client\n");

    console.log("2. Create a file 'get_polymarket_keys.py' with this content:");
    console.log(`
from py_clob_client.client import ClobClient

private_key = "${privateKey}"
chain_id = 137  # Polygon mainnet

client = ClobClient(chain_id=chain_id)
creds = client.create_or_derive_api_key(private_key=private_key)

print(f"POLYMARKET_API_KEY={creds['apiKey']}")
print(f"POLYMARKET_SECRET={creds['secret']}")
print(f"POLYMARKET_PASSPHRASE={creds['passphrase']}")
`);

    console.log("3. Run it:");
    console.log("   python get_polymarket_keys.py\n");

    console.log("4. Copy the output to your .env.local file\n");

  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

getPolymarketKeys();
