import { Navigate, useSearchParams } from 'react-router-dom';
import Testnet from './Testnet';

/** /testnet?v=1 keeps vaults made with the 1.0 contracts usable; everything else lives in the vault pages. */
export default function TestnetRoute() {
  const [q] = useSearchParams();
  return q.get('v') === '1' ? <Testnet /> : <Navigate to="/vault" replace />;
}
