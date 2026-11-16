import type { ReactNode } from 'react';
import { ParticleMark } from './ParticleMark';

/**
 * Per-page identity in the brutalist theme: an index and a label above the title, a row of facts under it,
 * and the mark, drawn in points, beside it. All decorative parts are aria-hidden.
 */

export type PageKind = 'how' | 'docs' | 'testnet';

const KICKER: Record<PageKind, [string, string]> = {
  how: ['P/01', 'The protocol'],
  docs: ['R/01', 'Reference'],
  testnet: ['T/01', 'Live network'],
};

const CAPTION: Record<PageKind, string> = {
  how: 'Dual ML-DSA-44 keys',
  docs: 'Protocol 2.0',
  testnet: 'Robinhood Chain testnet',
};

export function PageKicker({ kind }: { kind: PageKind }) {
  const [n, t] = KICKER[kind];
  return (
    <div className="pkicker caps">
      <span className="pk-n">{n}</span>
      <span className="pk-rule" aria-hidden />
      <span className="pk-t">{t}</span>
    </div>
  );
}

export function PageFacts({ facts }: { facts: Array<[ReactNode, string]> }) {
  return (
    <dl className="pfacts">
      {facts.map(([v, l], i) => (
        <div key={i}>
          <dt className="caps">{l}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageMark({ kind }: { kind: PageKind }) {
  return <ParticleMark className="pmark" caption={CAPTION[kind]} />;
}

/** Split a title so its last word carries the accent colour. */
export function AccentTitle({ title }: { title: string }) {
  const i = title.lastIndexOf(' ');
  if (i < 0) return <h1><em>{title}</em></h1>;
  return (
    <h1>
      <span className="nw">{title.slice(0, i)}</span> <em>{title.slice(i + 1)}</em>
    </h1>
  );
}
