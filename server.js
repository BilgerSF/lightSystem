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

const { exec } = require('child_process');
const crypto     = require('crypto');
const fs         = require('fs');
const os         = require('os');
const http       = require('http');
const express    = require('express');
const path       = require('path');
const { WebSocketServer } = require('ws');
const controller = require('./controller');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = 3000;

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

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const { volume } = JSON.parse(raw);
      if (typeof volume === 'number' && isFinite(volume)) danceMicVolume = volume;
    } catch { /* ignore malformed frames */ }
  });
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
      let bri = 2, dir = 1;
      activeEffect = setInterval(async () => {
        bri += dir * 20;
        if (bri >= 100) { bri = 100; dir = -1; }
        if (bri <= 2)   { bri = 2;   dir =  1; }
        await applyBrightness(target, bri).catch(() => {});
      }, 100);
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
      }, 10);
      return res.json({ ok: true });
    }

    if (effect === 'dance') {
      const { r = 255, g = 255, b = 255 } = req.body;
      await controller.goveeOn();
      await controller.setGoveeColor(r, g, b);
      await controller.setGoveeBrightness(100);

      let lastBri = 100;
      let volMin = 1, volMax = 0;
      const DECAY_UP   = 0.97;  // max rises slowly
      const DECAY_DOWN = 0.85;  // min drops fast — quick reaction to quiet

      activeEffect = setInterval(() => {
        const vol = danceMicVolume;

        // Adaptive range tracking
        if (vol < volMin) volMin = vol;
        if (vol > volMax) volMax = vol;
        volMin = volMin * DECAY_DOWN + vol * (1 - DECAY_DOWN);
        volMax = volMax * DECAY_UP   + vol * (1 - DECAY_UP);

        const range = volMax - volMin;
        const norm = range > 0.01 ? (vol - volMin) / range : 0;
        const bri = Math.max(5, Math.min(100, Math.round(norm * 100)));

        if (bri === lastBri) return;
        console.log(`Dance — vol: ${vol.toFixed(3)} bri: ${bri}%`);
        // Fire-and-forget via Python bridge (no socket overhead in Node)
        controller.setGoveeBrightnessRaw(bri);
        lastBri = bri;
      }, 80);

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

const UPDATE_PASSWORD_HASH = 'd102a5e24978f472c57411fb2d5a04a7e23451955316112d8276637bda628eb0'; // sha256 of update password

app.post('/api/update', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string') return res.status(401).json({ error: 'Password required.' });
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(UPDATE_PASSWORD_HASH))) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  exec('git pull origin main', { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr.trim() || err.message });

    exec('npm run build:exe', { cwd: __dirname }, (err2, stdout2, stderr2) => {
      if (err2) return res.status(500).json({ error: stderr2.trim() || err2.message });
      const src  = path.join(__dirname, 'dist', 'lightsystem.exe');
      const dest = path.join(os.homedir(), 'Desktop', 'lightsystem.exe');
      fs.copyFile(src, dest, (err3) => {
        const pullMsg  = stdout.trim()  || 'Already up to date.';
        const buildMsg = stdout2.trim() || 'Build complete.';
        const copyMsg  = err3 ? `Warning: could not copy to Desktop — ${err3.message}` : 'Copied to Desktop.';
        res.json({ ok: true, message: `${pullMsg}\n${buildMsg}\n${copyMsg}` });
      });
    });
  });
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

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n✔ Dashboard →  ${url}\n`);
    exec(`start "" "${url}"`, (err) => {
      if (err) {
        console.error('Failed to launch browser:', err.message);
      }
    });
  });
})();