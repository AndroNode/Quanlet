/**
 * The Quanlet relayer: submits transfers that a vault's keys have already signed, and pays their gas.
 *
 * A signed transfer names its fee recipient and fee, and the vault pays that fee in ETH in the same
 * transaction (or, for a protected transfer that waits a delay, when it is executed). The relayer only
 * submits a transfer that pays it at least its gas, to a contract with the code of a real Quanlet vault,
 * after simulating it. It can change nothing in what was signed, and it holds no power over any vault:
 * its key only pays gas. The key is the Worker secret RELAYER_PRIVATE_KEY; without it the relayer is off.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface RelayNet {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** Runtime code hashes of genuine Quanlet vaults on this network. */
  vaultCodehashes: string[];
}

/** Gas each kind of transaction is quoted for (measured on mainnet: FAST 1.38M, protected 2.59M). */
export const GAS = { fast: 1_700_000n, protected: 3_100_000n, execute: 250_000n } as const;
/** The quote is the gas at today's price times this margin (percent), and never below MIN_FEE. */
const QUOTE_MARGIN = 150n;
/** At submission the fee must cover the estimate at today's price plus this margin (percent). */
const COST_MARGIN = 120n;
export const MIN_FEE = 20_000_000_000_000n; // 0.00002 ETH
/** Below this balance the relayer stops taking new transfers. */
export const LOW_BALANCE = 500_000_000_000_000n; // 0.0005 ETH
/** What the relayer keeps for gas when it pays its earnings out (see sweep). */
export const KEEP = 5_000_000_000_000_000n; // 0.005 ETH
const ROUND = 1_000_000_000_000n; // quotes round up to 0.000001 ETH

const VAULT = parseAbi([
  'struct Transfer { uint8 route; address asset; address recipient; uint256 amount; address feeRecipient; uint256 feeWei; }',
  'struct Window { uint64 validAfter; uint64 validUntil; }',
  'struct Withdrawal { address asset; address recipient; uint256 amount; address feeRecipient; uint256 feeWei; uint64 authorityEpoch; uint64 policyEpoch; uint64 executionEpoch; uint64 executableAt; uint64 expiresAt; uint8 status; }',
  'function submitTransfer(Transfer t, Window w, bytes pSig, bytes aSig) returns (bytes32)',
  'function executeWithdrawal(bytes32 id)',
  'function getWithdrawal(bytes32 id) view returns (Withdrawal)',
  'function protectedDelay() view returns (uint32)',
  'error AllowanceExceeded()',
  'error BadInterval()',
  'error BadParams()',
  'error BadSignature()',
  'error Expired()',
  'error FastUnavailable()',
  'error KeyNotReady()',
  'error NotActive()',
  'error NotQueued()',
  'error QueueFull()',
  'error RecipientNotAllowed()',
  'error Reentrancy()',
  'error RequestNotAccepted()',
  'error StaleEpoch()',
  'error TooEarly()',
  'error TransferFailed()',
  'error UnexpectedSignature()',
  'error UnknownWithdrawal()',
  'error VerifierChanged()',
  'error WrongState()',
]);

/** Plain words for the vault's refusals, so the page can say what to fix. */
const REASONS: Record<string, string> = {
  AllowanceExceeded: 'This is more than the FAST allowance permits (the relayer fee counts against it).',
  RecipientNotAllowed: 'The recipient, or the relayer as fee recipient, is not on this vault’s FAST lists.',
  FastUnavailable: 'FAST is off, suspended or outside its dates.',
  BadSignature: 'A signature did not verify.',
  RequestNotAccepted: 'The signed request is outside its time window. Sign it again.',
  NotActive: 'The vault is frozen by a pending security change.',
  QueueFull: 'Too many protected transfers are already queued.',
  TransferFailed: 'The vault does not hold enough for the amount and the fee.',
  BadParams: 'The amount, recipient or fee is not valid.',
  TooEarly: 'The delay has not passed yet.',
  Expired: 'The window to execute has closed.',
  NotQueued: 'That transfer is no longer queued.',
  StaleEpoch: 'That transfer was invalidated by a freeze or a change.',
  BadInterval: 'The signed time window is invalid. Sign it again.',
  UnexpectedSignature: 'A FAST transfer carries only the primary signature.',
  KeyNotReady: 'One of the vault’s keys is not ready.',
};

type Call =
  | { functionName: 'submitTransfer'; args: [Signed['t'], Signed['w'], Hex, Hex] }
  | { functionName: 'executeWithdrawal'; args: [Hex] };

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const isAddr = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const isUint = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const roundUp = (v: bigint) => ((v + ROUND - 1n) / ROUND) * ROUND;

