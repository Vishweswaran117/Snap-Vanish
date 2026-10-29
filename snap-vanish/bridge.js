// Snap Vanish — isolated-world bridge: settings, popup commands, and relay to the on-device ML page.
(() => {
  'use strict';
  const NS = 'snapvanish';
  const DEFAULTS = { enabled: true, sensitivity: 6, duration: 3.5, direction: 'right', ai: true };
  let settings = Object.assign({}, DEFAULTS);
  let lastStatus = null;
  let ensured = false;

  const toMain = (type, data) =>
    window.postMessage(Object.assign({ ns: NS, from: 'bridge', type }, data || {}), '*');

  async function loadSettings() {
    try {
      settings = Object.assign({}, DEFAULTS, await chrome.storage.local.get(DEFAULTS));
      toMain('settings', { settings });
    } catch (e) { /* extension reloaded */ }
  }
  loadSettings();
  try { chrome.storage.onChanged.addListener(loadSettings); } catch (e) {}

  async function relay(msg) {
    try {
      if (!ensured) { await chrome.runtime.sendMessage({ type: 'ensureOffscreen' }); ensured = true; }
      const r = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
      return r || { status: 'loading' };
    } catch (e) {
      ensured = false;
      return { status: 'loading', error: '' };
    }
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ns !== NS || d.from !== 'main') return;
    if (d.type === 'hello') toMain('settings', { settings });
    else if (d.type === 'status') lastStatus = d.status;
    else if (d.type === 'frame') {
      const r = await relay({ type: 'frame', img: d.img });
      toMain('result', Object.assign({}, r, { t: d.t }));
    } else if (d.type === 'inpaint') {
      const r = await relay({ type: 'inpaint', img: d.img, mask: d.mask });
      toMain('inpaintResult', Object.assign({}, r, { id: d.id }));
    }
  });

  try {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (!lastStatus) return; // this frame has no camera session
      if (msg.type === 'snapNow') { toMain('snapNow'); reply({ ok: true }); }
      else if (msg.type === 'getStatus') reply({ status: lastStatus });
    });
  } catch (e) {}
})();
