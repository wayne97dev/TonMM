import { toNano } from "@ton/core";
import { Strategy } from "./base";
import { getState } from "../core/state";
import { executeSwap } from "../core/engine";
import { pickDex } from "../dex";
import { config } from "../config";
import { logger } from "../core/logger";

/**
 * Price target / floor & ceiling.
 *
 * - se prezzo (TON per 1 token) <= floorTon -> compra `buyTon` TON di token
 * - se prezzo (TON per 1 token) >= ceilingTon -> vende `sellToken` token
 *
 * Il prezzo viene stimato chiedendo al router AMM una quote per 1 token.
 */
export class PriceTargetStrategy extends Strategy {
  readonly name = "priceTarget";

  private async currentPriceTonPerToken(): Promise<number | null> {
    try {
      const state = getState();
      const oneToken = BigInt(10) ** BigInt(config.JETTON_DECIMALS);
      const { quote } = await pickDex(state.selectedDex, "sell", oneToken);
      // amountOut e' in nano TON: prezzo TON per 1 token
      const ton = Number(quote.amountOut) / Number(toNano("1"));
      return ton;
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "priceTarget: quote fallita",
      );
      return null;
    }
  }

  protected async tick(): Promise<void> {
    const p = getState().params.priceTarget;
    const price = await this.currentPriceTonPerToken();
    if (price == null) return;
    logger.info({ price }, "priceTarget: prezzo attuale");

    if (p.floorTon > 0 && price <= p.floorTon) {
      const r = await executeSwap({ side: "buy", amount: p.buyTon });
      logger.info({ price, ok: r.ok }, "priceTarget: trigger BUY (floor)");
    } else if (p.ceilingTon > 0 && price >= p.ceilingTon) {
      const r = await executeSwap({ side: "sell", amount: p.sellToken });
      logger.info({ price, ok: r.ok }, "priceTarget: trigger SELL (ceiling)");
    }
  }

  protected nextDelayMs(): number {
    return getState().params.priceTarget.pollSec * 1000;
  }
}
