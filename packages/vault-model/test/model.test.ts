import { describe, expect, it } from 'vitest';
import * as M from '../src';

const R1 = '0x1111111111111111111111111111111111111111';
const R2 = '0x2222222222222222222222222222222222222222';
const FEE_TO = '0x5e1a700000000000000000000000000000000001';
const Z = M.ZERO_ADDRESS;
const E = (x: string) => {
  const r = M.parseUnits(x, 18);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const ok = (r: M.Result) => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.state;
};
const code = (r: M.Result) => (r.ok ? 'OK' : r.code);
const adv = (s: M.DemoState, sec: number) => ok(M.advanceClock(s, sec));

const tx = (amount: bigint, route: M.Route = 'protected', extra: Partial<M.TransferParams> = {}): M.TransferParams => ({
  route,
  asset: 'ETH',
  recipient: R1,
  amount,
  feeWei: 0n,
  feeRecipient: Z,
  ...extra,
});
const protectedPay = (s: M.DemoState, p: M.TransferParams) => M.submitTransfer(s, p, M.pairApprovals(s, 'transfer', M.transferParamsHash(p)));
const fastPay = (s: M.DemoState, p: M.TransferParams) => M.submitTransfer(s, p, [M.makeApproval(s, s.vault!.P, 'transfer', M.transferParamsHash(p))]);
const setPolicy = (s: M.DemoState, p: M.Policy) => M.updatePolicy(s, p, M.pairApprovals(s, 'updatePolicy', M.policyHash(p)));

/** Whitepaper section 08 example: seven-day ETH allowance, 0.10 ETH remaining, 0.05 ETH per-action cap. */
function flexible(s = M.fundedFixture()) {
  const p = M.grantPolicy(s.vault!, s.clock, { asset: 'ETH', amount: E('0.10'), perActionCap: E('0.05'), days: 7, recipients: [R1], maxFastFeeWei: E('0.001'), feeRecipients: [FEE_TO] });
  return ok(setPolicy(s, p));
}
function withDelay(d: number, s = M.fundedFixture()) {
  return ok(setPolicy(s, { ...s.vault!.policy, protectedDelay: d }));
}

