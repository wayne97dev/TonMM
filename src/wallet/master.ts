import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4, internal, SendMode } from "@ton/ton";
import { Address, beginCell, Cell, OpenedContract } from "@ton/core";
import { config } from "../config";
import { logger } from "../core/logger";

/**
 * Master wallet del market maker.
 *
 * NOTA: per semplicita' e affidabilita' usiamo WalletContractV4R2 di @ton/ton.
 * V4 supporta fino a 4 messaggi per external e e' piu' che sufficiente per le
 * strategie qui implementate (1 swap = 1 messaggio interno verso il router).
 *
 * Per migrare a Highload Wallet V3 (decine di tx/secondo) basta sostituire la
 * costruzione del wallet sotto e adattare il metodo `sendInternal`.
 * Il subwallet_id e il timeout per HW V3 sono gia' presenti in config:
 *   - config.HIGHLOAD_SUBWALLET_ID
 *   - config.HIGHLOAD_TIMEOUT
 */

let cachedClient: TonClient | null = null;

export function tonClient(): TonClient {
  if (cachedClient) return cachedClient;
  cachedClient = new TonClient({
    endpoint: config.TON_ENDPOINT,
    apiKey: config.TON_API_KEY || undefined,
  });
  return cachedClient;
}

export interface MasterWallet {
  address: Address;
  send(messages: Array<{ to: Address; value: bigint; body?: Cell; bounce?: boolean }>): Promise<void>;
  balanceTon(): Promise<bigint>;
}

let cachedMaster: MasterWallet | null = null;

export async function getMasterWallet(): Promise<MasterWallet> {
  if (cachedMaster) return cachedMaster;

  const mnemonic = config.MASTER_MNEMONIC.split(/\s+/).filter(Boolean);
  if (mnemonic.length !== 24) {
    throw new Error(`MASTER_MNEMONIC deve avere 24 parole, ricevute ${mnemonic.length}`);
  }
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const client = tonClient();

  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }),
  ) as OpenedContract<WalletContractV4>;

  cachedMaster = {
    address: wallet.address,
    async send(messages) {
      if (messages.length === 0) return;
      if (messages.length > 4) {
        // V4 limita a 4 internal per external; chunkare se serve
        for (let i = 0; i < messages.length; i += 4) {
          await this.send(messages.slice(i, i + 4));
        }
        return;
      }
      const seqno = await wallet.getSeqno();
      await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
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
        { seqno, count: messages.length },
        "master: external inviato",
      );
    },
    async balanceTon() {
      return await client.getBalance(wallet.address);
    },
  };

  return cachedMaster;
}
