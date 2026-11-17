/**
 * FR-28: every launch detail comes from this one schema.
 * Token fields and protocol deployment fields are kept apart on purpose.
 * Unknown or unverified values stay null and the UI shows the "not announced" state.
 */
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const url = z.string().url().startsWith('https://');

export const NetworkSchema = z.object({
  name: z.string(),
  chainId: z.number().int().positive(),
  rpcUrl: url,
  explorerUrl: url,
  verified: z.boolean(),
});

export const ConfigSchema = z.object({
  releaseMode: z.enum(['demo', 'testnet', 'mainnet']),
  docsVersion: z.string(),
  social: z.object({ x: url.nullable() }),
  token: z.object({
    ticker: z.string().nullable(),
    contractAddress: address.nullable(),
    network: z.string().nullable(),
    explorerUrl: url.nullable(),
    buyUrl: url.nullable(),
    chartUrl: url.nullable(),
    verified: z.boolean(),
  }),
  networks: z.object({ testnet: NetworkSchema, mainnet: NetworkSchema }),
  deployments: z.object({
    testnet: z
      .object({
        keyFactory: address,
        verifier: address,
        vaultFactory: address,
        manifestUrl: z.string(),
        /** Earlier VaultFactory deployments on the same KeyFactory: their key backup files still open. */
        compatibleVaultFactories: z.array(address).default([]),
      })
      .nullable(),
    /** Protocol 2.0 (five roles, FAST/PROTECTED routes). Lives next to the 1.x deployment on the same network. */
    testnetV2: z
      .object({
        keyFactory: address,
        verifier: address,
        vaultFactory: address,
        /** Multicall3, used to register and activate a key in one transaction. */
        multicall: address,
        manifestUrl: z.string(),
        /** Earlier VaultFactoryV2 deployments on the same KeyFactoryV2 (their vaults and key backups still open). */
        compatibleVaultFactories: z.array(address).default([]),
        /** Tokens the current factory accepts besides ETH. */
        tokens: z.array(z.object({ symbol: z.string(), name: z.string(), address, decimals: z.number().int() })).default([]),
        /** First block of the deployment: searches for past transactions start here. */
        deployedAtBlock: z.number().int().nonnegative().optional(),
      })
      .nullable()
      .default(null),
    mainnet: z
      .object({ keyFactory: address, verifier: address, vaultFactory: address, manifestUrl: z.string() })
      .nullable(),
    /** Protocol 2.0 on Robinhood Chain mainnet: null until the contracts are deployed and checked. */
    mainnetV2: z
      .object({
        keyFactory: address,
        verifier: address,
        vaultFactory: address,
        multicall: address,
        manifestUrl: z.string(),
        compatibleVaultFactories: z.array(address).default([]),
        tokens: z.array(z.object({ symbol: z.string(), name: z.string(), address, decimals: z.number().int() })).default([]),
        deployedAtBlock: z.number().int().nonnegative().optional(),
        /** The rest of the deployment, shown on the Docs page (contracts/deployments/4663.v2.json). */
        f1600Helper: address.optional(),
        vaultCodeStores: z.array(address).default([]),
        /** Day of the deployment block, YYYY-MM-DD (UTC). */
        deployedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .nullable()
      .default(null),
  }),
  assets: z.array(z.object({ symbol: z.string(), address: address.nullable(), decimals: z.number().int(), reviewed: z.boolean() })),
});

export type QuanletConfig = z.infer<typeof ConfigSchema>;

/** Safe defaults: demo mode, nothing announced, no token. Network values from docs.robinhood.com/chain/connecting (checked 5 Nov 2026). */
export const DEFAULT_CONFIG: QuanletConfig = {
  releaseMode: 'testnet',
  docsVersion: 'Whitepaper v2.0',
  social: { x: null },
  token: { ticker: null, contractAddress: null, network: null, explorerUrl: null, buyUrl: null, chartUrl: null, verified: false },
  networks: {
    testnet: {
      name: 'Robinhood Chain Testnet',
      chainId: 46630,
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
      verified: true,
    },
    mainnet: {
      name: 'Robinhood Chain',
      chainId: 4663,
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
      explorerUrl: 'https://robinhoodchain.blockscout.com',
      verified: true,
    },
  },
  // Robinhood Chain Testnet deployment (contracts/deployments/46630.json, block 149396449).
  deployments: {
    testnet: {
      keyFactory: '0x68335F07BC58F1057b59bBFb378e804eFaC7Db0d',
      verifier: '0xb968d948271dc4F0DE95E904E7f6B09AE23D780c',
      vaultFactory: '0xE8cB1b0B90142C55068af0f212030f93847049B3',
      manifestUrl: 'contracts/deployments/46630.json',
      compatibleVaultFactories: ['0x4e00144f85dcA5E49bcFf5386E49d4465fcC5399'],
    },
    // Protocol 2.0 on the same network (contracts/deployments/46630.v2.json, block 153958071).
    testnetV2: {
      keyFactory: '0x3cc65726274462e15c031956dD0560400e25Caf5',
      verifier: '0xb968d948271dc4F0DE95E904E7f6B09AE23D780c',
      // ETH plus the official faucet's test stock tokens (contracts/deployments/46630.v2.tokens.json, block 153994668).
      vaultFactory: '0x8bA8297d0ddd6DE27E127C0b1B18102805AE99bC',
      multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
      manifestUrl: 'contracts/deployments/46630.v2.tokens.json',
      deployedAtBlock: 153958071,
      compatibleVaultFactories: ['0xE8A8F2F714f06fdd83630958FD23503872549db3'],
      tokens: [
        { symbol: 'TSLA', name: 'Tesla (test)', address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', decimals: 18 },
        { symbol: 'AMZN', name: 'Amazon (test)', address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', decimals: 18 },
        { symbol: 'PLTR', name: 'Palantir (test)', address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', decimals: 18 },
        { symbol: 'NFLX', name: 'Netflix (test)', address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', decimals: 18 },
        { symbol: 'AMD', name: 'AMD (test)', address: '0x71178BAc73cBeb415514eB542a8995b82669778d', decimals: 18 },
      ],
    },
    mainnet: null,
    // mainnetV2:begin (written by cli/scripts/mainnet-config.mjs from contracts/deployments/4663.v2.json)
    mainnetV2: null,
    // mainnetV2:end
  },
  assets: [{ symbol: 'ETH', address: null, decimals: 18, reviewed: true }],
};

export function parseConfig(input: unknown): QuanletConfig {
  const r = ConfigSchema.safeParse(input);
  return r.success ? r.data : DEFAULT_CONFIG;
}

/** FR-29/30: the CA can be copied only when address, network and explorer are all set and verified. */
export function tokenState(cfg: QuanletConfig) {
  const t = cfg.token;
  const caReady = Boolean(t.verified && t.contractAddress && t.network && t.explorerUrl);
  return {
    caReady,
    label: caReady ? `CA: ${t.contractAddress!.slice(0, 6)}…${t.contractAddress!.slice(-4)}` : 'CA: Not announced',
    tooltip: caReady ? 'Copy contract address' : 'Contract address will be announced at launch',
    explorerHref: caReady ? `${t.explorerUrl!.replace(/\/$/, '')}/address/${t.contractAddress}` : null,
    buyHref: caReady && t.buyUrl ? t.buyUrl : null,
    chartHref: caReady && t.chartUrl ? t.chartUrl : null,
  };
}
