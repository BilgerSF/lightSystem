# Dance Effect — How It Works

## Overview

The dance effect makes Govee LED strips react to music in real time by capturing microphone audio in the browser, analyzing bass frequencies, sending volume data to the server over WebSocket, and translating that into brightness commands sent via raw UDP to each Govee device.

---

## Pipeline

```
Microphone → Web Audio API → Bass Peak Detection → WebSocket → Server → Raw UDP → Govee Strips
  (browser)    (browser)         (browser)          (network)   (Node)   (Node)     (hardware)
```

---

## Step 1: Microphone Capture (Browser — `index.html`)

When the user clicks the **Dance** effect button:

1. **Request mic access** via `navigator.mediaDevices.getUserMedia({ audio: true })`
2. **Create an AudioContext** and connect the mic stream to an `AnalyserNode`
   - `analyser.fftSize = 256` → gives 128 frequency bins
3. **Open a WebSocket** to the server at `ws://<host>`

## Step 2: Bass Peak Detection (Browser — `index.html`)

Every **30ms**, a `setInterval` callback runs:

1. Call `analyser.getByteFrequencyData(buf)` — fills a `Uint8Array[128]` with frequency magnitudes (0–255)
2. Take the **peak value** of the first **10 bins** (≈ 0–1.7 kHz — the bass/kick drum range)
   - Peak (instead of average) reacts faster to transient beats
3. Normalize to 0–1: `volume = peak / 255`
4. Send `{ volume }` as JSON over the WebSocket

**Why bass bins?** Kick drums and bass lines dominate the 0–200 Hz range. These bins spike sharply on every beat and drop quickly between beats, giving a clean on/off signal.

## Step 3: WebSocket Relay (Server — `server.js`)

The server maintains a global `danceMicVolume` variable:

```js
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const { volume } = JSON.parse(raw);
    if (typeof volume === 'number' && isFinite(volume)) danceMicVolume = volume;
  });
});
```

Each incoming WebSocket message overwrites the current volume. The dance effect's `setInterval` reads this value on each tick.

## Step 4: Adaptive Normalization (Server — `server.js`)

Raw volume values don't span 0–1 cleanly — quiet music might range 0.2–0.5 while loud music ranges 0.4–0.9. The server uses **adaptive min/max tracking** to normalize:

```
volMin = volMin * DECAY_DOWN + vol * (1 - DECAY_DOWN)   // DECAY_DOWN = 0.85 (fast)
volMax = volMax * DECAY_UP   + vol * (1 - DECAY_UP)     // DECAY_UP   = 0.97 (slow)
```

- **volMin decays fast (0.85)** → brightness drops quickly when music gets quiet
- **volMax decays slow (0.97)** → peaks stay stable, preventing jitter at the top

The normalized value: `norm = (vol - volMin) / (volMax - volMin)` → always maps to roughly 0–1 regardless of absolute volume.

Final brightness: `bri = clamp(norm * 100, 5, 100)`

## Step 5: Raw UDP to Govee (Server — `server.js`)

Every **80ms**, the interval fires. If brightness changed from last tick:

1. Build the Govee LAN protocol JSON message:
   ```json
   { "msg": { "cmd": "brightness", "data": { "value": <bri> } } }
   ```
2. Send via the **library's own UDP socket** (`device.socket`) to each device's IP on **port 4003**
3. Fire-and-forget — no await, no callback blocking

**Why raw UDP instead of the library's `setBrightness()`?**
- The library wraps each call in a `Promise` that resolves on the UDP send callback
- At 80ms intervals, unresolved promises pile up and block subsequent commands
- Raw `socket.send()` is synchronous and non-blocking

**Why use the library's socket?**
- During discovery, the library creates a UDP socket bound to port 4002 and joined to multicast group `239.255.255.250`
- Govee devices only respond to commands from sockets they've seen during the scan handshake
- A fresh `dgram.createSocket('udp4')` gets ignored by the devices

---

## Timing Summary

| Stage | Interval | Purpose |
|---|---|---|
| Mic → FFT → WebSocket | 30ms | Capture bass peaks quickly |
| Server → UDP brightness | 80ms | Fast enough for beats, slow enough for Govee to process |
| volMin decay | 0.85 | Fast drop reaction |
| volMax decay | 0.97 | Stable peak tracking |

---

## Cleanup

When the user clicks Dance again (toggle off):

- **Browser**: stops mic stream, closes AudioContext, closes WebSocket, clears interval
- **Server**: `stopEffect()` clears the brightness interval
