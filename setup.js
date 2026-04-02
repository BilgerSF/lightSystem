/**
 * setup.js — One-time setup script for Philips Hue + Govee LAN Control
 *
 * Run this ONCE before using test.js:
 *   node setup.js
 *
 * What it does:
 *  1. Auto-discovers your Hue bridge on the local network
 *  2. Registers a new API user (you must press the link button on the bridge first)
 *  3. Discovers your Govee strip via LAN UDP multicast
 *  4. Saves bridge IP, Hue token, and Govee device IP to config.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const readline = require('readline');
const { discovery, api: hueApiFactory, v3 } = require('node-hue-api');
const GoveeClient = require('govee-lan-control').default;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ─── helpers ─────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { hue: { bridgeIp: '', username: '' }, govee: { deviceIp: '' } }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log('\n✔ config.json saved.\n');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Hue setup ───────────────────────────────────────────────────────────────

async function setupHue(config) {
  console.log('\n── Philips Hue Setup ──────────────────────────────────────');

  // 1. Discover bridge
  console.log('Scanning for Hue bridge…');
  const bridges = await discovery.nupnpSearch();

  if (!bridges.length) {
    console.error('No Hue bridge found on the local network. Check that it is connected and try again.');
    process.exit(1);
  }

  const bridge = bridges[0];
  config.hue.bridgeIp = bridge.ipaddress;
  console.log(`Found bridge at ${bridge.ipaddress} (id: ${bridge.id})`);

  // 2. Register user — user must press the physical link button first
  const appName  = 'lightSystem';
  const deviceName = 'nodeScript';

  await prompt('\nPress the LINK BUTTON on your Hue bridge now, then hit ENTER…');

  try {
    const unauthApi = await hueApiFactory.createLocal(config.hue.bridgeIp).connect();
    const createdUser = await unauthApi.users.createUser(appName, deviceName);
    config.hue.username = createdUser.username;
    console.log(`✔ Hue API user created: ${createdUser.username}`);
  } catch (err) {
    if (err.getHueErrorType && err.getHueErrorType() === 101) {
      console.error('\nLink button not pressed! Run setup.js again and press the button before hitting ENTER.');
    } else {
      console.error('Hue registration error:', err.message);
    }
    process.exit(1);
  }
}

// ─── Govee LAN setup ─────────────────────────────────────────────────────────

async function setupGovee(config) {
  console.log('\n── Govee LAN Setup ────────────────────────────────────────');
  console.log('Make sure "LAN Control" is enabled in the Govee Home app');
  console.log('  → Open app → Device → Settings (gear icon) → LAN Control → ON');
  console.log('\nScanning for Govee devices (10 seconds)…');

  const client = new GoveeClient();
  const found = [];

  // Deduplicate by IP — the library fires deviceAdded multiple times for the same device
  const seenIps = new Set();
  client.on('deviceAdded', device => {
    if (!seenIps.has(device.ip)) {
      seenIps.add(device.ip);
      console.log(`  Found: ${device.model} at ${device.ip}`);
      found.push(device);
    }
  });

  // Wait for initial discovery scan
  await sleep(12000);

  if (!found.length) {
    console.error(
      '\nNo Govee devices found. Verify:\n' +
      '  • LAN Control is enabled in the Govee Home app\n' +
      '  • Your PC and the Govee strip are on the same Wi-Fi network\n' +
      '  • No firewall is blocking UDP ports 4001–4003'
    );
    process.exit(1);
  }

  // Let user pick which devices to control (default: all)
  let selected;
  if (found.length === 1) {
    selected = found;
  } else {
    console.log('\nDevices found:');
    found.forEach((d, i) => console.log(`  [${i}] ${d.model} — ${d.ip}`));
    const answer = await prompt(
      'Enter device numbers to use (comma-separated), or press ENTER to select ALL: '
    );
    if (!answer.trim()) {
      selected = found;
    } else {
      selected = answer.split(',').map(s => found[parseInt(s.trim(), 10)]).filter(Boolean);
      if (!selected.length) selected = found;
    }
  }

  config.govee.deviceIps = selected.map(d => d.ip);
  console.log(`\n✔ Govee device(s) saved: ${config.govee.deviceIps.join(', ')}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const config = loadConfig();

  // Re-run only what is not yet configured (ask to reconfigure if already set)
  if (!config.hue.username) {
    await setupHue(config);
  } else {
    const ans = await prompt(`\nHue already configured (bridge: ${config.hue.bridgeIp}). Reconfigure? [y/N] `);
    if (ans.toLowerCase() === 'y') await setupHue(config);
  }

  if (!config.govee.deviceIps || !config.govee.deviceIps.length) {
    await setupGovee(config);
  } else {
    const current = config.govee.deviceIps.join(', ');
    const ans = await prompt(`\nGovee already configured (${config.govee.deviceIps.length} device(s): ${current}).\nReconfigure? [y/N] `);
    if (ans.toLowerCase() === 'y') await setupGovee(config);
  }

  saveConfig(config);
  console.log('Setup complete! Run  node test.js  to control your lights.\n');
})();
