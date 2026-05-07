import { Bot, Context, InlineKeyboard } from "grammy";
import { config } from "../config";
import { logger } from "../core/logger";
import { getState, patchParams, patchState } from "../core/state";
import { isRunning, startStrategy, stopAll, stopStrategy } from "../strategies";
import { executeSwap } from "../core/engine";
import { getMasterWallet } from "../wallet/master";
import { ensureSubwallets } from "../wallet/subwallets";
import { DexChoice, StrategyName } from "../types";
import { fromNano } from "@ton/core";

function isAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  return !!id && config.TELEGRAM_ADMIN_IDS.includes(id);
}

export async function startTelegramBot(): Promise<Bot> {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(
        `Accesso negato. Aggiungi il tuo Telegram ID (${ctx.from?.id ?? "?"}) a TELEGRAM_ADMIN_IDS.`,
      );
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "TonMM - Internal Market Maker",
        `Token: ${config.JETTON_SYMBOL} (${config.JETTON_MASTER.slice(0, 8)}...)`,
        "",
        "Usa /menu per il pannello.",
      ].join("\n"),
    );
  });

  bot.command("menu", async (ctx) => sendMainMenu(ctx));
  bot.command("status", async (ctx) => sendStatus(ctx));

  bot.callbackQuery(/dex:(stonfi|dedust|auto)/, async (ctx) => {
    const dex = ctx.match[1] as DexChoice;
    patchState({ selectedDex: dex });
    await ctx.answerCallbackQuery(`DEX: ${dex}`);
    await sendMainMenu(ctx, true);
  });

  bot.callbackQuery(/start:(volume|ladder|priceTarget|holdersBooster)/, async (ctx) => {
    const name = ctx.match[1] as StrategyName;
    startStrategy(name);
    await ctx.answerCallbackQuery(`Avviata: ${name}`);
    await sendMainMenu(ctx, true);
  });
  bot.callbackQuery(/stop:(volume|ladder|priceTarget|holdersBooster)/, async (ctx) => {
    const name = ctx.match[1] as StrategyName;
    stopStrategy(name);
    await ctx.answerCallbackQuery(`Fermata: ${name}`);
    await sendMainMenu(ctx, true);
  });
  bot.callbackQuery("stopall", async (ctx) => {
    stopAll();
    await ctx.answerCallbackQuery("Tutte fermate");
    await sendMainMenu(ctx, true);
  });

  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMainMenu(ctx, true);
  });
  bot.callbackQuery("status", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendStatus(ctx, true);
  });

  // /buy <amount-ton>  e  /sell <amount-token>
  bot.command("buy", async (ctx) => {
    const amount = parseFloat(ctx.match);
    if (!amount || amount <= 0) return ctx.reply("Uso: /buy <amount-ton>");
    const r = await executeSwap({ side: "buy", amount });
    await ctx.reply(r.ok ? `BUY inviato su ${r.dex}` : `Errore: ${r.error}`);
  });
  bot.command("sell", async (ctx) => {
    const amount = parseFloat(ctx.match);
    if (!amount || amount <= 0) return ctx.reply("Uso: /sell <amount-token>");
    const r = await executeSwap({ side: "sell", amount });
    await ctx.reply(r.ok ? `SELL inviato su ${r.dex}` : `Errore: ${r.error}`);
  });

  // /set <strategy>.<key> <value>
  bot.command("set", async (ctx) => {
    const m = ctx.match.match(/^(\w+)\.(\w+)\s+(.+)$/);
    if (!m) return ctx.reply("Uso: /set <strategy>.<key> <value>");
    const [, strat, key, raw] = m;
    const num = Number(raw);
    if (Number.isNaN(num)) return ctx.reply("Il valore deve essere numerico");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      patchParams(strat as any, { [key]: num } as any);
      await ctx.reply(`OK: ${strat}.${key} = ${num}`);
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("genwallets", async (ctx) => {
    const n = parseInt(ctx.match) || config.HOLDERS_BOOSTER_COUNT;
    await ctx.reply(`Genero ${n} sub-wallet...`);
    const list = await ensureSubwallets(n);
    await ctx.reply(`OK. Totale sub-wallet: ${list.length}. File: data/subwallets.json`);
  });

  bot.command("balance", async (ctx) => {
    const m = await getMasterWallet();
    const bal = await m.balanceTon();
    await ctx.reply(`Master ${m.address.toString({ bounceable: false })}\nSaldo: ${fromNano(bal)} TON`);
  });

  bot.catch((err) => logger.error({ err: err.error }, "telegram error"));

  await bot.start({ onStart: (info) => logger.info({ username: info.username }, "telegram bot online") });
  return bot;
}

function strategyButtons(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const list: StrategyName[] = ["volume", "ladder", "priceTarget", "holdersBooster"];
  for (const s of list) {
    const running = isRunning(s);
    kb.text(
      `${running ? "Stop" : "Start"} ${s}`,
      `${running ? "stop" : "start"}:${s}`,
    ).row();
  }
  kb.text("Stop ALL", "stopall").row();
  return kb;
}

async function sendMainMenu(ctx: Context, edit = false) {
  const state = getState();
  const text = [
    "*TonMM - Pannello*",
    "",
    `DEX selezionato: *${state.selectedDex}*`,
    `Trades: *${state.trades}*  |  TON spesi: *${state.spentTon.toFixed(3)}*`,
    `Holder creati: *${state.holdersCreated}* / ${state.params.holdersBooster.targetHolders}`,
    state.lastError ? `Ultimo errore: \`${state.lastError}\`` : "",
    "",
    "Strategie attive:",
    ...(["volume", "ladder", "priceTarget", "holdersBooster"] as StrategyName[]).map(
      (n) => `  - ${n}: ${state.active[n] ? "ON" : "off"}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const dexKb = new InlineKeyboard()
    .text("STON.fi", "dex:stonfi")
    .text("DeDust", "dex:dedust")
    .text("Auto", "dex:auto")
    .row();

  // unisci tastiere: prima DEX, poi strategie
  const combined = new InlineKeyboard();
  // copia righe da dexKb
  dexKb.inline_keyboard.forEach((r) =>
    combined.inline_keyboard.push(r),
  );
  strategyButtons().inline_keyboard.forEach((r) =>
    combined.inline_keyboard.push(r),
  );
  combined.text("Status", "status").row();

  const opts = { parse_mode: "Markdown" as const, reply_markup: combined };
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, opts);
  } else {
    await ctx.reply(text, opts);
  }
}

async function sendStatus(ctx: Context, edit = false) {
  const state = getState();
  const m = await getMasterWallet();
  const bal = await m.balanceTon();
  const text = [
    "*Status*",
    "",
    `Master: \`${m.address.toString({ bounceable: false })}\``,
    `Saldo TON: *${fromNano(bal)}*`,
    `DEX: *${state.selectedDex}*  |  Slippage max: ${config.MAX_SLIPPAGE_PCT}%`,
    `Trades: ${state.trades}  |  Spesa: ${state.spentTon.toFixed(3)} / ${config.SESSION_BUDGET_TON} TON`,
    `Holders creati: ${state.holdersCreated}`,
    "",
    "Parametri (JSON):",
    "```",
    JSON.stringify(state.params, null, 2),
    "```",
  ].join("\n");
  const kb = new InlineKeyboard().text("Menu", "menu");
  const opts = { parse_mode: "Markdown" as const, reply_markup: kb };
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, opts);
  } else {
    await ctx.reply(text, opts);
  }
}
