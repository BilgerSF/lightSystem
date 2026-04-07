/**
 * server.js — LightSystem Dashboard Server
 *
 * Starts an Express web server that:
 *  1. Serves the dashboard UI from /public
 *  2. Exposes a REST API for controlling Hue, Govee, or both
 *
 * Usage:  node server.js
 * Then open http://localhost:3000 in your browser.
 */

'use strict';

const express    = require('express');
const path       = require('path');
const controller = require('./controller');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────

let ready           = false;
let activeEffect    = null;
let danceMicVolume  = 0;

// ─── Static colour presets ────────────────────────────────────────────────────

const COLOR_PRESETS = {
  'warm-white':  { r: 255, g: 197, b: 143, brightness: 70  },
  'cool-white':  { r: 220, g: 235, b: 255, brightness: 100 },
  'sunset':      { r: 255, g: 80,  b: 30,  brightness: 80  },
  'ocean':       { r: 0,   g: 130, b: 200, brightness: 65  },
  'forest':      { r: 20,  g: 160, b: 60,  brightness: 55  },
  'purple':      { r: 160, g: 0,   b: 255, brightness: 90  },
  'red-alert':   { r: 255, g: 20,  b: 20,  brightness: 100 },
  'candle':      { r: 255, g: 147, b: 41,  brightness: 40  },
  'movie':       { r: 10,  g: 10,  b: 50,  brightness: 15  },
  'energize':    { r: 128, g: 200, b: 255, brightness: 100 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stopEffect() {
  if (activeEffect) { clearInterval(activeEffect); activeEffect = null; }
}

async function applyPower(target, on) {
  const tasks = [];
  if (target === 'hue'   || target === 'both') tasks.push(on ? controller.hueOn()   : controller.hueOff());
  if (target === 'govee' || target === 'both') tasks.push(on ? controller.goveeOn() : controller.goveeOff());
  await Promise.all(tasks);
}

async function applyColor(target, r, g, b) {
  const tasks = [];
  if (target === 'hue'   || target === 'both') tasks.push(controller.setHueColor(r, g, b));
  if (target === 'govee' || target === 'both') tasks.push(controller.setGoveeColor(r, g, b));
  await Promise.all(tasks);
}

async function applyBrightness(target, value) {
  const tasks = [];
  if (target === 'hue'   || target === 'both') tasks.push(controller.setHueBrightness(value));
  if (target === 'govee' || target === 'both') tasks.push(controller.setGoveeBrightness(value));
  await Promise.all(tasks);
}

// HSL → RGB (for dance effect)
function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => res.json({ ready }));

app.post('/api/dance/input', (req, res) => {
  const { volume } = req.body;
  if (typeof volume === 'number' && isFinite(volume)) danceMicVolume = volume;
  res.json({ ok: true });
});

app.post('/api/power', async (req, res) => {
  stopEffect();
  const { target = 'both', state } = req.body;
  try {
    await applyPower(target, state === 'on');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/color', async (req, res) => {
  stopEffect();
  const { target = 'both', r, g, b } = req.body;
  try {
    await applyColor(target, r, g, b);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brightness', async (req, res) => {
  stopEffect();
  const { target = 'both', value } = req.body;
  try {
    await applyBrightness(target, value);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/effect', async (req, res) => {
  stopEffect();
  const { target = 'both', effect } = req.body;
  try {
    // ── Static presets ──
    if (COLOR_PRESETS[effect]) {
      const { r, g, b, brightness } = COLOR_PRESETS[effect];
      await applyPower(target, true);
      await Promise.all([ applyColor(target, r, g, b), applyBrightness(target, brightness) ]);
      return res.json({ ok: true });
    }

    // ── Dynamic effects ──
    if (effect === 'fade') {
      const { r = 255, g = 255, b = 255 } = req.body;
      await applyPower(target, true);
      await applyColor(target, r, g, b);
      let bri = 10, dir = 1;
      activeEffect = setInterval(async () => {
        bri += dir * 10;
        if (bri >= 100) { bri = 100; dir = -1; }
        if (bri <= 10)  { bri = 10;  dir =  1; }
        await applyBrightness(target, bri).catch(() => {});
      }, 50);
      return res.json({ ok: true });
    }

    if (effect === 'breathing') {
      await applyPower(target, true);
      let bri = 10, dir = 1;
      activeEffect = setInterval(async () => {
        bri += dir * 4;
        if (bri >= 100) { bri = 100; dir = -1; }
        if (bri <= 10)  { bri = 10;  dir =  1; }
        await applyBrightness(target, bri).catch(() => {});
      }, 100);
      return res.json({ ok: true });
    }

    if (effect === 'dance') {
      await applyPower(target, true);
      await applyBrightness(target, 20);
      danceMicVolume = 0;
      let hue = 0;
      activeEffect = setInterval(async () => {
        const vol  = danceMicVolume;
        const bri  = Math.min(100, Math.max(5, Math.round(vol * 700)));
        const step = Math.max(2, Math.round(vol * 300));
        hue = (hue + step) % 360;
        const [r, g, b] = hslToRgb(hue / 360, 1, 0.5);
        // Send color to all targets; only send brightness to Hue (Govee rate-limit: 1 cmd/200ms)
        const tasks = [ applyColor(target, r, g, b) ];
        if (target === 'hue' || target === 'both') {
          tasks.push(controller.setHueBrightness(bri));
        }
        await Promise.all(tasks).catch(() => {});
      }, 200);
      return res.json({ ok: true });
    }

    if (effect === 'strobe') {
      let on = true;
      activeEffect = setInterval(async () => {
        await applyPower(target, on).catch(() => {});
        on = !on;
      }, 100);
      return res.json({ ok: true });
    }

    if (effect === 'candle') {
      await applyPower(target, true);
      activeEffect = setInterval(async () => {
        const r   = 255;
        const g   = 60  + Math.floor(Math.random() * 70);
        const b   = Math.floor(Math.random() * 15);
        const bri = 25  + Math.floor(Math.random() * 35);
        await Promise.all([
          applyColor(target, r, g, b),
          applyBrightness(target, bri),
        ]).catch(() => {});
      }, 180);
      return res.json({ ok: true });
    }

    res.status(400).json({ error: `Unknown effect: ${effect}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Initializing light controller…');
  try {
    await controller.init();
    ready = true;
    console.log('✔ Lights ready.');
  } catch (e) {
    console.error('Init failed — dashboard will still open but lights may not respond:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`\n✔ Dashboard →  http://localhost:${PORT}\n`);
  });
})();
