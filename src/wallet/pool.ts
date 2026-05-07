import fs from "node:fs";
import path from "node:path";
import PQueue from "p-queue";
import { mnemonicNew, mnemonicToPrivateKey, KeyPair } from "@ton/crypto";
import { WalletContractV4, internal, SendMode } from "@ton/ton";
import { Address, beginCell, Cell } from "@ton/core";
import { tonClient } from "./client";
import { logger } from "../core/logger";

/**
 * Pool di wallet master.
 *
 * - Persistito su data/wallets.json (in .gitignore)
 * - Ogni wallet ha la propria coda PQueue per serializzare seqno
 * - Massimo MAX_ACTIVE wallet attivi contemporaneamente (default 5)
 * - Le strategie usano `pickWalletRR()` per round-robin sugli attivi
 * - L'holders booster usa `getFundingWallet()` (wallet "selected", o primo attivo)
 */

export const MAX_ACTIVE = 5;
export const MAX_TOTAL = 50;

export interface WalletRecord {
  id: number;
  label: string;
  mnemonic: string[];
  address: string; // bounceable=false (UQ...)
  active: boolean;
  createdAt: number;
}

interface WalletsFile {
  wallets: WalletRecord[];
  nextId: number;
  selectedId: number | null;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "wallets.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let cache: WalletsFile | null = null;

function load(): WalletsFile {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(FILE)) {
    cache = { wallets: [], nextId: 1, selectedId: null };
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(FILE, "utf8")) as WalletsFile;
  return cache;
}

function save() {
  if (!cache) return;
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

const queues = new Map<number, PQueue>();
function getQueue(id: number): PQueue {
  let q = queues.get(id);
  if (!q) {
    q = new PQueue({ concurrency: 1 });
    queues.set(id, q);
  }
  return q;
}

export interface WalletInstance {
  record: WalletRecord;
  address: Address;
  send(
    messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[],
  ): Promise<void>;
  balanceTon(): Promise<bigint>;
  keyPair(): Promise<KeyPair>;
}

const instances = new Map<number, WalletInstance>();

async function buildInstance(record: WalletRecord): Promise<WalletInstance> {
  const kp = await mnemonicToPrivateKey(record.mnemonic);
  const client = tonClient();
  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }),
  );

  const sendBatch = async (
    messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[],
  ): Promise<void> => {
    const q = getQueue(record.id);
    await q.add(async () => {
      const seqno = await wallet.getSeqno();
      await wallet.sendTransfer({
        seqno,
        secretKey: kp.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: messages.map((m) =>
          internal({
            to: m.to,
            value: m.value,
            body: m.body ?? beginCell().endCell(),
            bounce: m.bounce ?? false,
          }),
        ),
      });
      logger.info(
        {
          walletId: record.id,
          label: record.label,
          seqno,
          count: messages.length,
        },
        "wallet: external inviato",
      );
    });
  };

  const send = async (
    messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[],
  ): Promise<void> => {
    if (messages.length === 0) return;
    for (let i = 0; i < messages.length; i += 4) {
      await sendBatch(messages.slice(i, i + 4));
    }
  };

  return {
    record,
    address: wallet.address,
    send,
    balanceTon: async () => client.getBalance(wallet.address),
    keyPair: async () => kp,
  };
}

async function getInstance(record: WalletRecord): Promise<WalletInstance> {
  const cached = instances.get(record.id);
  if (cached) return cached;
  const inst = await buildInstance(record);
  instances.set(record.id, inst);
  return inst;
}

export function listWallets(): WalletRecord[] {
  return load().wallets;
}

export function getActiveWallets(): WalletRecord[] {
  return load().wallets.filter((w) => w.active);
}

export function getSelectedId(): number | null {
  return load().selectedId;
}

