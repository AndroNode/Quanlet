/**
 * Point formations for the landing-page stage. Every formation is the same N points, so the stage can morph any
 * one into the next. Each point is (x, y, z, size). Coordinates are world units around the origin; a formation
 * fits a radius of about 3.6.
 *
 *   0 lattice   a hollow crystal of lattice points and edges around the vault mark (ML-DSA is lattice-based)
 *   1 curve     secp256k1, the curve every ordinary wallet key lives on, with point additions G -> public key
 *   2 quantum   that picture dissolving into an interference pattern (what a quantum computer exploits)
 *   3 roles     five key orbs on a tilted orbit, plus the gas wallet outside it
 *   4 routes    two streams out of the vault: FAST (capped gate) and PROTECTED (through a timelock ring)
 *   5 shield    a shell around the vault
 *   6 field     a sparse, distant field behind the reading sections
 *   7 mark      the Quanlet Q
 */

export const STATES = 8;

/** Q mark as one path in a 100 x 100 box (same as public/brand). */
export const Q_PATH =
  'M11.47 27.3 18.12 20.65 31.65 34.18 31.65 67.31 66.4 67.31 88.53 89.45 88.53 93 71.1 93 64.45 86.35 22.48 86.35 22.48 75.91 11.47 75.91ZM27.87 10.9 20.87 17.89 33.03 30.05 68.69 30.05 68.69 64.68 76.95 72.93 88.53 61.35 88.53 18.47 77.52 18.47 77.52 7 62.96 7 62.96 10.9Z';

/** Roles state geometry, shared with the stage for label placement. */
export const ORBIT = { radius: 3.15, tilt: 0.46 };
export const ROLE_ANGLES = [90, 162, 234, 306, 18].map((d) => (d * Math.PI) / 180); // P, A, G1, G2, G3
export const GAS_POS: [number, number, number] = [3.35, -2.8, 0.7];

/** Routes state geometry, shared with the stage for widget placement. */
export const CORE: [number, number, number] = [-3.15, 0.05, 0];
const FAST_CURVE: V[] = [[-2.75, 0.32, 0], [-1.2, 1.55, 0.2], [1.4, 1.75, 0.1], [3.95, 1.45, 0]];
const SAFE_CURVE: V[] = [[-2.75, -0.3, 0], [-1.4, -2.55, 0.5], [1.5, -2.55, 0.5], [3.95, -1.4, 0]];
export const GATE_U = 0.56;
/** The routes formation is turned this much about Y so its rings face the viewer at an angle. */
export const ROUTES_BASE = -0.42;
export const LOCK_U = 0.5;

type V = [number, number, number];

