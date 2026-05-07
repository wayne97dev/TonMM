# TonMM — Internal Market Maker per TON Chain

Bot Telegram in Node.js + TypeScript che esegue **Market Making automatico**
sul tuo jetton, sia su **STON.fi** che su **DeDust**, con strategie:

- **Volume bot** — buy/sell randomici con bias e cadenza configurabili
- **Pump / Anti-dump ladder** — raffica di micro-ordini scaglionati per stabilizzare il chart
- **Price target** — buy automatico sotto il floor, sell sopra il ceiling
- **Holders booster** — genera N nuovi indirizzi che comprano una piccola quantità,
  facendoli diventare holder reali on-chain

> Disclaimer: il MM su asset propri può violare le ToS di alcuni DEX/exchange e
> in molte giurisdizioni configura **manipolazione di mercato**. Usalo solo se
> conosci le implicazioni legali e operative. Nessuna garanzia di funzionamento.

## Architettura

```
src/
  index.ts              # entrypoint
  config.ts             # validazione .env (zod)
  types.ts              # tipi condivisi
  core/
    engine.ts           # esegue uno swap dal master (coda seqno)
    state.ts            # stato persistente in data/state.json
    logger.ts           # pino + pino-pretty
  wallet/
    master.ts           # WalletV4R2 (mnemonic in .env)
    subwallets.ts       # genera/gestisce N wallet per Holders Booster
  dex/
    types.ts
    stonfi.ts           # adapter STON.fi v2.2 (pTON v2.1)
    dedust.ts           # adapter DeDust (mainnet factory)
    index.ts            # router auto-pick
  strategies/
    base.ts
    volume.ts
    ladder.ts
    priceTarget.ts
    holdersBooster.ts
    index.ts
  bot/
    telegram.ts         # grammy: menu inline + comandi
```

## Setup

```bash
git clone <repo> && cd TonMM
cp .env.example .env
# compila .env (vedi sotto)
npm install
npm run dev          # avvio in dev (ts-node)
# oppure
npm run build && npm start
```

### Compilazione `.env`

| Variabile | Descrizione |
|-----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram (BotFather). **Revoca quello che hai già condiviso in chat.** |
| `TELEGRAM_ADMIN_IDS` | Tuo Telegram user id (puoi ottenerlo da @userinfobot). Solo questi ID possono usare il bot |
| `TON_ENDPOINT` | RPC TonCenter o TonAPI |
| `TON_API_KEY` | API key (consigliata in produzione) |
| `MASTER_MNEMONIC` | 24 parole mnemonic del wallet master. Va finanziato in TON e nel jetton |
| `JETTON_MASTER` | Indirizzo master del tuo jetton (formato EQ...) |
| `JETTON_DECIMALS` | Decimali del tuo jetton (default 9) |
| `JETTON_SYMBOL` | Ticker (solo display) |
| `DEFAULT_DEX` | `stonfi` / `dedust` / `auto` (default auto) |
| `HOLDERS_BOOSTER_COUNT` | Quanti sub-wallet generare al massimo |
| `SUBWALLETS_SEED` | Stringa di marker locale; cambiandola si rigenerano da zero |
| `MAX_TRADE_TON` | Limite TON per singolo trade |
| `SESSION_BUDGET_TON` | Limite TON spendibile per sessione |
| `MAX_SLIPPAGE_PCT` | Slippage massimo accettato sugli swap |

## Comandi Telegram

| Comando | Azione |
|---------|--------|
| `/start` | Welcome |
| `/menu` | Pannello inline (DEX, start/stop strategie) |
| `/status` | Saldo master, parametri JSON, contatori |
| `/balance` | Saldo TON master |
| `/buy <ton>` | Buy manuale |
| `/sell <token>` | Sell manuale |
| `/set <strategia>.<chiave> <valore>` | Cambia parametro a runtime, es: `/set volume.minIntervalSec 15` |
| `/genwallets <n>` | Pre-genera n sub-wallet per holders booster |

### Esempi `/set`

```
/set volume.minTradeTon 0.05
/set volume.maxTradeTon 0.4
/set volume.bias 0.2          # 20% piu' buy
/set ladder.levels 8
/set ladder.stepPct 1.0
/set priceTarget.floorTon 0.0008
/set priceTarget.ceilingTon 0.0012
/set holdersBooster.fundingTon 0.5
/set holdersBooster.buyTon 0.3
```

## Holders booster - come funziona

1. Pre-generi i wallet: `/genwallets 50` (mnemonic salvati in `data/subwallets.json`).
2. Avvia la strategia dal `/menu` → Start `holdersBooster`.
3. Per ogni iterazione il bot:
   - prende il prossimo sub-wallet "non usato"
   - **il master gli invia `fundingTon` TON**
   - **il sub-wallet** esegue un buy del jetton sul DEX → diventa holder
   - lo marca come usato e passa al prossimo dopo `intervalSec`

> ⚠️ Il file `data/subwallets.json` contiene **24-word mnemonic in chiaro** ed è
> l'unico modo per recuperare i token che restano sui sub-wallet. È in
> `.gitignore` ma fanne un backup criptato (es. age, gpg).

## Sicurezza

- Niente token o mnemonic nel repo — tutto via `.env` (in `.gitignore`)
- Whitelist degli admin Telegram (`TELEGRAM_ADMIN_IDS`)
- Limiti hard: `MAX_TRADE_TON`, `SESSION_BUDGET_TON`, `MAX_SLIPPAGE_PCT`
- Coda seqno per evitare race sull'invio external dal master
- Tutte le quote richiedono `amountOutMin` derivato dallo slippage configurato

## Note tecniche

- **Wallet master**: `WalletContractV4R2` di `@ton/ton`. Per migrare a Highload
  Wallet V3 (necessario solo se hai bisogno di > 4 messaggi per blocco) basta
  sostituire la costruzione del wallet in `src/wallet/master.ts`. Le variabili
  `HIGHLOAD_SUBWALLET_ID` e `HIGHLOAD_TIMEOUT` sono già pronte in `.env`.
- **STON.fi**: usa il router v2.2 e pTON v2.1 (mainnet).
- **DeDust**: usa la mainnet factory; verifica la readiness del pool prima dello swap.
- **Quote**: per semplicità di scaffold le `quote()` STON.fi restituiscono una
  stima neutra. La sicurezza è garantita comunque dal `MAX_SLIPPAGE_PCT` lato
  router. Per quote più accurate puoi leggere direttamente le reserves del pool.

## Roadmap suggerita

- [ ] Quote on-chain accurata su STON.fi (lettura reserves del pool)
- [ ] Migrazione a Highload Wallet V3 (stesso comportamento, più throughput)
- [ ] Comando `/sweep` per ritirare TON e jetton dai sub-wallet usati
- [ ] Dashboard web minimale (stat live + log)
- [ ] Persistenza degli ordini ladder per riprendere dopo restart