export async function createWallet(label?: string): Promise<WalletRecord> {
  const data = load();
  if (data.wallets.length >= MAX_TOTAL) {
    throw new Error(`Max ${MAX_TOTAL} wallet totali raggiunti.`);
  }
  const mnemonic = await mnemonicNew(24);
  const kp = await mnemonicToPrivateKey(mnemonic);
  const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  const id = data.nextId++;
  const activeCount = data.wallets.filter((x) => x.active).length;
  const record: WalletRecord = {
    id,
    label: label?.trim() || `wallet-${id}`,
    mnemonic,
    address: w.address.toString({ bounceable: false }),
    active: activeCount < MAX_ACTIVE,
    createdAt: Date.now(),
  };
  data.wallets.push(record);
  if (data.selectedId === null) data.selectedId = id;
  save();
  return record;
}

export async function importWallet(
  mnemonic: string[],
  label?: string,
): Promise<WalletRecord> {
  if (mnemonic.length !== 24) {
    throw new Error(`Mnemonic deve avere 24 parole, ricevute ${mnemonic.length}`);
  }
  const data = load();
  if (data.wallets.length >= MAX_TOTAL) {
    throw new Error(`Max ${MAX_TOTAL} wallet totali raggiunti.`);
  }
  const kp = await mnemonicToPrivateKey(mnemonic);
  const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  const address = w.address.toString({ bounceable: false });
  if (data.wallets.some((x) => x.address === address)) {
    throw new Error("Wallet gia' presente nel pool.");
  }
  const id = data.nextId++;
  const activeCount = data.wallets.filter((x) => x.active).length;
  const record: WalletRecord = {
    id,
    label: label?.trim() || `wallet-${id}`,
    mnemonic,
    address,
    active: activeCount < MAX_ACTIVE,
    createdAt: Date.now(),
  };
  data.wallets.push(record);
  if (data.selectedId === null) data.selectedId = id;
  save();
  return record;
}

export function setActive(id: number, active: boolean) {
  const data = load();
  const w = data.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`wallet ${id} non trovato`);
  if (active && !w.active) {
    const count = data.wallets.filter((x) => x.active).length;
    if (count >= MAX_ACTIVE) {
      throw new Error(`Massimo ${MAX_ACTIVE} wallet attivi contemporaneamente`);
    }
  }
  w.active = active;
  save();
}

export function setSelected(id: number) {
  const data = load();
  const w = data.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`wallet ${id} non trovato`);
  data.selectedId = id;
  save();
}

export function removeWallet(id: number) {
  const data = load();
  const idx = data.wallets.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`wallet ${id} non trovato`);
  data.wallets.splice(idx, 1);
  if (data.selectedId === id) {
    data.selectedId = data.wallets[0]?.id ?? null;
  }
  instances.delete(id);
  save();
}

export function getMnemonic(id: number): string[] {
  const w = load().wallets.find((x) => x.id === id);
  if (!w) throw new Error(`wallet ${id} non trovato`);
  return w.mnemonic;
}

let rrIndex = 0;
export async function pickWalletRR(): Promise<WalletInstance> {
  const active = getActiveWallets();
  if (active.length === 0) {
    throw new Error(
      "Nessun wallet attivo nel pool. Crea un wallet con /wallet_new",
    );
  }
  const w = active[rrIndex % active.length]!;
  rrIndex++;
  return getInstance(w);
}

export async function getFundingWallet(): Promise<WalletInstance> {
  const data = load();
  if (data.selectedId !== null) {
    const w = data.wallets.find((x) => x.id === data.selectedId);
    if (w?.active) return getInstance(w);
  }
  const active = getActiveWallets();
  if (active.length === 0) {
    throw new Error("Nessun wallet attivo per funding.");
  }
  return getInstance(active[0]!);
}

export async function getInstanceById(id: number): Promise<WalletInstance | null> {
  const w = load().wallets.find((x) => x.id === id);
  if (!w) return null;
  return getInstance(w);
}

export async function bootstrapFromEnv(): Promise<void> {
  const data = load();
  if (data.wallets.length > 0) return;
  const raw = (process.env.MASTER_MNEMONIC ?? "").trim();
  if (!raw || raw.startsWith("word1")) return;
  const mnemonic = raw.split(/\s+/);
  if (mnemonic.length !== 24) return;
  try {
    const rec = await importWallet(mnemonic, "imported-from-env");
    logger.info({ id: rec.id, address: rec.address }, "pool: imported MASTER_MNEMONIC");
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "pool: import env mnemonic fallito",
    );
  }
}
