import { Address } from "@ton/core";
import { Context } from "grammy";
import { patchParams, patchState, patchToken, patchLimits, getState } from "../core/state";

/**
 * Mini wizard step-based: per ogni chat tieniamo un puntatore al passo
 * corrente. Quando l'utente scrive un messaggio testuale, se ha un wizard
 * attivo, il messaggio viene consumato dal wizard.
 */

export type WizardStep =
  | "token.master"
  | "token.decimals"
  | "token.symbol"
  | "limits.maxTradeTon"
  | "limits.sessionBudgetTon"
  | "limits.maxSlippagePct"
  | "volume.minTradeTon"
  | "volume.maxTradeTon"
  | "volume.minIntervalSec"
  | "volume.maxIntervalSec"
  | "volume.bias"
  | "ladder.levels"
  | "ladder.stepPct"
  | "ladder.buyTonPerLevel"
  | "ladder.sellTokenPerLevel"
  | "ladder.rebalanceSec"
  | "priceTarget.floorTon"
  | "priceTarget.ceilingTon"
  | "priceTarget.buyTon"
  | "priceTarget.sellToken"
  | "priceTarget.pollSec"
  | "holdersBooster.targetHolders"
  | "holdersBooster.fundingTon"
  | "holdersBooster.buyTon"
  | "holdersBooster.intervalSec";

interface WizardState {
  flow: "setup" | "volume" | "ladder" | "priceTarget" | "holdersBooster" | "limits" | "single";
  steps: WizardStep[];
  index: number;
}

const wizards = new Map<number, WizardState>();

function flowSteps(flow: WizardState["flow"]): WizardStep[] {
  switch (flow) {
    case "setup":
      return ["token.master", "token.decimals", "token.symbol"];
    case "limits":
      return [
        "limits.maxTradeTon",
        "limits.sessionBudgetTon",
        "limits.maxSlippagePct",
      ];
    case "volume":
      return [
        "volume.minTradeTon",
        "volume.maxTradeTon",
        "volume.minIntervalSec",
        "volume.maxIntervalSec",
        "volume.bias",
      ];
    case "ladder":
      return [
        "ladder.levels",
        "ladder.stepPct",
        "ladder.buyTonPerLevel",
        "ladder.sellTokenPerLevel",
        "ladder.rebalanceSec",
      ];
    case "priceTarget":
      return [
        "priceTarget.floorTon",
        "priceTarget.ceilingTon",
        "priceTarget.buyTon",
        "priceTarget.sellToken",
        "priceTarget.pollSec",
      ];
    case "holdersBooster":
      return [
        "holdersBooster.targetHolders",
        "holdersBooster.fundingTon",
        "holdersBooster.buyTon",
        "holdersBooster.intervalSec",
      ];
    default:
      return [];
  }
}

const prompts: Record<WizardStep, string> = {
  "token.master": "Indirizzo del *jetton master* (CA), formato `EQ...` o `UQ...`:",
  "token.decimals": "Decimali del token (di solito 9):",
  "token.symbol": "Ticker del token (es. MYTOKEN):",

  "limits.maxTradeTon": "Spesa massima per *singolo trade* in TON (es. 5):",
  "limits.sessionBudgetTon": "Budget *totale* di sessione in TON (es. 100):",
  "limits.maxSlippagePct": "Slippage massimo accettato in % (es. 2):",

  "volume.minTradeTon": "Volume bot - importo MIN per trade in TON (es. 0.05):",
  "volume.maxTradeTon": "Volume bot - importo MAX per trade in TON (es. 0.4):",
  "volume.minIntervalSec":
    "Volume bot - intervallo MIN tra trade in secondi (es. 30):",
  "volume.maxIntervalSec":
    "Volume bot - intervallo MAX tra trade in secondi (es. 180):",
  "volume.bias":
    "Volume bot - bias buy/sell tra -1 e +1 (0 = neutro, +0.3 = piu' buy):",

  "ladder.levels": "Ladder - numero di livelli per lato (es. 5):",
  "ladder.stepPct": "Ladder - step % tra un livello e l'altro (es. 1.5):",
  "ladder.buyTonPerLevel": "Ladder - TON per ogni livello buy (es. 0.3):",
  "ladder.sellTokenPerLevel":
    "Ladder - token per ogni livello sell (es. 100):",
  "ladder.rebalanceSec":
    "Ladder - frequenza ribilanciamento in secondi (es. 600):",

  "priceTarget.floorTon": "Price target - prezzo *floor* TON/token sotto cui comprare (0 = off):",
  "priceTarget.ceilingTon":
    "Price target - prezzo *ceiling* TON/token sopra cui vendere (0 = off):",
  "priceTarget.buyTon":
    "Price target - TON da spendere quando trigger buy (es. 1):",
  "priceTarget.sellToken":
    "Price target - token da vendere quando trigger sell (es. 100):",
  "priceTarget.pollSec":
    "Price target - frequenza polling prezzo in secondi (es. 30):",

  "holdersBooster.targetHolders":
    "Holders booster - quanti nuovi holder generare in totale (es. 50):",
  "holdersBooster.fundingTon":
    "Holders booster - TON che il master invia a ogni sub-wallet (es. 0.4):",
  "holdersBooster.buyTon":
    "Holders booster - TON che ogni sub-wallet usa per il buy (es. 0.25):",
  "holdersBooster.intervalSec":
    "Holders booster - intervallo tra holder in secondi (es. 60):",
};

