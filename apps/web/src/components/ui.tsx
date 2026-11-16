import { useEffect, useRef, type ReactNode } from 'react';
import { PageFacts, PageMark, type PageKind } from './PageMarks';

export function PageHead({
  title,
  children,
  eyebrow,
  kind,
  facts,
}: {
  title: string;
  children?: ReactNode;
  eyebrow?: ReactNode;
  kind?: PageKind;
  facts?: Array<[ReactNode, string]>;
}) {
  const wide = kind === 'how' || kind === 'testnet';
  return (
    <header className={`page-head${kind ? ` ph ph-${kind}${wide ? ' ph-wide' : ''}` : ''}`}>
      <div className="ph-copy">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children}
        {facts && <PageFacts facts={facts} />}
      </div>
      {kind && <PageMark kind={kind} />}
    </header>
  );
}

/** Accessible modal: traps focus, closes on Escape, returns focus to the opener. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button, a[href], input, select, [tabindex]:not([tabindex="-1"])') ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        <h2 id="dialog-title" style={{ fontSize: '1.4rem' }}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** The brand motif: a live ring with dashed echoes of past epochs. Steps forward when the epoch changes. */
export function EpochMark({ epoch = 0, size = 220, label }: { epoch?: number; size?: number; label?: string }) {
  return (
    <svg className="epoch" viewBox="15 15 70 70" width={size} height={size} role="img" aria-label={label ?? `Execution epoch ${epoch}`}>
      <circle className="ring" cx="40" cy="40" r="24" fill="none" stroke="var(--q-echo)" strokeWidth="1.5" strokeDasharray="2 2.5" />
      <circle className="ring" cx="47" cy="47" r="24" fill="none" stroke="var(--q-echo)" strokeWidth="2.5" strokeDasharray="3 2.5" />
      <g key={epoch} className="epoch-live">
        <circle className="ring" cx="54" cy="54" r="24" fill="none" stroke="var(--q-text)" strokeWidth="9" />
        <line x1="63.9" y1="63.9" x2="80.9" y2="80.9" stroke="var(--q-accent)" strokeWidth="9" />
      </g>
    </svg>
  );
}
