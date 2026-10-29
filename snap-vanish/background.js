// Snap Vanish — service worker: creates the offscreen ML page and handles the keyboard shortcut.
let creating = null;

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run hand tracking, person segmentation and room inpainting locally on-device.'
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'ensureOffscreen') {
    ensureOffscreen().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'snap-now') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'snapNow' }).catch(() => {});
});
