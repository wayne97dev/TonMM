import { Bot, Context, InlineKeyboard } from "grammy";
import { fromNano } from "@ton/core";
import { config } from "../config";
import { logger } from "../core/logger";
import { getState, patchState } from "../core/state";
import { isRunning, startStrategy, stopAll, stopStrategy } from "../strategies";
import { executeSwap } from "../core/engine";
import {
  bootstrapFromEnv,
  createWallet,
  getActiveWallets,
  getInstanceById,
  getMnemonic,
  importWallet,
  listWallets,
  MAX_ACTIVE,
  removeWallet,
  setActive,
  setSelected,
  getSelectedId,
} from "../wallet/pool";
import { ensureSubwallets } from "../wallet/subwallets";
import { DexChoice, StrategyName } from "../types";
import * as wiz from "./wizard";

function isOpenMode(): boolean {
  return config.TELEGRAM_ADMIN_IDS.length === 0;
}

function isAdmin(ctx: Context): boolean {
  if (isOpenMode()) return true;
  const id = ctx.from?.id;
  return !!id && config.TELEGRAM_ADMIN_IDS.includes(id);
}

export async function startTelegramBot(): Promise<Bot> {
  await bootstrapFromEnv();

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(
        `Accesso negato. Il tuo Telegram ID e' ${ctx.from?.id ?? "?"}; aggiungilo a TELEGRAM_ADMIN_IDS.`,
      );
      return;
    }
    await next();
  });

  // ===== Comandi base =====
  bot.command("start", async (ctx) => {
    const s = getState();
    if (isOpenMode()) {
      logger.warn(
        { from: ctx.from?.id, username: ctx.from?.username },
        "OPEN MODE: chiunque ha appena interagito col bot",
      );
    }
    await ctx.reply(
      [
        "*TonMM* - Internal Market Maker",
        isOpenMode()
          ? `⚠️ *OPEN MODE* attiva: chiunque puo' usare il bot. Il tuo user id e': \`${ctx.from?.id ?? "?"}\`. Mettilo in TELEGRAM_ADMIN_IDS e riavvia per chiudere il bot agli altri.`
          : "",
        s.token.master
          ? `Token: *${s.token.symbol}* \`${s.token.master.slice(0, 8)}...\``
          : "Token: _non configurato_ (usa /setup)",
        "",
        "Comandi rapidi:",
        "/menu - pannello principale",
        "/setup - configura token",
        "/wallets - gestisci pool wallet",
        "/wizard <strategia> - configura una strategia (volume|ladder|priceTarget|holdersBooster)",
        "/limits - imposta limiti di sicurezza",
        "/status - stato e parametri",
        "/cancel - annulla wizard in corso",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("menu", async (ctx) => sendMainMenu(ctx));
  bot.command("status", async (ctx) => sendStatus(ctx));
  bot.command("cancel", async (ctx) => {
    const ok = wiz.cancel(ctx.chat!.id);
    await ctx.reply(ok ? "Wizard annullato." : "Nessun wizard attivo.");
  });

  // ===== Setup wizards =====
  bot.command("setup", async (ctx) => {
    const step = wiz.startWizard(ctx.chat!.id, "setup");
    await ctx.reply(wiz.promptFor(step), { parse_mode: "Markdown" });
  });
  bot.command("limits", async (ctx) => {
    const step = wiz.startWizard(ctx.chat!.id, "limits");
    await ctx.reply(wiz.promptFor(step), { parse_mode: "Markdown" });
  });
  bot.command("wizard", async (ctx) => {
    const flow = ctx.match.trim() as wiz.WizardStep extends `${infer F}.${string}`
      ? F
      : never;
    const valid = ["volume", "ladder", "priceTarget", "holdersBooster"] as const;
    if (!valid.includes(flow as (typeof valid)[number])) {
      return ctx.reply(`Uso: /wizard ${valid.join("|")}`);
    }
    const step = wiz.startWizard(
      ctx.chat!.id,
      flow as (typeof valid)[number],
    );
    await ctx.reply(wiz.promptFor(step), { parse_mode: "Markdown" });
  });

  // ===== Wallet pool =====
  bot.command("wallets", async (ctx) => sendWalletsList(ctx));

  bot.command("wallet_new", async (ctx) => {
    const label = ctx.match.trim() || undefined;
    const w = await createWallet(label);
    const inst = await getInstanceById(w.id);
    const bal = inst ? await inst.balanceTon() : 0n;
    await ctx.reply(
      [
        `Wallet creato: *#${w.id} ${w.label}*`,
        `Indirizzo: \`${w.address}\``,
        `Attivo: ${w.active ? "si" : "no (max attivi raggiunto)"}`,
        `Saldo: ${fromNano(bal)} TON`,
        "",
        "Finanzialo inviando TON a quell'indirizzo per iniziare a operare.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("wallet_import", async (ctx) => {
    // /wallet_import label | word1 word2 ... word24
    const raw = ctx.match.trim();
    const [labelPart, mnemonicPart] = raw.includes("|")
      ? raw.split("|").map((x) => x.trim())
      : ["imported", raw];
    const words = (mnemonicPart || "").split(/\s+/).filter(Boolean);
    if (words.length !== 24) {
      return ctx.reply("Uso: /wallet_import <label> | <24 parole separate da spazio>");
    }
    try {
      const w = await importWallet(words, labelPart);
      // best-effort: cancella il messaggio originale per non lasciare la mnemonic in chat
      try {
        await ctx.deleteMessage();
      } catch {
        /* ignore */
      }
      await ctx.reply(
        `Importato *#${w.id} ${w.label}*\n\`${w.address}\`\n\n(Il tuo messaggio con la mnemonic e' stato cancellato dal bot, controlla in chat.)`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("wallet_activate", async (ctx) => {
    const id = parseInt(ctx.match);
    if (!id) return ctx.reply("Uso: /wallet_activate <id>");
    try {
      setActive(id, true);
      await ctx.reply(`Wallet #${id} attivato.`);
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  bot.command("wallet_deactivate", async (ctx) => {
    const id = parseInt(ctx.match);
    if (!id) return ctx.reply("Uso: /wallet_deactivate <id>");
    try {
      setActive(id, false);
      await ctx.reply(`Wallet #${id} disattivato.`);
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  bot.command("wallet_select", async (ctx) => {
    const id = parseInt(ctx.match);
    if (!id) return ctx.reply("Uso: /wallet_select <id>");
    try {
      setSelected(id);
      await ctx.reply(`Wallet #${id} impostato come *primary* (usato per holders booster).`, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  bot.command("wallet_remove", async (ctx) => {
    const id = parseInt(ctx.match);
    if (!id) return ctx.reply("Uso: /wallet_remove <id>");
    try {
      removeWallet(id);
      await ctx.reply(`Wallet #${id} rimosso. (mnemonic perso se non hai backup)`);
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  bot.command("wallet_export", async (ctx) => {
    const id = parseInt(ctx.match);
    if (!id) return ctx.reply("Uso: /wallet_export <id>");
    try {
      const m = getMnemonic(id);
      await ctx.reply(
        `Mnemonic wallet #${id} (24 parole, *trattalo come password*):\n\n\`${m.join(" ")}\`\n\nSalvalo in un posto sicuro e poi cancella questo messaggio.`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.reply(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  bot.command("balance", async (ctx) => {
    const all = listWallets();
    if (all.length === 0) return ctx.reply("Pool vuoto. Crea un wallet con /wallet_new");
    const lines: string[] = [];
    for (const w of all) {
      const inst = await getInstanceById(w.id);
      let bal = 0n;
      try {
        bal = inst ? await inst.balanceTon() : 0n;
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e), id: w.id }, "balance: fetch fail");
      }
      lines.push(
        `#${w.id} ${w.label} ${w.active ? "ON" : "off"} - ${fromNano(bal)} TON`,
      );
    }
    await ctx.reply(lines.join("\n"));
  });

  // ===== Inline callbacks =====
  bot.callbackQuery(/dex:(stonfi|dedust|auto)/, async (ctx) => {
    const dex = ctx.match[1] as DexChoice;
    patchState({ selectedDex: dex });
    await ctx.answerCallbackQuery(`DEX: ${dex}`);
    await sendMainMenu(ctx, true);
  });

  bot.callbackQuery(/start:(volume|ladder|priceTarget|holdersBooster)/, async (ctx) => {
    const name = ctx.match[1] as StrategyName;
    try {
      // sanity: serve un token configurato e almeno un wallet attivo
      const s = getState();
      if (!s.token.master) throw new Error("Configura il token con /setup");
      if (getActiveWallets().length === 0) throw new Error("Crea/attiva un wallet con /wallet_new");
      startStrategy(name);
      await ctx.answerCallbackQuery(`Avviata: ${name}`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e instanceof Error ? e.message : String(e), show_alert: true });
    }
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
  bot.callbackQuery("wallets", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendWalletsList(ctx, true);
  });
  bot.callbackQuery("setup", async (ctx) => {
    const step = wiz.startWizard(ctx.chat!.id, "setup");
    await ctx.answerCallbackQuery();
    await ctx.reply(wiz.promptFor(step), { parse_mode: "Markdown" });
  });

  // ===== Manual buy/sell =====
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

  bot.command("genwallets", async (ctx) => {
    const n = parseInt(ctx.match) || getState().params.holdersBooster.targetHolders;
    await ctx.reply(`Genero ${n} sub-wallet per holders booster...`);
    const list = await ensureSubwallets(n);
    await ctx.reply(
      `OK. Totale sub-wallet: ${list.length}. File locale: data/subwallets.json`,
    );
  });

  // ===== Wizard input handler (deve essere ULTIMO sui messaggi testo) =====
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // i comandi sono gestiti sopra
    const res = await wiz.handleInput(ctx, text);
    if (!res) return;
    if (!res.ok) {
      await ctx.reply(`${res.message}\n\n${res.nextPrompt ?? ""}`, {
        parse_mode: "Markdown",
      });
      return;
    }
    if (res.done) {
      await ctx.reply(res.message, { parse_mode: "Markdown" });
      await sendMainMenu(ctx);
    } else if (res.nextPrompt) {
      await ctx.reply(res.nextPrompt, { parse_mode: "Markdown" });
    }
  });

  bot.catch((err) => logger.error({ err: err.error }, "telegram error"));

  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, "telegram bot online"),
  });
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
  const active = getActiveWallets();
  const text = [
    "*TonMM - Pannello*",
    "",
    state.token.master
      ? `Token: *${state.token.symbol}* \`${state.token.master.slice(0, 8)}...\` (dec ${state.token.decimals})`
      : "Token: _non configurato_ - usa Setup",
    `DEX: *${state.selectedDex}*  |  Slippage: ${state.limits.maxSlippagePct}%`,
    `Wallet attivi: *${active.length}* / ${MAX_ACTIVE}  |  Selected: ${getSelectedId() ?? "-"}`,
    `Trades: *${state.trades}*  |  TON spesi: *${state.spentTon.toFixed(3)}* / ${state.limits.sessionBudgetTon}`,
    `Holder creati: *${state.holdersCreated}* / ${state.params.holdersBooster.targetHolders}`,
    state.lastError ? `Ultimo errore: \`${state.lastError}\`` : "",
    "",
    "Strategie:",
    ...(["volume", "ladder", "priceTarget", "holdersBooster"] as StrategyName[]).map(
      (n) => `  - ${n}: ${state.active[n] ? "ON" : "off"}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const kb = new InlineKeyboard();
  kb.text("Setup token", "setup").text("Wallets", "wallets").text("Status", "status").row();
  kb.text("STON.fi", "dex:stonfi").text("DeDust", "dex:dedust").text("Auto", "dex:auto").row();
  strategyButtons().inline_keyboard.forEach((r) => kb.inline_keyboard.push(r));

  const opts = { parse_mode: "Markdown" as const, reply_markup: kb };
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      /* fall through to reply */
    }
  }
  await ctx.reply(text, opts);
}

async function sendStatus(ctx: Context, edit = false) {
  const state = getState();
  const all = listWallets();
  const lines: string[] = ["*Status*", ""];
  if (state.token.master) {
    lines.push(`Token: \`${state.token.master}\``);
    lines.push(`Symbol: ${state.token.symbol}  |  Decimals: ${state.token.decimals}`);
  } else {
    lines.push("Token: _non configurato_ (usa /setup)");
  }
  lines.push(`DEX: *${state.selectedDex}*  |  Slippage max: ${state.limits.maxSlippagePct}%`);
  lines.push(`Trades: ${state.trades}  |  Spesa: ${state.spentTon.toFixed(3)} / ${state.limits.sessionBudgetTon} TON`);
  lines.push(`Holders creati: ${state.holdersCreated}`);
  lines.push("");
  lines.push("*Wallet pool:*");
  for (const w of all) {
    const inst = await getInstanceById(w.id);
    const bal = inst ? await inst.balanceTon() : 0n;
    lines.push(
      `  #${w.id} ${w.label} ${w.active ? "[ON]" : "[off]"}${w.id === getSelectedId() ? " *" : ""} - \`${w.address}\` - ${fromNano(bal)} TON`,
    );
  }
  if (all.length === 0) lines.push("  (vuoto - usa /wallet_new)");
  lines.push("");
  lines.push("*Parametri:*");
  lines.push("```");
  lines.push(JSON.stringify(state.params, null, 2));
  lines.push("```");

  const kb = new InlineKeyboard().text("Menu", "menu");
  const opts = { parse_mode: "Markdown" as const, reply_markup: kb };
  const text = lines.join("\n");
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, opts);
}

async function sendWalletsList(ctx: Context, edit = false) {
  const all = listWallets();
  const sel = getSelectedId();
  const lines: string[] = ["Wallet pool", ""];
  if (all.length === 0) {
    lines.push("Pool vuoto. Crea un wallet con /wallet_new");
  } else {
    for (const w of all) {
      const inst = await getInstanceById(w.id);
      let bal = 0n;
      try {
        bal = inst ? await inst.balanceTon() : 0n;
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e), id: w.id }, "wallets list: balance fail");
      }
      lines.push(
        `#${w.id} ${w.label} ${w.active ? "ON" : "off"}${w.id === sel ? " (selected)" : ""}`,
      );
      lines.push(`   ${w.address} - ${fromNano(bal)} TON`);
    }
  }
  lines.push("");
  lines.push("Comandi:");
  lines.push("/wallet_new label   - crea nuovo wallet");
  lines.push("/wallet_activate ID   |   /wallet_deactivate ID");
  lines.push("/wallet_select ID   - imposta come primary");
  lines.push("/wallet_remove ID   - rimuovi (perdi accesso se non hai backup)");
  lines.push("/wallet_export ID   - mostra mnemonic (backup)");
  lines.push("/wallet_import label | 24 parole   - importa esterno");

  const kb = new InlineKeyboard().text("Menu", "menu");
  const opts = { reply_markup: kb };
  const text = lines.join("\n");
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, opts);
}
