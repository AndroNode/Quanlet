import * as THREE from 'three';
import { buildFormations, MARK, ORBIT, ROUTES_BASE, STATES, type V } from './shapes';

/**
 * The landing-page stage: one fixed WebGL canvas behind the page. A single body of points is the protagonist and
 * changes formation as the reader scrolls (see shapes.ts); a solid glass-and-violet Q sits at the centre when the
 * story is about the vault. The page drives it with a scroll-derived state value s in [0, STATES-1].
 */

type RGB = [number, number, number];
interface Key {
  axis: V;
  base?: number;
  speed: number;
  sway: number;
  noise: number;
  size: number;
  fade: number;
  a: RGB;
  b: RGB;
  q: { pos: V; scale: number };
  glow: number;
  focus: [number, number];
  focusP: [number, number];
  zoom: number;
  zoomP: number;
  pointer: number;
}

const LILAC: RGB = [0.6, 0.36, 1.0];
const PALE: RGB = [0.88, 0.84, 1.0];
const VIOLET: RGB = [0.5, 0.14, 1.0];
const SILVER: RGB = [0.78, 0.8, 0.9];
const STEEL: RGB = [0.5, 0.52, 0.64];
const tilted: V = [0, Math.cos(ORBIT.tilt), Math.sin(ORBIT.tilt)];
const Y: V = [0, 1, 0];

const KEYS: Key[] = [
  /* 0 lattice */ { axis: Y, speed: 0.07, sway: 0, noise: 0.028, size: 0.05, fade: 1, a: LILAC, b: PALE, q: { pos: [0, 0, 0], scale: 1 }, glow: 0.6, focus: [0.5, 0.53], focusP: [0.5, 0.4], zoom: 1.45, zoomP: 1.2, pointer: 1 },
  /* 1 key */ { axis: Y, speed: 0, sway: 0.22, noise: 0.006, size: 0.05, fade: 0.95, a: SILVER, b: STEEL, q: { pos: [0, 0, -3], scale: 0 }, glow: 0.12, focus: [0.5, 0.47], focusP: [0.5, 0.42], zoom: 1, zoomP: 1.02, pointer: 0.4 },
  /* 2 shatter */ { axis: Y, speed: 0.05, sway: 0.1, noise: 0.02, size: 0.045, fade: 0.72, a: SILVER, b: STEEL, q: { pos: [0, 0, -3], scale: 0 }, glow: 0, focus: [0.5, 0.47], focusP: [0.5, 0.42], zoom: 1.05, zoomP: 1.1, pointer: 0.3 },
  /* 3 roles */ { axis: tilted, speed: 0.16, sway: 0, noise: 0.008, size: 0.05, fade: 1, a: VIOLET, b: PALE, q: { pos: [0, 0, 0], scale: 0.8 }, glow: 0.85, focus: [0.5, 0.52], focusP: [0.5, 0.45], zoom: 1.04, zoomP: 0.9, pointer: 0 },
  /* 4 routes */ { axis: Y, base: ROUTES_BASE, speed: 0, sway: 0.07, noise: 0.004, size: 0.046, fade: 1, a: VIOLET, b: PALE, q: { pos: MARK[4]!.c, scale: 0.44 }, glow: 0.55, focus: [0.5, 0.53], focusP: [0.5, 0.42], zoom: 1.02, zoomP: 1.12, pointer: 0 },
  /* 5 shield */ { axis: Y, speed: 0.09, sway: 0, noise: 0.006, size: 0.046, fade: 0.95, a: VIOLET, b: LILAC, q: { pos: [0, 0, 0], scale: 0.62 }, glow: 0.8, focus: [0.5, 0.4], focusP: [0.5, 0.3], zoom: 1.22, zoomP: 1.05, pointer: 0 },
  /* 6 field */ { axis: Y, speed: 0.025, sway: 0, noise: 0.03, size: 0.042, fade: 0.5, a: VIOLET, b: LILAC, q: { pos: [0, 0, -4], scale: 0 }, glow: 0, focus: [0.5, 0.5], focusP: [0.5, 0.5], zoom: 1, zoomP: 1, pointer: 0.6 },
  /* 7 mark */ { axis: Y, speed: 0, sway: 0.32, noise: 0.012, size: 0.058, fade: 1.4, a: VIOLET, b: PALE, q: { pos: [0, 0, -3], scale: 0 }, glow: 0.75, focus: [0.5, 0.34], focusP: [0.5, 0.3], zoom: 1.45, zoomP: 1.25, pointer: 1 },
];

