// Snap Vanish — on-device ML engine (extension page). Nothing here touches the network.
const url = (p) => chrome.runtime.getURL(p);
const state = { status: 'loading', lama: 'off', error: '' };
let hand = null, seg = null, labels = [], lastTs = 0, worker = null, rid = 0;
const pending = new Map();

function dataUrlToBlob(u) {
  const i = u.indexOf(',');
  const bin = atob(u.slice(i + 1));
  const a = new Uint8Array(bin.length);
  for (let k = 0; k < a.length; k++) a[k] = bin.charCodeAt(k);
  return new Blob([a], { type: u.slice(5, u.indexOf(';')) });
}
function blobToDataUrl(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (!m || m.target !== 'offscreen') return;
  if (m.type === 'frame') { handleFrame(m).then(reply, (e) => reply({ status: 'error', error: String(e) })); return true; }
  if (m.type === 'inpaint') { handleInpaint(m).then(reply, (e) => { state.lama = 'ready'; reply({ error: String(e) }); }); return true; }
});

async function init() {
  try {
    const V = await import('./vendor/mediapipe/vision_bundle.mjs');
    const fileset = await V.FilesetResolver.forVisionTasks(url('vendor/mediapipe/wasm'));
    hand = await V.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: url('vendor/models/hand_landmarker.task') },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4
    });
    seg = await V.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: url('vendor/models/selfie_segmenter.tflite') },
      runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true
    });
    try { labels = seg.getLabels ? seg.getLabels() : []; } catch (e) { labels = []; }
    state.status = 'ready';
    initLama();
  } catch (e) {
    const msg = String(e && e.message || e);
    state.status = /dynamically imported|Failed to fetch|not found|404|NetworkError/i.test(msg) ? 'missing' : 'error';
    state.error = msg.slice(0, 200);
  }
}

async function initLama() {
  try {
    const r = await fetch(url('vendor/lama_fp32.onnx'), { method: 'HEAD' });
    if (!r.ok) throw new Error('missing');
  } catch (e) { state.lama = 'missing'; return; }
  state.lama = 'loading';
  worker = new Worker('lama-worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') state.lama = 'ready';
    else if (m.type === 'error') { state.lama = 'error'; state.error = m.error; }
    else if (m.type === 'done' || m.type === 'fail') {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) (m.type === 'done' ? p.resolve(m) : p.reject(new Error(m.error)));
    }
  };
  worker.postMessage({ type: 'init', base: url('') });
}

function packMask(r) {
  const cms = r.confidenceMasks;
  if (!cms || !cms.length) return null;
  let idx = 0;
  if (cms.length > 1) {
    idx = labels.findIndex((l) => /person|selfie|foreground/i.test(l));
    if (idx < 0) idx = cms.length - 1;
  }
  const m = cms[idx];
  const f = m.getAsFloat32Array(), w = m.width, h = m.height;
  // Sanity check: the top edge of a webcam frame is almost never "person". If it is, the mask is inverted.
  let hit = 0, tot = 0;
  for (let x = 0; x < w; x++) { hit += f[x] > 0.5 ? 1 : 0; tot++; }
  for (let y = 0; y < h >> 1; y++) { hit += (f[y * w] > 0.5 ? 1 : 0) + (f[y * w + w - 1] > 0.5 ? 1 : 0); tot += 2; }
  const inv = hit / tot > 0.65;
  const bytes = new Uint8Array((w * h + 7) >> 3);
  for (let i = 0; i < w * h; i++) {
    const on = f[i] > 0.5;
    if (on !== inv) bytes[i >> 3] |= 1 << (i & 7);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  return { w, h, b64: btoa(s) };
}

async function handleFrame(m) {
  if (state.status !== 'ready') return { status: state.status, lama: state.lama, error: state.error };
  const bmp = await createImageBitmap(dataUrlToBlob(m.img));
  const ts = Math.max(lastTs + 1, Math.round(performance.now()));
  lastTs = ts;
  let hands = [], mask = null;
  try {
    const hr = hand.detectForVideo(bmp, ts);
    const lms = hr.landmarks || [];
    const hd = hr.handedness || hr.handednesses || [];
    hands = lms.map((lm, i) => ({
      h: (hd[i] && hd[i][0] && hd[i][0].categoryName) || 'H' + i,
      p: lm.flatMap((q) => [Math.round(q.x * 10000) / 10000, Math.round(q.y * 10000) / 10000])
    }));
  } catch (e) { state.error = 'hand: ' + e; }
  try { seg.segmentForVideo(bmp, ts, (r) => { mask = packMask(r); }); } catch (e) { state.error = 'seg: ' + e; }
  bmp.close();
  return { status: 'ready', lama: state.lama, hands, mask, error: state.error };
}

function dilate(src, w, h, r) {
  const tmp = new Uint8Array(w * h), dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
    for (let k = a; k <= b; k++) if (src[y * w + k]) { v = 1; break; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) { const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) { let v = 0;
      for (let k = a; k <= b; k++) if (tmp[k * w + x]) { v = 1; break; }
      dst[y * w + x] = v; } }
  return dst;
}

async function handleInpaint(m) {
  if (state.lama !== 'ready' || !worker) return {};
  state.lama = 'busy';
  const S = 512, P = S * S;
  const [ib, mb] = await Promise.all([createImageBitmap(dataUrlToBlob(m.img)), createImageBitmap(dataUrlToBlob(m.mask))]);
  const c = new OffscreenCanvas(S, S), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ib, 0, 0, S, S);
  const id = x.getImageData(0, 0, S, S).data;
  x.clearRect(0, 0, S, S); x.drawImage(mb, 0, 0, S, S);
  const md = x.getImageData(0, 0, S, S).data;
  const hole = new Uint8Array(P);
  for (let i = 0; i < P; i++) hole[i] = md[4 * i + 3] > 40 ? 1 : 0;
  const grown = dilate(hole, S, S, 3);
  const image = new Float32Array(3 * P), mask = new Float32Array(P);
  for (let i = 0; i < P; i++) {
    mask[i] = grown[i];
    if (!grown[i]) { image[i] = id[4 * i] / 255; image[P + i] = id[4 * i + 1] / 255; image[2 * P + i] = id[4 * i + 2] / 255; }
  }
  const res = await new Promise((resolve, reject) => {
    const rid2 = ++rid; pending.set(rid2, { resolve, reject });
    worker.postMessage({ type: 'run', id: rid2, image, mask }, [image.buffer, mask.buffer]);
  });
  const d = res.data;
  let mx = 0; for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i];
  const k = mx > 2 ? 1 : 255;
  const out = new OffscreenCanvas(S, S), ox = out.getContext('2d');
  const od = ox.createImageData(S, S);
  for (let i = 0; i < P; i++) {
    od.data[4 * i] = d[i] * k; od.data[4 * i + 1] = d[P + i] * k; od.data[4 * i + 2] = d[2 * P + i] * k; od.data[4 * i + 3] = 255;
  }
  ox.putImageData(od, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  state.lama = 'ready';
  return { img: await blobToDataUrl(blob) };
}

init();
