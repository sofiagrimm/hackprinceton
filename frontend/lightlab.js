// Lighting lab: put your own lights in the room and see the mood.
//
// The room is the scan's 360 photo, mapped onto a box the size of the scanned space
// (camera in the middle at eye height). Every pixel therefore knows which wall, floor
// or ceiling point it shows and which way that surface faces, so a light you place
// falls off with distance, lights surfaces that face it, and spotlights have a cone.
// It is a sketch of the mood, not a lighting plan; the page says so.

import * as THREE from "./vendor/three.module.js";

const MAX = 32;
export const EYE = 1.55; // metres

const VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = `
  #define MAX ${MAX}
  uniform samplerCube map;
  uniform vec3 room;        // half width, height, half depth (m)
  uniform float eye;
  uniform float ambient;    // house lights 0..1
  uniform int count;
  uniform vec3 lpos[MAX];
  uniform vec3 lcol[MAX];
  uniform float lpow[MAX];
  uniform vec3 ldir[MAX];   // spot direction (zero for a bulb)
  uniform float lcone[MAX]; // cos of the spot's half angle
  uniform float lsize[MAX]; // how big the visible bulb looks
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    vec3 base = textureCube(map, d).rgb;
    // Where this ray meets the box, and that surface's normal.
    vec3 o = vec3(0.0, eye, 0.0);
    float tx = (d.x > 0.0 ? room.x : -room.x) / (abs(d.x) < 1e-4 ? 1e-4 : d.x);
    float tz = (d.z > 0.0 ? room.z : -room.z) / (abs(d.z) < 1e-4 ? 1e-4 : d.z);
    float ty = d.y > 0.0 ? (room.y - eye) / max(d.y, 1e-4) : -eye / min(d.y, -1e-4);
    float t = min(tx, min(ty, tz));
    vec3 n = t == tx ? vec3(-sign(d.x), 0.0, 0.0) : t == tz ? vec3(0.0, 0.0, -sign(d.z)) : vec3(0.0, -sign(d.y), 0.0);
    vec3 p = o + d * t;

    vec3 light = vec3(0.0);
    vec3 halo = vec3(0.0);
    for (int i = 0; i < MAX; i++) {
      if (i >= count) break;
      vec3 L = lpos[i] - p;
      float dist = length(L);
      vec3 l = L / max(dist, 1e-3);
      float ndl = max(dot(n, l), 0.0);
      float cone = 1.0;
      if (dot(ldir[i], ldir[i]) > 0.0) cone = smoothstep(lcone[i], lcone[i] + 0.06, dot(-l, normalize(ldir[i])));
      light += lcol[i] * lpow[i] * ndl * cone / (1.0 + dist * dist * 0.35);
      // the fixture itself, seen from where you stand
      vec3 toL = normalize(lpos[i] - o);
      float a = acos(clamp(dot(d, toL), -1.0, 1.0));
      halo += lcol[i] * min(lpow[i], 3.0) * (exp(-pow(a / (0.012 * lsize[i]), 2.0)) * 1.4 + exp(-pow(a / (0.06 * lsize[i]), 2.0)) * 0.25);
    }
    vec3 lit = base * (ambient + light * 0.9) + halo;
    // soft shoulder so bright lights bloom instead of clipping
    lit = 1.0 - exp(-lit * 1.25);
    gl_FragColor = vec4(lit, 1.0);
  }`;

const FACE_ORDER = [2, 4, 0, 5, 1, 3];

// lm: lumens per fixture (per bulb for string lights) at brightness 1; kelvin: default white.
export const KINDS = {
  wash: { label: "Warm wash", color: "#ffb36b", power: 2.2, size: 1.4, lm: 4000, kelvin: 2700 },
  spot: { label: "Spotlight", color: "#fff1d6", power: 6, size: 1, cone: 0.92, lm: 6000, kelvin: 3200 },
  string: { label: "String lights", color: "#ffcf7a", power: 1.2, size: 0.7, lm: 150, kelvin: 2200 },
  uplight: { label: "Color uplight", color: "#ff3d8b", power: 6, size: 1.2, cone: 0.35, lm: 1500, kelvin: null },
};

// ------------------------------------------------------------------ photometry
// The same formulas as backend/app/photometry.py (tested there).

/** Colour temperature to sRGB, Tanner Helland's fit to the Planckian locus. */
export function kelvinRgb(k) {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}
export const kelvinHex = (k) => "#" + kelvinRgb(k).map((v) => v.toString(16).padStart(2, "0")).join("");

