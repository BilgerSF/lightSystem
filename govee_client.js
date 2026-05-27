'use strict';

/**
 * govee_client.js — Node.js bridge to govee_bridge.py
 *
 * Spawns govee_bridge.py as a persistent child process and communicates with
 * it via stdin/stdout JSON-lines (one JSON object per line).
 *
 * Public API:
 *   await goveeClient.init(ips)          — start bridge, register device IPs
 *   await goveeClient.turnOn()
 *   await goveeClient.turnOff()
 *   await goveeClient.setColor(r, g, b)
 *   await goveeClient.setBrightness(value)
 *         goveeClient.brightnessRaw(value) — fire-and-forget (dance effect)
 *         goveeClient.stop()               — shut down bridge process
 */

const { spawn }   = require('child_process');
const path        = require('path');
const readline    = require('readline');

const BRIDGE_SCRIPT = path.join(__dirname, 'govee_bridge.py');

// On Windows 'python' is the standard command; on Unix prefer 'python3'.
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

class GoveePythonBridge {
  constructor() {
    this._proc    = null;
    this._pending = new Map();  // id → { resolve, reject }
    this._nextId  = 1;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  _start() {
    if (this._proc) return;

    this._proc = spawn(PYTHON_CMD, [BRIDGE_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe Python stderr to Node stderr for visibility
    this._proc.stderr.on('data', d => process.stderr.write(`[govee-py] ${d}`));

    // Parse newline-delimited JSON responses from Python stdout
    const rl = readline.createInterface({ input: this._proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      const cb = this._pending.get(msg.id);
      if (!cb) return;   // fire-and-forget response — intentionally discarded
      this._pending.delete(msg.id);
      if (msg.ok) cb.resolve(msg);
      else        cb.reject(new Error(msg.error || 'govee-bridge error'));
    });

    this._proc.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`[govee-py] bridge exited (${reason})`);
      for (const cb of this._pending.values()) {
        cb.reject(new Error(`govee-bridge process exited unexpectedly (${reason})`));
      }
      this._pending.clear();
      this._proc = null;
    });
  }

  stop() {
    if (this._proc) {
      this._proc.stdin.end();
      this._proc = null;
    }
  }

  // ── Internal transport ──────────────────────────────────────────────────────

  /**
   * Send a command and return a Promise that resolves with the response.
   */
  _send(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this._proc) return reject(new Error('govee-bridge not started — call init() first'));
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  /**
   * Send a command without waiting for a response.
   * Used on latency-sensitive paths (e.g. the 80 ms dance-effect loop).
   */
  _fire(cmd, args = {}) {
    if (!this._proc) return;
    // Allocate an id but do NOT register a pending entry — response is silently
    // discarded when it arrives (the rl 'line' handler skips unknown ids).
    const id = this._nextId++;
    this._proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Start the Python bridge and register device IPs. */
  async init(ips) {
    this._start();
    return this._send('init', { ips });
  }

  turnOn()             { return this._send('turn_on'); }
  turnOff()            { return this._send('turn_off'); }
  setColor(r, g, b)    { return this._send('set_color', { r, g, b }); }
  setBrightness(value) { return this._send('set_brightness', { value }); }

  /** Fire-and-forget brightness — used by the dance effect interval. */
  brightnessRaw(value) { this._fire('set_brightness', { value }); }
}

module.exports = new GoveePythonBridge();
