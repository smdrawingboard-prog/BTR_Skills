// Usage: node render.js beats <outDir> | node render.js full <outDir> | node render.js audio <outDir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const mode = process.argv[2] || 'beats';
const out = process.argv[3] || path.join(__dirname, 'out');
const url = 'file://' + path.join(__dirname, 'index.html');
const FPS = 60, SUB = 3, DUR = 15;

async function openPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await p.goto(url);
  await p.waitForFunction(() => window.READY === true);
  return p;
}

// Soundtrack: 120 BPM, kick on every beat, a hit on each scene change.
function makeAudio(DUR) {
  const SR = 48000, ctx = new OfflineAudioContext(2, SR * DUR, SR);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 4;
  const master = ctx.createGain(); master.gain.value = 0.8;
  master.gain.setValueAtTime(0.8, DUR - 0.7); master.gain.linearRampToValueAtTime(0, DUR - 0.02);
  comp.connect(master); master.connect(ctx.destination);
  const nb = ctx.createBuffer(1, SR, SR), nd = nb.getChannelData(0);
  let seed = 7; for (let i = 0; i < SR; i++) { seed = (seed * 16807) % 2147483647; nd[i] = seed / 1073741823.5 - 1; }
  const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const tone = (t, type, f0, f1, d, peak, lp) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + d * 0.6);
    env(g, t, 0.004, d, peak); let n = o;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); n = f; }
    n.connect(g); g.connect(comp); o.start(t); o.stop(t + d + 0.05);
  };
  const noise = (t, type, freq, d, peak, sweepTo) => {
    const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + d);
    const g = ctx.createGain(); env(g, t, 0.003, d, peak);
    s.connect(f); f.connect(g); g.connect(comp); s.start(t); s.stop(t + d + 0.05);
  };
  const kick = t => tone(t, 'sine', 135, 42, 0.26, 0.95);
  const hit = (t, big) => { noise(t, 'lowpass', 2400, 0.55, big ? 0.5 : 0.32, 180); tone(t, 'sine', 55, 40, 0.7, big ? 0.8 : 0.55);
    for (const f of [110, 164.8, 220]) tone(t, 'sawtooth', f, 0, 0.4, big ? 0.16 : 0.1, 1300); };
  for (let b = 0; b < 30; b++) kick(b * 0.5);
  for (const t of [0, 2, 4, 6, 9]) hit(t, false);
  hit(12, true);
  for (let t = 2.25; t < 12; t += 0.5) noise(t, 'highpass', 7500, 0.04, 0.1);
  const bass = [55, 55, 65.41, 55, 49, 49, 55, 73.42];
  for (let i = 0, t = 2; t < 12; t += 0.25, i++) tone(t, 'sawtooth', bass[i % 8], 0, 0.19, 0.2, 320);
  for (let t = 6.5; t < 12; t += 1) noise(t, 'bandpass', 1800, 0.12, 0.22);
  for (const t of [5, 5.5, 6]) tone(t, 'sine', 430, 170, 0.09, 0.4);
  for (const t of [2.5, 3.5, 4, 11.5]) tone(t, 'square', 2100, 0, 0.014, 0.12);
  for (const f of [110, 138.59, 164.81, 220.6]) { // closing chord
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, 12); g.gain.exponentialRampToValueAtTime(0.07, 12.05); g.gain.setValueAtTime(0.07, 14);
    g.gain.exponentialRampToValueAtTime(0.0001, 15); o.connect(lp); lp.connect(g); g.connect(comp); o.start(12); o.stop(15);
  }
  return ctx.startRendering().then(buf => {
    const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const ab = new ArrayBuffer(44 + n * 4), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
    let s = ''; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return btoa(s);
  });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  if (mode === 'audio') {
    const p = await openPage(browser);
    const b64 = await p.evaluate(makeAudio, DUR);
    fs.writeFileSync(path.join(out, 'soundtrack.wav'), Buffer.from(b64, 'base64'));
  } else if (mode === 'beats') {
    const p = await openPage(browser);
    for (let b = 0; b < 30; b++) {
      const t = b * 0.5 + 0.34;
      await p.evaluate(t => window.seek(t), t);
      await p.screenshot({ path: path.join(out, `beat${String(b + 1).padStart(2, '0')}.png`) });
    }
  } else {
    const total = FPS * SUB * DUR, W = 4;
    await Promise.all([...Array(W).keys()].map(async k => {
      const p = await openPage(browser);
      for (let n = k; n < total; n += W) {
        await p.evaluate(t => window.seek(t), n / (FPS * SUB));
        await p.screenshot({ path: path.join(out, `f${String(n).padStart(5, '0')}.png`) });
      }
    }));
  }
  await browser.close();
})();
