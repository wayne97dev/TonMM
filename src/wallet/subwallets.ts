import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mnemonicNew, mnemonicToPrivateKey, KeyPair } from "@ton/crypto";
import { WalletContractV4, internal, SendMode } from "@ton/ton";
import { Address, beginCell, Cell } from "@ton/core";
import { tonClient } from "./master";
import { config } from "../config";
import { logger } from "../core/logger";

const DATA_DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "subwallets.json");

interface SubwalletRecord {
  index: number;
  mnemonic: string[];
  address: string;
  used: boolean;
}

interface SubwalletsFile {
  seedFingerprint: string;
  wallets: SubwalletRecord[];
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fingerprint(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function load(): SubwalletsFile {
  ensureDir();
  if (!fs.existsSync(FILE)) {
    return { seedFingerprint: fingerprint(config.SUBWALLETS_SEED), wallets: [] };
  }
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function save(data: SubwalletsFile) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/**
 * Genera N nuovi sub-wallet (mnemonic random) e li salva su data/subwallets.json.
 * NB: il file e' nei .gitignore. Custodisci con cura.
 */
export async function ensureSubwallets(count: number): Promise<SubwalletRecord[]> {
  const data = load();
  const expectedFp = fingerprint(config.SUBWALLETS_SEED);
  if (data.wallets.length > 0 && data.seedFingerprint !== expectedFp) {
    throw new Error(
      "SUBWALLETS_SEED cambiato rispetto al file esistente. " +
        "Rinomina/elimina data/subwallets.json se vuoi rigenerare (PERDERAI gli accessi).",
    );
  }
  data.seedFingerprint = expectedFp;

  while (data.wallets.length < count) {
    const idx = data.wallets.length;
    const mnemonic = await mnemonicNew(24);
    const kp = await mnemonicToPrivateKey(mnemonic);
    const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
    data.wallets.push({
      index: idx,
      mnemonic,
      address: w.address.toString({ bounceable: false }),
      used: false,
    });
  }
  save(data);
  return data.wallets.slice(0, count);
}

export async function getSubwalletKeyPair(record: SubwalletRecord): Promise<KeyPair> {
  return await mnemonicToPrivateKey(record.mnemonic);
}

export function markUsed(index: number) {
  const data = load();
  const w = data.wallets.find((x) => x.index === index);
  if (w) {
    w.used = true;
    save(data);
  }
}

export function nextUnused(): SubwalletRecord | undefined {
  const data = load();
  return data.wallets.find((x) => !x.used);
}

/**
 * Esegue uno swap dal sub-wallet inviando un messaggio interno gia' costruito
 * (ad esempio prodotto dal DEX adapter) verso il router del DEX.
 */
export async function sendFromSubwallet(
  record: SubwalletRecord,
  msg: { to: Address; value: bigint; body: Cell; bounce?: boolean },
): Promise<void> {
  const client = tonClient();
  const kp = await getSubwalletKeyPair(record);
  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }),
  );
  const seqno = await wallet.getSeqno();
  await wallet.sendTransfer({
    seqno,
    secretKey: kp.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: msg.to,
        value: msg.value,
        body: msg.body ?? beginCell().endCell(),
        bounce: msg.bounce ?? false,
      }),
    ],
  });
  logger.info({ index: record.index, seqno }, "subwallet: external inviato");
}
