import { Address, toNano } from "@ton/core";
import { Strategy } from "./base";
import { getState, patchState } from "../core/state";
import { ensureSubwallets, markUsed, nextUnused, sendFromSubwallet } from "../wallet/subwallets";
import { getFundingWallet } from "../wallet/pool";
import { pickDex } from "../dex";
import { logger } from "../core/logger";

/**
 * Holders booster.
 *
 * Per ogni iterazione:
 *   1. Prende il prossimo sub-wallet "non usato" dal pool
 *   2. Il MASTER gli invia `fundingTon` in TON (gas + buy + storage)
 *   3. Il SUB-WALLET esegue un buy del token sul DEX scelto
 *   4. Marca il sub-wallet come usato e incrementa holdersCreated
 *
 * Risultato: nuovo holder on-chain con saldo del jetton.
 */
export class HoldersBoosterStrategy extends Strategy {
  readonly name = "holdersBooster";

  protected async tick(): Promise<void> {
    const state = getState();
    const p = state.params.holdersBooster;
    if (state.holdersCreated >= p.targetHolders) {
      logger.info(
        { holdersCreated: state.holdersCreated, target: p.targetHolders },
        "holdersBooster: target raggiunto, stop",
      );
      this.stop();
      return;
    }

    // assicurati che esistano abbastanza sub-wallet
    await ensureSubwallets(p.targetHolders);
    const sub = nextUnused();
    if (!sub) {
      logger.warn("holdersBooster: nessun sub-wallet disponibile");
      this.stop();
      return;
    }

    // 1. funding
    const funder = await getFundingWallet();
    const fundingNano = toNano(p.fundingTon.toFixed(9));
    await funder.send([
      { to: Address.parse(sub.address), value: fundingNano, bounce: false },
    ]);
    logger.info(
      { sub: sub.address, ton: p.fundingTon, funder: funder.record.label },
      "holdersBooster: funding inviato, attendo settle",
    );
    // attesa per la conferma del trasferimento
    await new Promise((r) => setTimeout(r, 12000));

    // 2. buy dal sub
    const buyNano = toNano(p.buyTon.toFixed(9));
    const { adapter, quote } = await pickDex(state.selectedDex, "buy", buyNano);
    const slippageBp = BigInt(Math.floor(state.limits.maxSlippagePct * 100));
    const minOut = (quote.amountOut * (10000n - slippageBp)) / 10000n;
    const msg = await adapter.buildSwap(
      "buy",
      buyNano,
      minOut,
      Address.parse(sub.address),
    );
    await sendFromSubwallet(sub, msg);

    markUsed(sub.index);
    patchState({ holdersCreated: state.holdersCreated + 1 });
    logger.info(
      { sub: sub.address, total: state.holdersCreated + 1 },
      "holdersBooster: holder creato",
    );
  }

  protected nextDelayMs(): number {
    return getState().params.holdersBooster.intervalSec * 1000;
  }
}
