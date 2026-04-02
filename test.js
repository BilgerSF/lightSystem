/**
 * test.js — Hue + Govee LAN Light Controller
 *
 * Prerequisites:
 *   1. Run `node setup.js` once to create config.json with bridge/device info.
 *   2. Enable "LAN Control" in the Govee Home app for your strip.
 *
 * Usage:   node test.js
 *
 * Exported controller API (for external use):
 *   const lights = require('./test');
 *   await lights.init();
 *   await lights.turnOn();
 *   await lights.setColor(255, 100, 0);
 *   await lights.setBrightness(80);
 *   await lights.turnOff();
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { discovery, api: hueApiFactory, model } = require('node-hue-api');
const LightState = model.lightStates.LightState;
const GoveeClient = require('govee-lan-control').default;

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ─── State ────────────────────────────────────────────────────────────────────

let hueApi      = null;   // authenticated node-hue-api instance
let hueLights   = [];     // all lights on the bridge
let goveeClient  = null;  // govee-lan-control Client
let goveeDevices = [];     // all selected Govee devices

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('config.json not found — run `node setup.js` first.');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.hue.username || !cfg.hue.bridgeIp) {
    throw new Error('Hue credentials missing in config.json — run `node setup.js` first.');
  }
  if (!cfg.govee.deviceIps || !cfg.govee.deviceIps.length) {
    throw new Error('Govee device IPs missing in config.json — run `node setup.js` first.');
  }
  return cfg;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Convert RGB (0-255) to Hue XY color (CIE 1931 color space).
 * The Math.max guard prevents log(0) and division-by-zero artifacts.
 */
function rgbToXy(r, g, b) {
  // Normalize
  let red   = r / 255;
  let green = g / 255;
  let blue  = b / 255;

  // Gamma correction (sRGB)
  red   = red   > 0.04045 ? Math.pow((red   + 0.055) / 1.055, 2.4) : red   / 12.92;
  green = green > 0.04045 ? Math.pow((green + 0.055) / 1.055, 2.4) : green / 12.92;
  blue  = blue  > 0.04045 ? Math.pow((blue  + 0.055) / 1.055, 2.4) : blue  / 12.92;

  // Wide RGB D65 conversion
  const X = red * 0.664511 + green * 0.154324 + blue * 0.162028;
  const Y = red * 0.283881 + green * 0.668433 + blue * 0.047685;
  const Z = red * 0.000088 + green * 0.072310 + blue * 0.986039;

  const sum = X + Y + Z;
  if (sum === 0) return [0, 0];
  return [X / sum, Y / sum];
}

// ─── Hue helpers ─────────────────────────────────────────────────────────────

async function hueSetAll(state) {
  await Promise.all(hueLights.map(light =>
    hueApi.lights.setLightState(light.id, state).catch(err =>
      console.warn(`  Hue light ${light.id} error:`, err.message)
    )
  ));
}

// ─── Govee helpers ───────────────────────────────────────────────────────────

async function goveeAll(fn) {
  await Promise.all(goveeDevices.map(d => Promise.resolve(fn(d)).catch(err =>
    console.warn(`  Govee [${d.ip}] error:`, err.message)
  )));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * init() — connect to Hue bridge and discover Govee strip.
 * Must be called before any other function.
 */
async function init() {
  const config = loadConfig();

  // ── Hue ──
  console.log(`Connecting to Hue bridge at ${config.hue.bridgeIp}…`);
  hueApi = await hueApiFactory.createLocal(config.hue.bridgeIp).connect(config.hue.username);
  const allLights = await hueApi.lights.getAll();
  hueLights = allLights;
  console.log(`✔ Hue connected — ${hueLights.length} light(s) found: ${hueLights.map(l => l.name).join(', ')}`);

  // ── Govee ──
  const targetIps = new Set(config.govee.deviceIps);
  console.log(`Connecting to ${targetIps.size} Govee device(s)…`);
  goveeClient = new GoveeClient();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (goveeDevices.length) resolve(); // accept partial
      else reject(new Error(
        'No Govee devices found. Check LAN Control is enabled and devices are on the same network.'
      ));
    }, 12000);

    goveeClient.on('deviceAdded', device => {
      if (targetIps.has(device.ip) && !goveeDevices.find(d => d.ip === device.ip)) {
        goveeDevices.push(device);
        console.log(`  ✔ ${device.model} at ${device.ip}`);
        if (goveeDevices.length === targetIps.size) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });

  console.log(`✔ Govee ready — ${goveeDevices.length}/${targetIps.size} device(s) connected.`);
}

