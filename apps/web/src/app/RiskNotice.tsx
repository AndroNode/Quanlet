/**
 * The mainnet risk notice: read and acknowledged, one tick per section, before the first deposit on a mainnet build.
 *
 * The text comes straight from docs/RISK-NOTICE.md, so the repository and the site always say the same thing. The
 * acknowledgement is kept in this browser against a hash of that text: if the notice changes, it is asked again.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import source from '../../../../docs/RISK-NOTICE.md?raw';

type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };
export type NoticeSection = { title: string; blocks: Block[]; ack: string };

/** Splits the notice into its numbered sections: paragraphs, bullet lists and the closing "> " acknowledgement. */
export function parseNotice(md: string): NoticeSection[] {
  const parts = md.split(/^### /m).slice(1);
  return parts.map((part) => {
    const [head, ...rest] = part.split('\n');
    const title = (head ?? '').replace(/^\d+\.\s*/, '').trim();
    const blocks: Block[] = [];
    const ack: string[] = [];
    let para: string[] = [];
    let list: string[] | null = null;
    const flush = () => {
      if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
      if (list) blocks.push({ kind: 'ul', items: list });
      list = null;
    };
    for (const raw of rest) {
      const line = raw.trimEnd();
      if (line.startsWith('>')) {
        flush();
        ack.push(line.replace(/^>\s?/, ''));
      } else if (!line.trim()) {
        flush();
      } else if (line.startsWith('- ')) {
        if (para.length) flush();
        (list ??= []).push(line.slice(2));
      } else if (list && /^\s+/.test(raw)) {
        list[list.length - 1] += ` ${line.trim()}`;
      } else {
        if (list) flush();
        para.push(line.trim());
      }
    }
    flush();
    return { title, blocks, ack: ack.join(' ') };
  });
}

/** **bold** is the only inline markup the notice uses. */
const inline = (s: string): ReactNode =>
  s.split(/(\*\*[^*]+\*\*)/).map((t, i) => (t.startsWith('**') && t.endsWith('**') ? <strong key={i}>{t.slice(2, -2)}</strong> : <Fragment key={i}>{t}</Fragment>));

function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

export const SECTIONS = parseNotice(source);
const KEY = 'quanlet.mainnet.risk';
const VERSION = hash(source);

export function riskAccepted(): boolean {
  try {
    return localStorage.getItem(KEY) === VERSION;
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, VERSION);
  } catch {
    // Private windows and blocked storage: the acknowledgement holds for this visit only.
  }
}

/** Shows the six sections with a tick each; `onAccept` runs once every one is ticked and the person confirms. */
export function RiskNotice({ onAccept }: { onAccept: () => void }) {
  const sections = useMemo(() => SECTIONS, []);
  const [ticked, setTicked] = useState<boolean[]>(() => sections.map(() => false));
  const left = ticked.filter((t) => !t).length;
  return (
    <form
      className="tn-form card stack rn"
      aria-labelledby="rn-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (left) return;
        remember();
        onAccept();
      }}
    >
      <h3 id="rn-title">Before your first deposit</h3>
      <p className="small muted">
        Deposits here are real ETH on Robinhood Chain. Read each part and tick it to confirm you understand. This is asked once in this browser.
      </p>
      <ol className="rn-list">
        {sections.map((s, i) => (
          <li key={s.title} className={`rn-sec${ticked[i] ? ' done' : ''}`}>
            <h4>{s.title}</h4>
            {s.blocks.map((b, j) =>
              b.kind === 'p' ? (
                <p key={j}>{inline(b.text)}</p>
              ) : (
                <ul key={j}>
                  {b.items.map((it, k) => (
                    <li key={k}>{inline(it)}</li>
                  ))}
                </ul>
              ),
            )}
            <label className="tn-check rn-ack">
              <input type="checkbox" checked={ticked[i]} onChange={(e) => setTicked((t) => t.map((v, k) => (k === i ? e.target.checked : v)))} />
              <span>{s.ack}</span>
            </label>
          </li>
        ))}
      </ol>
      <button className="btn primary" disabled={left > 0}>
        {left ? `Tick ${left === 1 ? 'the last part' : `the ${left} remaining parts`} to continue` : 'I understand, continue to deposit'}
      </button>
    </form>
  );
}