export interface Formations {
  n: number;
  states: Float32Array[]; // STATES x (n * 4)
  rnd: Float32Array; // n * 4: stagger delay, phase seed, hue, spare
  lane: Float32Array; // n: -1 none, [0,1) FAST u, [1,2) PROTECTED u   (routes state)
  group: Float32Array; // n: 0 halo, 1 P, 2 A, 3..5 G1..G3, 6 gas, 7 orbit   (roles state)
  mark: Float32Array; // n: 1 for the points that draw the Quanlet mark wherever a formation shows it
  anchors: {
    curveG: V; // generator point on the curve formation
    curvePub: V; // the public key the additions arrive at
    roles: V[]; // P, A, G1, G2, G3, gas (pre-spin positions)
    fastEnd: V;
    safeEnd: V;
    gate: V;
    lock: V;
  };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bez(c: V[], u: number): V {
  const m = 1 - u;
  const a = m * m * m, b = 3 * m * m * u, d = 3 * m * u * u, e = u * u * u;
  const [p0, p1, p2, p3] = c as [V, V, V, V];
  const at = (i: 0 | 1 | 2) => a * p0[i] + b * p1[i] + d * p2[i] + e * p3[i];
  return [at(0), at(1), at(2)];
}
function bezT(c: V[], u: number): V {
  const p = bez(c, Math.max(0, u - 0.002)), q = bez(c, Math.min(1, u + 0.002));
  const d: V = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}
function cross(a: V, b: V): V {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V): V {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Rotate about X by the orbit tilt (used for the roles ring). */
function tiltX(p: V, t = ORBIT.tilt): V {
  const c = Math.cos(t), s = Math.sin(t);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}
function rotAxis(p: V, k: V, a: number): V {
  const c = Math.cos(a), s = Math.sin(a);
  const kx = cross(k, p), d = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  const at = (i: 0 | 1 | 2) => p[i] * c + kx[i] * s + k[i] * d * (1 - c);
  return [at(0), at(1), at(2)];
}

/** Where each formation draws the mark (centre, width). Routes: at the vault core, already turned by ROUTES_BASE. */
export const MARK: Record<number, { c: V; w: number }> = {
  0: { c: [0, 0, 0], w: 2.6 },
  3: { c: [0, 0, 0], w: 2.15 },
  4: { c: rotAxis(CORE, [0, 1, 0], ROUTES_BASE), w: 1.25 },
  5: { c: [0, 0, 0], w: 1.75 },
  7: { c: [0, 0, 0], w: 5.6 },
};

/** Sample a filled 2D drawing: returns points in drawing pixels, biased toward edges so silhouettes read crisply. */
function sample2D(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, count: number, r: () => number, edgeShare = 0.5) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  draw(g);
  const data = g.getImageData(0, 0, w, h).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && (data[(y * w + x) * 4 + 3] ?? 0) > 127;
  const fill: number[] = [];
  const edge: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!on(x, y)) continue;
      fill.push(x, y);
      if (!on(x - 3, y) || !on(x + 3, y) || !on(x, y - 3) || !on(x, y + 3)) edge.push(x, y);
    }
  }
  const out: Array<[number, number, boolean]> = [];
  for (let i = 0; i < count; i += 1) {
    const useEdge = r() < edgeShare && edge.length > 0;
    const src = useEdge ? edge : fill;
    const k = Math.floor(r() * (src.length / 2)) * 2;
    out.push([src[k]! + r(), src[k + 1]! + r(), useEdge]);
  }
  return out;
}

