/**
 * Authority inspector: who may do what under protocol 2.0 (whitepaper sections 04, 07-12, Appendix A).
 * Pure explanation; it never changes state.
 */
import { delayLabel } from './constants';
import { available, fastState, type DemoState } from './model';
import { formatUnits } from './units';

export type Actor = 'primary' | 'approver' | 'pair' | 'guardians' | 'operator' | 'submitter' | 'ordinaryWallet';
export type InspectAction =
  | 'protectedTransfer'
  | 'fastWithin'
  | 'fastAbove'
  | 'grantAllowance'
  | 'changeDelay'
  | 'cancelQueued'
  | 'invalidate'
  | 'suspendFast'
  | 'rotateSpendingKeys'
  | 'startRecovery'
  | 'cancelRecovery'
  | 'replaceGuardians'
  | 'execute'
  | 'finalize'
  | 'skipDelay'
  | 'resetKeys'
  | 'upgradeRules'
  | 'pauseAll';

export const ACTORS: Record<Actor, string> = {
  primary: 'Primary key (P) alone',
  approver: 'Independent approver (A) alone',
  pair: 'Primary + approver together',
  guardians: 'Two of three guardians',
  operator: 'Quanlet operator',
  submitter: 'Any transaction submitter',
  ordinaryWallet: 'Ordinary wallet key',
};

export const INSPECT_ACTIONS: Record<InspectAction, string> = {
  protectedTransfer: 'Send a protected payment (any amount, new destination)',
  fastWithin: 'Send a FAST payment inside the allowance',
  fastAbove: 'Send a FAST payment above the allowance',
  grantAllowance: 'Grant, renew or raise a FAST allowance',
  changeDelay: 'Change the protected timelock',
  cancelQueued: 'Cancel a queued withdrawal',
  invalidate: 'Invalidate all spending approvals',
  suspendFast: 'Suspend FAST payments',
  rotateSpendingKeys: 'Replace a spending key',
  startRecovery: 'Start recovery of the spending pair',
  cancelRecovery: 'Cancel a recovery or guardian proposal',
  replaceGuardians: 'Replace the guardian set',
  execute: 'Execute a mature delayed withdrawal',
  finalize: 'Finalize or expire an eligible proposal',
  skipDelay: 'Skip an elected timelock',
  resetKeys: 'Reset keys outside the rules',
  upgradeRules: 'Change or upgrade vault code',
  pauseAll: 'Pause every vault',
};

export interface Verdict {
  allowed: boolean;
  why: string;
  prerequisites: string[];
}

const NO = (why: string): Verdict => ({ allowed: false, why, prerequisites: [] });
const YES = (why: string, ...p: Array<string | false | undefined>): Verdict => ({ allowed: true, why, prerequisites: p.filter(Boolean) as string[] });

