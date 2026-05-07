import { logger } from "../core/logger";

export abstract class Strategy {
  protected timer: NodeJS.Timeout | null = null;
  protected running = false;
  abstract readonly name: string;

  start() {
    if (this.running) return;
    this.running = true;
    logger.info({ strategy: this.name }, "strategy: start");
    this.scheduleNext(0);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info({ strategy: this.name }, "strategy: stop");
  }

  isRunning() {
    return this.running;
  }

  protected scheduleNext(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (e) {
        logger.error(
          { err: e instanceof Error ? e.message : String(e), strategy: this.name },
          "strategy tick errore",
        );
      }
      if (this.running) this.scheduleNext(this.nextDelayMs());
    }, delayMs);
  }

  protected abstract tick(): Promise<void>;
  protected abstract nextDelayMs(): number;
}

export function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}
