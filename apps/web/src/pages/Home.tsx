import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useUi } from '../store';
import { canRun3D, frames, loadStageModule, newLoadState, type LoadState } from '../home3d/loader';
import { LatticeLoader } from '../home3d/LatticeLoader';
import type { Stage } from '../home3d/stage';
import '../home3d/home.css';
import { IS_MAINNET, VAULTS_OPEN } from '../net';

/** The vault button's words: the vault is real on mainnet, practice on testnet. */
const OPEN_VAULT = IS_MAINNET ? 'Open your vault' : 'Open the testnet vault';

/**
 * The landing page is one scroll-driven story told by a single 3D body behind the page (home3d/stage.ts):
 * a lattice around the vault, one wallet key, that key shattering, five keys in orbit, two routes out, a shield
 * under fire, and the mark. Each section's text sits where that formation leaves room.
 *
 * Scroll mapping: an element with data-track="p:s,p:s" pins state value s to its scroll progress p. Elements with
 * data-act are sticky "acts" (p runs 0..1 while pinned); other tracked sections use viewport progress
 * (0 when the top enters, 1 when the bottom leaves).
 */

const ROLE_LABELS: Array<[string, string, string]> = [
  ['p', 'Primary key', 'Signs every payment'],
  ['a', 'Approver key', 'Co-signs protected payments'],
  ['g1', 'Guardian', 'Two of three restore access'],
  ['g2', 'Guardian', 'Two of three restore access'],
  ['g3', 'Guardian', 'Two of three restore access'],
  ['gas', 'Any wallet', 'Pays gas, holds no power'],
];

const BAD_DAYS: Array<{ title: string; body: string; out: string; hit?: string[]; lost?: string[] }> = [
  {
    title: 'Your primary key is stolen',
    body: 'The thief can spend only what is left of the FAST allowance, and only to listed recipients. Your approver alone can switch FAST off and cancel anything queued; two guardians then replace the pair.',
    out: 'Loss capped at the allowance',
    hit: ['P'],
  },
  {
    title: 'Your approver key is lost',
    body: 'Payments under the allowance still work. Two guardians install a new primary and approver after seven days.',
    out: 'New pair in seven days',
    lost: ['A'],
  },
  {
    title: 'Both spending keys are lost',
    body: 'Two of three guardians start a recovery. Outflows freeze at once, and the new pair takes over after seven days.',
    out: 'Funds frozen, then recovered',
    lost: ['P', 'A'],
  },
  {
    title: 'One guardian is compromised',
    body: 'Nothing happens. Every guardian action needs two of them, and guardians can never move funds.',
    out: 'No effect',
    hit: ['G1'],
  },
  {
    title: 'The wallet that pays gas is hacked',
    body: 'The vault is unaffected. That wallet only ever carried signed requests; it never had authority over the vault.',
    out: 'No effect',
    hit: ['Gas'],
  },
  {
    title: 'This website or its team disappears',
    body: 'The vault keeps working. It is a contract on chain with no owner, and any wallet can submit your signed requests to it.',
    out: 'Vault keeps working',
    lost: ['Site'],
  },
];

const FAQ: Array<[string, string]> = [
  [
    'Is Quanlet live?',
    IS_MAINNET && VAULTS_OPEN
      ? 'Yes. Quanlet runs on Robinhood Chain mainnet, for ETH only. The vault contracts have no owner and cannot be paused or upgraded; their addresses are on the Docs page.'
      : IS_MAINNET
        ? 'Not yet. The mainnet contracts are being deployed; no real funds should be sent to any address claiming otherwise.'
        : 'On testnet, yes: the contracts run on Robinhood Chain testnet and anyone can try them. Mainnet is not live, and no real funds should be sent to any address claiming otherwise.',
  ],
  ['Does connecting my wallet protect it?', 'No. Only assets you move into a Quanlet vault are protected. Connecting a wallet only lets it pay gas and send what you approve.'],
  ['Do I need a token?', 'No. Vaults, signing, payments and recovery work without any token. The QUANLET token (contract address at the bottom of every page) gives no power over any vault.'],
  ['What doesn\u2019t Quanlet protect?', 'Only assets inside a vault, and only who may move them. It does not make Robinhood Chain, bridges, token issuers or your devices quantum-resistant. If you lose both spending keys and two guardians, nobody can recover the funds, including the Quanlet team, which holds no keys to your vault.'],
  ['What happens if this website goes down?', 'Your vault keeps working. It is a contract on chain with no owner, and any wallet can submit your signed requests to it directly, without this site.'],
];