export function buildFormations(n: number, seed = 7): Formations {
  const r = rng(seed);
  const states = Array.from({ length: STATES }, () => new Float32Array(n * 4));
  const rnd = new Float32Array(n * 4);
  const lane = new Float32Array(n).fill(-1);
  const group = new Float32Array(n);
  const put = (s: number, i: number, p: V, size: number) => {
    const o = i * 4, st = states[s]!;
    st[o] = p[0];
    st[o + 1] = p[1];
    st[o + 2] = p[2];
    st[o + 3] = size;
  };
  for (let i = 0; i < n; i += 1) {
    rnd[i * 4] = r();
    rnd[i * 4 + 1] = r();
    rnd[i * 4 + 2] = r();
    rnd[i * 4 + 3] = r();
  }
  // Shuffle order so index ranges per state are not correlated between states (better morph mixing).
  const order = Array.from({ length: n }, (_, i) => i);
  const O = (i: number) => order[i]!;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  // The mark: the same points draw the Q in every formation that shows it, so it keeps its shape between them.
  const m = Math.floor(n * 0.2);
  const mark = new Float32Array(n);
  const markPts = sample2D(400, 400, (g) => (g.scale(4, 4), g.fill(new Path2D(Q_PATH))), m, r, 0.55).map(
    ([x, y, e]) => [(x / 4 - 50) / 100, -(y / 4 - 50) / 100, r() - 0.5, e ? 1 : 0] as const,
  );
  for (let k = 0; k < m; k += 1) mark[O(k)] = 1;
  const putMark = (s: number) => {
    const { c, w } = MARK[s]!;
    markPts.forEach(([u, v, z, e], k) => put(s, O(k), [c[0] + u * w, c[1] + v * w, c[2] + z * Math.max(0.16, w * 0.07)], e ? 1.4 : 1.05));
  };

  // ---------------------------------------------------------------- 0 lattice
  {
    const sp = 0.56, rIn = 2.05, rOut = 3.55, k = Math.ceil(rOut / sp);
    const nodes: V[] = [];
    for (let x = -k; x <= k; x += 1)
      for (let y = -k; y <= k; y += 1)
        for (let z = -k; z <= k; z += 1) {
          const p: V = [x * sp, y * sp, z * sp];
          const d = Math.hypot(...p);
          if (d >= rIn && d <= rOut) nodes.push(p);
        }
    const key = (p: V) => p.map((v) => Math.round(v / sp)).join(',');
    const set = new Set(nodes.map(key));
    const edges: Array<[V, V]> = [];
    for (const p of nodes)
      for (const d of [[sp, 0, 0], [0, sp, 0], [0, 0, sp]] as V[]) {
        const q: V = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
        if (set.has(key(q))) edges.push([p, q]);
      }
    putMark(0);
    let i = m;
    for (const p of nodes) {
      if (i >= n) break;
      // lattice + small error: the picture of a Module-LWE sample
      put(0, O(i++), [p[0] + (r() - 0.5) * 0.04, p[1] + (r() - 0.5) * 0.04, p[2] + (r() - 0.5) * 0.04], 1.55);
    }
    const per = Math.max(1, Math.floor((n - i) / Math.max(1, edges.length)));
    for (const [a, b] of edges) {
      for (let m = 1; m <= per && i < n; m += 1) {
        const f = m / (per + 1);
        put(0, O(i++), [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], 0.55);
      }
    }
    while (i < n) {
      const [a, b] = edges[Math.floor(r() * edges.length)]!;
      const f = r();
      put(0, O(i++), [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], 0.5);
    }
  }

  // ---------------------------------------------------------------- 1 curve, 2 interference
  // 1: the curve every ordinary wallet key lives on, secp256k1 (y^2 = x^3 + 7): the real curve as a glowing line,
  //    its points over a small prime field as a grid of dots behind it, and a run of point additions from the
  //    generator G to a public key. 2: that picture dissolving into a two-source interference pattern (Shor).
  // drawn wider than tall (x stretched) so it reads as the familiar bulb-and-wings shape inside the frame
  const CX = 1.12, CY = 0.66, COX = 0.28;
  const onCurve = (y: number): V => [Math.cbrt(y * y - 7) * CX + COX, y * CY, 0];
  const hopsY = [1.25, -2.4, 2.75, -1.05, 3.05];
  const hops = hopsY.map(onCurve);
  {
    let i = 0;
    const Y = 3.25;
    const line = Math.floor(n * 0.38);
    for (let k = 0; k < line; k += 1) {
      const y = -Y + 2 * Y * r();
      const c = onCurve(y);
      const j = (r() - 0.5) * 0.07, jz = (r() - 0.5) * 0.07;
      put(1, O(i++), [c[0] + j, c[1] + j * 0.4, c[2] + jz], 0.95);
    }
    // the curve over F_p (p = 211): the set a wallet key actually lives in, drawn as a faint dot grid
    const P = 211, fp: V[] = [];
    for (let x = 0; x < P; x += 1) {
      const rhs = (x * x * x + 7) % P;
      for (let y = 0; y < P; y += 1) if ((y * y) % P === rhs) fp.push([(x / P - 0.5) * 6.6, (y / P - 0.5) * 5.4, -1.7]);
    }
    const field = Math.floor(n * 0.3);
    for (let k = 0; k < field; k += 1) {
      const q = fp[k % fp.length]!;
      put(1, O(i++), [q[0] + (r() - 0.5) * 0.04, q[1] + (r() - 0.5) * 0.04, q[2]], 0.85);
    }
    // axes, dotted
    const axes = Math.floor(n * 0.06);
    for (let k = 0; k < axes; k += 1) {
      const f = r();
      if (k % 2) put(1, O(i++), [-2.6 + f * 5.2, 0, 0], 0.32);
      else put(1, O(i++), [COX, -2.5 + f * 5, 0], 0.32);
    }
    // point additions: chords from G to the public key, and bright points at each step
    const chords = Math.floor(n * 0.1);
    for (let k = 0; k < chords; k += 1) {
      const h = k % (hops.length - 1), f = r();
      if (Math.floor(f * 22) % 2) continue;
      const p0 = hops[h]!, p1 = hops[h + 1]!;
      put(1, O(i++), [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, 0.02], 0.8);
    }
    hops.forEach((h, k) => {
      const count = Math.floor(n * (k === 0 || k === hops.length - 1 ? 0.02 : 0.008));
      const rad = k === hops.length - 1 ? 0.2 : k === 0 ? 0.15 : 0.08;
      for (let m = 0; m < count && i < n; m += 1) {
        const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]), rr = rad * Math.cbrt(r());
        put(1, O(i++), [h[0] + d[0] * rr, h[1] + d[1] * rr, h[2] + d[2] * rr], 1.25);
      }
    });
    while (i < n) {
      const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]), rad = 3.8 + r() * 3;
      put(1, O(i++), [d[0] * rad * 1.3, d[1] * rad, d[2] * rad - 2], 0.3);
    }
  }
  {
    // two sources, one screen: bright bands where the waves agree. Laid back like a floor, rippling in depth.
    const lam = 0.62, s1: [number, number] = [-1.05, -2.2], s2: [number, number] = [1.05, -2.2];
    const tilt = -0.8, ct = Math.cos(tilt), st = Math.sin(tilt);
    let i = 0, guard = 0;
    while (i < n && guard < n * 60) {
      guard += 1;
      const u = (r() - 0.5) * 9.2, v = -2.2 + r() * 6.2;
      const d1 = Math.hypot(u - s1[0], v - s1[1]), d2 = Math.hypot(u - s2[0], v - s2[1]);
      const I = Math.cos((Math.PI * (d1 - d2)) / lam) ** 2 * Math.exp(-Math.hypot(u, v + 2.2) / 7);
      if (r() > I * I * I) continue;
      const h = 0.16 * Math.cos((2 * Math.PI * (d1 + d2)) / (2 * lam));
      const y = v - 0.6, z = h;
      put(2, O(i++), [u, y * ct - z * st - 0.2, y * st + z * ct], 0.55 + I * 0.5);
    }
    while (i < n) put(2, O(i++), [(r() - 0.5) * 9, (r() - 0.5) * 6, -3 - r() * 4], 0.3);
  }

  // ---------------------------------------------------------------- 3 roles
  const roles: V[] = [];
  {
    const R = ORBIT.radius;
    const orbs = ROLE_ANGLES.map((a, k) => ({ c: tiltX([R * Math.cos(a), 0, R * Math.sin(a)]), rad: k < 2 ? 0.5 : 0.36, share: k < 2 ? 0.12 : 0.075, g: k + 1 }));
    orbs.forEach((o) => roles.push(o.c));
    roles.push(GAS_POS);
    putMark(3);
    let i = m;
    const sphere = (c: V, rad: number, count: number, g: number, size: number) => {
      for (let m = 0; m < count && i < n; m += 1) {
        const y = 1 - (2 * (m + 0.5)) / count, rr = Math.sqrt(1 - y * y), th = m * 2.399963;
        const j = r() < 0.18 ? 0.55 + r() * 0.4 : 1; // a few points inside the orb
        put(3, O(i), [c[0] + Math.cos(th) * rr * rad * j, c[1] + y * rad * j, c[2] + Math.sin(th) * rr * rad * j], size);
        group[O(i)] = g;
        i += 1;
      }
    };
    for (const o of orbs) sphere(o.c, o.rad, Math.floor(n * o.share), o.g, 0.95);
    sphere(GAS_POS, 0.26, Math.floor(n * 0.035), 6, 0.6);
    const ring = Math.floor(n * 0.17);
    for (let m = 0; m < ring && i < n; m += 1) {
      const a = (m / ring) * Math.PI * 2;
      const w = (r() - 0.5) * 0.05;
      put(3, O(i), tiltX([(R + w) * Math.cos(a), (r() - 0.5) * 0.03, (R + w) * Math.sin(a)]), 0.5);
      group[O(i)] = 7;
      i += 1;
    }
    // dashed carry line from the gas wallet toward the orbit: it only carries
    const carry = Math.floor(n * 0.02);
    for (let m = 0; m < carry && i < n; m += 1) {
      const f = r();
      if (Math.floor(f * 14) % 2) continue;
      const a: V = GAS_POS, b: V = [GAS_POS[0] * 0.42, GAS_POS[1] * 0.42, GAS_POS[2] * 0.42];
      put(3, O(i), [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], 0.42);
      group[O(i)] = 6;
      i += 1;
    }
    while (i < n) {
      const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]), rad = 1.6 + r() * 0.6;
      put(3, O(i), [d[0] * rad, d[1] * rad, d[2] * rad], 0.4);
      group[O(i)] = 0;
      i += 1;
    }
  }

  // ---------------------------------------------------------------- 4 routes
  {
    putMark(4);
    let i = m;
    const tube = (curve: V[], count: number, base: number, laneId: number, size: number, narrow?: number) => {
      for (let m = 0; m < count && i < n; m += 1) {
        const u = r();
        const c = bez(curve, u), t = bezT(curve, u);
        const a = norm(cross(t, [0, 0, 1])), b = cross(t, a);
        let rad = base * (0.35 + 0.65 * Math.sqrt(r()));
        if (narrow !== undefined) rad *= 1 - 0.78 * Math.exp(-(((u - narrow) / 0.07) ** 2));
        rad *= 0.6 + 0.4 * Math.min(1, u * 6); // thin where it leaves the vault
        const th = r() * Math.PI * 2;
        put(4, O(i), [c[0] + (a[0] * Math.cos(th) + b[0] * Math.sin(th)) * rad, c[1] + (a[1] * Math.cos(th) + b[1] * Math.sin(th)) * rad, c[2] + (a[2] * Math.cos(th) + b[2] * Math.sin(th)) * rad], size);
        lane[O(i)] = laneId + Math.min(u, 0.9999);
        i += 1;
      }
    };
    const ringAround = (curve: V[], u: number, R: number, count: number, size: number, ticks = 0) => {
      const c = bez(curve, u), t = bezT(curve, u);
      const a = norm(cross(t, [0, 0, 1])), b = cross(t, a);
      for (let m = 0; m < count && i < n; m += 1) {
        const th = (m / count) * Math.PI * 2;
        let rr = R + (r() - 0.5) * 0.04;
        if (ticks && m % Math.floor(count / ticks) < 3) rr += 0.12;
        const off = (r() - 0.5) * 0.06;
        put(4, O(i), [c[0] + (a[0] * Math.cos(th) + b[0] * Math.sin(th)) * rr + t[0] * off, c[1] + (a[1] * Math.cos(th) + b[1] * Math.sin(th)) * rr + t[1] * off, c[2] + (a[2] * Math.cos(th) + b[2] * Math.sin(th)) * rr + t[2] * off], size);
        i += 1;
      }
    };
    tube(FAST_CURVE, Math.floor(n * 0.3), 0.2, 0, 0.75, GATE_U);
    ringAround(FAST_CURVE, GATE_U, 0.32, Math.floor(n * 0.03), 0.7);
    tube(SAFE_CURVE, Math.floor(n * 0.32), 0.28, 1, 0.75);
    ringAround(SAFE_CURVE, LOCK_U, 0.72, Math.floor(n * 0.1), 0.75, 24);
    // the vault core the routes leave from
    while (i < n) {
      const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]), rad = 0.95 + r() * 0.5;
      put(4, O(i), [CORE[0] + d[0] * rad, CORE[1] + d[1] * rad, CORE[2] + d[2] * rad], 0.4);
      i += 1;
    }
  }

  // ---------------------------------------------------------------- 5 shield
  {
    const R = 3.05;
    putMark(5);
    let i = m;
    const shell = Math.floor(n * 0.6);
    for (let m = 0; m < shell; m += 1) {
      const y = 1 - (2 * (m + 0.5)) / shell, rr = Math.sqrt(1 - y * y), th = m * 2.399963;
      put(5, O(i++), [Math.cos(th) * rr * R, y * R, Math.sin(th) * rr * R], 0.72);
    }
    const seams = Math.floor(n * 0.17);
    const axes: V[] = [norm([0.2, 1, 0.45]), norm([1, 0.3, 0.2]), norm([0.4, 0.2, 1]), norm([-0.7, 0.5, 0.5]), norm([0.6, -0.4, 0.7])];
    for (let m = 0; m < seams; m += 1) {
      const k = axes[m % axes.length]!;
      const a = norm(cross(k, [0.31, 0.77, 0.55])), b = cross(k, a), th = r() * Math.PI * 2;
      const rr = R * 1.004;
      put(5, O(i++), [(a[0] * Math.cos(th) + b[0] * Math.sin(th)) * rr, (a[1] * Math.cos(th) + b[1] * Math.sin(th)) * rr, (a[2] * Math.cos(th) + b[2] * Math.sin(th)) * rr], 0.95);
    }
    while (i < n) {
      const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]), rad = 1.5 + r() * 0.5;
      put(5, O(i++), [d[0] * rad, d[1] * rad, d[2] * rad], 0.34);
    }
  }

  // ---------------------------------------------------------------- 6 field
  for (let i = 0; i < n; i += 1) {
    const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const rad = 5.5 + r() * 9;
    let z = d[2] * rad;
    if (z > 3) z = -z;
    put(6, O(i), [d[0] * rad * 1.5, d[1] * rad, z - 2], 0.38 + r() * 0.35);
  }

  // ---------------------------------------------------------------- 7 mark
  {
    putMark(7);
    const rest = n - m;
    const pts = sample2D(400, 400, (g) => (g.scale(4, 4), g.fill(new Path2D(Q_PATH))), rest, r, 0.5);
    const W = MARK[7]!.w;
    pts.forEach(([x, y, e], k) => {
      const i = m + k;
      if (k > rest * 0.88) {
        const d = norm([r() - 0.5, r() - 0.5, (r() - 0.5) * 0.4]), rad = 3.3 + r() * 1.6;
        put(7, O(i), [d[0] * rad, d[1] * rad, d[2] * rad], 0.35);
      } else put(7, O(i), [((x / 4 - 50) / 100) * W, (-(y / 4 - 50) / 100) * W, (r() - 0.5) * 0.42], e ? 1.05 : 0.8);
    });
  }

  return {
    n,
    states,
    rnd,
    lane,
    group,
    mark,
    anchors: {
      curveG: onCurve(1.25),
      curvePub: onCurve(3.05),
      roles,
      fastEnd: bez(FAST_CURVE, 0.97),
      safeEnd: bez(SAFE_CURVE, 0.97),
      gate: bez(FAST_CURVE, GATE_U),
      lock: bez(SAFE_CURVE, LOCK_U),
    },
  };
}

/** Parse Q_PATH (absolute polygons) into point lists, for the extruded mark. */
export function qPolygons(): Array<Array<[number, number]>> {
  return Q_PATH.split('Z')
    .map((s) => s.replace('M', '').trim())
    .filter(Boolean)
    .map((s) => {
      const nums = s.split(/[\s,]+/).map(Number);
      const pts: Array<[number, number]> = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
      return pts;
    });
}

export { tiltX, rotAxis };
export type { V };
