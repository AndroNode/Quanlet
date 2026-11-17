import { Navigate, useSearchParams } from 'react-router-dom';
import Testnet from './Testnet';
import { IS_MAINNET } from '../net';

/** /testnet?v=1 keeps vaults made with the 1.0 contracts usable; everything else lives in the vault pages. */
export default function TestnetRoute() {
  const [q] = useSearchParams();
  // A mainnet build serves no testnet pages: its /api/rpc reads mainnet.
  return !IS_MAINNET && q.get('v') === '1' ? <Testnet /> : <Navigate to="/vault" replace />;
}