describe('setup (section 06, Appendix B/E)', () => {
  it('five distinct activated, backed-up keys; all five consent; defaults Guarded', () => {
    let s = M.initialState();
    expect(code(M.createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G2', 'G3'] }))).toBe('KEY_NOT_READY');
    for (const k of ['P1', 'A1', 'G1', 'G2', 'G3']) s = ok(M.checkBackup(ok(M.prepareKey(s, k)), k));
    expect(code(M.createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G1', 'G3'] }))).toBe('DUPLICATE_KEYS');
    expect(code(M.createVault(s, { P: 'P1', A: 'P1', G: ['G1', 'G2', 'G3'] }))).toBe('DUPLICATE_KEYS');
    expect(code(M.createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G2', 'G3'] }, ['P1', 'A1', 'G1', 'G2']))).toBe('MISSING_CONSENT');
    expect(code(M.createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G2', 'G3'], protectedDelay: 7200 }))).toBe('BAD_DELAY');
    const v = ok(M.createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G2', 'G3'] })).vault!;
    expect(v.policy.protectedDelay).toBe(0);
    expect(v.policy.fastEnabled).toBe(false);
    expect(v.fastSuspended).toBe(false);
    expect([v.authorityEpoch, v.policyEpoch, v.executionEpoch]).toEqual([1, 1, 1]);
    expect(Object.values(v.nonces)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('protected route (sections 07, 09, 10)', () => {
  it('Guarded: P alone refused, ordinary key refused, P+A executes immediately with delay 0', () => {
    const s = M.fundedFixture();
    const p = tx(E('0.5'));
    expect(code(M.submitTransfer(s, p, [M.makeApproval(s, 'P1', 'transfer', M.transferParamsHash(p))]))).toBe('APPROVER_REQUIRED');
    expect(code(M.submitTransfer(s, p, [M.makeApproval(s, 'ORDINARY_WALLET', 'transfer', M.transferParamsHash(p))]))).toBe('ORDINARY_KEY');
    expect(code(M.submitTransfer(s, p, [M.makeApproval(s, 'A1', 'transfer', M.transferParamsHash(p))]))).toBe('PRIMARY_REQUIRED');
    const a = M.makeApproval(s, 'P1', 'transfer', M.transferParamsHash(p));
    expect(code(M.submitTransfer(s, p, [a, a]))).toBe('DUPLICATE_SIGNER');
    const s2 = ok(protectedPay(s, p));
    expect(s2.vault!.balances.ETH).toBe(E('1.5'));
    expect(s2.queue.length).toBe(0);
  });
  it('FAST route with P only while FAST disabled is refused (no fallback)', () => {
    const s = M.fundedFixture();
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('FAST_DISABLED');
  });
  it('replay and changed parameters are refused', () => {
    const s = M.fundedFixture();
    const p = tx(E('0.1'));
    const ap = M.pairApprovals(s, 'transfer', M.transferParamsHash(p));
    const s2 = ok(M.submitTransfer(s, p, ap));
    expect(M.submitTransfer(s2, p, ap).ok).toBe(false);
    expect(code(M.submitTransfer(s, tx(E('0.2')), ap))).toBe('PARAMS_CHANGED');
  });
  it('acceptance window: validUntil exclusive, at most 1,800 s', () => {
    const s = M.fundedFixture();
    const p = tx(E('0.1'));
    const ap = M.pairApprovals(s, 'transfer', M.transferParamsHash(p));
    expect(code(M.submitTransfer(adv(s, 1799), p, ap))).toBe('OK');
    expect(code(M.submitTransfer(adv(s, 1800), p, ap))).toBe('ACCEPTANCE_EXPIRED');
    const long = [M.makeApproval(s, 'P1', 'transfer', M.transferParamsHash(p), { validFor: 1801 }), M.makeApproval(s, 'A1', 'transfer', M.transferParamsHash(p), { validFor: 1801 })];
    expect(code(M.submitTransfer(s, p, long))).toBe('BAD_INTERVAL');
  });
  it('atomic failure moves nothing and consumes no nonce', () => {
    const s = M.fundedFixture();
    const p = tx(E('0.1'));
    const r = M.submitTransfer(s, p, M.pairApprovals(s, 'transfer', M.transferParamsHash(p)), { forceTransferFailure: true });
    expect(r.ok).toBe(false);
    expect(r.state.vault!.balances.ETH).toBe(E('2'));
    expect(r.state.vault!.nonces.spend).toBe(0);
    expect(code(protectedPay(s, tx(E('3'))))).toBe('INSUFFICIENT');
  });
  it('recipient cannot be zero; zero fee needs zero fee recipient', () => {
    const s = M.fundedFixture();
    expect(code(protectedPay(s, tx(E('0.1'), 'protected', { recipient: Z })))).toBe('BAD_PARAMS');
    expect(code(protectedPay(s, tx(E('0.1'), 'protected', { feeRecipient: FEE_TO })))).toBe('BAD_PARAMS');
    expect(code(protectedPay(s, tx(E('0.1'), 'protected', { feeWei: 1n })))).toBe('BAD_PARAMS');
  });
});

describe('optional timelock (section 10)', () => {
  it('delay 24 h: P+A queue an entry; exact executable/expiry boundaries', () => {
    let s = withDelay(86_400);
    s = ok(protectedPay(s, tx(E('0.3'))));
    expect(s.vault!.balances.ETH).toBe(E('2'));
    const w = s.queue[0]!;
    expect(w.executableAt - w.acceptedAt).toBe(86_400);
    expect(w.expiresAt - w.executableAt).toBe(604_800);
    expect(code(M.executeWithdrawal(adv(s, 86_399), w.id))).toBe('TOO_EARLY');
    expect(code(M.executeWithdrawal(adv(s, 86_400), w.id))).toBe('OK');
    expect(code(M.executeWithdrawal(adv(s, 86_400 + 604_799), w.id))).toBe('OK');
    expect(code(M.executeWithdrawal(adv(s, 86_400 + 604_800), w.id))).toBe('EXPIRED');
  });
  it('only 0, 1 h, 24 h, 72 h are allowed', () => {
    const s = M.fundedFixture();
    expect(code(setPolicy(s, { ...s.vault!.policy, protectedDelay: 7_200 }))).toBe('BAD_POLICY');
    for (const d of [3_600, 86_400, 259_200]) expect(withDelay(d).vault!.policy.protectedDelay).toBe(d);
  });
  it('P or A can cancel on its own safety lane; executed cannot be cancelled', () => {
    let s = ok(protectedPay(withDelay(3_600), tx(E('0.1'))));
    const id = s.queue[0]!.id;
    const byA = M.cancelWithdrawal(s, id, M.makeApproval(s, 'A1', 'cancel', M.idParamsHash('cancel', id)));
    expect(byA.ok).toBe(true);
    expect(byA.state.vault!.nonces.aSafety).toBe(1);
    expect(byA.state.vault!.nonces.pSafety).toBe(0);
    expect(code(M.executeWithdrawal(adv(byA.state, 3_600), id))).toBe('CANCELLED');
    s = adv(s, 3_600);
    const ex = ok(M.executeWithdrawal(s, id));
    expect(code(M.cancelWithdrawal(ex, id, M.makeApproval(ex, 'P1', 'cancel', M.idParamsHash('cancel', id))))).toBe('ALREADY_EXECUTED');
  });
  it('32 live entries per epoch, the 33rd refused; expired entries free a slot', () => {
    let s = withDelay(3_600);
    for (let i = 1; i <= 32; i++) s = ok(protectedPay(s, tx(BigInt(i))));
    expect(code(protectedPay(s, tx(33n)))).toBe('QUEUE_FULL');
    s = adv(s, 3_600 + 604_800);
    expect(code(protectedPay(s, tx(34n)))).toBe('OK');
  });
  it('invalidation by A voids queued entries and approvals; lifetime FAST debit unchanged', () => {
    let s = ok(protectedPay(withDelay(3_600, flexible()), tx(E('0.1'))));
    const before = s.vault!.spent.ETH;
    const id = s.queue[0]!.id;
    s = ok(M.invalidateSpending(s, M.makeApproval(s, 'A1', 'invalidate', M.epochParamsHash('invalidate', s.vault!.executionEpoch))));
    expect(code(M.executeWithdrawal(adv(s, 3_600), id))).toBe('INVALIDATED');
    expect(s.vault!.spent.ETH).toBe(before);
  });
});

describe('FAST allowance accounting (section 08, Appendix D)', () => {
  it('whitepaper example: 0.041 + 0.041 leaves 0.018; a further 0.02 is rejected regardless of time', () => {
    let s = flexible();
    const pay = tx(E('0.04'), 'fast', { feeWei: E('0.001'), feeRecipient: FEE_TO });
    s = ok(fastPay(s, pay));
    s = ok(fastPay(s, pay));
    expect(M.available(s.vault!, 'ETH')).toBe(E('0.018'));
    expect(code(fastPay(s, tx(E('0.02'), 'fast')))).toBe('ALLOWANCE_EXCEEDED');
    expect(code(fastPay(adv(s, 86_400), tx(E('0.02'), 'fast')))).toBe('ALLOWANCE_EXCEEDED');
  });
  it('split theft: tiny sends against 0.10 ETH stop at 0.10 total', () => {
    let s = flexible();
    let total = 0n;
    for (let i = 0; i < 40; i++) {
      const r = fastPay(s, tx(E('0.004'), 'fast'));
      if (!r.ok) break;
      s = r.state;
      total += E('0.004');
    }
    expect(total).toBeLessThanOrEqual(E('0.10'));
    expect(s.vault!.spent.ETH).toBe(total);
  });
  it('no refill: waiting, deposits and returning ETH do not restore authority', () => {
    let s = flexible();
    s = ok(fastPay(s, tx(E('0.05'), 'fast')));
    s = ok(fastPay(s, tx(E('0.05'), 'fast')));
    expect(M.available(s.vault!, 'ETH')).toBe(0n);
    s = ok(M.deposit(adv(s, 86_400), 'ETH', E('1')));
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('ALLOWANCE_EXCEEDED');
  });
  it('per-action cap, approved recipients, expiry, fee cap and fee recipient', () => {
    const s = flexible();
    expect(code(fastPay(s, tx(E('0.06'), 'fast')))).toBe('PER_ACTION_CAP');
    expect(code(fastPay(s, tx(E('0.01'), 'fast', { recipient: R2 })))).toBe('RECIPIENT_NOT_APPROVED');
    expect(code(fastPay(adv(s, 7 * 86_400), tx(E('0.01'), 'fast')))).toBe('ALLOWANCE_EXPIRED');
    expect(code(fastPay(s, tx(E('0.01'), 'fast', { feeWei: E('0.002'), feeRecipient: FEE_TO })))).toBe('FEE_CAP');
    expect(code(fastPay(s, tx(E('0.01'), 'fast', { feeWei: E('0.0005'), feeRecipient: R2 })))).toBe('FEE_RECIPIENT_NOT_APPROVED');
    expect(code(M.submitTransfer(s, tx(E('0.01'), 'fast'), [M.makeApproval(s, 'A1', 'transfer', M.transferParamsHash(tx(E('0.01'), 'fast')))]))).toBe('WRONG_ROLE');
  });
  it('above-budget primary-only request with a long delay but no A is still rejected', () => {
    const s = withDelay(86_400, flexible());
    const p = tx(E('1'));
    expect(code(M.submitTransfer(s, p, [M.makeApproval(s, 'P1', 'transfer', M.transferParamsHash(p))]))).toBe('APPROVER_REQUIRED');
  });
  it('a protected payment does not refill the allowance; FAST stays immediate under a timelock', () => {
    let s = withDelay(86_400, flexible());
    s = ok(fastPay(s, tx(E('0.05'), 'fast')));
    expect(s.queue.length).toBe(0);
    const before = M.available(s.vault!, 'ETH');
    s = ok(protectedPay(s, tx(E('0.5'))));
    expect(M.available(s.vault!, 'ETH')).toBe(before);
  });
  it('a renewal sets the ceiling to spent + B and never below lifetime debit', () => {
    let s = flexible();
    s = ok(fastPay(s, tx(E('0.05'), 'fast')));
    const v = s.vault!;
    const bad = { ...v.policy, rules: { ETH: { ...v.policy.rules.ETH!, ceiling: E('0.01') } } };
    expect(code(setPolicy(s, bad))).toBe('BAD_POLICY');
    s = ok(setPolicy(s, M.grantPolicy(v, s.clock, { asset: 'ETH', amount: E('0.2'), perActionCap: E('0.05'), days: 30, recipients: [R1] })));
    expect(M.available(s.vault!, 'ETH')).toBe(E('0.2'));
    expect(code(setPolicy(s, M.grantPolicy(s.vault!, s.clock, { asset: 'ETH', amount: E('0.1'), perActionCap: E('0.05'), days: 31, recipients: [R1] })))).toBe('BAD_POLICY');
  });
  it('a grant needs both spending keys', () => {
    const s = M.fundedFixture();
    const p = M.grantPolicy(s.vault!, s.clock, { asset: 'ETH', amount: E('1'), perActionCap: E('1'), days: 7, recipients: [R1] });
    expect(code(M.updatePolicy(s, p, [M.makeApproval(s, 'P1', 'updatePolicy', M.policyHash(p))]))).toBe('APPROVER_REQUIRED');
  });
  it('suspension is sticky until a joint resume', () => {
    let s = flexible();
    s = ok(M.suspendFast(s, M.makeApproval(s, 'A1', 'suspendFast', M.epochParamsHash('suspend', s.vault!.executionEpoch))));
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('FAST_SUSPENDED');
    s = ok(M.deposit(s, 'ETH', 1n));
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('FAST_SUSPENDED');
    s = ok(setPolicy(s, { ...s.vault!.policy, resumeFast: true }));
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('OK');
  });
});

describe('administration under the current delay (section 11, Appendix D)', () => {
  it('lowering an elected 24 h delay to zero cannot activate before 24 h; outflows frozen meanwhile', () => {
    let s = withDelay(86_400);
    s = ok(setPolicy(s, { ...s.vault!.policy, protectedDelay: 0 }));
    expect(s.vault!.status).toBe('pending');
    expect(s.vault!.policy.protectedDelay).toBe(86_400);
    expect(code(protectedPay(s, tx(E('0.1'))))).toBe('FROZEN');
    expect(code(M.finalizeSecurityChange(adv(s, 86_399)))).toBe('TOO_EARLY');
    const f = ok(M.finalizeSecurityChange(adv(s, 86_400)));
    expect(f.vault!.policy.protectedDelay).toBe(0);
    expect(f.vault!.status).toBe('active');
  });
  it('P+A cancel an admin proposal; expiry at +7 days restores the old configuration', () => {
    let s = withDelay(3_600);
    s = ok(setPolicy(s, { ...s.vault!.policy, protectedDelay: 0 }));
    const p = s.proposal!;
    const c = ok(M.cancelAdminChange(s, M.pairApprovals(s, 'cancelAdmin', M.idParamsHash('cancel-admin', p.id))));
    expect(c.vault!.policy.protectedDelay).toBe(3_600);
    expect(code(M.expireSecurityChange(adv(s, 3_600 + 604_799)))).toBe('NOT_EXPIRED');
    expect(code(M.finalizeSecurityChange(adv(s, 3_600 + 604_800)))).toBe('EXPIRED');
    const e = ok(M.expireSecurityChange(adv(s, 3_600 + 604_800)));
    expect(e.vault!.policy.protectedDelay).toBe(3_600);
  });
  it('spending-key rotation: needs P+A, consent, distinct roles; swap is invalid', () => {
    const s = M.fundedFixture();
    const pa = (k: [string, string]) => M.pairApprovals(s, 'replaceSpendingKeys', M.keysParamsHash(k));
    expect(code(M.replaceSpendingKeys(s, 'A1', 'P1', pa(['A1', 'P1'])))).toBe('SWAP_NOT_ROTATION');
    expect(code(M.replaceSpendingKeys(s, 'P1', 'G1', pa(['P1', 'G1'])))).toBe('KEY_CONFLICT');
    expect(code(M.replaceSpendingKeys(s, 'P1', 'N1', pa(['P1', 'N1']), []))).toBe('MISSING_CONSENT');
    expect(code(M.replaceSpendingKeys(s, 'P1', 'N1', [M.makeApproval(s, 'P1', 'replaceSpendingKeys', M.keysParamsHash(['P1', 'N1']))]))).toBe('APPROVER_REQUIRED');
    const r = ok(M.replaceSpendingKeys(s, 'P1', 'N1', pa(['P1', 'N1'])));
    expect(r.vault!.A).toBe('N1');
    expect(r.vault!.authorityEpoch).toBe(2);
  });
});

describe('recovery (section 12, Appendix D)', () => {
  const recover = (s: M.DemoState, pair: [string, string], gs: string[]) =>
    M.startRecovery(s, pair, gs.map((g) => M.makeApproval(s, g, 'startRecovery', M.keysParamsHash(pair))));

  it('two distinct guardians; spending keys are not guardians; new pair distinct from all five', () => {
    const s = M.fundedFixture();
    expect(code(recover(s, ['N1', 'N2'], ['G1']))).toBe('INSUFFICIENT_SIGNERS');
    expect(code(recover(s, ['N1', 'N2'], ['G1', 'G1']))).toBe('DUPLICATE_SIGNER');
    expect(code(recover(s, ['N1', 'N2'], ['P1', 'G1']))).toBe('SPENDING_KEY_NOT_GUARDIAN');
    expect(code(recover(s, ['N1', 'G3'], ['G1', 'G2']))).toBe('KEY_CONFLICT');
    expect(code(recover(s, ['N1', 'N1'], ['G1', 'G2']))).toBe('DUPLICATE_KEYS');
  });
  it('start freezes at once, suspends FAST, voids the queue; day 7 / day 14 bounds; no funds move', () => {
    let s = ok(protectedPay(withDelay(3_600, flexible()), tx(E('0.1'))));
    const old = s.queue[0]!.id;
    const bal = s.vault!.balances.ETH;
    s = ok(recover(s, ['N1', 'N2'], ['G1', 'G2']));
    expect(s.vault!.status).toBe('pending');
    expect(s.vault!.fastSuspended).toBe(true);
    expect(code(fastPay(s, tx(E('0.01'), 'fast')))).toBe('FROZEN');
    expect(code(M.executeWithdrawal(adv(s, 3_600), old))).toBe('FROZEN');
    expect(code(M.finalizeSecurityChange(adv(s, 604_799)))).toBe('TOO_EARLY');
    const f = ok(M.finalizeSecurityChange(adv(s, 604_800)));
    expect([f.vault!.P, f.vault!.A]).toEqual(['N1', 'N2']);
    expect(f.vault!.policy.fastEnabled).toBe(false);
    expect(f.vault!.policy.protectedDelay).toBe(3_600);
    expect(f.vault!.balances.ETH).toBe(bal);
    expect(f.vault!.spent.ETH).toBe(s.vault!.spent.ETH);
    expect(code(M.executeWithdrawal(f, old))).toBe('INVALIDATED');
    expect(code(M.finalizeSecurityChange(adv(s, 1_209_600)))).toBe('EXPIRED');
  });
  it('P and A cannot veto; two guardians cancel and FAST stays suspended; expiry keeps old requests invalid', () => {
    let s = flexible();
    s = ok(recover(s, ['N1', 'N2'], ['G1', 'G2']));
    const p = s.proposal!;
    const h = M.idParamsHash('cancel-recovery', p.id);
    expect(code(M.cancelRecoveryChange(s, [M.makeApproval(s, 'P1', 'cancelRecovery', h), M.makeApproval(s, 'A1', 'cancelRecovery', h)]))).toBe('SPENDING_KEYS_CANNOT_VETO');
    const c = ok(M.cancelRecoveryChange(s, [M.makeApproval(s, 'G2', 'cancelRecovery', h), M.makeApproval(s, 'G3', 'cancelRecovery', h)]));
    expect(c.vault!.status).toBe('active');
    expect(c.vault!.fastSuspended).toBe(true);
    const e = ok(M.expireSecurityChange(adv(s, 1_209_600)));
    expect(e.vault!.P).toBe('P1');
  });
  it('recovery approvals survive spending-side epoch churn; recovery preempts an admin proposal', () => {
    let s = withDelay(86_400);
    const pair: [string, string] = ['N1', 'N2'];
    const ap = ['G1', 'G2'].map((g) => M.makeApproval(s, g, 'startRecovery', M.keysParamsHash(pair)));
    s = ok(M.invalidateSpending(s, M.makeApproval(s, 'P1', 'invalidate', M.epochParamsHash('invalidate', s.vault!.executionEpoch))));
    s = ok(setPolicy(s, { ...s.vault!.policy, protectedDelay: 0 }));
    expect(s.proposal!.kind).toBe('policy');
    const r = ok(M.startRecovery(s, pair, ap));
    expect(r.proposal!.kind).toBe('recovery');
    expect(code(recover(r, ['N3', 'N4'], ['G1', 'G3']))).toBe('PROPOSAL_EXISTS');
  });
  it('guardian replacement: P + A + two guardians + consents, fixed 7 days, only guardians cancel', () => {
    const s = M.fundedFixture();
    const g: [string, string, string] = ['G1', 'N3', 'N4'];
    const h = M.keysParamsHash(g);
    const ap = (ks: string[]) => ks.map((k) => M.makeApproval(s, k, 'replaceGuardians', h));
    expect(code(M.replaceGuardians(s, g, ap(['G1', 'G2'])))).toBe('PAIR_REQUIRED');
    expect(code(M.replaceGuardians(s, g, ap(['P1', 'A1', 'G1'])))).toBe('INSUFFICIENT_SIGNERS');
    expect(code(M.replaceGuardians(s, ['G1', 'N3', 'P1'], ['P1', 'A1', 'G1', 'G2'].map((k) => M.makeApproval(s, k, 'replaceGuardians', M.keysParamsHash(['G1', 'N3', 'P1'])))))).toBe('KEY_CONFLICT');
    const r = ok(M.replaceGuardians(s, g, ap(['P1', 'A1', 'G1', 'G2'])));
    expect(r.proposal!.executableAt - r.proposal!.startedAt).toBe(604_800);
    const f = ok(M.finalizeSecurityChange(adv(r, 604_800)));
    expect(f.vault!.G).toEqual(g);
  });
});

describe('authority inspector', () => {
  it('matches the role table', () => {
    const s = M.fundedFixture();
    expect(M.inspect(s, 'primary', 'protectedTransfer').allowed).toBe(false);
    expect(M.inspect(s, 'approver', 'protectedTransfer').allowed).toBe(false);
    expect(M.inspect(s, 'pair', 'protectedTransfer').allowed).toBe(true);
    expect(M.inspect(s, 'primary', 'grantAllowance').allowed).toBe(false);
    expect(M.inspect(s, 'approver', 'suspendFast').allowed).toBe(true);
    expect(M.inspect(s, 'pair', 'cancelRecovery').allowed).toBe(false);
    expect(M.inspect(s, 'guardians', 'startRecovery').allowed).toBe(true);
    expect(M.inspect(s, 'guardians', 'protectedTransfer').allowed).toBe(false);
    for (const a of ['skipDelay', 'resetKeys', 'upgradeRules', 'pauseAll'] as const) expect(M.inspect(s, 'pair', a).allowed).toBe(false);
    for (const a of ['protectedTransfer', 'grantAllowance', 'resetKeys'] as const) expect(M.inspect(s, 'operator', a).allowed).toBe(false);
    expect(M.inspect(s, 'primary', 'fastWithin').allowed).toBe(false);
    expect(M.inspect(flexible(), 'primary', 'fastWithin').allowed).toBe(true);
  });
});

describe('units', () => {
  it('rejects excess precision and bad recipients', () => {
    expect(M.parseAssetAmount('0.0000000000000000001', 'ETH').ok).toBe(false);
    expect(M.parseAssetAmount('1.1234567', 'USDG').ok).toBe(false);
    expect(M.validateRecipient(Z)).toBeTruthy();
    expect(M.validateRecipient('0x123')).toBeTruthy();
  });
});
