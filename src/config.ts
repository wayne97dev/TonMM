import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_ADMIN_IDS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number(x)),
    ),

  TON_ENDPOINT: z.string().url(),
  TON_API_KEY: z.string().optional().default(""),
  TON_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),

  MASTER_MNEMONIC: z.string().min(20),
  HIGHLOAD_SUBWALLET_ID: z.coerce.number().int().default(0x10ad),
  HIGHLOAD_TIMEOUT: z.coerce.number().int().default(128),

  JETTON_MASTER: z.string().min(10),
  JETTON_DECIMALS: z.coerce.number().int().default(9),
  JETTON_SYMBOL: z.string().default("TOKEN"),

  DEFAULT_DEX: z.enum(["stonfi", "dedust", "auto"]).default("auto"),

  HOLDERS_BOOSTER_COUNT: z.coerce.number().int().min(0).max(500).default(50),
  SUBWALLETS_SEED: z.string().min(4).default("change-me"),

  MAX_TRADE_TON: z.coerce.number().positive().default(5),
  SESSION_BUDGET_TON: z.coerce.number().positive().default(100),
  MAX_SLIPPAGE_PCT: z.coerce.number().positive().default(2),
});

export type Config = z.infer<typeof schema>;

export const config: Config = (() => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
})();
