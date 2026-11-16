#!/usr/bin/env python3
"""Builds test/acvp/mldsa44-sigver.json from NIST's ACVP sigVer vectors.

Usage: python3 -I test/acvp/convert.py <internalProjection.json> > test/acvp/mldsa44-sigver.json

Input: usnistgov/ACVP-Server gen-val/json-files/ML-DSA-sigVer-FIPS204/internalProjection.json
For each ML-DSA-44 case it writes `data`, the input the verifier core hashes with tr:
  external pure     M' = 0x00 || len(ctx) || ctx || M                (FIPS 204 Alg. 2)
  external preHash  M' = 0x01 || len(ctx) || ctx || OID || PH(M)     (FIPS 204 Alg. 4)
  internal          M' as given                                       (FIPS 204 Alg. 8)
  internal + mu     mu as given (64 bytes)
"""
import hashlib, json, sys

OID_LAST = {'SHA2-256': 1, 'SHA2-384': 2, 'SHA2-512': 3, 'SHA2-224': 4, 'SHA2-512/224': 5, 'SHA2-512/256': 6,
            'SHA3-224': 7, 'SHA3-256': 8, 'SHA3-384': 9, 'SHA3-512': 10, 'SHAKE-128': 11, 'SHAKE-256': 12}
HASH = {'SHA2-256': lambda m: hashlib.sha256(m).digest(), 'SHA2-384': lambda m: hashlib.sha384(m).digest(),
        'SHA2-512': lambda m: hashlib.sha512(m).digest(), 'SHA2-224': lambda m: hashlib.sha224(m).digest(),
        'SHA2-512/224': lambda m: hashlib.new('sha512_224', m).digest(),
        'SHA2-512/256': lambda m: hashlib.new('sha512_256', m).digest(),
        'SHA3-224': lambda m: hashlib.sha3_224(m).digest(), 'SHA3-256': lambda m: hashlib.sha3_256(m).digest(),
        'SHA3-384': lambda m: hashlib.sha3_384(m).digest(), 'SHA3-512': lambda m: hashlib.sha3_512(m).digest(),
        'SHAKE-128': lambda m: hashlib.shake_128(m).digest(32), 'SHAKE-256': lambda m: hashlib.shake_256(m).digest(64)}


def main(path):
    src = open(path, 'rb').read()
    d = json.loads(src)
    out = []
    for g in d['testGroups']:
        if g['parameterSet'] != 'ML-DSA-44':
            continue
        for t in g['tests']:
            e = {'tcId': t['tcId'], 'tgId': g['tgId'], 'expected': t['testPassed'], 'reason': t['reason'],
                 'pk': '0x' + t['pk'].lower(), 'sig': '0x' + t['signature'].lower(),
                 'isMu': False, 'direct': False, 'message': '0x'}
            if g['signatureInterface'] == 'internal':
                if g['externalMu']:
                    e['isMu'] = True
                    e['data'] = '0x' + t['mu'].lower()
                else:
                    e['data'] = '0x' + t['message'].lower()
            else:
                m, ctx = bytes.fromhex(t['message']), bytes.fromhex(t['context'])
                if g['preHash'] == 'pure':
                    mp = bytes([0, len(ctx)]) + ctx + m
                    if not ctx:  # the production verifier can take this case unchanged
                        e['direct'] = True
                        e['message'] = '0x' + m.hex()
                else:
                    oid = bytes.fromhex('06096086480165030402') + bytes([OID_LAST[t['hashAlg']]])
                    mp = bytes([1, len(ctx)]) + ctx + oid + HASH[t['hashAlg']](m)
                e['data'] = '0x' + mp.hex()
            out.append(e)
    doc = {'source': 'https://github.com/usnistgov/ACVP-Server/tree/master/gen-val/json-files/ML-DSA-sigVer-FIPS204 (internalProjection.json)',
           'sourceSha256': hashlib.sha256(src).hexdigest(), 'vsId': d['vsId'],
           'note': 'ML-DSA-44 entries only. data = the M prime of FIPS 204 Algorithm 2/5 (or mu for externalMu tests), '
                   'built from message, context and pre-hash as FIPS 204 Algorithm 3 and 5 specify.',
           'count': len(out), 'tests': out}
    json.dump(doc, sys.stdout, indent=1)


if __name__ == '__main__':
    main(sys.argv[1])
