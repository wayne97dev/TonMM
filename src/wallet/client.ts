import { TonClient } from "@ton/ton";
import { config } from "../config";

let cached: TonClient | null = null;

export function tonClient(): TonClient {
  if (cached) return cached;
  cached = new TonClient({
    endpoint: config.TON_ENDPOINT,
    apiKey: config.TON_API_KEY || undefined,
  });
  return cached;
}