const VERT = /* glsl */ `
uniform float uMix, uTime, uPR, uScale, uSize, uSwirl, uNoiseA, uNoiseB, uFade;
uniform vec4 uRotA, uRotB;
uniform float uFlow, uShield, uImpactAge, uPointerAmt;
uniform vec3 uImpactDir, uPointer;
uniform float uGroupBoost[8];
uniform float uIs3A, uIs3B, uIs4A, uIs4B, uFocus3, uFocus4;
uniform vec2 uLaneBoost;
attribute vec4 aFrom;
attribute vec4 aTo;
attribute vec4 aRnd;
attribute float aLane;
attribute float aGroup;
attribute float aMark;
uniform float uMarkA, uMarkB;
uniform vec3 uMarkCA, uMarkCB;
uniform vec4 uMarkRot;
varying float vAlpha;
varying float vHue;
varying float vHot;

vec3 rotA(vec3 p, vec4 r) {
  float c = cos(r.w), s = sin(r.w);
  return p * c + cross(r.xyz, p) * s + r.xyz * dot(r.xyz, p) * (1.0 - c);
}

void main() {
  float d = aRnd.x * 0.42;
  float t = clamp((uMix - d) / 0.58, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  bool still = aGroup > 5.5 && aGroup < 6.5;
  vec4 ra = (still && uIs3A > 0.5) ? vec4(uRotA.xyz, 0.0) : uRotA;
  vec4 rb = (still && uIs3B > 0.5) ? vec4(uRotB.xyz, 0.0) : uRotB;
  vec3 pa = rotA(aFrom.xyz, ra);
  vec3 pb = rotA(aTo.xyz, rb);
  // the mark keeps its own gentle turn about its centre in every formation that shows it
  bool markA = aMark > 0.5 && uMarkA > 0.5, markB = aMark > 0.5 && uMarkB > 0.5;
  if (markA) pa = rotA(aFrom.xyz - uMarkCA, uMarkRot) + uMarkCA;
  if (markB) pb = rotA(aTo.xyz - uMarkCB, uMarkRot) + uMarkCB;
  vec3 p = mix(pa, pb, t);
  float ph = aRnd.y * 6.2831853;
  vec3 n = vec3(sin(ph * 7.0 + uTime * 0.9), sin(ph * 5.0 + uTime * 0.7 + 1.3), sin(ph * 3.0 - uTime * 0.8 + 2.1));
  p += n * sin(t * 3.14159265) * uSwirl * ((markA && markB) ? 0.12 : 1.0);
  p += n * mix(uNoiseA, uNoiseB, t);

  float hot = 0.0;
  float dim = 1.0;
  if (uShield > 0.001) {
    float ang = acos(clamp(dot(normalize(p), uImpactDir), -1.0, 1.0));
    float w = exp(-pow((ang - uImpactAge * 2.4) * 6.0, 2.0)) * (1.0 - smoothstep(0.0, 1.1, uImpactAge));
    p += normalize(p) * w * 0.32 * uShield;
    hot = max(hot, w * uShield);
  }
  vec3 dp = p - uPointer;
  float dl = length(dp);
  p += (dp / max(dl, 0.001)) * uPointerAmt * 0.55 * exp(-dl * dl * 1.6);

  float w3 = uIs3A * (1.0 - t) + uIs3B * t;
  if (w3 > 0.001) {
    float b = uGroupBoost[int(aGroup + 0.5)];
    hot = max(hot, b * w3 * 0.32);
    dim *= 1.0 - uFocus3 * w3 * (1.0 - b) * 0.6;
  }
  float w4 = uIs4A * (1.0 - t) + uIs4B * t;
  if (aLane >= 0.0 && w4 > 0.001) {
    float lane = floor(aLane);
    float u = fract(aLane);
    float q = lane < 0.5 ? u * 7.0 - uTime * 1.9 : u * 3.5 - uTime * 0.55;
    float pulse = pow(max(0.0, sin(q * 6.2831853)), 30.0);
    float lb = lane < 0.5 ? uLaneBoost.x : uLaneBoost.y;
    hot = max(hot, (pulse * uFlow * 0.7 + lb * 0.22) * w4);
    dim *= 1.0 - uFocus4 * w4 * (1.0 - lb) * 0.6;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = mix(aFrom.w, aTo.w, t);
  gl_PointSize = min(64.0, uSize * sz * (1.0 + hot * 1.4) * uPR * (uScale / max(0.5, -mv.z)));
  vAlpha = uFade * dim * clamp(0.35 + sz * 0.6, 0.0, 1.6);
  vHue = aRnd.z;
  vHot = hot;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColA, uColB;
varying float vAlpha;
varying float vHue;
varying float vHot;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  a *= a;
  vec3 col = mix(uColA, uColB, vHue * vHue);
  col = mix(col, vec3(1.0, 0.96, 1.0), clamp(vHot, 0.0, 1.0));
  gl_FragColor = vec4(col * a * vAlpha * (1.0 + vHot * 1.2), 0.0);
}
`;

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpV = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => lerp(v, b[i] ?? v, t));
function rotV(p: V, k: V, a: number): V {
  const c = Math.cos(a), s = Math.sin(a);
  const cx: V = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]];
  const d = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  const at = (i: 0 | 1 | 2) => p[i] * c + cx[i] * s + k[i] * d * (1 - c);
  return [at(0), at(1), at(2)];
}

