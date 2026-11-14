// Stand in the room: a 3D model of the room at its real size, with the singers and you in it.
// Drag the people around the floor; the chord is rendered for exactly where you stand:
// the direct sound and the reflections off all six surfaces (image sources, up to two bounces),
// each delayed, quieted and panned by the path it takes, then the room's own reverberant tail.
// The room is a box at the scanned length, width and height, not its exact shape.

import * as THREE from "./vendor/three.module.js";
import { RoomSound } from "./audio.js";

const C = 343; // speed of sound, m/s
const FACE_ORDER = [2, 4, 0, 5, 1, 3]; // Matterport skybox faces in three.js cube order
const PANO_EYE = 1.5; // the scan camera's height, metres

// The room's own 360 photo, projected onto the box from where the scan camera stood:
// each wall and floor point takes the colour the camera saw in that direction.
const PANO_VERT = `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const PANO_FRAG = `
  uniform samplerCube map;
  uniform vec3 eye;
  uniform float shade;
  uniform float calm; // how much to quiet the photo (the floor smears furniture flat)
  varying vec3 vWorld;
  void main() {
    vec3 c = textureCube(map, normalize(vWorld - eye)).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l) * vec3(1.02, 0.97, 0.92), calm * 0.55);
    gl_FragColor = vec4(c * shade, 1.0);
    #include <colorspace_fragment>
  }`;
const CHERRY = 0x8e1424, CREAM = 0xf3ece1, GOLD = 0xd9a441;

function person(color, height = 1.7) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, height * 0.72, 16), mat);
  body.position.y = height * 0.36;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat);
  head.position.y = height * 0.72 + 0.14;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.34, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  g.add(body, head, ring);
  g.userData.body = body;
  return g;
}

export function createStandView(container, { onMove } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const el = renderer.domElement;
  el.style.touchAction = "none";
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff2e6, 0x3a1517, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, 12, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  let roomGroup = null, dims = { length: 12, width: 8, height: 3.5 }, pano = null;
  const singers = [];
  const listener = person(CREAM, 1.65);
  scene.add(listener);
  let orbit = { theta: -0.9, phi: 0.95, r: 22 };
  let dirty = true;

  function place(obj, x, z) {
    const hl = dims.length / 2 - 0.35, hw = dims.width / 2 - 0.35;
    obj.position.set(Math.max(-hl, Math.min(hl, x)), 0, Math.max(-hw, Math.min(hw, z)));
  }

  function buildRoom() {
    if (roomGroup) scene.remove(roomGroup);
    roomGroup = new THREE.Group();
    const { length: L, width: W, height: H } = dims;
    // floor, with a 1 m grid
    const panoMat = (shade, calm = 0) => new THREE.ShaderMaterial({
      uniforms: { map: { value: pano }, eye: { value: new THREE.Vector3(0, PANO_EYE, 0) }, shade: { value: shade }, calm: { value: calm } },
      vertexShader: PANO_VERT, fragmentShader: PANO_FRAG, side: THREE.BackSide,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(L, W),
      pano ? panoMat(0.78, 1) : new THREE.MeshStandardMaterial({ color: 0x6e3f3f, roughness: 0.9 }));
    if (pano) floor.material.side = THREE.DoubleSide;
    floor.rotation.x = -Math.PI / 2;
    floor.name = "floor";
    roomGroup.add(floor);
    const grid = new THREE.GridHelper(Math.max(L, W), Math.round(Math.max(L, W)), 0x9a6a64, 0x7d4b4b);
    grid.scale.set(L / Math.max(L, W), 1, W / Math.max(L, W));
    grid.position.y = 0.005;
    if (pano) { grid.material.transparent = true; grid.material.opacity = 0.18; }
    roomGroup.add(grid);
    // the stage: the front few metres
    const stage = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3, L * 0.25), W * 0.8), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.22 }));
    stage.rotation.x = -Math.PI / 2;
    stage.position.set(-L / 2 + Math.min(3, L * 0.25) / 2, 0.01, 0);
    roomGroup.add(stage);
    // walls: see-through from outside, faint from inside
    // walls: from outside you see the far walls' inner faces (a dollhouse); the near ones step aside
    const box = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), pano
      ? [panoMat(0.92), panoMat(0.92), panoMat(1.05), panoMat(0.85), panoMat(0.92), panoMat(0.92)]
      : new THREE.MeshStandardMaterial({ color: 0xe9ddd0, transparent: true, opacity: 0.1, side: THREE.BackSide, depthWrite: false }));
    if (pano) box.material[3].visible = false; // the floor plane already covers the bottom
    box.position.y = H / 2;
    roomGroup.add(box);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), new THREE.LineBasicMaterial({ color: CREAM }));
    edges.position.y = H / 2;
    roomGroup.add(edges);
    scene.add(roomGroup);
    orbit.r = Math.max(L, W) * 1.45 + 4;
  }

  function setSingers(n) {
    while (singers.length > n) scene.remove(singers.pop());
    while (singers.length < n) { const s = person(CHERRY, 1.7); singers.push(s); scene.add(s); }
    arrange();
  }

  /** Singers in a shallow arc on the stage; you about a third of the way back. */
  function arrange() {
    const { length: L, width: W } = dims;
    const n = singers.length;
    const rows = n > 10 ? 2 : 1, perRow = Math.ceil(n / rows);
    singers.forEach((s, i) => {
      const row = Math.floor(i / perRow), k = i % perRow, m = Math.min(perRow, n - row * perRow);
      const spread = Math.min(W * 0.7, m * 0.7);
      const z = m > 1 ? -spread / 2 + (k * spread) / (m - 1) : 0;
      place(s, -L / 2 + 0.9 + row * 0.8 + Math.abs(z) * 0.18, z);
    });
    place(listener, -L / 2 + Math.max(3, L * 0.38), W * 0.08);
    dirty = true;
  }

  // ---------------------------------------------------------------- dragging and orbiting
  const ray = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag = null, spin = null;
  const ndc = (e) => { const r = el.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  el.addEventListener("pointerdown", (e) => {
    ray.setFromCamera(ndc(e), camera);
    const people = [listener, ...singers];
    const hit = ray.intersectObjects(people, true)[0];
    if (hit) {
      drag = people.find((p) => p === hit.object.parent || p === hit.object);
      el.style.cursor = "grabbing";
    } else spin = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (drag) {
      ray.setFromCamera(ndc(e), camera);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(floorPlane, p)) { place(drag, p.x, p.z); dirty = true; onMove?.(true); }
    } else if (spin) {
      orbit.theta -= (e.clientX - spin.x) * 0.006;
      orbit.phi = Math.max(0.25, Math.min(1.45, orbit.phi - (e.clientY - spin.y) * 0.005));
      spin = { x: e.clientX, y: e.clientY };
      dirty = true;
    } else {
      ray.setFromCamera(ndc(e), camera);
      el.style.cursor = ray.intersectObjects([listener, ...singers], true).length ? "grab" : "move";
    }
  });
  el.addEventListener("pointerup", () => {
    if (drag) onMove?.(false);
    drag = null; spin = null; el.style.cursor = "grab";
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbit.r = Math.max(4, Math.min(120, orbit.r * (1 + e.deltaY * 0.001)));
    dirty = true;
  }, { passive: false });

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
    if (!dirty) return;
    dirty = false;
    const { r, theta, phi } = orbit;
    camera.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) + 1, r * Math.sin(phi) * Math.sin(theta));
    camera.lookAt(0, dims.height * 0.25, 0);
    renderer.render(scene, camera);
  })();

  return {
    setRoom(d, voices) {
      dims = { length: d.length, width: d.width, height: d.height };
      buildRoom();
      setSingers(voices);
    },
    setVoices: setSingers,
    /** Dress the room in its own 360 photo (or pass nulls to go back to the plain box). */
    async setPanorama(modelId, panoId) {
      if (!modelId) { pano = null; buildRoom(); dirty = true; return; }
      const tex = await new THREE.CubeTextureLoader().loadAsync(FACE_ORDER.map((i) => `/api/pano/${modelId}/${panoId}/${i}.jpg`));
      tex.colorSpace = THREE.SRGBColorSpace;
      pano?.dispose?.();
      pano = tex;
      buildRoom();
      dirty = true;
    },
    reset: arrange,
    /** Positions in metres with the room's corner at the origin: x along the length, z across, y up. */
    positions() {
      const off = (o, y) => [o.position.x + dims.length / 2, y, o.position.z + dims.width / 2];
      return { listener: off(listener, 1.2), singers: singers.map((s) => off(s, 1.5)), dims };
    },
  };
}

// ---------------------------------------------------------------- the sound at your seat

const img = (n, x, L) => n * L + (n % 2 === 0 ? x : L - x);

/**
 * A stereo impulse response for one listener and a group of singers in a box room.
 * rt: reverberation time (s). Returns { buffer, nearest, critical }.
 */
export function seatImpulse(ctx, pos, rt) {
  const { length: L, width: W, height: H } = pos.dims;
  const sr = ctx.sampleRate;
  const V = L * W * H, S = 2 * (L * W + L * H + W * H);
  const alpha = Math.max(0.03, Math.min(0.9, (0.161 * V) / (S * Math.max(rt, 0.1))));
  const beta = Math.sqrt(1 - alpha);
  const R = (S * alpha) / (1 - alpha);
  const critical = 0.057 * Math.sqrt(V / Math.max(rt, 0.1));
  const seconds = Math.min(6, Math.max(0.6, rt * 1.3));
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const Lc = buf.getChannelData(0), Rc = buf.getChannelData(1);
  const [lx, ly, lz] = pos.listener;
  const singers = pos.singers.slice(0, 16);
  const norm = 1 / Math.sqrt(singers.length || 1);
  let nearest = Infinity;
  let firstTail = 0;
  for (const [sx, sy, sz] of singers) {
    nearest = Math.min(nearest, Math.hypot(sx - lx, sz - lz));
    for (let nx = -2; nx <= 2; nx++) for (let ny = -2; ny <= 2; ny++) for (let nz = -2; nz <= 2; nz++) {
      const order = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
      if (order > 2) continue;
      const ix = img(nx, sx, L), iy = img(ny, sy, H), iz = img(nz, sz, W);
      const dx = ix - lx, dy = iy - ly, dz = iz - lz;
      const d = Math.max(0.4, Math.hypot(dx, dy, dz));
      const t = d / C;
      firstTail = Math.max(firstTail, t);
      const g = (Math.pow(beta, order) / d) * norm;
      // you face the stage (towards x = 0): sound from your left reaches the left ear first and louder
      const side = Math.max(-1, Math.min(1, dz / d)); // +z is your left when facing -x
      const gl = g * Math.sqrt((1 + side) / 2) * 1.2, gr = g * Math.sqrt((1 - side) / 2) * 1.2;
      const itd = side * 0.00066;
      const il = Math.floor((t + Math.max(0, -itd)) * sr), ir = Math.floor((t + Math.max(0, itd)) * sr);
      if (il < len) Lc[il] += gl;
      if (ir < len) Rc[ir] += gr;
    }
  }
  // the reverberant tail: decaying noise, darker as it ages, at the energy the room's absorption allows
  const start = Math.floor(firstTail * 0.8 * sr);
  const decay = 6.91 / Math.max(rt, 0.05);
  const tail = [new Float32Array(len), new Float32Array(len)];
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    let lp = 0;
    for (let i = start; i < len; i++) {
      const tt = (i - start) / sr;
      const bright = Math.max(0.1, 0.85 * Math.exp(-tt * (2 / Math.max(rt, 0.2))));
      lp += bright * ((Math.random() * 2 - 1) - lp);
      const v = lp * Math.exp(-decay * tt) * Math.min(1, (i - start) / (sr * 0.02));
      tail[ch][i] = v;
      energy += v * v;
    }
  }
  // reverberant energy relative to a direct sound at 1 m (Hopkins-Stryker): 16 pi / R per singer, shared between ears
  const target = ((16 * Math.PI) / R) * singers.length * norm * norm;
  const k = energy > 0 ? Math.sqrt(target / (energy / 2)) * 0.5 : 0;
  for (let i = start; i < len; i++) { Lc[i] += tail[0][i] * k; Rc[i] += tail[1][i] * k; }
  // keep the overall level sensible without hiding how distance changes it
  for (const ch of [Lc, Rc]) for (let i = 0; i < len; i++) ch[i] *= 1.6;
  return { buffer: buf, nearest, critical };
}

/** A RoomSound whose reverb is replaced by the seat impulse, with no separate dry path. */
export class SeatSound extends RoomSound {
  useImpulse(buffer) {
    this._ensure();
    this.convolver.buffer = buffer;
    const now = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(0, now, 0.02);
    this.wet.gain.setTargetAtTime(1, now, 0.02);
  }
  setRoom() { /* the seat impulse decides the room sound */ }
}
