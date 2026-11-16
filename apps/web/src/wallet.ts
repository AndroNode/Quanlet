import { create } from 'zustand';

/**
 * Browser wallet connection. Finds wallets with EIP-6963 (falls back to window.ethereum),
 * reads the address and network, can ask the wallet to switch to Robinhood Chain Testnet,
 * and reads balances through the site's own /api/rpc (Alchemy behind the Worker).
 * It never asks for a signature, a transaction or a token approval.
 */

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, f: (x: unknown) => void) => void;
  removeListener?: (e: string, f: (x: unknown) => void) => void;
};
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
}

import { NET } from './net';
export const TARGET_CHAIN = NET.chainId;
export const TARGET_HEX = '0x' + TARGET_CHAIN.toString(16);
export const TARGET_NAME = NET.name;
export const EXPLORER = NET.explorerUrl;
const LAST = 'quanlet.wallet';

interface WalletStore {
  wallets: WalletInfo[];
  active: WalletInfo | null;
  address: string | null;
  chainId: number | null;
  balance: bigint | null;
  balanceState: 'idle' | 'loading' | 'ok' | 'error';
  status: string | null;
  busy: boolean;
  connect: (w: WalletInfo) => Promise<void>;
  /** Reconnect without a prompt when the wallet already allows this site. */
  resume: (w: WalletInfo) => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

let unbind: (() => void) | null = null;

function remember(rdns: string | null) {
  try {
    if (rdns) localStorage.setItem(LAST, rdns);
    else localStorage.removeItem(LAST);
  } catch {
    /* storage unavailable: no auto-reconnect */
  }
}
function remembered(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const toChain = (v: unknown) => (typeof v === 'string' ? parseInt(v, 16) : typeof v === 'number' ? v : null);

/** One JSON-RPC read through the Worker. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error || !('result' in j)) throw new Error(j.error?.message || `RPC ${res.status}`);
    return j.result as T;
  } finally {
    clearTimeout(t);
  }
}

export const useWallet = create<WalletStore>((set, get) => {
  const bind = (w: WalletInfo) => {
    unbind?.();
    const onAccounts = (a: unknown) => {
      const acc = Array.isArray(a) ? a[0] : null;
      if (isAddr(acc)) {
        set({ address: acc, balance: null });
        void get().refreshBalance();
      } else get().disconnect();
    };
    const onChain = (c: unknown) => {
      set({ chainId: toChain(c) });
      void get().refreshBalance();
    };
    const onDisconnect = () => get().disconnect();
    w.provider.on?.('accountsChanged', onAccounts);
    w.provider.on?.('chainChanged', onChain);
    w.provider.on?.('disconnect', onDisconnect);
    unbind = () => {
      w.provider.removeListener?.('accountsChanged', onAccounts);
      w.provider.removeListener?.('chainChanged', onChain);
      w.provider.removeListener?.('disconnect', onDisconnect);
      unbind = null;
    };
  };

  const attach = async (w: WalletInfo, ask: boolean) => {
    const accounts = (await w.provider.request({ method: ask ? 'eth_requestAccounts' : 'eth_accounts' })) as unknown[];
    const addr = accounts?.[0];
    if (!isAddr(addr)) {
      if (ask) set({ status: 'The wallet returned no address.' });
      return false;
    }
    const chain = toChain(await w.provider.request({ method: 'eth_chainId' }).catch(() => null));
    bind(w);
    set({ active: w, address: addr, chainId: chain, balance: null, status: null });
    remember(w.rdns);
    void get().refreshBalance();
    return true;
  };

  return {
    wallets: [],
    active: null,
    address: null,
    chainId: null,
    balance: null,
    balanceState: 'idle',
    status: null,
    busy: false,
    connect: async (w) => {
      set({ busy: true, status: null });
      try {
        await attach(w, true);
      } catch (e) {
        const code = (e as { code?: number }).code;
        set({
          status:
            code === 4001
              ? 'You rejected the request. Nothing was shared.'
              : code === -32002
                ? 'A request is already open in your wallet. Check the wallet window.'
                : 'The wallet could not connect. Try again or pick another wallet.',
        });
      } finally {
        set({ busy: false });
      }
    },
    resume: async (w) => {
      try {
        await attach(w, false);
      } catch {
        /* stay disconnected */
      }
    },
    disconnect: () => {
      unbind?.();
      remember(null);
      set({ active: null, address: null, chainId: null, balance: null, balanceState: 'idle', status: 'Disconnected. Your wallet may still list this site as connected; you can remove it there.' });
    },
    switchNetwork: async () => {
      const w = get().active;
      if (!w) return;
      set({ busy: true, status: null });
      try {
        try {
          await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_HEX }] });
        } catch (e) {
          const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
          if (code !== 4902) throw e;
          await w.provider.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: TARGET_HEX, chainName: TARGET_NAME, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [NET.rpcUrl], blockExplorerUrls: [EXPLORER] }],
          });
          // Some wallets add the network without switching to it.
          await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_HEX }] }).catch(() => null);
        }
        const chain = toChain(await w.provider.request({ method: 'eth_chainId' }).catch(() => null));
        if (chain) set({ chainId: chain });
      } catch (e) {
        set({ status: (e as { code?: number }).code === 4001 ? 'You declined the network switch.' : 'The wallet could not switch networks. You can add it manually from the details below.' });
      } finally {
        set({ busy: false });
      }
    },
    refreshBalance: async () => {
      const addr = get().address;
      if (!addr) return;
      set({ balanceState: 'loading' });
      try {
        const hex = await rpc<string>('eth_getBalance', [addr, 'latest']);
        if (get().address === addr) set({ balance: BigInt(hex), balanceState: 'ok' });
      } catch {
        if (get().address === addr) set({ balanceState: 'error' });
      }
    },
  };
});

/** Format wei as ETH with up to 5 decimals. */
export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 5).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Start wallet discovery once, and quietly reconnect the last wallet if it still grants access. */
let started = false;
export function startWalletDiscovery() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const found = new Map<string, WalletInfo>();
  const publish = () => useWallet.setState({ wallets: Array.from(found.values()) });
  const tryAuto = (w: WalletInfo) => {
    if (useWallet.getState().active || remembered() !== w.rdns) return;
    // eth_accounts never opens a prompt; it only answers if the site is already allowed.
    void useWallet.getState().resume(w);
  };
  window.addEventListener('eip6963:announceProvider', (ev) => {
    const d = (ev as CustomEvent).detail as { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 } | undefined;
    if (!d?.provider || !d.info?.uuid || !d.info.name) return;
    const icon = typeof d.info.icon === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(d.info.icon) ? d.info.icon : '';
    const w: WalletInfo = { uuid: d.info.uuid, name: d.info.name.slice(0, 40), icon, rdns: d.info.rdns || d.info.uuid, provider: d.provider };
    found.set(w.uuid, w);
    publish();
    tryAuto(w);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // Older wallets only inject window.ethereum.
  window.setTimeout(() => {
    const eth = (window as unknown as { ethereum?: Eip1193 & { isMetaMask?: boolean } }).ethereum;
    if (!eth || found.size) return;
    const w: WalletInfo = { uuid: 'injected', name: eth.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '', rdns: 'injected', provider: eth };
    found.set(w.uuid, w);
    publish();
    tryAuto(w);
  }, 400);
}