/**
 * turnOn() — turn on all Hue lights and the Govee strip.
 */
async function turnOn() {
  console.log('Turning lights ON…');
  const hueState = new LightState().on();
  await Promise.all([
    hueSetAll(hueState),
    goveeAll(d => d.actions.setOn()),
  ]);
}

/**
 * turnOff() — turn off all Hue lights and the Govee strip.
 */
async function turnOff() {
  console.log('Turning lights OFF…');
  const hueState = new LightState().off();
  await Promise.all([
    hueSetAll(hueState),
    goveeAll(d => d.actions.setOff()),
  ]);
}

/**
 * setColor(r, g, b) — set RGB colour on all lights simultaneously.
 * @param {number} r  Red   0-255
 * @param {number} g  Green 0-255
 * @param {number} b  Blue  0-255
 */
async function setColor(r, g, b) {
  console.log(`Setting color → rgb(${r}, ${g}, ${b})`);
  const [x, y] = rgbToXy(r, g, b);
  const hueState = new LightState().on().xy(x, y);
  await Promise.all([
    hueSetAll(hueState),
    goveeAll(d => d.actions.setColor({ rgb: [r, g, b] })),
  ]);
}

/**
 * setBrightness(percent) — set brightness on all lights.
 * @param {number} percent  1–100
 */
async function setBrightness(percent) {
  const pct = Math.max(1, Math.min(100, percent));
  console.log(`Setting brightness → ${pct}%`);
  // Both Hue (new model API) and Govee accept 0-100 percentage
  const hueState = new LightState().on().brightness(pct);
  await Promise.all([
    hueSetAll(hueState),
    goveeAll(d => d.actions.setBrightness(pct)),
  ]);
}

// ─── Demo sequence (runs when this file is executed directly) ─────────────────

async function demo() {
  await init();

  console.log('\n── Demo sequence starting ──────────────────────────────────');

  // 1. Turn on & go full brightness white
  await turnOn();
  await setBrightness(100);
  await setColor(255, 255, 255);
  await sleep(2000);

  // 2. Warm orange (cozy / movie)
  console.log('\nScene: warm orange');
  await setColor(255, 100, 10);
  await setBrightness(70);
  await sleep(2500);

  // 3. Cool blue (focus / night)
  console.log('\nScene: cool blue');
  await setColor(20, 80, 255);
  await setBrightness(60);
  await sleep(2500);

  // 4. Party purple
  console.log('\nScene: party purple');
  await setColor(160, 0, 255);
  await setBrightness(90);
  await sleep(2500);

  // 5. Relax green
  console.log('\nScene: relax green');
  await setColor(0, 200, 80);
  await setBrightness(50);
  await sleep(2500);

  // 6. Fade out
  console.log('\nFading out…');
  for (let b = 50; b >= 10; b -= 10) {
    await setBrightness(b);
    await sleep(300);
  }
  await sleep(500);
  await turnOff();

  console.log('\n✔ Demo complete.\n');

  process.exit(0);
}

// Run demo when executed directly; export API for external use
if (require.main === module) {
  demo().catch(err => { console.error('\nError:', err.message); process.exit(1); });
} else {
  module.exports = { init, turnOn, turnOff, setColor, setBrightness };
}
