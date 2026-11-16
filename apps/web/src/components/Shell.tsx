import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { tokenState } from '@quanlet/config';
import { useUi } from '../store';
import { Dialog } from './ui';
import { BETA, IS_MAINNET, NET, VAULTS_OPEN, WORDS } from '../net';
import { EXPLORER, TARGET_CHAIN, TARGET_NAME, formatEth, short, startWalletDiscovery, useWallet } from '../wallet';


function WalletModal({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const [copied, setCopied] = useState(false);
  const onTarget = w.chainId === TARGET_CHAIN;

  const copy = async () => {
    if (!w.address) return;
    try {
      await navigator.clipboard.writeText(w.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the address is selectable */
    }
  };

  return (
    <Dialog title={w.address ? 'Wallet connected' : 'Connect wallet'} onClose={onClose}>
      {w.address ? (
        <div className="wallet-card">
          <div className="wallet-head">
            {w.active?.icon ? <img src={w.active.icon} alt="" width={28} height={28} /> : <span className="wallet-glyph" aria-hidden />}
            <div>
              <div className="small muted">{w.active?.name ?? 'Browser wallet'}</div>
              <button className="wallet-addr mono" onClick={copy} title="Copy address">
                {short(w.address)} <span className="small muted">{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>
          <dl className="wallet-rows">
            <div>
              <dt>Network</dt>
              <dd>
                <span className={`dot ${onTarget ? 'live' : 'warn'}`} aria-hidden /> {onTarget ? TARGET_NAME : w.chainId ? `Chain ${w.chainId}` : 'Unknown'}
              </dd>
            </div>
            <div>
              <dt>{WORDS.balance}</dt>
              <dd className="mono">
                {w.balanceState === 'loading' && !w.balance ? 'Loading…' : w.balanceState === 'error' ? 'Could not load' : w.balance !== null ? `${formatEth(w.balance)} ETH` : '–'}
                <button className="btn ghost xs" onClick={() => void w.refreshBalance()} aria-label="Refresh balance">
                  ↻
                </button>
              </dd>
            </div>
          </dl>
          {!onTarget && (
            <div className="notice warn wallet-switch">
              <span>Your wallet is on another network. Quanlet runs on {TARGET_NAME} (chain {TARGET_CHAIN}).</span>
              <button className="btn primary sm" disabled={w.busy} onClick={() => void w.switchNetwork()}>
                Switch to {TARGET_NAME}
              </button>
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="btn primary sm" to="/vault" onClick={onClose}>
              Open your vault
            </Link>
            <a className="btn sm" href={`${EXPLORER}/address/${w.address}`} target="_blank" rel="noopener noreferrer">
              View on explorer ↗
            </a>
            <button className="btn ghost sm" onClick={() => w.disconnect()}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <>
          <p>Pick a wallet. Connecting shares your <strong>public address</strong> so the site can show your network and {IS_MAINNET ? 'balance' : 'testnet balance'}.</p>
          {w.wallets.length ? (
            <div className="wallet-list">
              {w.wallets.map((x) => (
                <button key={x.uuid} className="wallet-opt" disabled={w.busy} onClick={() => void w.connect(x)}>
                  {x.icon ? <img src={x.icon} alt="" width={28} height={28} /> : <span className="wallet-glyph" aria-hidden />}
                  <span>{x.name}</span>
                  <span className="small muted">{w.busy ? 'Waiting…' : 'Connect'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="notice">
              <span>No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload this page.</span>
            </div>
          )}
        </>
      )}
      <p className="small muted" style={{ marginTop: 14 }}>
        Quanlet never asks for your wallet's private key or seed phrase. Connecting only shares your address; in the vault pages each transaction
        appears in your wallet for you to approve. Connecting does not protect this wallet: only assets deposited into a Quanlet vault are covered.
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>
          Close
        </button>
      </div>
      <p aria-live="polite" className="small" style={{ marginTop: 8 }}>
        {w.status}
      </p>
    </Dialog>
  );
}

function XDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Quanlet X account not announced" onClose={onClose}>
      <p>Quanlet has not announced an official X account yet. Any account claiming to be Quanlet is unverified until it is listed here.</p>
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </Dialog>
  );
}

/** X status in the header (wide screens; narrower screens have it in the menu). */
function XButton() {
  const cfg = useUi((s) => s.config);
  const [open, setOpen] = useState(false);
  if (cfg.social.x)
    return (
      <a className="btn sm ghost x-btn" href={cfg.social.x} target="_blank" rel="noreferrer" aria-label="Quanlet on X">
        X
      </a>
    );
  return (
    <>
      <button className="btn sm ghost x-btn" onClick={() => setOpen(true)} aria-label="Quanlet X account status">
        X
      </button>
      {open && <XDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function CaChip() {
  const cfg = useUi((s) => s.config);
  const t = tokenState(cfg);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  if (t.caReady) {
    return (
      <button
        className="chip"
        title={t.tooltip}
        onClick={async () => {
          await navigator.clipboard?.writeText(cfg.token.contractAddress!);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : t.label}
      </button>
    );
  }
  return (
    <>
      <button className="chip" title={t.tooltip} aria-label={`${t.label}. ${t.tooltip}`} onClick={() => setOpen(true)}>
        {t.label}
      </button>
      {open && (
        <Dialog title="Contract address not announced" onClose={() => setOpen(false)}>
          <p>{t.tooltip}.</p>
          <p className="muted">Quanlet protocol v1 needs no token. Vaults, signing, recovery and withdrawals work without one, and no token launch has been confirmed. Copy, buy and chart links stay hidden until a verified address is published.</p>
          <button className="btn" disabled title={t.tooltip}>
            Copy address
          </button>{' '}
          <button className="btn ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </Dialog>
      )}
    </>
  );
}

const APP = ['/vault', '/payments', '/recovery', '/control'];
const NAV_MAIN: Array<[string, string, string?]> = [
  ['/how-it-works', 'How it works'],
  ['/vault', 'Vault', VAULTS_OPEN ? 'live' : ''],
  ['/docs', 'Docs'],
];

function MenuOverlay({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cfg = useUi((s) => s.config);
  const [x, setX] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('menu-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('menu-open');
    };
  }, [onClose]);
  const links: Array<[string, string, string]> = [
    ['/', 'Home', 'What Quanlet is'],
    ['/how-it-works', 'How it works', 'Setup to payment, step by step'],
    ['/vault', 'Vault', 'Set up, fund and see your vault'],
    ['/payments', 'Payments', 'Send, set limits, see the queue'],
    ['/recovery', 'Recovery', 'Guardians and lost keys'],
    ['/control', 'Control', 'Brakes and key changes'],
    ['/docs', 'Docs and FAQ', 'Rules, limits, addresses'],
  ];
  return (
    <div className={`menu ${closing ? 'closing' : ''}`} id="site-menu" ref={ref} role="dialog" aria-modal="true" aria-label="Site menu">
      <nav className="menu-inner" aria-label="All pages">
        {links.map(([to, label, sub], i) => (
          <NavLink key={to} to={to} end className="menu-link">
            <span className="mono menu-n">{String(i).padStart(2, '0')}</span>
            <span className="menu-link-label">{label}</span>
            <span className="menu-link-sub">{sub}</span>
          </NavLink>
        ))}
        <div className="row menu-meta">
          <CaChip />
          {cfg.social.x ? (
            <a className="btn sm" href={cfg.social.x} target="_blank" rel="noreferrer">
              X
            </a>
          ) : (
            <button className="btn sm" onClick={() => setX(true)} aria-label="Quanlet X account status">
              X
            </button>
          )}
        </div>
      </nav>
      {x && <XDialog onClose={() => setX(false)} />}
    </div>
  );
}

function TopNav() {
  const loc = useLocation();
  return (
    <nav className="topnav" aria-label="Main">
      {NAV_MAIN.map(([to, label, kind]) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `topnav-link ${isActive || (to === '/vault' && APP.includes(loc.pathname)) ? 'active' : ''}`}
        >
          {kind === 'live' && <span className="dot ok" aria-hidden />}
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Header() {
  const [menu, setMenu] = useState(false);
  const [wallet, setWallet] = useState(false);
  const address = useWallet((s) => s.address);
  const chainId = useWallet((s) => s.chainId);
  useEffect(() => startWalletDiscovery(), []);
  useEffect(() => {
    const open = () => setWallet(true);
    window.addEventListener('quanlet:wallet-open', open);
    return () => window.removeEventListener('quanlet:wallet-open', open);
  }, []);
  const loc = useLocation();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenu(false);
    menuBtn.current?.focus();
  }, []);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={`header ${scrolled ? 'scrolled' : ''} ${menu ? 'menu-is-open' : ''}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <div className="header-in">
        <Link to="/" className="logo" aria-label="Quanlet home">
          <img src="/brand/quanlet-mark-small-on-dark.svg" alt="" width={26} height={26} className="logo-mark" />
          <span className="logo-word">Quanlet</span>
        </Link>
        <TopNav />
        <div className="header-actions">
          <span className="x-slot">
            <XButton />
          </span>
          <button className="btn sm wallet-btn" onClick={() => setWallet(true)}>
            <span className={`dot ${address ? (chainId === TARGET_CHAIN ? 'ok' : 'warn') : ''}`} aria-hidden />{' '}
            {address ? (
              <span className="mono">{short(address)}</span>
            ) : (
              <>
                <span className="wb-long">Connect wallet</span>
                <span className="wb-short" aria-hidden>
                  Wallet
                </span>
              </>
            )}
          </button>
          <button ref={menuBtn} className="menu-btn" aria-expanded={menu} aria-controls="site-menu" onClick={() => setMenu(!menu)}>
            <span className="menu-btn-icon" aria-hidden>
              <span />
              <span />
            </span>
            <span className="visually-hidden">{menu ? 'Close menu' : 'Menu'}</span>
          </button>
        </div>
      </div>
      {menu && <MenuOverlay onClose={closeMenu} closing={false} />}
      {wallet && <WalletModal onClose={() => setWallet(false)} />}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-brand">
          <img src="/brand/quanlet-mark-on-dark.svg" alt="" width={44} height={44} />
          <span className="footer-word">Quanlet</span>
          <span className="caps footer-tag">Post-quantum asset protection · Robinhood Chain</span>
        </div>
        <div className="cols">
          <nav aria-label="Product" className="stack">
            <span className="caps">Use</span>
            <Link to="/vault">Vault</Link>
            <Link to="/payments">Payments</Link>
            <Link to="/recovery">Recovery</Link>
            <Link to="/control">Control</Link>
          </nav>
          <nav aria-label="Learn" className="stack">
            <span className="caps">Learn</span>
            <Link to="/how-it-works">How it works</Link>
            <Link to="/docs">Docs and FAQ</Link>
            <Link to="/docs#gaps">Known gaps</Link>
            <a href="https://github.com/AndroNode/Quanlet" target="_blank" rel="noopener noreferrer">
              Source code
            </a>
          </nav>
          <div className="stack footer-legal">
            <span className="caps">Status</span>
            <p>
              {IS_MAINNET && !VAULTS_OPEN
                ? `Quanlet vaults on ${NET.name} open after the reviewed contracts are deployed.`
                : IS_MAINNET
                ? `Quanlet is in a capped beta on Robinhood Chain. Use only amounts you can afford to lose${BETA.vaultCapEth ? `; the site accepts up to ${BETA.vaultCapEth} ETH per vault` : ''}.`
                : 'Quanlet runs on Robinhood Chain testnet and is not live on mainnet yet. The vault uses the protocol 2.0 contracts on testnet, where ETH has no value.'}
            </p>
            <p>
              Not financial advice. Quanlet protects only assets in a vault, and only who may move them. Independent project; no affiliation with or endorsement by Robinhood
              or bb84 is claimed.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
