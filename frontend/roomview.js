// See a room at showtime: the room's real 360 photo, relit for the time of day.
//
// The photo is a Matterport panorama (six cube faces) drawn on the inside of a
// cube you can look around in. A small shader changes how it looks with the sun:
//   - midday: as photographed
//   - golden hour: warmer, and the brightest parts of the photo (windows, glass,
//     sky) take on the low orange sun
//   - after sunset: windows go dark blue-black and the room is lit warm and dim,
//     the way it looks under its own lights
// It is a preview of the mood, not a lighting simulation, and the page says so.

import * as THREE from "./vendor/three.module.js";

const VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = `
  uniform samplerCube map;
  uniform float day;      // 0 night .. 1 full daylight
  uniform float golden;   // 0 .. 1 how much low warm sun
  uniform float windowy;  // 0 .. 1 how much glass the room has
  // Sun patches: the photo is treated as a box the size of the room (camera at eye height).
  // A point on the floor or a wall is in sun when the ray from it toward the sun leaves the
  // box through a window cell (cells found in this photo by the server, 25 cm square).
  uniform vec3 room;        // half width, height, half depth (m)
  uniform float eye;
  uniform vec3 sunDir;      // toward the sun, room frame
  uniform float sunOn;      // 0..1
  uniform vec4 shaded;      // per wall +x, -x, +z, -z: 1 when a neighbour shades it
  uniform sampler2D winTex; // rows: wall j's cells from j*rowsPerWall; columns: along the wall
  uniform vec2 winSize;     // columns, rowsPerWall
  uniform float hasWin;
  varying vec3 vDir;

  float windowAt(int j, float along, float halfLen, float y) {
    float ia = floor((along + halfLen) / 0.25);
    float ih = floor(y / 0.25);
    if (ia < 0.0 || ih < 0.0 || ia >= winSize.x || ih >= winSize.y) return 0.0;
    vec2 uv = vec2((ia + 0.5) / winSize.x, (float(j) * winSize.y + ih + 0.5) / (4.0 * winSize.y));
    return texture2D(winTex, uv).r;
  }

  float sunPatch(vec3 d) {
    if (sunOn <= 0.0 || hasWin <= 0.0 || sunDir.y <= 0.0) return 0.0;
    vec3 o = vec3(0.0, eye, 0.0);
    float tx = (d.x > 0.0 ? room.x : -room.x) / (abs(d.x) < 1e-4 ? 1e-4 : d.x);
    float tz = (d.z > 0.0 ? room.z : -room.z) / (abs(d.z) < 1e-4 ? 1e-4 : d.z);
    float ty = d.y > 0.0 ? (room.y - eye) / max(d.y, 1e-4) : -eye / min(d.y, -1e-4);
    float t = min(tx, min(ty, tz));
    if (t == ty && d.y > 0.0) return 0.0;              // the ceiling never gets sun here
    vec3 n = t == tx ? vec3(-sign(d.x), 0.0, 0.0) : t == tz ? vec3(0.0, 0.0, -sign(d.z)) : vec3(0.0, 1.0, 0.0);
    if (dot(n, sunDir) <= 0.0) return 0.0;              // facing away from the sun
    vec3 p = o + d * t + n * 0.01;
    float sx = (sunDir.x > 0.0 ? room.x : -room.x) - p.x;
    float sz = (sunDir.z > 0.0 ? room.z : -room.z) - p.z;
    float ex = abs(sunDir.x) > 1e-4 ? sx / sunDir.x : 1e9;
    float ez = abs(sunDir.z) > 1e-4 ? sz / sunDir.z : 1e9;
    float ey = (room.y - p.y) / sunDir.y;
    float e = min(ex, min(ez, ey));
    if (e == ey) return 0.0;                            // leaves through the ceiling
    vec3 q = p + sunDir * e;
    if (e == ex) {
      int j = sunDir.x > 0.0 ? 0 : 1;
      float sh = j == 0 ? shaded.x : shaded.y;
      return (1.0 - sh) * windowAt(j, q.z, room.z, q.y);
    }
    int j = sunDir.z > 0.0 ? 2 : 3;
    float sh = j == 2 ? shaded.z : shaded.w;
    return (1.0 - sh) * windowAt(j, q.x, room.x, q.y);
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 c = textureCube(map, d).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    // Windows: very bright, fairly colourless, and at eye level or above (not the floor).
    float above = smoothstep(-0.25, 0.05, d.y);
    float win = smoothstep(0.80, 0.97, lum) * (1.0 - smoothstep(0.18, 0.4, sat)) * above * (0.55 + 0.45 * windowy);
    // Golden hour: warm the whole room a little, the windows a lot.
    vec3 warm = c * vec3(1.08, 0.94, 0.78);
    vec3 glow = mix(c, vec3(1.0, 0.66, 0.32), 0.75);
    vec3 g = mix(warm, glow, win);
    vec3 dayCol = mix(c, g, golden);
    // Night: dark glass, warm dim lamps elsewhere.
    vec3 lamp = pow(c, vec3(1.15)) * vec3(1.0, 0.8, 0.56) * 0.7;
    vec3 nightCol = mix(lamp, vec3(0.06, 0.07, 0.10), win * 0.9);
    vec3 col = mix(nightCol, dayCol, day);
    // Direct sun through the windows: warmer the lower the sun.
    float sunAmt = sunPatch(d) * sunOn;
    vec3 sunCol = mix(vec3(1.0, 0.62, 0.32), vec3(1.0, 0.95, 0.86), clamp((sunDir.y - 0.08) / 0.5, 0.0, 1.0));
    vec3 boosted = col * (1.0 + 1.1 * sunCol) + 0.07 * sunCol;
    boosted = 1.0 - exp(-boosted * 1.8);               // soft shoulder so a patch blooms instead of clipping
    col = mix(col, max(boosted, col), sunAmt);
    gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
  }`;

