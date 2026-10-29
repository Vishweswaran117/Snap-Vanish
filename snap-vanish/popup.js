const DEF = { enabled: true, sensitivity: 6, duration: 3.5, direction: 'right', ai: true };
const $ = (id) => document.getElementById(id);
const save = (patch) => chrome.storage.local.set(patch);

async function init() {
  const s = Object.assign({}, DEF, await chrome.storage.local.get(DEF));
  $('enabled').checked = s.enabled;
  $('sens').value = s.sensitivity; $('sensOut').textContent = s.sensitivity;
  $('dur').value = s.duration; $('durOut').textContent = s.duration + ' s';
  $('dir').value = s.direction;
  $('ai').checked = s.ai;

  $('enabled').onchange = (e) => save({ enabled: e.target.checked });
  $('sens').oninput = (e) => { $('sensOut').textContent = e.target.value; save({ sensitivity: +e.target.value }); };
  $('dur').oninput = (e) => { $('durOut').textContent = e.target.value + ' s'; save({ duration: +e.target.value }); };
  $('dir').onchange = (e) => save({ direction: e.target.value });
  $('ai').onchange = (e) => save({ ai: e.target.checked });
  $('snap').onclick = async () => {
    const tab = await activeTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'snapNow' }).catch(() => {});
    setTimeout(refresh, 400);
  };

  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'snap-now');
    if (c && c.shortcut) $('key').textContent = c.shortcut;
  } catch (e) {}
  refresh(); setInterval(refresh, 1000);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function row(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

async function refresh() {
  const tab = await activeTab();
  let st = null;
  if (tab) { try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }); st = r && r.status; } catch (e) {} }
  const info = $('info');
  if (!st) {
    $('state').textContent = 'No camera in this tab yet. Open a call, then reload the tab.';
    $('snap').disabled = true; info.innerHTML = ''; return;
  }
  $('snap').disabled = false;
  const phase = { visible: 'You are visible', vanishing: 'Turning to dust…', gone: 'You are gone', returning: 'Coming back…' }[st.phase] || st.phase;
  $('state').textContent = st.note || phase;
  const eng = { ready: 'ready', loading: 'loading…', missing: 'models missing: run setup', error: 'error' }[st.engine] || st.engine;
  const lama = { ready: 'ready', busy: 'filling…', loading: 'loading…', missing: 'not installed (basic fill)', error: 'error', off: 'off' }[st.lama] || st.lama;
  info.innerHTML = row('Tracking', eng) + row('AI room fill', lama) + row('Mic click', st.audio ? 'listening' : 'waiting for a click on the page') + row('Room learned', st.known + '%') + (st.error ? row('Note', st.error) : '');
}
init();
