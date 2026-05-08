import { toNano } from "@ton/core";
import { Strategy, rand } from "./base";
import { getState } from "../core/state";
import { executeSwap } from "../core/engine";
import { pickDex } from "../dex";
import { logger } from "../core/logger";

export class VolumeStrategy extends Strategy {
  readonly name = "volume";

  /**
   * Per i SELL il param `amount` di executeSwap e' interpretato come
   * "numero di token". Ma all'utente chiediamo "min/max trade TON" che
   * ha senso solo per i buy. Per i sell convertiamo il valore-TON
   * desiderato in numero di token interrogando il prezzo corrente.
   */
  private async tonValueToTokens(tonValue: number): Promise<number | null> {
    try {
      const state = getState();
      const oneToken = BigInt(10) ** BigInt(state.token.decimals);
      const { quote } = await pickDex(state.selectedDex, "sell", oneToken);
      const priceTon = Number(quote.amountOut) / Number(toNano("1"));
      if (priceTon <= 0) return null;
      return tonValue / priceTon;
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "volume: quote per sell non disponibile",
      );
      return null;
    }
  }

  protected async tick(): Promise<void> {
    const p = getState().params.volume;
    const buyProb = Math.min(0.95, Math.max(0.05, (1 + p.bias) / 2));
    const side = Math.random() < buyProb ? "buy" : "sell";
    const tonValue = rand(p.minTradeTon, p.maxTradeTon);

    let amount = tonValue;
    if (side === "sell") {
      const tokens = await this.tonValueToTokens(tonValue);
      if (tokens == null) {
        logger.warn("volume: salto questo sell, prezzo non disponibile");
        return;
      }
      amount = tokens;
    }

    const res = await executeSwap({ side, amount });
    logger.info(
      {
        side,
        tonValue: tonValue.toFixed(4),
        amount: amount.toFixed(6),
        ok: res.ok,
        err: res.error,
      },
      "volume: tick",
    );
  }

  protected nextDelayMs(): number {
    const p = getState().params.volume;
    return rand(p.minIntervalSec, p.maxIntervalSec) * 1000;
  }
}