export function startWizard(chatId: number, flow: WizardState["flow"]): WizardStep {
  const steps = flowSteps(flow);
  wizards.set(chatId, { flow, steps, index: 0 });
  return steps[0]!;
}

export function startSingleStep(chatId: number, step: WizardStep): WizardStep {
  wizards.set(chatId, { flow: "single", steps: [step], index: 0 });
  return step;
}

export function cancel(chatId: number): boolean {
  return wizards.delete(chatId);
}

export function isActive(chatId: number): boolean {
  return wizards.has(chatId);
}

export function promptFor(step: WizardStep): string {
  return prompts[step];
}

export interface AdvanceResult {
  ok: boolean;
  message: string;
  done: boolean;
  nextPrompt?: string;
}

export async function handleInput(
  ctx: Context,
  text: string,
): Promise<AdvanceResult | null> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;
  const w = wizards.get(chatId);
  if (!w) return null;
  const step = w.steps[w.index]!;

  try {
    applyValue(step, text.trim());
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      done: false,
      nextPrompt: prompts[step],
    };
  }

  w.index += 1;
  if (w.index >= w.steps.length) {
    wizards.delete(chatId);
    return { ok: true, message: summary(w.flow), done: true };
  }
  const next = w.steps[w.index]!;
  return {
    ok: true,
    message: `OK: ${step} salvato.`,
    done: false,
    nextPrompt: prompts[next],
  };
}

function applyValue(step: WizardStep, raw: string) {
  if (step === "token.master") {
    Address.parse(raw); // validate
    patchToken({ master: raw });
    return;
  }
  if (step === "token.symbol") {
    if (!raw) throw new Error("Symbol vuoto");
    patchToken({ symbol: raw });
    return;
  }
  // tutti gli altri step sono numerici
  const v = Number(raw);
  if (Number.isNaN(v)) throw new Error("Devi scrivere un numero");
  switch (step) {
    case "token.decimals":
      patchToken({ decimals: Math.floor(v) });
      break;
    case "limits.maxTradeTon":
      patchLimits({ maxTradeTon: v });
      break;
    case "limits.sessionBudgetTon":
      patchLimits({ sessionBudgetTon: v });
      break;
    case "limits.maxSlippagePct":
      patchLimits({ maxSlippagePct: v });
      break;
    case "volume.minTradeTon":
      patchParams("volume", { minTradeTon: v });
      break;
    case "volume.maxTradeTon":
      patchParams("volume", { maxTradeTon: v });
      break;
    case "volume.minIntervalSec":
      patchParams("volume", { minIntervalSec: v });
      break;
    case "volume.maxIntervalSec":
      patchParams("volume", { maxIntervalSec: v });
      break;
    case "volume.bias":
      patchParams("volume", { bias: v });
      break;
    case "ladder.levels":
      patchParams("ladder", { levels: Math.floor(v) });
      break;
    case "ladder.stepPct":
      patchParams("ladder", { stepPct: v });
      break;
    case "ladder.buyTonPerLevel":
      patchParams("ladder", { buyTonPerLevel: v });
      break;
    case "ladder.sellTokenPerLevel":
      patchParams("ladder", { sellTokenPerLevel: v });
      break;
    case "ladder.rebalanceSec":
      patchParams("ladder", { rebalanceSec: v });
      break;
    case "priceTarget.floorTon":
      patchParams("priceTarget", { floorTon: v });
      break;
    case "priceTarget.ceilingTon":
      patchParams("priceTarget", { ceilingTon: v });
      break;
    case "priceTarget.buyTon":
      patchParams("priceTarget", { buyTon: v });
      break;
    case "priceTarget.sellToken":
      patchParams("priceTarget", { sellToken: v });
      break;
    case "priceTarget.pollSec":
      patchParams("priceTarget", { pollSec: v });
      break;
    case "holdersBooster.targetHolders":
      patchParams("holdersBooster", { targetHolders: Math.floor(v) });
      break;
    case "holdersBooster.fundingTon":
      patchParams("holdersBooster", { fundingTon: v });
      break;
    case "holdersBooster.buyTon":
      patchParams("holdersBooster", { buyTon: v });
      break;
    case "holdersBooster.intervalSec":
      patchParams("holdersBooster", { intervalSec: v });
      break;
  }
}

function summary(flow: WizardState["flow"]): string {
  const s = getState();
  switch (flow) {
    case "setup":
      return [
        "*Setup token completato:*",
        `CA: \`${s.token.master}\``,
        `Decimals: ${s.token.decimals}`,
        `Symbol: ${s.token.symbol}`,
      ].join("\n");
    case "limits":
      return [
        "*Limiti aggiornati:*",
        `Max trade: ${s.limits.maxTradeTon} TON`,
        `Budget sessione: ${s.limits.sessionBudgetTon} TON`,
        `Slippage: ${s.limits.maxSlippagePct}%`,
      ].join("\n");
    case "volume":
    case "ladder":
    case "priceTarget":
    case "holdersBooster":
      return `*${flow}* aggiornato:\n\`\`\`\n${JSON.stringify(s.params[flow], null, 2)}\n\`\`\``;
    case "single":
      return "OK, valore salvato.";
  }
  // unreachable
  return "OK.";
}

// Export per usi esterni
export const allFlows: WizardState["flow"][] = [
  "setup",
  "limits",
  "volume",
  "ladder",
  "priceTarget",
  "holdersBooster",
];