export interface Anchor {
  el: HTMLElement;
  state: number;
  pos: V;
  /** True when the point does not turn with its formation. */
  still?: boolean;
  /** Opacity threshold: label shows only when the state weight passes this. */
  min?: number;
}

export interface StageOptions {
  reduced: boolean;
  /** Maps the current scroll position to the target state value. */
  target: () => number;
  /** Per-frame hook for page-side effects (state value and weights). */
  onFrame?: (s: number) => void;
  /** Start from this scene time (seconds) and skip the opening gather: the 2D loader already drew it. */
  startTime?: number;
  /** The first frames rendered with compiled shaders. */
  onReady?: () => void;
  /** The scene cannot be shown: a shader failed to compile, or the GPU context was lost and not given back. */
  onFail?: (why: string) => void;
}

export class Stage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
  private points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private geo = new THREE.BufferGeometry();
  private glow: THREE.Sprite;
  private streak: THREE.Line;
  readonly formations: ReturnType<typeof buildFormations>;
  private pair = [-1, -1];
  private s = 0;
  private intro = 0;
  private clock = new THREE.Clock();
  private time = 0;
  private raf = 0;
  private w = 1;
  private h = 1;
  private portrait = false;
  private pointerT = new THREE.Vector3(99, 99, 0);
  private pointerAmt = 0;
  private mouse = new THREE.Vector2();
  private mouseS = new THREE.Vector2();
  private hasPointer = false;
  private anchors: Anchor[] = [];
  private impact = { dir: new THREE.Vector3(0, 0, 1), age: 9, next: 1, flying: -1, from: new THREE.Vector3() };
  private focus3 = 0;
  private focus4 = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private disposed = false;
  private failed = false;
  private framesOk = 0;
  private readySent = false;
  private lostTimer = 0;
  private u = {
    uMix: { value: 0 },
    uTime: { value: 0 },
    uPR: { value: 1 },
    uScale: { value: 400 },
    uSize: { value: 0.05 },
    uSwirl: { value: 0 },
    uNoiseA: { value: 0 },
    uNoiseB: { value: 0 },
    uFade: { value: 1 },
    uRotA: { value: new THREE.Vector4(0, 1, 0, 0) },
    uRotB: { value: new THREE.Vector4(0, 1, 0, 0) },
    uFlow: { value: 0 },
    uShield: { value: 0 },
    uImpactAge: { value: 9 },
    uImpactDir: { value: new THREE.Vector3(0, 0, 1) },
    uPointer: { value: new THREE.Vector3(99, 99, 0) },
    uPointerAmt: { value: 0 },
    uGroupBoost: { value: new Array<number>(8).fill(0) },
    uMarkA: { value: 0 },
    uMarkB: { value: 0 },
    uMarkCA: { value: new THREE.Vector3() },
    uMarkCB: { value: new THREE.Vector3() },
    uMarkRot: { value: new THREE.Vector4(0, 1, 0, 0) },
    uIs3A: { value: 0 },
    uIs3B: { value: 0 },
    uIs4A: { value: 0 },
    uIs4B: { value: 0 },
    uFocus3: { value: 0 },
    uFocus4: { value: 0 },
    uLaneBoost: { value: new THREE.Vector2() },
    uColA: { value: new THREE.Color() },
    uColB: { value: new THREE.Color() },
  };

  constructor(private canvas: HTMLCanvasElement, private opts: StageOptions) {
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 700 || (navigator.hardwareConcurrency || 8) <= 4;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75));
    this.renderer.setClearColor(0x000000, 0);
    // A shader that does not compile on this GPU would otherwise leave a silent, empty canvas.
    this.renderer.debug.onShaderError = (gl, program) => {
      console.warn('Quanlet 3D: shader failed', gl.getProgramInfoLog(program));
      this.fail('shader');
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    // No filmic tone mapping: it pushes the brand violet (#8902FE) toward pink at high intensity.
    this.renderer.toneMapping = THREE.NoToneMapping;


    // ---------------------------------------------------------------- points
    const n = mobile ? 5600 : 9800;
    this.formations = buildFormations(n);
    const f = this.formations;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geo.setAttribute('aFrom', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    this.geo.setAttribute('aTo', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    this.geo.setAttribute('aRnd', new THREE.BufferAttribute(f.rnd, 4));
    this.geo.setAttribute('aLane', new THREE.BufferAttribute(f.lane, 1));
    this.geo.setAttribute('aGroup', new THREE.BufferAttribute(f.group, 1));
    this.geo.setAttribute('aMark', new THREE.BufferAttribute(f.mark, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
    const preserveAlpha = {
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    } as const;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      ...preserveAlpha,
      uniforms: this.u,
    });
    this.u.uPR.value = this.renderer.getPixelRatio();
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);


    // halo behind the mark
    const gc = document.createElement('canvas');
    gc.width = gc.height = 256;
    const g = gc.getContext('2d')!;
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(137,2,254,0.6)');
    grd.addColorStop(0.22, 'rgba(137,2,254,0.22)');
    grd.addColorStop(0.55, 'rgba(137,2,254,0.05)');
    grd.addColorStop(1, 'rgba(137,2,254,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const gt = new THREE.CanvasTexture(gc);
    gt.colorSpace = THREE.SRGBColorSpace;
    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: gt, transparent: true, depthWrite: false, toneMapped: false, ...preserveAlpha, blendSrc: THREE.SrcAlphaFactor }),
    );
    this.glow.scale.set(7.5, 7.5, 1);
    this.scene.add(this.glow);

    // incoming strike for the shield
    const sg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.streak = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xf2e6ff, transparent: true, depthWrite: false, ...preserveAlpha }));
    this.streak.frustumCulled = false;
    this.streak.visible = false;
    this.scene.add(this.streak);

    if (opts.reduced || opts.startTime !== undefined) this.intro = 1;
    this.time = opts.startTime ?? 0;
    this.s = opts.target();
    this.resize();
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    document.addEventListener('visibilitychange', this.onVis);
    this.loop();
  }

  bindAnchors(list: Anchor[]) {
    this.anchors = list;
  }

  /** Highlight orbs in the roles state: groups 1 P, 2 A, 3-5 guardians, 6 gas. */
  focusRoles(groups: number[] | null) {
    for (let i = 0; i < 8; i += 1) this.u.uGroupBoost.value[i] = groups?.includes(i) ? 1 : 0;
    this.focus3 = groups ? 1 : 0;
  }

  /** Highlight a lane in the routes state: 0 FAST, 1 PROTECTED. */
  focusLane(lane: number | null) {
    this.u.uLaneBoost.value.set(lane === 0 ? 1 : 0, lane === 1 ? 1 : 0);
    this.focus4 = lane === null ? 0 : 1;
  }

  setReduced(r: boolean) {
    this.opts.reduced = r;
    if (r) this.intro = 1;
  }

  resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.w && Math.abs(h - this.h) < 2) return;
    this.w = w;
    this.h = h;
    this.portrait = w / h < 0.95;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.hasPointer = true;
    this.mouse.set((e.clientX / this.w) * 2 - 1, -(e.clientY / this.h) * 2 + 1);
  };

  private onVis = () => {
    if (document.hidden) cancelAnimationFrame(this.raf);
    else {
      this.clock.getDelta();
      this.loop();
    }
  };

  private setPair(a: number, b: number) {
    if (this.pair[0] === a && this.pair[1] === b) return;
    this.pair = [a, b];
    const from = this.geo.getAttribute('aFrom') as THREE.BufferAttribute;
    const to = this.geo.getAttribute('aTo') as THREE.BufferAttribute;
    (from.array as Float32Array).set(this.formations.states[a]!);
    (to.array as Float32Array).set(this.formations.states[b]!);
    from.needsUpdate = true;
    to.needsUpdate = true;
  }

  private angle(k: Key) {
    const t = this.opts.reduced ? 0 : this.time;
    return (k.base ?? 0) + k.speed * t + k.sway * Math.sin(t * 0.42);
  }

  private fail(why: string) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    cancelAnimationFrame(this.raf);
    this.opts.onFail?.(why);
  }

  // The browser may take the GPU context away (memory pressure, a driver reset). three.js restores it when it is
  // given back; if it is not given back soon, the page falls back to the 2D view.
  private onLost = () => {
    clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => this.fail('context lost'), 4000);
  };
  private onRestored = () => {
    clearTimeout(this.lostTimer);
  };

  private loop = () => {
    if (this.disposed || this.failed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const reduced = this.opts.reduced;
    if (!reduced) this.time += dt;
    const u = this.u;

    // scroll target, eased so the formation follows the page with a little weight
    const target = Math.max(0, Math.min(STATES - 1, this.opts.target()));
    this.s += (target - this.s) * (reduced ? 1 : 1 - Math.exp(-dt * 4.2));
    if (Math.abs(target - this.s) < 1e-4) this.s = target;
    if (this.intro < 1) this.intro = Math.min(1, this.intro + dt / 2.6);

    let a = Math.floor(this.s), mix = this.s - a;
    if (a >= STATES - 1) (a = STATES - 2), (mix = 1);
    let b = a + 1;
    // opening: the field gathers into the lattice once, on load
    const introOn = this.intro < 1 && this.s < 0.5;
    if (introOn) (a = 6), (b = 0), (mix = ease(this.intro));
    this.setPair(a, b);
    const KA = KEYS[a]!, KB = KEYS[b]!;
    const e = ease(mix);
    const K = (fn: (k: Key) => number) => lerp(fn(KA), fn(KB), e);

    u.uMix.value = mix;
    u.uTime.value = this.time;
    u.uSwirl.value = reduced ? 0 : 0.55;
    u.uNoiseA.value = reduced ? 0 : KA.noise;
    u.uNoiseB.value = reduced ? 0 : KB.noise;
    u.uSize.value = K((k) => k.size);
    u.uFade.value = K((k) => k.fade) * (introOn ? 0.3 + 0.7 * ease(this.intro) : 1);
    (u.uRotA.value as THREE.Vector4).set(KA.axis[0], KA.axis[1], KA.axis[2], this.angle(KA));
    (u.uRotB.value as THREE.Vector4).set(KB.axis[0], KB.axis[1], KB.axis[2], this.angle(KB));
    (u.uColA.value as THREE.Color).setRGB(...(lerpV(KA.a, KB.a, e) as RGB));
    (u.uColB.value as THREE.Color).setRGB(...(lerpV(KA.b, KB.b, e) as RGB));
    u.uIs3A.value = a === 3 ? 1 : 0;
    u.uIs3B.value = b === 3 ? 1 : 0;
    u.uIs4A.value = a === 4 ? 1 : 0;
    u.uIs4B.value = b === 4 ? 1 : 0;
    u.uFocus3.value += (this.focus3 - u.uFocus3.value) * Math.min(1, dt * 5);
    u.uFocus4.value += (this.focus4 - u.uFocus4.value) * Math.min(1, dt * 5);
    u.uFlow.value = reduced ? 0 : 1;
    const wShield = Math.max(0, 1 - Math.abs(this.s - 5));
    u.uShield.value = reduced ? 0 : wShield;

    // camera: fit the formation, then slide the frame so the formation sits where the layout wants it
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const fit = 4.05 * (this.portrait ? K((k) => k.zoomP) : K((k) => k.zoom));
    const dist = this.portrait ? fit / (tanH * this.camera.aspect) : fit / tanH;
    this.mouseS.lerp(this.mouse, Math.min(1, dt * 3));
    const par = this.hasPointer && !reduced ? 0.35 : 0;
    this.camera.position.set(this.mouseS.x * par, this.mouseS.y * par * 0.6, dist);
    this.camera.lookAt(0, 0, 0);
    const fx = this.portrait ? K((k) => k.focusP[0]) : K((k) => k.focus[0]);
    const fy = this.portrait ? K((k) => k.focusP[1]) : K((k) => k.focus[1]);
    this.camera.setViewOffset(this.w, this.h, (0.5 - fx) * this.w, (0.5 - fy) * this.h, this.w, this.h);
    this.camera.updateMatrixWorld();
    u.uScale.value = this.h / 2 / tanH;

    // pointer: a soft push in the lattice and the mark
    if (this.hasPointer && !reduced) {
      this.ray.setFromCamera(this.mouse, this.camera);
      this.ray.ray.intersectPlane(this.plane, this.pointerT);
      this.u.uPointer.value.lerp(this.pointerT, Math.min(1, dt * 8));
      this.pointerAmt += (K((k) => k.pointer) - this.pointerAmt) * Math.min(1, dt * 3);
    } else this.pointerAmt *= 0.9;
    u.uPointerAmt.value = this.pointerAmt;

    // the mark is drawn by points and turns gently on its own
    const tq = reduced ? 0 : this.time;
    const hasMark = (i: number) => (MARK[i] ? 1 : 0);
    u.uMarkA.value = introOn ? 0 : hasMark(a);
    u.uMarkB.value = hasMark(b);
    if (MARK[a]) u.uMarkCA.value.set(...MARK[a]!.c);
    if (MARK[b]) u.uMarkCB.value.set(...MARK[b]!.c);
    u.uMarkRot.value.set(0, 1, 0, Math.sin(tq * 0.42) * 0.32); // same turn as the closing mark formation
    const qs = K((k) => k.q.scale);
    const qp = lerpV(rotV(KA.q.pos, KA.axis, MARK[a] ? 0 : this.angle(KA)), rotV(KB.q.pos, KB.axis, MARK[b] ? 0 : this.angle(KB)), e) as V;
    const gw = K((k) => k.glow) * (introOn ? ease(this.intro) : 1);
    this.glow.position.set(qp[0], qp[1], qp[2] - 1.2);
    this.glow.scale.setScalar(7.5 * Math.max(0.35, qs));
    (this.glow.material as THREE.SpriteMaterial).opacity = gw * (0.82 + 0.18 * Math.sin(tq * 1.3));
    this.glow.visible = gw > 0.01;

    // shield strikes
    const im = this.impact;
    im.age += dt;
    if (!reduced && wShield > 0.4) {
      im.next -= dt;
      if (im.flying < 0 && im.next <= 0) {
        im.dir.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.6).normalize();
        im.flying = 0;
      }
    }
    if (im.flying >= 0) {
      im.flying += dt / 0.34;
      const k = Math.min(1, im.flying);
      const R = 3.05;
      const head = 10 - (10 - R) * k;
      const pos = this.streak.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, im.dir.x * head, im.dir.y * head, im.dir.z * head);
      pos.setXYZ(1, im.dir.x * (head + 2.2), im.dir.y * (head + 2.2), im.dir.z * (head + 2.2));
      pos.needsUpdate = true;
      this.streak.visible = wShield > 0.2;
      if (k >= 1) {
        im.flying = -1;
        im.age = 0;
        im.next = 1.15 + Math.random() * 0.9;
        this.streak.visible = false;
        (u.uImpactDir.value as THREE.Vector3).copy(im.dir);
      }
    } else this.streak.visible = false;
    u.uImpactAge.value = im.age;

    this.renderer.render(this.scene, this.camera);
    if (!this.readySent && !this.failed && !this.renderer.getContext().isContextLost() && (this.framesOk += 1) >= 3) {
      this.readySent = true;
      this.opts.onReady?.();
    }
    this.placeAnchors();
    this.opts.onFrame?.(this.s);
  };

  private v = new THREE.Vector3();
  private placeAnchors() {
    for (const an of this.anchors) {
      const w = Math.max(0, 1 - Math.abs(this.s - an.state));
      const op = Math.max(0, Math.min(1, (w - (an.min ?? 0.55)) / 0.25));
      if (op <= 0) {
        if (an.el.style.opacity !== '0') an.el.style.opacity = '0';
        an.el.style.visibility = 'hidden';
        continue;
      }
      const k = KEYS[an.state]!;
      const p = an.still ? an.pos : rotV(an.pos, k.axis, this.angle(k));
      this.v.set(p[0], p[1], p[2]).project(this.camera);
      const x = ((this.v.x + 1) / 2) * this.w;
      const y = ((1 - this.v.y) / 2) * this.h;
      an.el.style.visibility = 'visible';
      an.el.style.opacity = String(op);
      an.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      an.el.dataset.back = p[2] < -0.9 ? '1' : '0';
      const room = Math.min(190, this.w * 0.3);
      an.el.dataset.side = x < this.w * 0.5 ? (x < room ? 'r' : 'l') : x > this.w - room ? 'l' : 'r';
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.lostTimer);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVis);
    this.geo.dispose();
    this.mat.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      mats.forEach((x) => x.dispose());
    });
    this.renderer.dispose();
  }
}

export { STATES };