export type Signed = {
  vault: Address;
  t: { route: number; asset: Address; recipient: Address; amount: bigint; feeRecipient: Address; feeWei: bigint };
  w: { validAfter: bigint; validUntil: bigint };
  pSig: Hex;
  aSig: Hex;
};

/** The site's "quanlet-v2-signed-transfer" format (apps/web/src/testnet/v2/chain.ts exportSigned). */
export function parseSigned(raw: unknown, chainId: number): Signed {
  const r = raw as Record<string, any>;
  if (!r || r.format !== 'quanlet-v2-signed-transfer' || r.version !== 1) throw new RelayError(400, 'This is not a Quanlet signed transfer.');
  if (r.chainId !== chainId) throw new RelayError(400, 'This signed transfer is for a different network.');
  const t = r.transfer;
  if (!isAddr(r.vault) || !t || ![1, 2].includes(t.route) || !isAddr(t.asset) || !isAddr(t.recipient) || !isAddr(t.feeRecipient) || !isUint(t.amount) || !isUint(t.feeWei))
    throw new RelayError(400, 'The signed transfer is malformed.');
  if (!r.window || !isUint(r.window.validAfter) || !isUint(r.window.validUntil) || !isHex(r.pSig) || !isHex(r.aSig) || r.pSig.length > 20000 || r.aSig.length > 20000)
    throw new RelayError(400, 'The signed transfer is malformed.');
  return {
    vault: r.vault,
    t: { route: t.route, asset: t.asset, recipient: t.recipient, amount: BigInt(t.amount), feeRecipient: t.feeRecipient, feeWei: BigInt(t.feeWei) },
    w: { validAfter: BigInt(r.window.validAfter), validUntil: BigInt(r.window.validUntil) },
    pSig: r.pSig,
    aSig: r.aSig,
  };
}

/** The custom error a reverted call carries, if any. */
function reasonOf(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    if (name) return REASONS[name] ?? name;
    const m = /reverted with the following signature:\s*(0x[0-9a-f]{8})/i.exec(e.message);
    if (m) return `The vault refused it (${m[1]}).`;
  }
  return 'The vault would refuse this transaction.';
}

// One transaction at a time per Worker instance, so nonces do not collide.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const run = queue.then(f, f);
  queue = run.catch(() => undefined);
  return run;
};

// A light per-instance limit: each address may ask a few times a minute.
const hits = new Map<string, number[]>();
export function limited(key: string, max = 8, perMs = 60_000): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < perMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

export class Relayer {
  readonly address: Address;
  private pc;
  private wc;

