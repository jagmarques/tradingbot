#!/usr/bin/env python3

from py_clob_client.client import ClobClient

private_key = "0x4c114c6fe82b4f9ddd47a9d94d2eb2fe4ad1842a54b8434b4bc50eb9109ca70a"
chain_id = 137  # Polygon mainnet

print("[*] Connecting to Polymarket CLOB...")
client = ClobClient(host="https://clob.polymarket.com", chain_id=chain_id, key=private_key)

print("[*] Deriving API credentials...")
creds = client.create_or_derive_api_creds()

print("\nSUCCESS! Your Polymarket CLOB credentials:\n")
print(f"POLYMARKET_API_KEY={creds.api_key}")
print(f"POLYMARKET_SECRET={creds.api_secret}")
print(f"POLYMARKET_PASSPHRASE={creds.api_passphrase}\n")

print("Update your .env.local file with:")
print(f"POLYMARKET_API_KEY={creds.api_key}")
print(f"POLYMARKET_SECRET={creds.api_secret}")
print(f"POLYMARKET_PASSPHRASE={creds.api_passphrase}")
