import { Strategy } from "./base";
import { getState } from "../core/state";
import { executeSwap } from "../core/engine";
import { logger } from "../core/logger";

/**
 * Pump / anti-dump ladder.
 *
 * Idea: in modo periodico (rebalanceSec) il bot piazza un set di micro-ordini
 * di buy "sotto" il prezzo corrente e di sell "sopra" il prezzo corrente.
 *
 * Su AMM puro non esistono limit order, quindi simuliamo l'effetto eseguendo
 * piccoli swap a cadenza: una "raffica" di N buy progressivamente piu' grandi
 * se il prezzo scende (anti-dump) e di N sell se il prezzo sale (pump cap).
 *
 * Per semplicita' di scaffold, qui eseguiamo a ogni ciclo un buy + un sell
 * dimensionati sui parametri (levels e step). Una versione full-fledged
 * agganciherebbe il prezzo dal pool e modulerebbe.
 */
export class LadderStrategy extends Strategy {
  readonly name = "ladder";

  protected async tick(): Promise<void> {
    const p = getState().params.ladder;

    for (let i = 1; i <= p.levels; i++) {
      const buyAmount = p.buyTonPerLevel * (1 + (i - 1) * (p.stepPct / 100));
      const sellAmount =
        p.sellTokenPerLevel * (1 + (i - 1) * (p.stepPct / 100));

      const buy = await executeSwap({ side: "buy", amount: buyAmount });
      const sell = await executeSwap({ side: "sell", amount: sellAmount });
      logger.info(
        {
          level: i,
          buyTon: buyAmount.toFixed(4),
          sellToken: sellAmount.toFixed(4),
          buyOk: buy.ok,
          sellOk: sell.ok,
        },
        "ladder: livello eseguito",
      );
      // pacing tra i livelli
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  protected nextDelayMs(): number {
    return getState().params.ladder.rebalanceSec * 1000;
  }
}
