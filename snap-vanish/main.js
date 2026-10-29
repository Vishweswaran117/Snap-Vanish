// Snap Vanish — page-world script. Hooks the webcam/mic, runs the snap gesture logic and renders the dust effect.
(() => {
  'use strict';
  if (window.__snapVanishLoaded) return;
  window.__snapVanishLoaded = true;

  const NS = 'snapvanish';
  const W = 640, H = 360, N = W * H, AR = 16 / 9;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const post = (type, data) => window.postMessage(Object.assign({ ns: NS, from: 'main', type }, data || {}), '*');

  const S = { enabled: true, sensitivity: 6, duration: 3.5, direction: 'right', ai: true };
  const engine = { status: 'idle', lama: 'off', error: '' };
  let session = null;
  let settingsResolve;
  const settingsReady = new Promise((r) => { settingsResolve = r; });
  setTimeout(() => settingsResolve(), 600);

  function dataUrlToBlob(u) {
    const i = u.indexOf(',');
    const bin = atob(u.slice(i + 1));
    const a = new Uint8Array(bin.length);
    for (let k = 0; k < a.length; k++) a[k] = bin.charCodeAt(k);
    return new Blob([a], { type: u.slice(5, u.indexOf(';')) });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ns !== NS || d.from !== 'bridge') return;
    if (d.type === 'settings') { Object.assign(S, d.settings); settingsResolve(); }
    else if (d.type === 'snapNow') { if (session) session.toggle(); }
    else if (d.type === 'result') { if (session) session.onResult(d); }
    else if (d.type === 'inpaintResult') { if (session) session.onInpaint(d); }
  });
  post('hello');

  // ---------- static noise + direction vectors ----------
  const NOISE = new Float32Array(N);
  (() => {
    const hash = (x, y) => {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967295;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) NOISE[y * W + x] = 0.6 * hash(x >> 3, y >> 3) + 0.4 * hash(x, y);
  })();
  const DIRS = { right: { x: 1, y: -0.15 }, left: { x: -1, y: -0.15 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, burst: { x: 0, y: 0, burst: true } };
  for (const k in DIRS) { const d = DIRS[k], l = Math.hypot(d.x, d.y); if (l) { d.x /= l; d.y /= l; } }

  // ---------- small-grid morphology for masks ----------
  function dilate(src, dst, tmp, w, h, r) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) if (src[y * w + k]) { v = 255; break; }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) { const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) { let v = 0;
        for (let k = a; k <= b; k++) if (tmp[k * w + x]) { v = 255; break; }
        dst[y * w + x] = v; } }
  }
  function blur3(src, dst, w, h) {
    for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        let s = 0, c = 0;
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { s += src[yy * w + xx]; c++; }
        dst[y * w + x] = s / c; } }
  }

  // ---------- microphone: click confirmation + mute ----------
  class ClickDetector {
    constructor() { this.ctx = null; this.an = null; this.buf = null; this.base = 0.004; this.lastClick = 0; this.ok = false; this.clone = null; }
    attach(track) {
      if (this.an) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.clone = track.clone(); // separate listener: keeps hearing the mic while the call's copy is muted
        const src = this.ctx.createMediaStreamSource(new MediaStream([this.clone]));
        this.an = this.ctx.createAnalyser();
        this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0;
        src.connect(this.an); // analyser only, never routed to speakers
        this.buf = new Float32Array(this.an.fftSize);
        const resume = () => { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
        ['pointerdown', 'keydown', 'click', 'touchstart'].forEach((ev) => window.addEventListener(ev, resume, { capture: true, passive: true }));
        resume();
      } catch (e) { this.release(); }
    }
    release() {
      try { if (this.clone) this.clone.stop(); } catch (e) {}
      try { if (this.ctx) this.ctx.close(); } catch (e) {}
      this.ctx = this.an = this.clone = null; this.ok = false;
    }
    poll(now, sens) {
      if (!this.an || !this.ctx || this.ctx.state !== 'running') { this.ok = false; return; }
      this.ok = true;
      this.an.getFloatTimeDomainData(this.buf);
      const b = this.buf; let peak = 0, sum = 0;
      for (let i = 1; i < b.length; i++) { const d = Math.abs(b[i] - b[i - 1]); sum += d * d; if (d > peak) peak = d; }
      const rms = Math.sqrt(sum / (b.length - 1));
      const thr = Math.max(0.12 - sens * 0.008, this.base * (14 - sens));
      if (peak > thr) { if (now - this.lastClick > 150) this.lastClick = now; }
      else this.base = this.base * 0.95 + rms * 0.05;
    }
  }
  const clicks = new ClickDetector();
  const mics = new Set();
  const muteState = new Map();

  function registerMic(t) {
    if (mics.has(t)) return;
    mics.add(t);
    const origStop = t.stop.bind(t);
    const gone = () => {
      mics.delete(t); muteState.delete(t);
      clicks.release();
      const next = [...mics].find((m) => m.readyState === 'live');
      if (next) clicks.attach(next);
    };
    t.stop = () => { origStop(); gone(); };
    t.addEventListener('ended', gone);
    clicks.attach(t);
  }
  function setMicMuted(muted) {
    for (const t of mics) {
      if (t.readyState !== 'live') continue;
      if (muted) { if (!muteState.has(t)) muteState.set(t, t.enabled); t.enabled = false; }
      else if (muteState.has(t)) { t.enabled = muteState.get(t); muteState.delete(t); }
    }
  }

  // ---------- the camera session ----------
  class VideoSession {
    constructor(track) {
      this.track = track;
      const st = track.getSettings ? track.getSettings() : {};
      this.ow = st.width || 1280; this.oh = st.height || 720;
      this.out = canvas(this.ow, this.oh); this.octx = this.out.getContext('2d');
      this.work = canvas(W, H); this.wctx = this.work.getContext('2d', { willReadFrequently: true });
      this.small = canvas(480, 270); this.sctx = this.small.getContext('2d');
      this.repC = canvas(W, H); this.repX = this.repC.getContext('2d'); this.repD = this.repX.createImageData(W, H);
      this.dustC = canvas(W, H); this.dustX = this.dustC.getContext('2d'); this.dustD = this.dustX.createImageData(W, H);
      this.upC = canvas(W, H); this.upX = this.upC.getContext('2d', { willReadFrequently: true });
      this.tmpC = canvas(W, H); this.tmpX = this.tmpC.getContext('2d');
      this.mc = null;
      this.m = new Uint8Array(N); this.mBig = new Uint8Array(N); this.maskAt = 0;
      this.plate = new Uint8ClampedArray(N * 4); this.known = new Uint8Array(N); this.knownCount = 0;
      this.fb = null; this.ai = null; this.pendingAI = null;
      this.lastLive = null; this.pending = null;
      this.inflight = false; this.lastSend = 0;
      this.lastInp = 0; this.lastHoles = -1; this.inpFlight = false; this.inpHoles = 0;
      this.fx = { phase: 'visible', start: 0, D: 3500 };
      this.sMap = new Float32Array(N); this.P = null;
      this.hs = {}; this.cand = null; this.cool = 0;
      this.ended = false; this.note = '';
      this.start();
      session = this;
      this.statTimer = setInterval(() => post('status', { status: this.status() }), 800);
    }

    start() {
      const T = window.MediaStreamTrackProcessor, G = window.MediaStreamTrackGenerator;
      if (T && G && window.VideoFrame) {
        const proc = new T({ track: this.track });
        const gen = new G({ kind: 'video' });
        this.outTrack = gen;
        this.pump(proc.readable.getReader(), gen.writable.getWriter());
      } else {
        this.vid = document.createElement('video');
        this.vid.muted = true; this.vid.playsInline = true;
        this.vid.srcObject = new MediaStream([this.track]);
        this.vid.play().catch(() => {});
        this.outTrack = this.out.captureStream(30).getVideoTracks()[0];
        const step = () => {
          if (this.ended) return;
          const v = this.vid;
          if (v.readyState >= 2 && v.videoWidth) {
            if (!this.tick(v, v.videoWidth, v.videoHeight)) {
              if (this.out.width !== v.videoWidth) { this.out.width = v.videoWidth; this.out.height = v.videoHeight; }
              this.octx.drawImage(v, 0, 0);
            }
          }
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
        };
        step();
      }
      const t = this.outTrack, orig = this.track;
      const origStop = t.stop.bind(t);
      t.stop = () => { this.destroy(); origStop(); };
      const origGS = t.getSettings.bind(t);
      t.getSettings = () => Object.assign({}, orig.getSettings(), origGS());
      try { Object.defineProperty(t, 'label', { value: orig.label }); } catch (e) {}
      orig.addEventListener('ended', () => this.destroy());
    }

    async pump(reader, writer) {
      this.writer = writer;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done || !r.value) break;
          const frame = r.value;
          let drew = false;
          try { drew = this.tick(frame, frame.displayWidth, frame.displayHeight); }
          catch (e) { console.warn('[Snap Vanish]', e); drew = false; }
          if (drew) { const f = new VideoFrame(this.out, { timestamp: frame.timestamp }); frame.close(); await writer.write(f); }
          else await writer.write(frame);
        }
      } catch (e) { /* track stopped */ }
      try { writer.close(); } catch (e) {}
    }

    destroy() {
      if (this.ended) return;
      this.ended = true;
      clearInterval(this.statTimer);
      if (this.fx.phase !== 'visible') setMicMuted(false);
      try { this.track.stop(); } catch (e) {}
      try { if (this.writer) this.writer.close(); } catch (e) {}
      if (session === this) session = null;
    }

    status() {
      return {
        wrapped: true, phase: this.fx.phase, engine: engine.status, lama: engine.lama, audio: clicks.ok,
        known: Math.round((100 * this.knownCount) / N), error: engine.error, note: this.note
      };
    }

    // ----- per-frame work -----
    tick(src, w, h) {
      if (session !== this) return false;
      const now = performance.now();
      if (!S.enabled) { if (this.fx.phase !== 'visible') { this.fx.phase = 'visible'; setMicMuted(false); } return false; }
      if (w !== this.ow || h !== this.oh) { this.ow = w; this.oh = h; this.out.width = w; this.out.height = h; }
      clicks.poll(now, S.sensitivity);
      this.checkFire(now);
      const gap = engine.status === 'ready' ? 70 : 1500;
      if (this.inflight && now - this.lastSend > 4000) this.inflight = false;
      if (!this.inflight && now - this.lastSend >= gap) this.sendFrame(src, now);

      const fx = this.fx;
      if (fx.phase === 'visible') return false;
      const el = now - fx.start;
      let tf;
      if (fx.phase === 'vanishing') { tf = Math.min(el, fx.D); if (el >= fx.D) fx.phase = 'gone'; }
      else if (fx.phase === 'returning') {
        tf = Math.max(fx.D - el, 0);
        if (el >= fx.D) { fx.phase = 'visible'; if (this.pendingAI) { this.ai = this.pendingAI; this.pendingAI = null; } return false; }
      } else tf = fx.D;

      this.octx.drawImage(src, 0, 0, w, h);
      this.renderReplace(tf);
      this.octx.drawImage(this.repC, 0, 0, w, h);
      if (fx.phase !== 'gone') { this.renderDust(tf); this.octx.drawImage(this.dustC, 0, 0, w, h); }
      return true;
    }

    sendFrame(src, now) {
      this.wctx.drawImage(src, 0, 0, W, H);
      const live = this.wctx.getImageData(0, 0, W, H);
      this.sctx.drawImage(this.work, 0, 0, 480, 270);
      const img = this.small.toDataURL('image/jpeg', 0.7);
      this.lastSend = now; this.inflight = true;
      this.pending = { t: now, live };
      this.lastLive = live;
      post('frame', { img, t: now });
    }

    onResult(d) {
      this.inflight = false;
      if (d.status) engine.status = d.status;
      if (d.lama) engine.lama = d.lama;
      engine.error = d.error || '';
      if (d.status !== 'ready') return;
      if (d.hands) this.feedHands(d.t, d.hands);
      const p = this.pending;
      if (d.mask && p && p.t === d.t) {
        this.setMask(d.mask);
        this.updatePlate(p.live);
        this.maskAt = performance.now();
        this.maybeInpaint(this.maskAt);
      }
    }

    // ----- snap gesture -----
    feedHands(t, hands) {
      const pT = 0.2 + 0.03 * S.sensitivity, rT = 0.62;
      const seen = {};
      for (const h of hands) {
        const p = h.p;
        const dist = (a, b) => Math.hypot((p[2 * a] - p[2 * b]) * AR, p[2 * a + 1] - p[2 * b + 1]);
        const scale = dist(0, 9);
        if (scale < 0.04) continue;
        const pinch = dist(4, 12) / scale; // thumb tip to middle fingertip
        const st = this.hs[h.h] || (this.hs[h.h] = { cnt: 0, ready: 0 });
        seen[h.h] = 1;
        if (pinch < pT) { st.cnt++; if (st.cnt >= 2) st.ready = t + 700; }
        else {
          st.cnt = 0;
          if (pinch > rT && st.ready >= t) { st.ready = 0; this.cand = { t, lost: false, recv: performance.now() }; }
        }
      }
      for (const k in this.hs) {
        if (seen[k]) continue;
        const st = this.hs[k];
        if (st.ready >= t && st.cnt >= 2) this.cand = { t, lost: true, recv: performance.now() };
        st.ready = 0; st.cnt = 0;
      }
      this.checkFire(performance.now());
    }

    checkFire(now) {
      const c = this.cand;
      if (!c) return;
      if (now - c.recv > 800) { this.cand = null; return; }
      const ph = this.fx.phase;
      if (now < this.cool || ph === 'vanishing' || ph === 'returning') return;
      let fire;
      if (clicks.ok) fire = clicks.lastClick >= c.t - 400 && clicks.lastClick <= c.t + 700;
      else fire = !c.lost; // no usable mic analysis: hand gesture alone
      if (fire) { this.cand = null; this.cool = now + 1500; this.toggle(); }
    }

    toggle() {
      const fx = this.fx;
      if (fx.phase === 'vanishing' || fx.phase === 'returning') return false;
      if (engine.status !== 'ready') { this.note = 'Engine not ready. Run the setup script, then reload the tab.'; return false; }
      if (!this.lastLive || performance.now() - this.maskAt > 2500) { this.note = 'No fresh camera analysis yet.'; return false; }
      const going = fx.phase === 'visible';
      if (going && this.knownCount < N * 0.5) { this.note = 'Still learning the room behind you…'; return false; }
      this.note = '';
      fx.D = clamp(S.duration, 1, 8) * 1000;
      fx.start = performance.now();
      this.buildParticles();
      if (going || !this.fb) this.buildFallback();
      fx.phase = going ? 'vanishing' : 'returning';
      setMicMuted(going);
      post('status', { status: this.status() });
      return true;
    }

    // ----- mask + background plate -----
    setMask(mask) {
      const w = mask.w, h = mask.h, n = w * h;
      if (!this.mc || this.mc.width !== w || this.mc.height !== h) {
        this.mc = canvas(w, h); this.mcx = this.mc.getContext('2d'); this.mcd = this.mcx.createImageData(w, h);
        this.msA = new Uint8Array(n); this.msB = new Uint8Array(n); this.msT = new Uint8Array(n);
      }
      const bin = atob(mask.b64), a = this.msA, b = this.msB, t = this.msT;
      for (let i = 0; i < n; i++) a[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
      dilate(a, b, t, w, h, 1); blur3(b, t, w, h);
      this.uploadMask(t, w, h, this.m, false);
      dilate(a, b, t, w, h, 4);
      this.uploadMask(b, w, h, this.mBig, true);
    }
    uploadMask(arr, w, h, dst, binary) {
      const d = this.mcd.data;
      for (let i = 0, n = w * h; i < n; i++) d[4 * i + 3] = arr[i];
      this.mcx.putImageData(this.mcd, 0, 0);
      this.upX.clearRect(0, 0, W, H);
      this.upX.drawImage(this.mc, 0, 0, W, H);
      const u = this.upX.getImageData(0, 0, W, H).data;
      if (binary) for (let i = 0; i < N; i++) dst[i] = u[4 * i + 3] > 40 ? 1 : 0;
      else for (let i = 0; i < N; i++) { const v = (u[4 * i + 3] - 40) * 2.1; dst[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    }

    updatePlate(live) {
      const d = live.data, pl = this.plate, kn = this.known, mb = this.mBig;
      let kc = this.knownCount;
      for (let i = 0; i < N; i++) {
        if (mb[i]) continue;
        const o = i << 2;
        if (!kn[i]) { pl[o] = d[o]; pl[o + 1] = d[o + 1]; pl[o + 2] = d[o + 2]; pl[o + 3] = 255; kn[i] = 1; kc++; }
        else { pl[o] += (d[o] - pl[o]) * 0.2; pl[o + 1] += (d[o + 1] - pl[o + 1]) * 0.2; pl[o + 2] += (d[o + 2] - pl[o + 2]) * 0.2; }
      }
      this.knownCount = kc;
    }

    // cheap diffusion fill; used when the AI model isn't installed or hasn't finished yet
    buildFallback() {
      const gw = 80, gh = 45, cs = 8, G = gw * gh;
      const sum = new Float32Array(G * 3), cnt = new Float32Array(G);
      const pl = this.plate, kn = this.known;
      for (let y = 0; y < H; y++) { const gy = (y / cs) | 0;
        for (let x = 0; x < W; x++) { const i = y * W + x; if (!kn[i]) continue;
          const g = gy * gw + ((x / cs) | 0), o = i << 2;
          sum[g * 3] += pl[o]; sum[g * 3 + 1] += pl[o + 1]; sum[g * 3 + 2] += pl[o + 2]; cnt[g]++; } }
      const val = new Float32Array(G * 3), kg = new Uint8Array(G);
      let tr = 0, tg = 0, tb = 0, tn = 0;
      for (let g = 0; g < G; g++) if (cnt[g] >= cs * cs * 0.5) {
        kg[g] = 1; val[g * 3] = sum[g * 3] / cnt[g]; val[g * 3 + 1] = sum[g * 3 + 1] / cnt[g]; val[g * 3 + 2] = sum[g * 3 + 2] / cnt[g];
        tr += val[g * 3]; tg += val[g * 3 + 1]; tb += val[g * 3 + 2]; tn++;
      }
      const av = tn ? [tr / tn, tg / tn, tb / tn] : [110, 110, 110];
      for (let g = 0; g < G; g++) if (!kg[g]) { val[g * 3] = av[0]; val[g * 3 + 1] = av[1]; val[g * 3 + 2] = av[2]; }
      for (let it = 0; it < 150; it++) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const g = y * gw + x; if (kg[g]) continue;
        const l = y * gw + Math.max(0, x - 1), r = y * gw + Math.min(gw - 1, x + 1), u = Math.max(0, y - 1) * gw + x, dn = Math.min(gh - 1, y + 1) * gw + x;
        for (let c = 0; c < 3; c++) val[g * 3 + c] = (val[l * 3 + c] + val[r * 3 + c] + val[u * 3 + c] + val[dn * 3 + c]) / 4;
      }
      const fb = new Uint8ClampedArray(N * 4);
      for (let y = 0; y < H; y++) {
        const fy = clamp((y + 0.5) / cs - 0.5, 0, gh - 1), y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < W; x++) {
          const fx = clamp((x + 0.5) / cs - 0.5, 0, gw - 1), x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
          const o = (y * W + x) << 2;
          for (let c = 0; c < 3; c++) {
            const a = val[(y0 * gw + x0) * 3 + c] * (1 - tx) + val[(y0 * gw + x1) * 3 + c] * tx;
            const b = val[(y1 * gw + x0) * 3 + c] * (1 - tx) + val[(y1 * gw + x1) * 3 + c] * tx;
            fb[o + c] = a * (1 - ty) + b * ty;
          }
          fb[o + 3] = 255;
        }
      }
      this.fb = fb;
    }

    // ----- AI room fill (LaMa, in the offscreen engine) -----
    maybeInpaint(now) {
      if (!S.ai || engine.lama !== 'ready' || this.inpFlight || now - this.lastInp < 7000) return;
      const ph = this.fx.phase;
      if (ph === 'vanishing' || ph === 'returning') return;
      const holes = N - this.knownCount;
      if (holes < N * 0.01) return;
      if (this.ai && Math.abs(holes - this.lastHoles) < N * 0.02) return;
      this.buildFallback();
      const id = this.tmpX.createImageData(W, H), md = this.tmpX.createImageData(W, H);
      for (let i = 0; i < N; i++) {
        const o = i << 2, src = this.known[i] ? this.plate : this.fb;
        id.data[o] = src[o]; id.data[o + 1] = src[o + 1]; id.data[o + 2] = src[o + 2]; id.data[o + 3] = 255;
        md.data[o] = md.data[o + 1] = md.data[o + 2] = 255; md.data[o + 3] = this.known[i] ? 0 : 255;
      }
      const c512 = canvas(512, 512), x512 = c512.getContext('2d');
      this.tmpX.putImageData(id, 0, 0); x512.drawImage(this.tmpC, 0, 0, 512, 512);
      const img = c512.toDataURL('image/jpeg', 0.92);
      x512.clearRect(0, 0, 512, 512);
      this.tmpX.clearRect(0, 0, W, H); this.tmpX.putImageData(md, 0, 0); x512.drawImage(this.tmpC, 0, 0, 512, 512);
      const mask = c512.toDataURL('image/png');
      this.inpFlight = true; this.lastInp = now; this.inpHoles = holes;
      post('inpaint', { img, mask, id: 1 });
    }

    async onInpaint(d) {
      if (!d.img) { this.inpFlight = false; return; }
      try {
        const bmp = await createImageBitmap(dataUrlToBlob(d.img));
        this.tmpX.clearRect(0, 0, W, H); this.tmpX.drawImage(bmp, 0, 0, W, H); bmp.close();
        const arr = this.tmpX.getImageData(0, 0, W, H).data;
        const ph = this.fx.phase;
        if (ph === 'vanishing' || ph === 'returning' || ph === 'gone') this.pendingAI = arr; else this.ai = arr;
        if (ph === 'gone') this.ai = this.ai || arr;
        this.lastHoles = this.inpHoles;
      } catch (e) { /* ignore */ }
      this.inpFlight = false;
    }

    // ----- effect rendering -----
    buildParticles() {
      const live = this.lastLive.data, m = this.m, D = this.fx.D, s = this.sMap;
      const dir = DIRS[S.direction] || DIRS.right;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const b = dir.burst
          ? 1 - Math.min(1, Math.hypot((x / W - 0.5) * AR, y / H - 0.5) * 1.7)
          : 1 - clamp(0.5 + (x / W - 0.5) * dir.x + (y / H - 0.5) * dir.y, 0, 1);
        s[i] = clamp(0.62 * b + 0.38 * NOISE[i], 0, 1);
      }
      let st = 2, cnt = 0;
      const count = () => { cnt = 0; for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) if (m[y * W + x] >= 128) cnt++; };
      count(); if (cnt > 28000) { st = 3; count(); }
      const P = {
        n: cnt, st, x: new Float32Array(cnt), y: new Float32Array(cnt), r: new Uint8Array(cnt), g: new Uint8Array(cnt), b: new Uint8Array(cnt),
        t0: new Float32Array(cnt), life: new Float32Array(cnt), vx: new Float32Array(cnt), vy: new Float32Array(cnt),
        ph: new Float32Array(cnt), amp: new Float32Array(cnt)
      };
      const base = dir.burst ? W * 0.45 : (Math.abs(dir.x) * W + Math.abs(dir.y) * H) * 0.85;
      let k = 0;
      for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) {
        const i = y * W + x;
        if (m[i] < 128) continue;
        const o = i << 2;
        P.x[k] = x + Math.random() * st; P.y[k] = y + Math.random() * st;
        P.r[k] = live[o]; P.g[k] = live[o + 1]; P.b[k] = live[o + 2];
        P.t0[k] = s[i] * D * 0.55;
        P.life[k] = Math.min(D * 0.4 * (0.7 + Math.random() * 0.5), D - P.t0[k]);
        const ang = dir.burst ? Math.random() * 6.2832 : Math.atan2(dir.y, dir.x) + (Math.random() - 0.5) * 0.8;
        const sp = base * (0.45 + Math.random() * 0.8);
        P.vx[k] = Math.cos(ang) * sp; P.vy[k] = Math.sin(ang) * sp - Math.random() * H * 0.12;
        P.ph[k] = Math.random() * 6.28; P.amp[k] = Math.random() * 10;
        k++;
      }
      this.P = P;
    }

    renderReplace(tf) {
      const d = this.repD.data, m = this.m, s = this.sMap, pl = this.plate, kn = this.known, fl = this.ai || this.fb || pl;
      const F = this.fx.D * 0.12, T0 = this.fx.D * 0.55;
      for (let i = 0; i < N; i++) {
        const o = i << 2, mv = m[i];
        if (!mv) { d[o + 3] = 0; continue; }
        const x = (tf - s[i] * T0) / F;
        if (x <= 0) { d[o + 3] = 0; continue; }
        d[o + 3] = x >= 1 ? mv : mv * x * x * (3 - 2 * x);
        const src = kn[i] ? pl : fl;
        d[o] = src[o]; d[o + 1] = src[o + 1]; d[o + 2] = src[o + 2];
      }
      this.repX.putImageData(this.repD, 0, 0);
    }

    renderDust(tf) {
      const P = this.P, dd = this.dustD.data;
      dd.fill(0);
      if (P) {
        const st = P.st;
        for (let k = 0; k < P.n; k++) {
          const u = (tf - P.t0[k]) / P.life[k];
          if (u <= 0 || u >= 1) continue;
          const e = u * u * (0.55 + 0.45 * u);
          const px = (P.x[k] + P.vx[k] * e + Math.sin(P.ph[k] + u * 6) * P.amp[k] * u) | 0;
          const py = (P.y[k] + P.vy[k] * e + Math.cos(P.ph[k] + u * 5) * P.amp[k] * u * 0.6) | 0;
          const q = 1 - u, a = q * (0.6 + 0.4 * q) * 235;
          const ash = 0.35 * u, ia = 1 - ash;
          const r = P.r[k] * ia + 70 * ash, g = P.g[k] * ia + 66 * ash, b = P.b[k] * ia + 62 * ash;
          for (let yy = py; yy < py + st; yy++) {
            if (yy < 0 || yy >= H) continue;
            for (let xx = px; xx < px + st; xx++) {
              if (xx < 0 || xx >= W) continue;
              const o = (yy * W + xx) << 2;
              if (dd[o + 3] < a) { dd[o] = r; dd[o + 1] = g; dd[o + 2] = b; dd[o + 3] = a; }
            }
          }
        }
      }
      this.dustX.putImageData(this.dustD, 0, 0);
    }
  }

  // ---------- getUserMedia hook ----------
  const proto = window.MediaDevices && window.MediaDevices.prototype;
  if (!proto || !proto.getUserMedia) return;
  const origGUM = proto.getUserMedia;
  proto.getUserMedia = async function (constraints) {
    const stream = await origGUM.call(this, constraints);
    try {
      await settingsReady;
      if (!S.enabled) return stream;
      const audio = stream.getAudioTracks();
      audio.forEach(registerMic);
      const vt = stream.getVideoTracks()[0];
      if (!vt) return stream;
      const s = new VideoSession(vt);
      return new MediaStream([...audio, s.outTrack]);
    } catch (err) {
      console.warn('[Snap Vanish] using the original camera stream:', err);
      return stream;
    }
  };
})();
