/**
 * Which network this build of the site serves. Testnet unless the build sets VITE_QUANLET_NETWORK=mainnet,
 * and the Worker that serves it must run with RELEASE_MODE = "mainnet" so /api/rpc reads the same chain.
 * A mainnet build opens vaults only once config.deployments.mainnetV2 holds the deployed contracts;
 * until then the vault pages say so and touch no chain.
 */
import { DEFAULT_CONFIG } from '@quanlet/config';

export type NetworkName = 'testnet' | 'mainnet';
export const NETWORK: NetworkName = (import.meta.env.VITE_QUANLET_NETWORK as string | undefined) === 'mainnet' ? 'mainnet' : 'testnet';
export const IS_MAINNET = NETWORK === 'mainnet';
export const NET = DEFAULT_CONFIG.networks[NETWORK];
export const DEPLOYMENT_V2 = IS_MAINNET ? DEFAULT_CONFIG.deployments.mainnetV2 : DEFAULT_CONFIG.deployments.testnetV2;
/** False on a mainnet build before the contracts are deployed: the vault pages show a notice instead. */
export const VAULTS_OPEN = !!DEPLOYMENT_V2;

/** Words that change with the network, so the copy never says testnet on mainnet or the other way round. */
export const WORDS = IS_MAINNET
  ? {
      phase: 'mainnet',
      gas: 'It pays the gas for each step. It never holds or controls your keys.',
      funds: 'Move ETH from your wallet into the vault.',
      intro: 'Set one up on Robinhood Chain in six steps.',
      keysWarning: 'Keep each backup and its password apart. Anyone with both can sign as that key.',
      chipTitle: 'Every action here is a real transaction on Robinhood Chain',
      balance: 'Balance',
      fileTag: 'mainnet',
    }
  : {
      phase: 'testnet',
      gas: 'It pays the testnet gas for each step. It never holds or controls your keys.',
      funds: 'Move testnet ETH or test tokens from your wallet into the vault.',
      intro: 'Set one up on the testnet in six steps.',
      keysWarning: 'Testnet only: never reuse these keys on mainnet.',
      chipTitle: 'Every action here is a real transaction on the testnet',
      balance: 'Testnet balance',
      fileTag: 'testnet',
    };
