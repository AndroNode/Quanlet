import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, tokenState } from '../src';

describe('config', () => {
  it('defaults publish the QUANLET contract address with an explorer link and no buy or chart links', () => {
    const t = tokenState(DEFAULT_CONFIG);
    expect(t.caReady).toBe(true);
    expect(t.label).toBe('CA: 0x62cc…5235');
    expect(t.explorerHref).toBe('https://robinhoodchain.blockscout.com/address/0x62cc5a8Ad309c306fC744d901517Fa38993a5235');
    expect(t.buyHref).toBeNull();
    expect(t.chartHref).toBeNull();
  });
  it('an unverified or missing CA shows the placeholder', () => {
    const t = tokenState({ ...DEFAULT_CONFIG, token: { ...DEFAULT_CONFIG.token, verified: false } });
    expect(t.label).toBe('CA: Not announced');
    expect(t.tooltip).toBe('Contract address will be announced at launch');
  });
  it('a verified CA enables copy and explorer link; removing it restores placeholders', () => {
    const cfg = { ...DEFAULT_CONFIG, token: { ...DEFAULT_CONFIG.token, contractAddress: '0x' + 'ab'.repeat(20), network: 'Robinhood Chain', explorerUrl: 'https://robinhoodchain.blockscout.com', verified: true } };
    const t = tokenState(cfg);
    expect(t.caReady).toBe(true);
    expect(t.explorerHref).toContain('/address/0xabab');
    expect(t.buyHref).toBeNull();
    expect(tokenState({ ...cfg, token: { ...cfg.token, contractAddress: null } }).label).toBe('CA: Not announced');
  });
  it('invalid config falls back to safe defaults', () => {
    expect(parseConfig({ releaseMode: 'yolo' })).toEqual(DEFAULT_CONFIG);
  });
});
