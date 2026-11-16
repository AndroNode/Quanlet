// Shared command-line plumbing for the toolkit: arguments, files, passwords, confirmation and RPC clients.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createPublicClient, http } from 'viem';
import { ACCEPTANCE_MAX, DEFAULT_CHAIN, RPC } from './protocol.mjs';


export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export const out = (s = '') => process.stdout.write(s + '\n');
export const fail = (m) => {
  process.stderr.write(`quanlet: ${m}\n`);
  process.exit(1);
};
export const readJson = (p, what) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`cannot read ${what} ${p}: ${e.message}`);
  }
};
export function writeJson(path, obj, force) {
  const text = JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
  if (!path) return out(text.trimEnd());
  if (existsSync(path) && !force) fail(`${path} exists. Pass --force to overwrite.`);
  writeFileSync(path, text, { mode: 0o600 });
  out(`wrote ${path}`);
}

export function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(a);
    });
  });
}

export async function password(opt, confirm = false) {
  if (opt['password-env']) {
    const v = process.env[opt['password-env']];
    if (!v) fail(`environment variable ${opt['password-env']} is empty`);
    return v;
  }
  if (!process.stdin.isTTY) fail('no terminal to ask for the password. Use --password-env NAME.');
  const p = await ask('Key file password: ', true);
  if (confirm && (await ask('Repeat the password: ', true)) !== p) fail('the passwords differ');
  return p;
}

export async function confirmOrExit(opt) {
  if (opt.yes) return;
  if (!process.stdin.isTTY) fail('refusing to sign without confirmation. Re-run in a terminal, or pass --yes after checking the summary.');
  const a = await ask('Type "sign" to sign exactly this: ');
  if (a.trim() !== 'sign') fail('not signed');
}

export function client(opt, chainId) {
  const url = opt.rpc ?? process.env.QUANLET_RPC ?? RPC[chainId];
  if (!url) fail(`no RPC for chain ${chainId}. Pass --rpc URL.`);
  return createPublicClient({ transport: http(url, { timeout: 30_000 }) });
}

export async function checkChain(pc, chainId) {
  const id = await pc.getChainId();
  if (id !== chainId) fail(`the RPC is on chain ${id}, not ${chainId}`);
}

export const chainOf = (opt) => Number(opt.chain ?? DEFAULT_CHAIN);
export const rd = (pc, address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });

export async function window(pc, opt) {
  const now = opt['valid-after'] ? Number(opt['valid-after']) : Number((await pc.getBlock()).timestamp) - 30;
  const len = Number(opt['valid-for'] ?? ACCEPTANCE_MAX);
  if (!(len > 0 && len <= ACCEPTANCE_MAX)) fail(`--valid-for must be 1..${ACCEPTANCE_MAX} seconds`);
  return { validAfter: now, validUntil: now + len };
}

export const when = (t) => `${new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z')} (${t})`;
export const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