  constructor(
    private net: RelayNet,
    key: string,
  ) {
    const k = (key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('RELAYER_PRIVATE_KEY is not a 32-byte hex key');
    const account = privateKeyToAccount(k);
    this.address = account.address;
    const chain = defineChain({ id: net.chainId, name: net.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [net.rpcUrl] } } });
    this.pc = createPublicClient({ chain, transport: http(net.rpcUrl, { timeout: 20_000 }) });
    this.wc = createWalletClient({ account, chain, transport: http(net.rpcUrl, { timeout: 20_000 }) });
  }

  /** What each kind of relayed transfer costs right now, and whether the relayer is taking new ones. */
  async status() {
    const [gasPrice, balance] = await Promise.all([this.pc.getGasPrice(), this.pc.getBalance({ address: this.address })]);
    const q = (gas: bigint) => {
      const v = roundUp((gas * gasPrice * QUOTE_MARGIN) / 100n);
      return (v < MIN_FEE ? MIN_FEE : v).toString();
    };
    return {
      enabled: true,
      address: this.address,
      chainId: this.net.chainId,
      accepting: balance >= LOW_BALANCE && this.net.vaultCodehashes.length > 0,
      fees: { fast: q(GAS.fast), protected: q(GAS.protected), protectedDelayed: q(GAS.protected + GAS.execute), execute: q(GAS.execute) },
      gasPrice: gasPrice.toString(),
    };
  }

  private async checkVault(vault: Address) {
    const code = await this.pc.getCode({ address: vault });
    if (!code || code === '0x' || !this.net.vaultCodehashes.some((h) => same(h, keccak256(code)))) throw new RelayError(400, 'That address is not a Quanlet vault on this network.');
  }

  private async ready() {
    const balance = await this.pc.getBalance({ address: this.address });
    if (balance < LOW_BALANCE) throw new RelayError(503, 'The relayer is paused (low balance). Send the transfer from your own wallet for now.');
  }

  /** Simulates, prices and sends one call to a vault. The fee must cover the gas with margin. */
  private async send(vault: Address, call: Call, feeWei: bigint, laterGas = 0n) {
    let gas: bigint;
    try {
      // Through the ABI, so a refusal comes back as the vault's own error name.
      gas = await this.pc.estimateContractGas({ account: this.address, address: vault, abi: VAULT, ...call } as Parameters<typeof this.pc.estimateContractGas>[0]);
    } catch (e) {
      throw new RelayError(422, reasonOf(e));
    }
    const data = encodeFunctionData({ abi: VAULT, ...call } as Parameters<typeof encodeFunctionData>[0]);
    const gasPrice = await this.pc.getGasPrice();
    const cost = ((gas + laterGas) * gasPrice * COST_MARGIN) / 100n;
    if (feeWei < cost) throw new RelayError(402, 'The fee no longer covers the gas. Get a new quote and sign again.', { minFeeWei: roundUp(cost).toString() });
    return serial(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const nonce = await this.pc.getTransactionCount({ address: this.address, blockTag: 'pending' });
          return await this.wc.sendTransaction({ to: vault, data, gas: (gas * 125n) / 100n, gasPrice: (gasPrice * 120n) / 100n, nonce, type: 'legacy' });
        } catch (e) {
          const msg = (e as Error).message ?? '';
          if (attempt === 0 && /nonce|already known|replacement/i.test(msg)) continue;
          throw new RelayError(502, 'The relayer could not send the transaction. Try again, or send it from your own wallet.');
        }
      }
    });
  }

  /** Submits a signed transfer whose fee is paid to this relayer. */
  async submit(raw: unknown) {
    const s = parseSigned(raw, this.net.chainId);
    if (!same(s.t.feeRecipient, this.address) || s.t.feeWei === 0n) throw new RelayError(400, `The transfer must pay its fee to the relayer (${this.address}).`);
    if (s.w.validUntil <= BigInt(Math.floor(Date.now() / 1000)) + 20n) throw new RelayError(400, 'The signed transfer has expired. Sign it again.');
    await this.ready();
    await this.checkVault(s.vault);
    const delayed = s.t.route === 2 && (await this.pc.readContract({ address: s.vault, abi: VAULT, functionName: 'protectedDelay' })) > 0;
    const hash = await this.send(s.vault, { functionName: 'submitTransfer', args: [s.t, s.w, s.pSig, s.aSig] }, s.t.feeWei, delayed ? GAS.execute : 0n);
    return { hash, queued: delayed };
  }

  /**
   * Pays the relayer's earnings above KEEP to the owner's payout address (the Worker variable RELAYER_PAYOUT).
   * Anyone may trigger it: it can only send to that one address, so the relayer key never has to leave the Worker.
   */
  async sweep(payout: string | undefined) {
    if (!isAddr(payout)) throw new RelayError(503, 'No payout address is set for the relayer.');
    return serial(async () => {
      const [balance, gasPrice] = await Promise.all([this.pc.getBalance({ address: this.address }), this.pc.getGasPrice()]);
      const gas = 50_000n;
      const price = (gasPrice * 120n) / 100n;
      const value = balance - KEEP - gas * price;
      if (value <= 0n) return { hash: null, paid: '0' };
      const nonce = await this.pc.getTransactionCount({ address: this.address, blockTag: 'pending' });
      const hash = await this.wc.sendTransaction({ to: payout, value, gas, gasPrice: price, nonce, type: 'legacy' });
      return { hash, paid: value.toString() };
    });
  }

  /** Executes a matured protected transfer that pays this relayer its fee. */
  async execute(raw: unknown) {
    const r = raw as Record<string, unknown>;
    if (!r || !isAddr(r.vault) || !isHex(r.id) || r.id.length !== 66) throw new RelayError(400, 'Send the vault address and the transfer id.');
    const vault = r.vault;
    const id = r.id as Hex;
    await this.ready();
    await this.checkVault(vault);
    const w = await this.pc.readContract({ address: vault, abi: VAULT, functionName: 'getWithdrawal', args: [id] });
    if (w.status !== 1) throw new RelayError(400, 'That transfer is not queued.');
    if (!same(w.feeRecipient, this.address) || w.feeWei === 0n) throw new RelayError(400, 'That transfer does not pay the relayer, so it cannot execute it. Execute it from your wallet.');
    const hash = await this.send(vault, { functionName: 'executeWithdrawal', args: [id] }, w.feeWei);
    return { hash };
  }
}