/** The hero's two side rails: who holds a key, and how funds can leave. Facts from contracts/src/v2. */
const HERO_KEYS: Array<[string[], string, string]> = [
  [['P'], 'Primary', 'Starts every payment'],
  [['A'], 'Approver', 'Co-signs protected payments and every change'],
  [['G1', 'G2', 'G3'], 'Guardians', 'Any two restore access'],
];
const HERO_ROUTES: Array<[string, string, string]> = [
  ['FAST', 'Primary alone, to listed recipients, inside an allowance', 'At once'],
  ['Protected', 'Primary and approver, any amount', '0 to 72 h'],
  ['Recovery', 'Two guardians replace both spending keys', '7 days'],
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 64 hex characters that never sit still: a stand-in for a private key (decorative, random each frame). */
function KeyScramble() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hex = '0123456789abcdef';
    const buf = new Uint8Array(64);
    const draw = () => {
      crypto.getRandomValues(buf);
      let s = '';
      for (let i = 0; i < 64; i += 1) s += hex[buf[i]! & 15] + (i % 16 === 15 ? '\n' : i % 4 === 3 ? ' ' : '');
      el.textContent = s;
    };
    draw();
    if (reduced) return;
    let on = false, t = 0, raf = 0;
    const io = new IntersectionObserver(([e]) => (on = !!e?.isIntersecting));
    io.observe(el);
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!on || now - t < 90) return;
      t = now;
      draw();
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);
  return <div className="ks-hex" ref={ref} aria-hidden />;
}

function KeyCells({ hit = [], lost = [] }: { hit?: string[]; lost?: string[] }) {
  const cells = ['P', 'A', 'G1', 'G2', 'G3', 'Gas', 'Site'];
  return (
    <div className="kc" aria-hidden>
      {cells.map((c) => (
        <span key={c} className={`kc-c${hit.includes(c) ? ' hit' : ''}${lost.includes(c) ? ' lost' : ''}${c === 'Gas' ? ' sep' : ''}`}>
          {c}
        </span>
      ))}
    </div>
  );
}

