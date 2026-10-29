// Snap Vanish — runs the LaMa inpainting model (ONNX Runtime Web, WASM) off the main thread.
let session = null, imgName = 'image', maskName = 'mask';
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      importScripts(m.base + 'vendor/ort/ort.min.js');
      ort.env.wasm.wasmPaths = m.base + 'vendor/ort/';
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(m.base + 'vendor/lama_fp32.onnx', { executionProviders: ['wasm'] });
      const names = session.inputNames;
      maskName = names.find((n) => /mask/i.test(n)) || names[1];
      imgName = names.find((n) => n !== maskName) || names[0];
      self.postMessage({ type: 'ready' });
    } catch (err) { self.postMessage({ type: 'error', error: 'LaMa: ' + String(err).slice(0, 160) }); }
  } else if (m.type === 'run') {
    try {
      const feeds = {};
      feeds[imgName] = new ort.Tensor('float32', m.image, [1, 3, 512, 512]);
      feeds[maskName] = new ort.Tensor('float32', m.mask, [1, 1, 512, 512]);
      const out = await session.run(feeds);
      const o = out[session.outputNames[0]];
      self.postMessage({ type: 'done', id: m.id, data: o.data }, [o.data.buffer]);
    } catch (err) { self.postMessage({ type: 'fail', id: m.id, error: String(err) }); }
  }
};