// Matterport skybox faces: 0 up, 1 front, 2 right, 3 back, 4 left, 5 down.
// three.js cube order: +x, -x, +y, -y, +z, -z.
const FACE_ORDER = [2, 4, 0, 5, 1, 3];

export function createRoomViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 100);
  const blankWin = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  blankWin.needsUpdate = true;
  const uniforms = {
    map: { value: null }, day: { value: 1 }, golden: { value: 0 }, windowy: { value: 0.5 },
    room: { value: new THREE.Vector3(5, 3, 5) }, eye: { value: 1.55 }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunOn: { value: 0 }, shaded: { value: new THREE.Vector4() }, winTex: { value: blankWin },
    winSize: { value: new THREE.Vector2(1, 1) }, hasWin: { value: 0 },
  };
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(50, 50, 50),
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false }),
  );
  scene.add(cube);

  let yaw = 0, pitch = 0, dragging = null, dirty = true, autoTurn = true;
  const el = renderer.domElement;
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e) => { dragging = { x: e.clientX, y: e.clientY }; autoTurn = false; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointerup", () => { dragging = null; el.style.cursor = "grab"; });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - dragging.x) * 0.004;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - (e.clientY - dragging.y) * 0.004));
    dragging = { x: e.clientX, y: e.clientY };
    dirty = true;
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.fov = Math.max(35, Math.min(95, camera.fov + e.deltaY * 0.03));
    camera.updateProjectionMatrix();
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

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(container);
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    if (autoTurn && uniforms.map.value) { yaw += 0.0012; dirty = true; }
    if (!dirty) return;
    dirty = false;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    renderer.render(scene, camera);
  }
  frame();

  return {
    async load(modelId, panoId) {
      const urls = FACE_ORDER.map((i) => `/api/pano/${modelId}/${panoId}/${i}.jpg`);
      const tex = await new THREE.CubeTextureLoader().loadAsync(urls);
      tex.colorSpace = THREE.SRGBColorSpace;
      uniforms.map.value?.dispose?.();
      uniforms.map.value = tex;
      dirty = true;
    },
    /** sun: {altitude} degrees; windowy: 0..1 from the scan description. */
    setLight(sun, windowy = 0.5) {
      const alt = sun.altitude;
      uniforms.day.value = Math.max(0, Math.min(1, (alt + 4) / 10));
      uniforms.golden.value = alt > -4 ? Math.max(0, Math.min(1, 1 - (alt - 2) / 14)) : 0;
      uniforms.windowy.value = windowy;
      dirty = true;
    },
    /** The room box and the window cells the server found in this photo (/api/daylight). */
    setWindows(room, walls) {
      uniforms.room.value.set(room.w / 2, room.h, room.d / 2);
      const cols = Math.max(1, ...walls.map((w) => w.na)), rows = Math.max(1, ...walls.map((w) => w.nh));
      const px = new Uint8Array(cols * rows * 4 * 4);
      let any = 0;
      ["+x", "-x", "+z", "-z"].forEach((id, j) => {
        const w = walls.find((x) => x.id === id);
        (w?.cells || []).forEach(([a, h]) => { px[((j * rows + h) * cols + a) * 4] = 255; any = 1; });
      });
      uniforms.winTex.value?.dispose?.();
      const tex = new THREE.DataTexture(px, cols, rows * 4, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      uniforms.winTex.value = tex;
      uniforms.winSize.value.set(cols, rows);
      uniforms.hasWin.value = any;
      dirty = true;
    },
    /** sunDir: unit vector toward the sun in the room frame; shaded: walls a neighbour shades. */
    setSunPatches(sunDir, shaded = []) {
      uniforms.sunDir.value.set(...sunDir);
      uniforms.sunOn.value = sunDir[1] > 0 ? Math.min(1, sunDir[1] / 0.04) : 0;
      uniforms.shaded.value.set(...["+x", "-x", "+z", "-z"].map((w) => (shaded.includes(w) ? 1 : 0)));
      dirty = true;
    },
    clearWindows() { uniforms.hasWin.value = 0; dirty = true; },
  };
}
