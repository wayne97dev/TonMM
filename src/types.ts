export type DexName = "stonfi" | "dedust";
export type DexChoice = DexName | "auto";

export type Side = "buy" | "sell";

export interface Quote {
  dex: DexName;
  side: Side;
  /** TON in (per buy) o jetton in (per sell), in nano */
  amountIn: bigint;
  /** Output stimato in nano */
  amountOut: bigint;
  /** Prezzo in TON per 1 token (float, indicativo) */
  priceTon: number;
  /** Slippage percentuale stimata vs prezzo medio */
  priceImpactPct: number;
}

export interface SwapResult {
  dex: DexName;
  side: Side;
  amountIn: bigint;
  amountOutMin: bigint;
  txHash?: string;
  ok: boolean;
  error?: string;
}

export type StrategyName =
  | "volume"
  | "ladder"
  | "priceTarget"
  | "holdersBooster";

export interface StrategyParams {
  volume: {
    minTradeTon: number;
    maxTradeTon: number;
    minIntervalSec: number;
    maxIntervalSec: number;
    /** -1..+1: 0 = neutro, +0.3 = 30% piu' buy, -0.3 = piu' sell */
    bias: number;
  };
  ladder: {
    /** numero di livelli per lato */
    levels: number;
    /** distanza % tra un livello e l'altro */
    stepPct: number;
    /** TON per livello sul lato buy */
    buyTonPerLevel: number;
    /** Token per livello sul lato sell */
    sellTokenPerLevel: number;
    /** ribilanciamento ogni N secondi */
    rebalanceSec: number;
  };
  priceTarget: {
    /** Compra se prezzo TON/token sotto questo valore */
    floorTon: number;
    /** Vende se prezzo TON/token sopra questo valore */
    ceilingTon: number;
    /** TON da spendere per buy quando trigger */
    buyTon: number;
    /** Token da vendere quando trigger */
    sellToken: number;
    /** Polling prezzo (sec) */
    pollSec: number;
  };
  holdersBooster: {
    /** quanti nuovi holder generare in totale */
    targetHolders: number;
    /** TON che il master invia a ciascun sub-wallet */
    fundingTon: number;
    /** quanti TON ciascun sub-wallet usera' per il buy */
    buyTon: number;
    /** intervallo tra holder (sec) */
    intervalSec: number;
  };
}

export interface TokenSettings {
  master: string | null; // jetton master EQ...
  decimals: number;
  symbol: string;
}

export interface SessionLimits {
  maxTradeTon: number;
  sessionBudgetTon: number;
  maxSlippagePct: number;
}

export interface RuntimeState {
  active: Partial<Record<StrategyName, boolean>>;
  spentTon: number; // dall'avvio
  trades: number;
  lastError?: string;
  selectedDex: DexChoice;
  params: StrategyParams;
  holdersCreated: number;
  token: TokenSettings;
  limits: SessionLimits;
}