export function inspect(state: DemoState, actor: Actor, action: InspectAction): Verdict {
  const v = state.vault;
  const pending = v?.status === 'pending';
  const delay = v?.policy.protectedDelay ?? 0;
  const fast = v ? fastState(v) : 'disabled';
  const frozen = pending ? 'A security proposal is pending; every outflow is blocked until it resolves.' : undefined;

  // Things nobody can do.
  if (action === 'skipDelay') return NO('An elected delay applies to every protected payment and cannot be waived per transaction, even by P and A together. Lowering it waits out the current delay first.');
  if (action === 'upgradeRules') return NO('Vault code, verifier, asset set and signature thresholds are immutable. New features need a separately deployed vault and an owner-authorized migration.');
  if (action === 'pauseAll') return NO('There is no global pause. Hosted services can stop; onchain vault rights do not change.');
  if (action === 'resetKeys') return NO('There is no platform reset key, support reset or weaker path. Keys change only through joint rotation or guardian recovery.');

  // Anyone, on already authorized state.
  if (action === 'execute') {
    if (actor === 'ordinaryWallet' || actor === 'operator' || actor === 'submitter' || actor === 'primary' || actor === 'approver' || actor === 'pair' || actor === 'guardians') {
      return YES('Anyone may execute a mature delayed withdrawal. It runs only the exact signed transfer.', 'Elected delay passed and within the 7-day window', 'Current execution epoch', !pending && 'Vault active', pending && frozen, 'Enough balance for amount and fee');
    }
  }
  if (action === 'finalize') {
    return YES('Anyone may finalize a proposal inside its window, or expire it afterwards. It installs exactly what was committed.', 'Recovery and guardian changes: from day 7 until day 14', 'Delayed policy or key changes: after the current delay, within 7 days');
  }

  switch (actor) {
    case 'ordinaryWallet':
      return NO('A conventional wallet key has no authority over the vault. It can only pay gas to submit requests that the required post-quantum keys already signed.');
    case 'submitter':
      return NO('Paying gas grants no authority. A submitter relays complete signed requests and cannot change their amount, destination, fee or route.');
    case 'operator':
      return NO('The operator hosts interfaces, relays and alerts. It holds no signing role and cannot withdraw, reset keys, pause vaults or edit rules.');
    case 'primary':
      switch (action) {
        case 'fastWithin':
          return fast === 'active'
            ? YES('Inside a finite FAST allowance the primary pays alone, with no Quanlet delay.', 'Approved recipient and supported asset', 'Within the per-action cap and the remaining amount', 'Grant not expired', v ? `ETH remaining now: ${formatUnits(available(v, 'ETH'), 18)} ETH` : undefined)
            : NO(fast === 'suspended' ? 'FAST is suspended. Only a joint P + A policy request resumes it.' : 'FAST is disabled (the Guarded default). The primary alone cannot move funds.');
        case 'fastAbove':
          return NO('Above the allowance the primary alone is always refused. Waiting does not help and the allowance never refills; get the approver to co-sign, or renew with both keys.');
        case 'protectedTransfer':
          return NO('A protected payment needs the independent approver as well. The primary alone can never move the reserve.');
        case 'cancelQueued':
        case 'invalidate':
        case 'suspendFast':
          return pending ? NO(frozen!) : YES('Safety actions restrict spending; either spending key may use them alone, on its own nonce lane.', 'Fresh primary signature within 30 minutes', action === 'cancelQueued' && 'Must land before someone executes the entry');
        case 'grantAllowance':
        case 'changeDelay':
        case 'rotateSpendingKeys':
          return NO('Policy and key changes need both spending keys. The primary cannot increase its own permissions.');
        case 'startRecovery':
        case 'replaceGuardians':
          return NO(action === 'startRecovery' ? 'Recovery is started by two guardians, not by a spending key.' : 'Not alone: guardian replacement needs P, A and two current guardians.');
        case 'cancelRecovery':
          return NO('The spending keys cannot veto recovery. Otherwise a thief holding them could block every rescue.');
      }
      break;
    case 'approver':
      switch (action) {
        case 'cancelQueued':
        case 'invalidate':
        case 'suspendFast':
          return pending ? NO(frozen!) : YES('The approver can restrict spending alone, on its own safety lane: useful when the primary may be compromised.', 'Fresh approver signature within 30 minutes', action === 'cancelQueued' && 'Must land before someone executes the entry');
        case 'fastWithin':
        case 'fastAbove':
        case 'protectedTransfer':
          return NO('The approver cannot spend alone. It only co-signs protected payments with the primary.');
        case 'cancelRecovery':
          return NO('The spending keys cannot veto recovery.');
        default:
          return NO('Not alone. Administrative changes need both spending keys; recovery needs two guardians.');
      }
    case 'pair':
      switch (action) {
        case 'protectedTransfer':
          return pending
            ? NO(frozen!)
            : YES(
                delay === 0 ? 'Both keys sign the identical request; with no timelock elected it executes in the submitting transaction.' : `Both keys sign; it is queued for the elected ${delayLabel(delay)} delay, then anyone may execute it.`,
                'Distinct current P and A signatures over the same digest',
                'Current authority, policy and execution epochs and the next spend nonce',
                'Supported asset; recipient not zero and not the vault',
              );
        case 'fastWithin':
        case 'fastAbove':
          return NO('FAST is the primary-only route. With both keys, use the protected route instead.');
        case 'grantAllowance':
        case 'changeDelay':
        case 'rotateSpendingKeys':
          return pending
            ? NO(frozen!)
            : YES(
                delay === 0 ? 'Joint administration applies atomically while no timelock is elected.' : `Joint administration waits out the current ${delayLabel(delay)} delay and freezes outflows meanwhile.`,
                action === 'grantAllowance' && 'A finite amount, a per-action cap, approved recipients and at most 30 days',
                action === 'changeDelay' && 'Lowering a delay still waits the existing delay',
                action === 'rotateSpendingKeys' && 'The new key is registered, distinct from all roles, and consents',
              );
        case 'cancelQueued':
        case 'invalidate':
        case 'suspendFast':
          return pending ? NO(frozen!) : YES('Either key could do this alone; both may as well.');
        case 'replaceGuardians':
          return YES('Possible with two current guardians co-signing, plus consent from all three designated guardians.', 'Two current guardian signatures on the same action', 'Fixed 7-day delay with frozen outflows, then a 7-day window');
        case 'startRecovery':
          return NO('Recovery is the guardians’ action. The spending pair cannot start it.');
        case 'cancelRecovery':
          return NO('The current P and A cannot veto an accepted recovery.');
      }
      break;
    case 'guardians':
      switch (action) {
        case 'startRecovery':
          return state.proposal?.kind === 'recovery'
            ? NO('A recovery is already live and cannot be displaced.')
            : YES('Two distinct current guardians propose a new primary and approver. Outflows freeze and FAST is suspended at once.', 'Both new keys activated, distinct from all five roles, and consenting', 'Finalize from day 7 until day 14', state.proposal ? 'It would discard the pending administrative proposal' : undefined);
        case 'cancelRecovery':
          return state.proposal && (state.proposal.kind === 'recovery' || state.proposal.kind === 'guardians')
            ? YES('Two current guardians can cancel the exact live proposal. Old authority resumes with FAST still suspended.')
            : YES('Two current guardians can cancel a live recovery or guardian proposal.', 'A recovery or guardian proposal must be pending');
        case 'replaceGuardians':
          return NO('Not alone: replacing guardians also needs the primary and the approver.');
        case 'protectedTransfer':
        case 'fastWithin':
        case 'fastAbove':
          return NO('Guardians never transfer assets. Recovery replaces spending authority only.');
        default:
          return NO('Guardians only start, and cancel, recovery and guardian proposals.');
      }
  }
  return NO('Not permitted.');
}
