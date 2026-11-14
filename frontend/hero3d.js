// The hero: a live 3D model of the venue, built from real data.
//
//  * ground  - the Vexcel aerial photo of the parcel, georeferenced to metres
//  * building - the Vexcel footprint polygon extruded to the building's height
//  * sun     - a directional light placed from the real solar position for the
//              venue, date and time, so the shadows are the shadows you'd see
//  * sound   - rings that ripple out from the stage and fade at the speed of
//              the room's reverberation (RT60): a dry room's rings die fast,
//              a live room's linger
//
// Everything is plain three.js and renders in a few milliseconds a frame.

import * as THREE from "./vendor/three.module.js";

const M_PER_DEG = 111320;

export function createHero(container, { shiftX = 0, zoom = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050507, 260, 620);
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 3000);

  const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x1a1410, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const world = new THREE.Group();
  scene.add(world);

  // Endless dark floor so the parcel floats in space.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(900, 64),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  scene.add(floor);

  let radius = 80;
  let framing = 120;
  let center = new THREE.Vector3();
  let rt60 = 1.6;
  let rings = [];
  let ringClock = 0;
  let pulseUntil = 0;
  let angle = 0.6;
  let scroll = 0;
  let eased = 0;
  let visible = true;

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    // Push the model sideways so it sits beside the copy instead of under it.
    if (shiftX) camera.setViewOffset(w, h, -w * shiftX, 0, w, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(container);

  function clear() {
    world.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
    });
    world.clear();
    rings = [];
  }

  /** site: the /api/venues/:id/site payload; imageUrl: the aerial JPEG. */
  async function showVenue(site, imageUrl) {
    clear();
    const b = site.image_bounds;
    const lat0 = (b.north + b.south) / 2, lon0 = (b.east + b.west) / 2;
    const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
    const toLocal = ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG]; // x east, y north

    const groundW = (b.east - b.west) * kx;
    const groundH = (b.north - b.south) * M_PER_DEG;
    const tex = await new THREE.TextureLoader().loadAsync(imageUrl).catch(() => null);
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundW, groundH),
      new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x222226, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    world.add(ground);

    // Thin glowing edge around the photo tile.
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(groundW, 0.2, groundH)),
      new THREE.LineBasicMaterial({ color: 0x2a2a30 }),
    );
    edge.position.y = 0.1;
    world.add(edge);

    const heightM = Math.max(6, (site.building_height_ft || 40) * 0.3048);
    let pts = (site.footprint || []).map(toLocal);
    if (pts.length < 3) {
      const side = Math.sqrt((site.aerial?.footprint_sqft || 8000) * 0.0929);
      pts = [[-side / 2, -side / 2], [side / 2, -side / 2], [side / 2, side / 2], [-side / 2, side / 2]];
    }
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const building = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
      color: 0xf2f2f5, roughness: 0.25, metalness: 0.08,
      clearcoat: 0.7, clearcoatRoughness: 0.3, transparent: true, opacity: 0.86,
    }));
    building.castShadow = true;
    building.receiveShadow = true;
    world.add(building);

    // Floor lines every ~4 m, like a model maker's contour slices.
    const floors = Math.max(1, Math.floor(heightM / 4));
    const outline = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]].map(([x, y]) => new THREE.Vector3(x, 0, -y)));
    for (let i = 1; i <= floors; i++) {
      const line = new THREE.Line(outline, new THREE.LineBasicMaterial({
        color: 0xff375f, transparent: true, opacity: i === floors ? 0.95 : 0.12,
      }));
      line.position.y = (heightM * i) / floors;
      world.add(line);
    }

    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    center = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, 0, -(Math.min(...ys) + Math.max(...ys)) / 2);
    radius = Math.max(groundW, groundH) * 0.7;
    framing = Math.max(groundW, groundH, heightM * 1.9);
    const sr = Math.max(radius, framing);
    sun.shadow.camera.left = -sr * 1.6; sun.shadow.camera.right = sr * 1.6;
    sun.shadow.camera.top = sr * 1.6; sun.shadow.camera.bottom = -sr * 1.6;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = sr * 8;
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(center);
    container.dataset.ready = "1";
  }

  /** sun: {altitude, azimuth} in degrees (azimuth clockwise from north). */
  function setSun({ altitude, azimuth }) {
    const alt = (Math.max(altitude, -4) * Math.PI) / 180, az = (azimuth * Math.PI) / 180;
    const dist = Math.max(radius, framing) * 3;
    sun.position.set(
      center.x + Math.sin(az) * Math.cos(alt) * dist,
      Math.max(Math.sin(alt) * dist, 2),
      center.z - Math.cos(az) * Math.cos(alt) * dist,
    );
    const day = THREE.MathUtils.clamp(altitude / 25, 0, 1);
    const golden = THREE.MathUtils.clamp(1 - Math.abs(altitude - 4) / 10, 0, 1);
    sun.intensity = altitude > 0 ? 0.9 + 2.3 * day + 0.6 * golden : 0;
    sun.color.setRGB(1, 0.86 + 0.14 * day - 0.14 * golden, 0.72 + 0.28 * day - 0.3 * golden);
    hemi.intensity = 0.32 + 0.4 * day;
    renderer.toneMappingExposure = 0.85 + 0.3 * day + 0.2 * golden;
  }

  /** The room's reverberation sets how long the sound rings live. */
  function setReverb(seconds) { rt60 = Math.max(0.2, seconds || 1.5); }
  function pulse(seconds = 4) { pulseUntil = performance.now() + seconds * 1000; }

  function spawnRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 96),
      new THREE.MeshBasicMaterial({ color: 0xff375f, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(center.x, 0.4, center.z);
    ring.userData.born = performance.now();
    world.add(ring);
    rings.push(ring);
  }

  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = clock.getDelta();
    angle += dt * 0.035;
    // Scroll-scrubbed camera: close and low at the top (immersive), pulling
    // back and up as the visitor scrolls. Eased so it glides, and it rewinds
    // when they scroll back.
    eased += (scroll - eased) * Math.min(1, dt * 4);
    const p = eased;
    const r = (framing * (1.7 + p * 1.3)) / zoom;
    const lift = 0.38 + p * 0.4;
    const a = angle + p * 2.4;
    camera.position.set(center.x + Math.cos(a) * r, r * lift, center.z + Math.sin(a) * r);
    // Aim above the roof so the model sits in the lower part of the frame, under the headline.
    camera.lookAt(center.x, framing * (0.62 - p * 0.12), center.z);

    // Rings: one per beat; louder and more frequent while audio plays.
    const playing = performance.now() < pulseUntil;
    ringClock += dt;
    if (container.dataset.ready && ringClock > (playing ? 0.45 : 1.6)) { ringClock = 0; spawnRing(); }
    const now = performance.now();
    rings = rings.filter((ring) => {
      const age = (now - ring.userData.born) / 1000;
      const life = rt60 * 1.6;
      if (age > life) { world.remove(ring); ring.geometry.dispose(); ring.material.dispose(); return false; }
      const s = 4 + age * (radius * 0.55);
      ring.scale.set(s, s, 1);
      // 60 dB of decay over RT60: amplitude falls as 10^(-3 t / RT60)
      ring.material.opacity = (playing ? 0.95 : 0.55) * Math.pow(10, (-3 * age) / rt60);
      return true;
    });
    renderer.render(scene, camera);
  }
  frame();

  /** 0 at the top of the pinned hero, 1 at its end. */
  function setScroll(p) { scroll = Math.min(1, Math.max(0, p)); }

  return { showVenue, setSun, setReverb, pulse, setScroll };
}
