import { Address } from "@ton/core";
import { DEX, pTON } from "@ston-fi/sdk";
import { tonClient } from "../wallet/client";
import { requireJettonMaster } from "../core/state";
import { DexAdapter, BuiltSwapMessage } from "./types";
import { Quote, Side } from "../types";

/**
 * STON.fi adapter (router v2.2 / pTON v2.1).
 *
 * STON.fi non espone l'indirizzo del router come costante nell'SDK: va
 * passato esplicitamente. Lo prendiamo da `STONFI_ROUTER` (env). Se non
 * configurato, l'adapter lancia errore e il router auto-pick lo scarta.
 *
 * L'indirizzo mainnet del CPI Router v2.2 e' documentato qui:
 * https://docs.ston.fi/docs/developer-section/api-reference-v2/contracts
 */
export class StonfiAdapter implements DexAdapter {
  readonly name = "stonfi" as const;

  private routerCache: ReturnType<typeof this.openRouter> | null = null;

  private routerAddress(): Address {
    const raw = process.env.STONFI_ROUTER;
    if (!raw) {
      throw new Error(
        "STON.fi disabilitato: imposta STONFI_ROUTER=<indirizzo del router CPI v2.2> in .env",
      );
    }
    return Address.parse(raw);
  }

  private async openRouter() {
    const router = tonClient().open(
      DEX.v2_2.Router.CPI.create(this.routerAddress()),
    );
    return router;
  }

  private getRouter() {
    if (!this.routerCache) this.routerCache = this.openRouter();
    return this.routerCache;
  }

  private get jetton(): Address {
    return Address.parse(requireJettonMaster());
  }

  private get proxyTon(): Address {
    return pTON.v2_1.address;
  }

  async quote(side: Side, amountIn: bigint): Promise<Quote> {
    // Il SDK STON.fi non espone una "estimate swap" senza chiamare l'API HTTP.
    // Per safety lo slippage viene applicato in engine.ts su MAX_SLIPPAGE_PCT.
    return {
      dex: this.name,
      side,
      amountIn,
      amountOut: amountIn,
      priceTon: 0,
      priceImpactPct: 0,
    };
  }

  async buildSwap(
    side: Side,
    amountIn: bigint,
    amountOutMin: bigint,
    sender: Address,
  ): Promise<BuiltSwapMessage> {
    const router = await this.getRouter();
    if (side === "buy") {
      const params = await router.getSwapTonToJettonTxParams({
        userWalletAddress: sender,
        proxyTon: pTON.v2_1.create(this.proxyTon),
        offerAmount: amountIn,
        askJettonAddress: this.jetton,
        minAskAmount: amountOutMin,
        queryId: BigInt(Date.now()),
      });
      return { to: params.to, value: params.value, body: params.body!, bounce: true };
    } else {
      const params = await router.getSwapJettonToTonTxParams({
        userWalletAddress: sender,
        offerJettonAddress: this.jetton,
        offerAmount: amountIn,
        minAskAmount: amountOutMin,
        proxyTon: pTON.v2_1.create(this.proxyTon),
        queryId: BigInt(Date.now()),
      });
      return { to: params.to, value: params.value, body: params.body!, bounce: true };
    }
  }
}
