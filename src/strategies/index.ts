import { Strategy } from "./base";
import { VolumeStrategy } from "./volume";
import { LadderStrategy } from "./ladder";
import { PriceTargetStrategy } from "./priceTarget";
import { HoldersBoosterStrategy } from "./holdersBooster";
import { StrategyName } from "../types";
import { patchState, getState } from "../core/state";

const registry: Record<StrategyName, Strategy> = {
  volume: new VolumeStrategy(),
  ladder: new LadderStrategy(),
  priceTarget: new PriceTargetStrategy(),
  holdersBooster: new HoldersBoosterStrategy(),
};

export function startStrategy(name: StrategyName) {
  registry[name].start();
  const a = { ...getState().active, [name]: true };
  patchState({ active: a });
}

export function stopStrategy(name: StrategyName) {
  registry[name].stop();
  const a = { ...getState().active, [name]: false };
  patchState({ active: a });
}

export function isRunning(name: StrategyName) {
  return registry[name].isRunning();
}

export function stopAll() {
  (Object.keys(registry) as StrategyName[]).forEach(stopStrategy);
}