/** The colour temperature a colour is closest to, or null when it's a real colour (a gel, an LED). */
export function kelvinOf(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let best = null, bestD = 1e9;
  for (let k = 1500; k <= 10000; k += 100) {
    const p = kelvinRgb(k);
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD < 34 ? best : null;
}

/** Candela: lumens over 4 pi for a bare bulb, over the cone 2 pi (1 - cos half-angle) for a spot. */
export function intensityCd(lm, cone) {
  return cone ? lm / (2 * Math.PI * (1 - cone)) : lm / (4 * Math.PI);
}

export const C_INCIDENT = 250; // incident-meter calibration constant (flat disc, ISO 2720)
export const ev100 = (lux) => Math.log2(Math.max(lux, 1e-6) * 100 / C_INCIDENT);
export const shutterFor = (lux, iso = 800, f = 2.8) => (f * f) / 2 ** (ev100(lux) + Math.log2(iso / 100));
export const isoFor = (lux, t = 1 / 48, f = 2.8) => 100 * 2 ** (Math.log2((f * f) / t) - ev100(lux));

/** Where the meter reads: face height (1.5 m) above a floor point, facing the middle of the room. */
export function meterPoint(room, at = null) {
  const x = at ? Math.max(-room.x + 0.3, Math.min(room.x - 0.3, at.x)) : 0;
  const z = at ? Math.max(-room.z + 0.3, Math.min(room.z - 0.3, at.z)) : -room.z + 1.2;
  const S = new THREE.Vector3(x, 1.5, z);
  const face = new THREE.Vector3(-x, 0, -z);
  if (face.lengthSq() < 0.01) face.set(0, 0, 1);
  return { S, face: face.normalize() };
}

/**
 * Light on the performers' faces at the meter point (by default 1.2 m out from the far wall).
 * Each fixture: inverse square, Lambert cosine on the face, and the beam edge for spots.
 * lights: [{ pos, dir, cone, lm, kelvin }]; room: Vector3 (half width, height, half depth).
 */
export function stageMeter(lights, room, ambient, at = null) {
  const { S, face } = meterPoint(room, at);
  let total = 0;
  const parts = [];
  for (const l of lights) {
    const L = l.pos.clone().sub(S);
    const d = Math.max(L.length(), 0.3);
    const dir = L.clone().divideScalar(d);
    let I = intensityCd(l.lm || 0, l.dir ? l.cone : 0);
    if (l.dir) {
      const along = -dir.dot(l.dir.clone().normalize());
      const t = Math.max(0, Math.min(1, (along - l.cone) / 0.06));
      I *= t * t * (3 - 2 * t);
    }
    const e = (I * Math.max(0, face.dot(dir))) / (d * d);
    total += e;
    parts.push({ e, kelvin: l.kelvin });
  }
  const house = 250 * ambient; // house lights at full: about 250 lux on the performers
  total += house;
  const whites = parts.filter((p) => p.kelvin && p.e > total * 0.08);
  const ks = whites.map((p) => p.kelvin);
  return {
    lux: total, house,
    warm: Math.min(...ks, Infinity), cool: Math.max(...ks, -Infinity),
    mixed: ks.length > 1 && Math.max(...ks) - Math.min(...ks) >= 1500,
  };
}

export function createLightLab(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
  const blank = () => Array.from({ length: MAX }, () => new THREE.Vector3());
  const uniforms = {
    map: { value: null }, room: { value: new THREE.Vector3(5, 3, 5) }, eye: { value: EYE }, ambient: { value: 0.35 }, count: { value: 0 },
    lpos: { value: blank() }, lcol: { value: blank() }, lpow: { value: new Array(MAX).fill(0) },
    ldir: { value: blank() }, lcone: { value: new Array(MAX).fill(0) }, lsize: { value: new Array(MAX).fill(1) },
  };
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50),
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false })));

  let yaw = 0, pitch = -0.05, down = null, dirty = true;
  const el = renderer.domElement;
  el.style.cursor = "crosshair";
  el.style.touchAction = "none";
  const ray = new THREE.Raycaster();
  let onPick = null, grab = null; // grab: { start(hit) -> bool, move(hit), end() } for dragging a placed light
  const hitAt = (e) => {
    const r = el.getBoundingClientRect();
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    camera.updateMatrixWorld();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    return surfacePoint(ray.ray.direction);
  };
  let dragging = false;
  el.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    el.setPointerCapture(e.pointerId);
    dragging = !!grab?.start(hitAt(e));
    if (dragging) el.style.cursor = "grabbing";
  });
  el.addEventListener("pointermove", (e) => {
    if (dragging) { grab.move(hitAt(e)); return; }
    if (!down) return;
    yaw -= (e.clientX - down.x) * 0.004;
    pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - down.y) * 0.004));
    down.x = e.clientX; down.y = e.clientY;
    dirty = true;
  });
  el.addEventListener("pointerup", (e) => {
    const moved = down && Math.hypot(e.clientX - down.sx, e.clientY - down.sy) > 6;
    down = null;
    if (dragging) { dragging = false; el.style.cursor = ""; grab.end(); return; }
    if (moved || !onPick) return;
    // a click (not a drag) picks the wall, floor or ceiling point under the pointer
    const r = el.getBoundingClientRect();
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    camera.updateMatrixWorld();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    onPick(surfacePoint(ray.ray.direction));
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.fov = Math.max(35, Math.min(100, camera.fov + e.deltaY * 0.03));
    camera.updateProjectionMatrix();
    dirty = true;
  }, { passive: false });

  function surfacePoint(d) {
    const { x: hx, y: h, z: hz } = uniforms.room.value;
    const tx = (d.x > 0 ? hx : -hx) / (Math.abs(d.x) < 1e-4 ? 1e-4 : d.x);
    const tz = (d.z > 0 ? hz : -hz) / (Math.abs(d.z) < 1e-4 ? 1e-4 : d.z);
    const ty = d.y > 0 ? (h - EYE) / Math.max(d.y, 1e-4) : -EYE / Math.min(d.y, -1e-4);
    const t = Math.min(tx, ty, tz);
    const p = new THREE.Vector3(0, EYE, 0).addScaledVector(d, t);
    const n = t === tx ? new THREE.Vector3(-Math.sign(d.x), 0, 0) : t === tz ? new THREE.Vector3(0, 0, -Math.sign(d.z)) : new THREE.Vector3(0, -Math.sign(d.y), 0);
    return { p, n, d: d.clone() };
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(container);
  resize();

  (function frame() {
    requestAnimationFrame(frame);
    if (!dirty || !uniforms.map.value) return;
    dirty = false;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    renderer.render(scene, camera);
  })();

  return {
    async load(modelId, panoId, areaSqft, heightFt) {
      const tex = await new THREE.CubeTextureLoader().loadAsync(FACE_ORDER.map((i) => `/api/pano/${modelId}/${panoId}/${i}.jpg`));
      tex.colorSpace = THREE.SRGBColorSpace;
      uniforms.map.value?.dispose?.();
      uniforms.map.value = tex;
      // a box the size of the scanned room, a little longer than wide
      const area = Math.max(150, areaSqft || 800) * 0.0929;
      const w = Math.sqrt(area / 1.3), dpt = area / w;
      uniforms.room.value.set(w / 2, Math.max(2.6, (heightFt || 10) * 0.3048), dpt / 2);
      dirty = true;
    },
    room: () => uniforms.room.value.clone(),
    surfacePoint,
    onPick(fn) { onPick = fn; },
    /** While set, pressing on a placed light drags it instead of turning the view. */
    onGrab(handlers) { grab = handlers; el.style.cursor = handlers ? "grab" : "crosshair"; },
    setAmbient(v) { uniforms.ambient.value = v; dirty = true; },
    /** lights: [{ pos: Vector3, color: '#rrggbb', power, dir: Vector3|null, cone, size }] */
    setLights(lights) {
      const n = Math.min(MAX, lights.length);
      uniforms.count.value = n;
      for (let i = 0; i < MAX; i++) {
        const l = lights[i];
        uniforms.lpos.value[i].copy(l ? l.pos : new THREE.Vector3());
        uniforms.lcol.value[i].copy(l ? new THREE.Vector3(...new THREE.Color(l.color).toArray()) : new THREE.Vector3());
        uniforms.lpow.value[i] = l ? l.power : 0;
        uniforms.ldir.value[i].copy(l?.dir || new THREE.Vector3());
        uniforms.lcone.value[i] = l?.cone ?? 0;
        uniforms.lsize.value[i] = l?.size ?? 1;
      }
      dirty = true;
    },
    look(y, p) { yaw = y; pitch = p; dirty = true; },
    snapshot() { renderer.render(scene, camera); return el.toDataURL("image/jpeg", 0.85); },
  };
}

