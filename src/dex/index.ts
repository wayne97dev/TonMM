import { DexAdapter } from "./types";
import { StonfiAdapter } from "./stonfi";
import { DedustAdapter } from "./dedust";
import { DexChoice, DexName, Quote, Side } from "../types";
import { logger } from "../core/logger";

const stonfi = new StonfiAdapter();
const dedust = new DedustAdapter();

export function getAdapter(name: DexName): DexAdapter {
  return name === "stonfi" ? stonfi : dedust;
}

/**
 * Sceglie il DEX su cui eseguire lo swap.
 * - "stonfi" / "dedust": forzato dall'utente
 * - "auto": chiede una quote ad entrambi e prende quello con output migliore
 */
export async function pickDex(
  choice: DexChoice,
  side: Side,
  amountIn: bigint,
): Promise<{ adapter: DexAdapter; quote: Quote }> {
  if (choice !== "auto") {
    const a = getAdapter(choice);
    const q = await a.quote(side, amountIn);
    return { adapter: a, quote: q };
  }
  const [qs, qd] = await Promise.allSettled([
    stonfi.quote(side, amountIn),
    dedust.quote(side, amountIn),
  ]);
  const candidates: { adapter: DexAdapter; quote: Quote }[] = [];
  if (qs.status === "fulfilled")
    candidates.push({ adapter: stonfi, quote: qs.value });
  if (qd.status === "fulfilled")
    candidates.push({ adapter: dedust, quote: qd.value });
  if (candidates.length === 0) throw new Error("Nessun DEX disponibile");
  candidates.sort((a, b) => Number(b.quote.amountOut - a.quote.amountOut));
  const winner = candidates[0]!;
  logger.debug(
    { winner: winner.adapter.name, candidates: candidates.length },
    "router: dex selezionato",
  );
  return winner;
}
