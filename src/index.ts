import { startTelegramBot } from "./bot/telegram";
import { logger } from "./core/logger";
import { stopAll } from "./strategies";
import { config } from "./config";

async function main() {
  logger.info(
    {
      network: config.TON_NETWORK,
      dex: config.DEFAULT_DEX,
      jetton: config.JETTON_SYMBOL,
    },
    "TonMM avvio...",
  );
  const bot = await startTelegramBot();

  const shutdown = async (signal: string) => {
    logger.warn({ signal }, "shutdown");
    stopAll();
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, "fatal");
  process.exit(1);
});