function Steps({ items, className = '' }: { items: ReactNode[]; className?: string }) {
  return (
    <div className={`acts-steps ${className}`}>
      <ol className="acts-ticks" aria-hidden>
        {items.map((_, i) => (
          <li key={i} data-i={i} />
        ))}
      </ol>
      <div className="acts-stack">
        {items.map((it, i) => (
          <div key={i} className="st" data-i={i}>
            {it}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const anchors = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const motion = useUi((s) => s.motion);
  // 3D only with WebGL 2 on a real GPU (?3d=force skips the speed check); otherwise the 2D crystal stays.
  const [can3d] = useState(() => canRun3D(new URLSearchParams(window.location.search).get('3d') === 'force'));
  const [view, setView] = useState<'loading' | 'live' | 'fallback'>(can3d ? 'loading' : 'fallback');
  const load = useRef<LoadState>(newLoadState());
  // The full-screen opening plays on the first visit in a session; later visits assemble in place.
  const [intro] = useState(() => {
    if (!can3d) return false;
    try {
      return !sessionStorage.getItem('quanlet.intro');
    } catch {
      return true;
    }
  });
  const [introDone, setIntroDone] = useState(!intro);
  const clock = useRef(0);
  const reducedNow = () => matchMedia('(prefers-reduced-motion: reduce)').matches || useUi.getState().motion === 'off';
  const [ready, setReady] = useState(false);
  const [loaderGone, setLoaderGone] = useState(false);
  useEffect(() => {
    if (view !== 'live' || !introDone) return;
    const t = window.setTimeout(() => setLoaderGone(true), 1200);
    return () => clearTimeout(t);
  }, [view, introDone]);

  // ------------------------------------------------------------------ scroll engine
  const pts = useRef<Array<[number, number]>>([[0, 0]]);
  const target = useRef(() => {
    const y = window.scrollY;
    const p = pts.current;
    const first = p[0]!;
    if (y <= first[0]) return first[1];
    for (let i = 1; i < p.length; i += 1) {
      const [y1, s1] = p[i]!;
      if (y <= y1) {
        const [y0, s0] = p[i - 1]!;
        return s0 + (s1 - s0) * ((y - y0) / Math.max(1, y1 - y0));
      }
    }
    return p[p.length - 1]![1];
  });

  useEffect(() => {
    const el = root.current!;
    let vh = window.innerHeight, vw = window.innerWidth;
    type Sec = { el: HTMLElement; top: number; h: number; act: boolean; cuts: number[]; step: number };
    let secs: Sec[] = [];
    let trackW = 0;
    const meterN = anchors.current?.querySelector<HTMLElement>('.meter-n') ?? null;
    const measure = () => {
      vh = window.innerHeight;
      vw = document.documentElement.clientWidth;
      const y = window.scrollY;
      const list: Array<[number, number]> = [];
      secs = [...el.querySelectorAll<HTMLElement>('[data-track], [data-act], [data-prog]')].map((s) => {
        const top = s.getBoundingClientRect().top + y;
        const h = s.offsetHeight;
        const act = s.hasAttribute('data-act');
        (s.dataset.track || '').split(',').filter(Boolean).forEach((pair) => {
          const [p = 0, v = 0] = pair.split(':').map(Number);
          list.push([act ? top + p * (h - vh) : top - vh + p * (h + vh), v]);
        });
        const cuts = (s.dataset.cuts || '').split(',').filter(Boolean).map(Number);
        return { el: s, top, h, act, cuts, step: -1 };
      });
      list.sort((a, b) => a[0] - b[0]);
      pts.current = list.length ? list : [[0, 0]];
      trackW = track.current ? track.current.scrollWidth : 0;
      update();
    };
    const onStep = (id: string, step: number) => {
      const st = stage.current;
      const an = anchors.current;
      if (an) an.dataset[id] = String(step);
      if (!st) return;
      if (id === 'roles') st.focusRoles(step === 1 ? [1, 2] : step === 2 ? [3, 4, 5] : step === 3 ? [6] : null);
      if (id === 'routes') st.focusLane(step === 1 ? 0 : step === 2 ? 1 : null);
    };
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = window.scrollY;
      for (const s of secs) {
        const p = s.act ? clamp01((y - s.top) / Math.max(1, s.h - vh)) : clamp01((y - s.top + vh) / (s.h + vh));
        s.el.style.setProperty('--p', p.toFixed(4));
        if (s.act && s.cuts.length) {
          let step = 0;
          while (step < s.cuts.length && p >= s.cuts[step]!) step += 1;
          if (step !== s.step) {
            s.step = step;
            s.el.dataset.step = String(step);
            if (s.el.id) onStep(s.el.id, step);
          }
        }
        if (s.el.id === 'routes' && anchors.current) {
          // FAST payments go out one by one while step 2 is on screen: the allowance only goes down
          const v = 1 - 0.08 * Math.floor(clamp01((p - 0.3) / 0.32) * 8);
          anchors.current.style.setProperty('--fill', v.toFixed(2));
          if (meterN && meterN.textContent !== v.toFixed(2)) meterN.textContent = v.toFixed(2);
        }
        if (s.el.id === 'bad-day' && track.current) {
          const q = clamp01((p - 0.16) / 0.78);
          const travel = Math.max(0, trackW - vw + 32);
          track.current.style.transform = `translate3d(${(-q * travel).toFixed(1)}px,0,0)`;
        }
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    let rt = 0;
    const onResize = () => {
      clearTimeout(rt);
      rt = window.setTimeout(() => {
        measure();
        stage.current?.resize();
      }, 120);
    };
    measure();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    document.fonts?.ready.then(measure);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    // With the opening, the hero title rises when the veil opens (see onExited below).
    const t = requestAnimationFrame(() => !intro && setReady(true));
    return () => {
      cancelAnimationFrame(t);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ------------------------------------------------------------------ 3D stage (loaded after first paint)
  // The 2D loader shows real progress while the stage downloads, builds its points and compiles its shaders;
  // the page crossfades to the stage once it has rendered (see LatticeLoader). Any failure keeps the 2D view.
  useEffect(() => {
    if (!can3d || !canvas.current) return;
    let alive = true;
    const st0 = load.current;
    const giveUp = () => {
      if (!alive) return;
      stage.current?.dispose();
      stage.current = null;
      st0.phase = 'fallback';
      setView('fallback');
    };
    loadStageModule(st0)
      .then(async ({ Stage }) => {
        if (!alive || !canvas.current) return;
        st0.phase = 'build';
        st0.points = Math.min(window.innerWidth, window.innerHeight) < 700 || (navigator.hardwareConcurrency || 8) <= 4 ? 5600 : 9800;
        st0.p = Math.max(st0.p, 0.86);
        await frames(2);
        if (!alive || !canvas.current) return;
        const st = new Stage(canvas.current, {
          reduced: reducedNow(),
          target: () => target.current(),
          startTime: clock.current,
          onReady: () => {
            st0.phase = 'ready';
            st0.p = 1;
          },
          onFail: giveUp,
        });
        stage.current = st;
        st0.phase = 'compile';
        st0.p = Math.max(st0.p, 0.93);
        const f = st.formations.anchors;
        const an = anchors.current!;
        const q = (k: string) => an.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
        st.bindAnchors([
          { el: q('cg'), state: 1, pos: f.curveG },
          { el: q('cpub'), state: 1, pos: f.curvePub },
          ...ROLE_LABELS.map(([k], i) => ({ el: q(k), state: 3, pos: f.roles[i]!, still: k === 'gas' })),
          { el: q('fast'), state: 4, pos: [f.gate[0], f.gate[1] + 0.42, f.gate[2]] as [number, number, number] },
          { el: q('safe'), state: 4, pos: [f.lock[0], f.lock[1] - 0.78, f.lock[2]] as [number, number, number] },
          { el: q('meter'), state: 4, pos: f.fastEnd },
          { el: q('dial'), state: 4, pos: f.safeEnd },
        ]);
      })
      .catch(giveUp);
    return () => {
      alive = false;
      stage.current?.dispose();
      stage.current = null;
    };
  }, [can3d]);

  useEffect(() => {
    stage.current?.setReduced(motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, [motion]);

  return (
    <div className={`h3d${ready ? ' ready' : ''}${view === 'live' ? ' has3d' : view === 'fallback' ? ' no3d' : ' loading3d'}`} ref={root}>
      {can3d && <canvas className="h3d-canvas" ref={canvas} aria-hidden />}
      {view !== 'live' || !loaderGone ? (
        <LatticeLoader
          state={load}
          mode={view === 'fallback' ? 'fallback' : 'loading'}
          reduced={reducedNow()}
          clock={clock}
          intro={intro}
          onSettled={() => setView('live')}
          onExited={() => {
            try {
              sessionStorage.setItem('quanlet.intro', '1');
            } catch {
              /* storage blocked: the opening may play again next time */
            }
            setIntroDone(true);
            setReady(true);
          }}
        />
      ) : null}

      {/* labels that ride on the 3D formations */}
      <div className="h3d-anchors" ref={anchors} aria-hidden>
        <div className="an an-pt" data-k="cg">
          <span className="an-txt">
            <b>Generator point G</b>
            <small>Public, the same for everyone</small>
          </span>
        </div>
        <div className="an an-pt" data-k="cpub">
          <span className="an-txt">
            <b>Your public key</b>
            <small>Secret number × G</small>
          </span>
        </div>
        {ROLE_LABELS.map(([k, t, d]) => (
          <div className="an an-role" data-k={k} key={k}>
            <span className="an-pin" />
            <span className="an-txt">
              <b>{t}</b>
              <small>{d}</small>
            </span>
          </div>
        ))}
        <div className="an an-lane" data-k="fast">
          <span className="an-txt">
            <b>FAST</b>
            <small>Primary key alone, inside the allowance</small>
          </span>
        </div>
        <div className="an an-lane an-low" data-k="safe">
          <span className="an-txt">
            <b>Protected</b>
            <small>Primary and approver, any address</small>
          </span>
        </div>
        <div className="an an-widget" data-k="meter">
          <div className="meter">
            <span className="meter-k">Allowance left</span>
            <span className="meter-v">
              <span className="meter-n" />
              <span className="meter-of">of 1.00 ETH</span>
            </span>
            <span className="meter-bar">
              <i />
            </span>
            <span className="meter-k faint">Never refills on its own</span>
          </div>
        </div>
        <div className="an an-widget" data-k="dial">
          <div className="dial">
            <svg viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="27" className="dial-track" />
              <circle cx="32" cy="32" r="27" className="dial-arc" pathLength={100} />
              {Array.from({ length: 24 }, (_, i) => (
                <line key={i} x1="32" y1="3" x2="32" y2={i % 6 ? 6 : 8} transform={`rotate(${i * 15} 32 32)`} className="dial-tick" />
              ))}
            </svg>
            <span className="dial-txt">
              <b>24 h</b>
              <small>Delay you chose. Either key can cancel.</small>
            </span>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- hero */}
      <section className="hero3" data-track="0:0,0.55:0" aria-labelledby="hero-title">
        <h1 id="hero-title" className="hero3-title">
          <span className="l1">
            <span>Post-quantum</span>
          </span>{' '}
          <span className="l2">
            <span>asset protection</span>
          </span>
        </h1>
        <div className="hero3-rails">
          <section className="hero3-rail l" aria-labelledby="hr-keys">
            <h2 id="hr-keys">Five keys, one vault</h2>
            <ul>
              {HERO_KEYS.map(([ids, name, what]) => (
                <li key={name}>
                  <span className="hr-ids">
                    {ids.map((k) => (
                      <span className="hr-id" key={k}>
                        {k}
                      </span>
                    ))}
                  </span>
                  <span className="hr-txt">
                    <b>{name}</b>
                    <small>{what}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="hero3-rail r" aria-labelledby="hr-routes">
            <h2 id="hr-routes">Three ways funds move</h2>
            <ul>
              {HERO_ROUTES.map(([name, who, when]) => (
                <li key={name}>
                  <span className="hr-txt">
                    <b>{name}</b>
                    <small>{who}</small>
                  </span>
                  <span className="hr-when">{when}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="hero3-foot">
          <p className="hero3-lede">
            Quanlet is a self-custody vault on Robinhood Chain. Funds inside it move only with lattice-based signatures from keys you hold, and three guardians can restore access if
            those keys are lost.
          </p>
          <div className="hero3-cta">
            <Link className="btn primary lg" to="/vault">
              {OPEN_VAULT}
            </Link>
            <a className="btn lg" href="#problem">
              See how it works
            </a>
            <p className="hero3-status">
              <span className="dot live" /> {IS_MAINNET ? 'Live on Robinhood Chain mainnet. ETH only.' : 'Live on testnet. Mainnet is not live yet.'}
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- act 1: one key */}
      <section className="act act1" id="problem" data-act data-cuts="0.36,0.68" data-track="-0.16:0,0.1:1,0.66:1,0.8:2" style={{ '--len': 3.8 } as CSSProperties} aria-labelledby="a1-h">
        <div className="act-pin">
          <h2 id="a1-h" className="act-h">
            Today, one key holds everything.
          </h2>
          <Steps
            className="a1-steps"
            items={[
              <p>Every wallet on Robinhood Chain answers to one secret number on one curve, secp256k1. Whoever holds that number can move everything the wallet owns.</p>,
              <p>Leak it once, through a phishing link, malware or a careless backup, and the funds are gone. There is no second signer and no undo.</p>,
              <p>
                A large enough quantum computer running Shor&rsquo;s algorithm could work that number out from your public key, which every transaction you send reveals. A key you
                never leaked would no longer be safe.
              </p>,
            ]}
          />
          <div className="ks" aria-hidden>
            <span className="ks-k">Private key, secp256k1</span>
            <KeyScramble />
            <span className="ks-cap">
              <span data-i="0">64 characters. Copy them and you own the wallet.</span>
              <span data-i="1">Leaked once, lost for good.</span>
              <span data-i="2">Recoverable from the public key by Shor&rsquo;s algorithm.</span>
            </span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- act 2: five keys */}
      <section className="act act2" id="roles" data-act data-cuts="0.27,0.5,0.75" data-track="0:2,0.13:3,1:3" style={{ '--len': 4.4 } as CSSProperties} aria-labelledby="a2-h">
        <div className="act-pin">
          <h2 id="a2-h" className="act-h">
            Quanlet splits that power five ways.
          </h2>
          <Steps
            className="a2-steps"
            items={[
              <p>
                A Quanlet vault answers to five keys, each with one job. Every one is an <strong>ML-DSA-44</strong> key, the lattice signature NIST standardised as FIPS 204, checked
                on chain.
              </p>,
              <p>
                <strong>Your primary key signs every payment.</strong> Your approver, kept on a separate device, co-signs anything beyond your everyday allowance.
              </p>,
              <p>
                <strong>Three guardians can't spend anything.</strong> Any two of them can hand the vault to a new pair of keys after a seven-day wait.
              </p>,
              <p>
                <strong>The wallet that sends the transaction only pays gas.</strong> It carries your signed request and can't change a word of it.
              </p>,
            ]}
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- act 3: two routes */}
      <section className="act act3" id="routes" data-act data-cuts="0.3,0.64" data-track="0:3,0.14:4,1:4" style={{ '--len': 3.8 } as CSSProperties} aria-labelledby="a3-h">
        <div className="act-pin">
          <h2 id="a3-h" className="act-h">
            Two ways out of the vault.
          </h2>
          <Steps
            className="a3-steps"
            items={[
              <p>Every payment starts with your primary key signing that exact payment: amount, recipient, asset. A signature works once, for 30 minutes at most.</p>,
              <p>
                <strong>FAST</strong> is for everyday spending. Both keys grant it a lifetime ceiling, a cap per payment, an expiry and a list of recipients. It never refills on its
                own.
              </p>,
              <p>
                <strong>Protected</strong> handles everything else. Both keys sign, and you can add a 1, 24 or 72 hour delay. While a payment waits, either key alone can cancel it.
              </p>,
            ]}
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- act 4: bad days */}
      <section className="act act4" id="bad-day" data-act data-track="0:4,0.1:5,1:5" style={{ '--len': 5 } as CSSProperties} aria-labelledby="a4-h">
        <div className="act-pin">
          <div className="a4-head">
            <h2 id="a4-h" className="act-h">
              Built for the bad day.
            </h2>
            <p className="a4-sub">Six things that go wrong, and what the vault does about each.</p>
          </div>
          <div className="bd-rail">
            <div className="bd-track" ref={track}>
              {BAD_DAYS.map((b, i) => (
                <article className="bd" key={b.title}>
                  <span className="bd-n">{i + 1}</span>
                  <KeyCells hit={b.hit} lost={b.lost} />
                  <h3>{b.title}</h3>
                  <p>{b.body}</p>
                  <p className="bd-out">{b.out}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- faq */}
      <section className="faq3" data-track="0:5,0.4:6" aria-labelledby="faq-h">
        <div className="wrap faq3-in">
          <h2 id="faq-h" className="sec-h">
            Short answers.
          </h2>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- end card */}
      <section className="end3" data-track="0.12:6,0.44:7" aria-labelledby="end-h">
        <div className="wrap end3-in">
          <h2 id="end-h" className="end3-word">
            Quanlet
          </h2>
          <p className="end3-tag">Post-quantum asset protection on Robinhood Chain</p>
          <Link className="btn primary lg" to="/vault">
            {OPEN_VAULT}
          </Link>
        </div>
      </section>
    </div>
  );
}
