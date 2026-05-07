import fs from "node:fs";
import path from "node:path";
import { RuntimeState, StrategyParams, TokenSettings, SessionLimits } from "../types";
import { config } from "../config";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const defaultParams: StrategyParams = {
  volume: {
    minTradeTon: 0.1,
    maxTradeTon: 0.5,
    minIntervalSec: 30,
    maxIntervalSec: 180,
    bias: 0,
  },
  ladder: {
    levels: 5,
    stepPct: 1.5,
    buyTonPerLevel: 0.3,
    sellTokenPerLevel: 100,
    rebalanceSec: 600,
  },
  priceTarget: {
    floorTon: 0,
    ceilingTon: 0,
    buyTon: 1,
    sellToken: 100,
    pollSec: 30,
  },
  holdersBooster: {
    targetHolders: config.HOLDERS_BOOSTER_COUNT,
    fundingTon: 0.4,
    buyTon: 0.25,
    intervalSec: 60,
  },
};

function envTokenMaster(): string | null {
  const v = (config.JETTON_MASTER ?? "").trim();
  if (!v || v.startsWith("EQxxxxxxxx")) return null;
  return v;
}

const defaultState: RuntimeState = {
  active: {},
  spentTon: 0,
  trades: 0,
  selectedDex: config.DEFAULT_DEX,
  params: defaultParams,
  holdersCreated: 0,
  token: {
    master: envTokenMaster(),
    decimals: config.JETTON_DECIMALS,
    symbol: config.JETTON_SYMBOL,
  },
  limits: {
    maxTradeTon: config.MAX_TRADE_TON,
    sessionBudgetTon: config.SESSION_BUDGET_TON,
    maxSlippagePct: config.MAX_SLIPPAGE_PCT,
  },
};

let state: RuntimeState = load();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(): RuntimeState {
  try {
    ensureDir();
    if (!fs.existsSync(STATE_FILE)) return structuredClone(defaultState);
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      ...defaultState,
      ...raw,
      params: { ...defaultParams, ...(raw.params ?? {}) },
      token: { ...defaultState.token, ...(raw.token ?? {}) },
      limits: { ...defaultState.limits, ...(raw.limits ?? {}) },
    };
  } catch {
    return structuredClone(defaultState);
  }
}

export function getState(): RuntimeState {
  return state;
}

export function saveState(): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function patchState(patch: Partial<RuntimeState>): RuntimeState {
  state = { ...state, ...patch };
  saveState();
  return state;
}

export function patchParams<K extends keyof StrategyParams>(
  strat: K,
  patch: Partial<StrategyParams[K]>,
): RuntimeState {
  state.params[strat] = { ...state.params[strat], ...patch };
  saveState();
  return state;
}

export function patchToken(patch: Partial<TokenSettings>): RuntimeState {
  state.token = { ...state.token, ...patch };
  saveState();
  return state;
}

export function patchLimits(patch: Partial<SessionLimits>): RuntimeState {
  state.limits = { ...state.limits, ...patch };
  saveState();
  return state;
}

export function requireJettonMaster(): string {
  if (!state.token.master)
    throw new Error("Jetton master non configurato. Usa /setup o /set_token.");
  return state.token.master;
}
