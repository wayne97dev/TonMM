import { Address, beginCell, toNano, Sender, SenderArguments } from "@ton/core";
import {
  Asset,
  Factory,
  MAINNET_FACTORY_ADDR,
  PoolType,
  ReadinessStatus,
  VaultJetton,
  JettonRoot,
} from "@dedust/sdk";
import { tonClient } from "../wallet/client";
import { requireJettonMaster } from "../core/state";
import { DexAdapter, BuiltSwapMessage } from "./types";
import { Quote, Side } from "../types";

/**
 * Sender che invece di inviare cattura il primo messaggio prodotto.
 * Lo usiamo per intercettare il payload che DeDust costruisce, e poi lo
 * spediamo dal nostro master/sub-wallet.
 */
class CaptureSender implements Sender {
  captured: SenderArguments | null = null;
  async send(args: SenderArguments): Promise<void> {
    if (this.captured) throw new Error("CaptureSender: piu' di un messaggio");
    this.captured = args;
  }
}

export class DedustAdapter implements DexAdapter {
  readonly name = "dedust" as const;

  private get jettonAddr(): Address {
    return Address.parse(requireJettonMaster());
  }

  private factory() {
    return tonClient().open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));
  }

  private async getPool() {
    const factory = this.factory();
    const tonAsset = Asset.native();
    const jettonAsset = Asset.jetton(this.jettonAddr);
    const pool = tonClient().open(
      await factory.getPool(PoolType.VOLATILE, [tonAsset, jettonAsset]),
    );
    const status = await pool.getReadinessStatus();
    if (status !== ReadinessStatus.READY) {
      throw new Error("DeDust pool TON/JETTON non pronto");
    }
    return pool;
  }

  async quote(side: Side, amountIn: bigint): Promise<Quote> {
    const pool = await this.getPool();
    const inputAsset =
      side === "buy" ? Asset.native() : Asset.jetton(this.jettonAddr);
    try {
      const est = await pool.getEstimatedSwapOut({
        assetIn: inputAsset,
        amountIn,
      });
      return {
        dex: this.name,
        side,
        amountIn,
        amountOut: est.amountOut,
        priceTon: 0,
        priceImpactPct: 0,
      };
    } catch {
      return {
        dex: this.name,
        side,
        amountIn,
        amountOut: amountIn,
        priceTon: 0,
        priceImpactPct: 0,
      };
    }
  }

  async buildSwap(
    side: Side,
    amountIn: bigint,
    amountOutMin: bigint,
    sender: Address,
  ): Promise<BuiltSwapMessage> {
    const factory = this.factory();
    const pool = await this.getPool();

    if (side === "buy") {
      const tonVault = tonClient().open(await factory.getNativeVault());
      const capture = new CaptureSender();
      await tonVault.sendSwap(capture, {
        amount: amountIn,
        poolAddress: pool.address,
        limit: amountOutMin,
        gasAmount: toNano("0.25"),
      });
      const a = capture.captured!;
      return {
        to: a.to,
        value: a.value,
        body: a.body!,
        bounce: a.bounce ?? true,
      };
    } else {
      // Jetton -> TON
      const jettonRoot = tonClient().open(JettonRoot.createFromAddress(this.jettonAddr));
      const jettonWallet = tonClient().open(await jettonRoot.getWallet(sender));
      const jettonVault = tonClient().open(
        await factory.getJettonVault(this.jettonAddr),
      );

      const forwardPayload = VaultJetton.createSwapPayload({
        poolAddress: pool.address,
        limit: amountOutMin,
      });

      const body = beginCell()
        .storeUint(0xf8a7ea5, 32) // op transfer
        .storeUint(BigInt(Date.now()), 64) // query id
        .storeCoins(amountIn)
        .storeAddress(jettonVault.address)
        .storeAddress(sender) // response_destination
        .storeBit(0) // no custom payload
        .storeCoins(toNano("0.25")) // forward TON amount
        .storeBit(1)
        .storeRef(forwardPayload)
        .endCell();

      return {
        to: jettonWallet.address,
        value: toNano("0.3"),
        body,
        bounce: true,
      };
    }
  }
}
