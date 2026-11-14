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
  varying vec3 vDir;
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
    // Gentle vignette, like a camera.
    gl_FragColor = vec4(col, 1.0);
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
  const uniforms = {
    map: { value: null }, day: { value: 1 }, golden: { value: 0 }, windowy: { value: 0.5 },
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
  };
}