/** Turn a picked surface point into the fixtures a kind of light puts there. */
export function fixturesFor(kind, hit, room, color, power) {
  const k = KINDS[kind];
  const V = THREE.Vector3;
  const { p, n } = hit;
  if (kind === "spot") {
    // hung from the ceiling partway between you and the spot, aimed at it
    const from = new V(p.x * 0.45, room.y - 0.15, p.z * 0.45);
    return [{ pos: from, dir: p.clone().sub(from).normalize(), cone: k.cone, color, power, size: k.size }];
  }
  if (kind === "uplight") {
    // on the floor against the surface, washing up it
    const base = new V(p.x, 0.12, p.z).addScaledVector(n, 0.35);
    const aim = new V(p.x, Math.min(room.y, p.y + 1.6), p.z);
    return [{ pos: base, dir: aim.sub(base).normalize(), cone: k.cone, color, power, size: k.size }];
  }
  if (kind === "string") {
    // a swag of small bulbs along the surface, sagging between two ends
    const along = Math.abs(n.y) > 0.5 ? new V(1, 0, 0) : new V(-n.z, 0, n.x);
    const top = Math.min(room.y - 0.25, Math.max(1.8, p.y));
    return Array.from({ length: 5 }, (_, i) => {
      const s = (i - 2) / 2;
      const pos = new V(p.x, top - 0.35 * (1 - s * s), p.z).addScaledVector(along, s * 1.6).addScaledVector(n, 0.12);
      return { pos, dir: null, cone: 0, color, power, size: k.size };
    });
  }
  // a warm wash: a soft source a little in front of the surface
  return [{ pos: p.clone().addScaledVector(n, 0.8), dir: null, cone: 0, color, power, size: k.size }];
}
