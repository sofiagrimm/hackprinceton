// Drive the Matterport 3D tour with the Showcase SDK:
//   * fly the visitor to the recommended room,
//   * pin a "Perform here" label inside it,
//   * "walk and listen": whenever the visitor walks into another room, measure
//     that room's acoustics and switch the hear-the-room sound to match.
//
// The SDK key from the CoStar track is only valid on localhost, so on other
// domains we fall back to the plain embed (no key needed for public scans).

const SDK_URL = "https://static.matterport.com/showcase-sdk/latest.js";
let sdkScript = null;

function loadSdk() {
  if (window.MP_SDK) return Promise.resolve();
  if (!sdkScript) {
    sdkScript = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SDK_URL;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return sdkScript;
}

export function sdkUsable(key, allowedHosts = []) {
  if (!key) return false;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || allowedHosts.includes(host);
}

/**
 * Load a model into the iframe. With a usable key, connect the SDK and wire
 * the room features; otherwise just show the plain tour.
 * hooks: { targetAreaSqft, label, onRoomChange(room) }
 */
export async function loadTour(iframe, modelId, key, hooks = {}) {
  const base = `https://my.matterport.com/show/?m=${modelId}&play=1&qs=1&brand=0`;
  if (!sdkUsable(key, hooks.allowedHosts)) {
    iframe.src = base;
    return null;
  }
  iframe.src = `${base}&applicationKey=${key}`;
  try {
    await loadSdk();
    await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
    const sdk = await window.MP_SDK.connect(iframe, key, "");
    await waitForPlaying(sdk);
    const rooms = await collect(sdk.Room?.data);
    const sweeps = await collect(sdk.Sweep?.data);
    const target = pickRoom(rooms, hooks.targetAreaSqft);
    if (target) {
      await flyInto(sdk, target, sweeps);
      await pinLabel(sdk, target, hooks.label);
    }
    watchRooms(sdk, rooms, hooks.onRoomChange);
    return sdk;
  } catch (err) {
    console.warn("Matterport SDK unavailable, showing the plain tour:", err);
    return null;
  }
}

function waitForPlaying(sdk) {
  return new Promise((resolve) => {
    if (!sdk.App?.state) return resolve();
    const sub = sdk.App.state.subscribe((s) => {
      if (s.phase === sdk.App.Phase.PLAYING) {
        sub?.cancel?.();
        resolve();
      }
    });
    setTimeout(resolve, 15000);
  });
}

/** Snapshot an SDK observable collection into a plain array. */
function collect(observable) {
  return new Promise((resolve) => {
    if (!observable) return resolve([]);
    let done = false;
    const sub = observable.subscribe({
      onCollectionUpdated(collection) {
        if (done) return;
        done = true;
        resolve(Object.entries(collection).map(([id, v]) => ({ id, ...v })));
        setTimeout(() => sub?.cancel?.(), 0);
      },
    });
    setTimeout(() => { if (!done) { done = true; resolve([]); } }, 8000);
  });
}

const SQM_TO_SQFT = 10.7639;
const M_TO_FT = 3.28084;

export function roomGeometry(room) {
  const size = room.size || sizeFromBounds(room.bounds);
  if (!size) return null;
  return {
    areaSqft: size.x * size.z * SQM_TO_SQFT,
    widthFt: size.x * M_TO_FT,
    depthFt: size.z * M_TO_FT,
    heightFt: size.y * M_TO_FT,
  };
}

function sizeFromBounds(b) {
  if (!b?.min || !b?.max) return null;
  return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
}

function centerOf(room) {
  if (room.center) return room.center;
  const b = room.bounds;
  if (!b?.min) return null;
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
}

/** The scanned room closest in floor area to the space we recommended (else the largest). */
function pickRoom(rooms, targetAreaSqft) {
  const sized = rooms.map((r) => ({ r, g: roomGeometry(r) })).filter((x) => x.g && x.g.areaSqft > 50);
  if (!sized.length) return null;
  if (targetAreaSqft) {
    sized.sort((a, b) => Math.abs(a.g.areaSqft - targetAreaSqft) - Math.abs(b.g.areaSqft - targetAreaSqft));
  } else {
    sized.sort((a, b) => b.g.areaSqft - a.g.areaSqft);
  }
  return sized[0].r;
}

async function flyInto(sdk, room, sweeps) {
  const c = centerOf(room);
  if (!c || !sweeps.length) return;
  const inRoom = sweeps.filter((s) => s.roomInfo?.id === room.id);
  const pool = inRoom.length ? inRoom : sweeps;
  const nearest = pool.reduce((best, s) => {
    const p = s.position || {};
    const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
    return !best || d < best.d ? { s, d } : best;
  }, null);
  if (!nearest) return;
  try {
    await sdk.Sweep.moveTo(nearest.s.id || nearest.s.sid, {
      transition: sdk.Sweep.Transition?.FLY,
      transitionTime: 2500,
    });
  } catch (err) {
    console.warn("moveTo failed", err);
  }
}

async function pinLabel(sdk, room, label) {
  const c = centerOf(room);
  if (!c || !label) return;
  const tag = {
    label: label.title,
    description: label.description,
    anchorPosition: { x: c.x, y: (room.bounds?.min?.y ?? c.y) + 0.1, z: c.z },
    stemVector: { x: 0, y: 1.4, z: 0 },
    color: { r: 1, g: 0.19, b: 0.35 },
  };
  try {
    if (sdk.Tag?.add) await sdk.Tag.add(tag);
    else if (sdk.Mattertag?.add) await sdk.Mattertag.add(tag);
  } catch (err) {
    console.warn("could not add tag", err);
  }
}

function watchRooms(sdk, rooms, onRoomChange) {
  if (!sdk.Room?.current || !onRoomChange) return;
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
  let last = null;
  sdk.Room.current.subscribe((current) => {
    const room = current?.rooms?.[0];
    if (!room || room.id === last) return;
    last = room.id;
    const full = byId[room.id] || room;
    const g = roomGeometry(full);
    if (g) onRoomChange({ id: room.id, label: full.label || full.classification || null, ...g });
  });
}
