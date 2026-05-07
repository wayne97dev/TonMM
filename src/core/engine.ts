import { toNano } from "@ton/core";
import { logger } from "./logger";
import { getState, patchState, saveState } from "./state";
import { DexChoice, Side, SwapResult } from "../types";
import { pickDex } from "../dex";
import { pickWalletRR, getInstanceById } from "../wallet/pool";

/**
 * Esegue uno swap dal pool wallet sulla DEX scelta.
 * - Se walletId e' specificato usa quel wallet, altrimenti round-robin
 *   sui wallet attivi nel pool (max 5).
 */
export async function executeSwap(args: {
  side: Side;
  amount: number; // TON per buy, token interi per sell
  dexChoice?: DexChoice;
  walletId?: number;
}): Promise<SwapResult> {
  const state = getState();
  const choice: DexChoice = args.dexChoice ?? state.selectedDex;

  if (args.side === "buy") {
    if (args.amount > state.limits.maxTradeTon) {
      return ko(`trade size oltre maxTradeTon (${state.limits.maxTradeTon})`);
    }
    if (state.spentTon + args.amount > state.limits.sessionBudgetTon) {
      return ko("session budget esaurito");
    }
  }

  const decimals = state.token.decimals;
  const amountInNano =
    args.side === "buy"
      ? toNano(args.amount.toFixed(9))
      : BigInt(Math.floor(args.amount * 10 ** decimals));

  try {
    const wallet =
      args.walletId !== undefined
        ? await getInstanceById(args.walletId)
        : await pickWalletRR();
    if (!wallet) return ko(`wallet ${args.walletId} non trovato`);

    const { adapter, quote } = await pickDex(choice, args.side, amountInNano);

    const slippageBp = BigInt(Math.floor(state.limits.maxSlippagePct * 100));
    const minOut = (quote.amountOut * (10000n - slippageBp)) / 10000n;

    const msg = await adapter.buildSwap(
      args.side,
      amountInNano,
      minOut,
      wallet.address,
    );

    await wallet.send([msg]);

    const newSpent = state.spentTon + (args.side === "buy" ? args.amount : 0);
    patchState({ spentTon: newSpent, trades: state.trades + 1 });

    logger.info(
      {
        dex: adapter.name,
        side: args.side,
        wallet: wallet.record.label,
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
