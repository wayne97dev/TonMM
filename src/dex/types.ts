import { Address, Cell } from "@ton/core";
import { DexName, Quote, Side } from "../types";

export interface BuiltSwapMessage {
  to: Address;
  value: bigint; // TON da allegare (gas + amount per i buy)
  body: Cell;
  bounce?: boolean;
}

export interface DexAdapter {
  readonly name: DexName;

  /** Stima output per uno swap. amountIn in nano (TON per buy, jetton per sell). */
  quote(side: Side, amountIn: bigint): Promise<Quote>;

  /**
   * Costruisce il messaggio interno da firmare con il wallet (master o sub).
   * - sender: indirizzo che firmera' (necessario per costruire il jetton transfer in caso di sell)
   * - amountOutMin: protezione slippage in nano (output minimo)
   */
  buildSwap(
    side: Side,
    amountIn: bigint,
    amountOutMin: bigint,
    sender: Address,
  ): Promise<BuiltSwapMessage>;
}
