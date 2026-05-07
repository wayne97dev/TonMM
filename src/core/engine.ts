import { toNano } from "@ton/core";
import PQueue from "p-queue";
import { config } from "../config";
import { logger } from "./logger";
import { getState, patchState, saveState } from "./state";
import { DexChoice, Side, SwapResult } from "../types";
import { pickDex } from "../dex";
import { getMasterWallet } from "../wallet/master";

/**
 * Coda globale: serializza l'invio degli external dal master wallet
 * (un seqno alla volta) per evitare collisioni.
 */
const masterQueue = new PQueue({ concurrency: 1 });

/**
 * Esegue uno swap dal master wallet sulla DEX scelta.
 * - amountIn in unita' decimali (TON o token interi -> verra' convertito)
 */
export async function executeSwap(args: {
  side: Side;
  amount: number; // TON per buy, token interi per sell
  dexChoice?: DexChoice;
}): Promise<SwapResult> {
  const state = getState();
  const choice: DexChoice = args.dexChoice ?? state.selectedDex;

  // Budget guard
  if (args.side === "buy") {
    if (args.amount > config.MAX_TRADE_TON) {
      return ko("trade size oltre MAX_TRADE_TON");
    }
    if (state.spentTon + args.amount > config.SESSION_BUDGET_TON) {
      return ko("session budget esaurito");
    }
  }

  const decimals = config.JETTON_DECIMALS;
  const amountInNano =
    args.side === "buy"
      ? toNano(args.amount.toFixed(9))
      : BigInt(Math.floor(args.amount * 10 ** decimals));

  return masterQueue.add(async (): Promise<SwapResult> => {
    try {
      const master = await getMasterWallet();
      const { adapter, quote } = await pickDex(choice, args.side, amountInNano);

      const slippageBp = BigInt(Math.floor(config.MAX_SLIPPAGE_PCT * 100));
      const minOut =
        (quote.amountOut * (10000n - slippageBp)) / 10000n;

      const msg = await adapter.buildSwap(
        args.side,
        amountInNano,
        minOut,
        master.address,
      );

      await master.send([msg]);

      const newSpent =
        state.spentTon + (args.side === "buy" ? args.amount : 0);
      patchState({
        spentTon: newSpent,
        trades: state.trades + 1,
      });

      logger.info(
        {
          dex: adapter.name,
          side: args.side,
          amountIn: amountInNano.toString(),
          minOut: minOut.toString(),
        },
        "swap inviato",
      );

      return {
        dex: adapter.name,
        side: args.side,
        amountIn: amountInNano,
        amountOutMin: minOut,
        ok: true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "swap fallito");
      patchState({ lastError: message });
      saveState();
      return ko(message);
    }
  }) as Promise<SwapResult>;
}

function ko(error: string): SwapResult {
  return {
    dex: "stonfi",
    side: "buy",
    amountIn: 0n,
    amountOutMin: 0n,
    ok: false,
    error,
  };
}
