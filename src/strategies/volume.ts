import { Strategy, rand } from "./base";
import { getState } from "../core/state";
import { executeSwap } from "../core/engine";
import { logger } from "../core/logger";

export class VolumeStrategy extends Strategy {
  readonly name = "volume";

  protected async tick(): Promise<void> {
    const p = getState().params.volume;
    // bias in [-1, +1]: prob(buy) = (1+bias)/2
    const buyProb = Math.min(0.95, Math.max(0.05, (1 + p.bias) / 2));
    const side = Math.random() < buyProb ? "buy" : "sell";
    const amount = rand(p.minTradeTon, p.maxTradeTon);
    const res = await executeSwap({ side, amount });
    logger.info(
      { side, amount: amount.toFixed(4), ok: res.ok, err: res.error },
      "volume: tick",
    );
  }

  protected nextDelayMs(): number {
    const p = getState().params.volume;
    return rand(p.minIntervalSec, p.maxIntervalSec) * 1000;
  }
}
