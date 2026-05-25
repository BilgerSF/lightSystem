#!/usr/bin/env python3
"""
govee_segment_test.py — Segment control test for Govee H6175 LED strip lights
using the govee-led-wez library (https://github.com/wez/govee-py)

Install dependency:
    pip install govee-led-wez

─── How segment control works on H6175 ──────────────────────────────────────
The Govee LAN API (WLAN protocol) officially exposes four commands:
  turn · brightness · colorwc · devStatus

Per-LED "razer"-style commands are NOT supported on the H6175 via LAN.
Segment control is achieved here by treating each physical strip as one
independently-addressed colour zone:

  • Each of the 9 strips is its own segment.
  • Commands are sent in parallel to all strips, or staggered to create
    gradient / chase effects across the array.
  • govee-led-wez handles discovery bookkeeping; direct UDP is used for
    sending commands because the library's LAN poller relies on multicast
    which is sometimes blocked by routers.  Both paths are demonstrated.

Device IPs are loaded from config.json (govee.deviceIps) and augmented
by whatever govee-led-wez discovers via multicast scan.
─────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import base64
import colorsys
import json
import os
import socket
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from govee_led_wez import (
    GoveeController,
    GoveeColor,
    GoveeDevice,
    GoveeLanDeviceDefinition,
)

# ─── Constants ────────────────────────────────────────────────────────────────

COMMAND_PORT     = 4003   # Govee LAN control port
LISTEN_PORT      = 4002   # Port devices respond on
DISCOVERY_TIMEOUT = 5.0   # seconds for govee-led-wez multicast scan
PROBE_TIMEOUT    = 1.0    # seconds to wait for devStatus reply
STEP_DELAY       = 1.5    # seconds between test steps

# ─── Config ───────────────────────────────────────────────────────────────────

def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)

# ─── Direct UDP helpers ───────────────────────────────────────────────────────

def _send(ip: str, cmd: dict) -> None:
    """Fire-and-forget UDP send to a Govee device on port 4003."""
    data = json.dumps(cmd).encode("utf-8")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.sendto(data, (ip, COMMAND_PORT))


def probe_device(ip: str) -> Optional[dict]:
    """
    Send devStatus and return the response data dict, or None on timeout.
    Opens a fresh listener each call so it works without a persistent server.
    """
    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        listener.bind(("0.0.0.0", LISTEN_PORT))
    except OSError:
        # Port already bound elsewhere; skip the response capture
        listener.close()
        _send(ip, {"msg": {"cmd": "devStatus", "data": {}}})
        return None

    listener.settimeout(PROBE_TIMEOUT)
    _send(ip, {"msg": {"cmd": "devStatus", "data": {}}})
    try:
        data, addr = listener.recvfrom(4096)
        if addr[0] == ip:
            return json.loads(data).get("msg", {}).get("data", {})
    except socket.timeout:
        pass
    finally:
        listener.close()
    return None


def turn_on(ip: str) -> None:
    _send(ip, {"msg": {"cmd": "turn",       "data": {"value": 1}}})

def turn_off(ip: str) -> None:
    _send(ip, {"msg": {"cmd": "turn",       "data": {"value": 0}}})

def set_brightness(ip: str, pct: int) -> None:
    _send(ip, {"msg": {"cmd": "brightness", "data": {"value": max(1, min(100, pct))}}})

def set_color(ip: str, r: int, g: int, b: int) -> None:
    _send(ip, {"msg": {"cmd": "colorwc",    "data": {"color": {"r": r, "g": g, "b": b},
                                                      "colorTemInKelvin": 0}}})

# ─── ptReal within-strip segment helpers ─────────────────────────────────────

def make_ptreal_packet(seg: int, r: int, g: int, b: int) -> str:
    """
    Build a base64-encoded 20-byte BLE-style ptReal packet for one segment.
    Confirmed format for RGBIC strips (H619D; expected identical for H6175):
      byte  0:     0x33          BLE command header
      bytes 1-2:   0x05 0x15     LED domain / color mode
      byte  3:     0x01          color subcommand
      bytes 4-6:   R  G  B
      bytes 7-11:  0x00 × 5      color-temp padding (0 = use RGB color)
      bytes 12-18: 7-byte little-endian bitmask (bit N = segment N lit)
      byte  19:    XOR checksum of bytes 0-18
    """
    bitmask = (1 << seg).to_bytes(7, "little")
    data = bytes([0x33, 0x05, 0x15, 0x01, r, g, b,
                  0x00, 0x00, 0x00, 0x00, 0x00]) + bitmask
    chk = 0
    for byte in data:
        chk ^= byte
    return base64.b64encode(data + bytes([chk])).decode()


def send_ptreal(ip: str, seg: int, r: int, g: int, b: int) -> None:
    """Send a ptReal command targeting one segment on a device."""
    pkt = make_ptreal_packet(seg, r, g, b)
    _send(ip, {"msg": {"cmd": "ptReal", "data": {"command": [pkt]}}})

# ─── govee-led-wez: inject known IPs as virtual LAN devices ──────────────────

def build_controller_with_ips(ips: List[str]) -> GoveeController:
    """
    Create a GoveeController pre-populated with LAN device entries for each
    known IP.  This lets us call set_color / set_brightness via the library
    even when multicast discovery is blocked by the router.
    """
    ctrl = GoveeController()

    for idx, ip in enumerate(ips):
        device_id = f"LAN:{ip}"
        model     = "H6175"
        dev = GoveeDevice(device_id=device_id, model=model)
        dev.lan_definition = GoveeLanDeviceDefinition(
            ip_addr=ip,
            device_id=device_id,
            model=model,
            ble_hardware_version="",
            ble_software_version="",
            wifi_hardware_version="",
            wifi_software_version="",
        )
        ctrl.devices[device_id] = dev

    return ctrl

# ─── govee-led-wez discovery (multicast) ─────────────────────────────────────

_found_via_lib: List[GoveeDevice] = []

def _on_device(device: GoveeDevice) -> None:
    if device not in _found_via_lib and device.lan_definition:
        _found_via_lib.append(device)
        print(f"  [multicast] {device.device_id}  ip={device.lan_definition.ip_addr}")


async def discover_lan(timeout: float = DISCOVERY_TIMEOUT) -> List[str]:
    """
    Use govee-led-wez multicast scan to discover devices.
    Returns a list of IP addresses.
    """
    print(f"  Multicast scan ({timeout:.0f}s) …", end="", flush=True)
    ctrl = GoveeController()
    ctrl.set_device_change_callback(_on_device)
    ctrl.start_lan_poller()
    await asyncio.sleep(timeout)
    ips = [d.lan_definition.ip_addr for d in ctrl.devices.values() if d.lan_definition]
    await ctrl.async_stop()
    print(f" found {len(ips)} device(s)")
    return ips

# ─── Reachability check ───────────────────────────────────────────────────────

def probe_all(ips: List[str]) -> Dict[str, Optional[dict]]:
    """Send devStatus to every IP and return {ip: status_data_or_None}."""
    # One shared listener bound before probing
    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        listener.bind(("0.0.0.0", LISTEN_PORT))
    except OSError:
        listener.close()
        listener = None

    for ip in ips:
        _send(ip, {"msg": {"cmd": "devStatus", "data": {}}})

    results: Dict[str, Optional[dict]] = {ip: None for ip in ips}

    if listener:
        listener.settimeout(0.4)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                data, addr = listener.recvfrom(4096)
                src = addr[0]
                if src in results:
                    results[src] = json.loads(data).get("msg", {}).get("data", {})
            except socket.timeout:
                break
        listener.close()

    return results

# ─── Colour helpers ───────────────────────────────────────────────────────────

def hsv_color(hue: float, sat: float = 1.0, val: float = 1.0) -> Tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(hue % 1.0, sat, val)
    return int(r * 255), int(g * 255), int(b * 255)


async def set_segments_async(ip: str, colors: List[Tuple[int, int, int]]) -> None:
    """
    Send ptReal to all segments of one device, respecting the ~20 cmd/s rate
    limit.  One (r, g, b) tuple per segment.  Designed to run concurrently
    across multiple devices via asyncio.gather.
    """
    for seg, (r, g, b) in enumerate(colors):
        send_ptreal(ip, seg, r, g, b)
        await asyncio.sleep(0.05)  # 50 ms ≈ 20 cmd/s per-device limit

# ─── Segment test suite ───────────────────────────────────────────────────────

async def run_segment_tests(ips: List[str], ctrl: GoveeController) -> None:
    """
    Demonstrate segment control using the 9 physical strips as zones.

    Phase 1  — govee-led-wez API (GoveeController.set_color / set_brightness)
    Phase 2  — Direct UDP: solid-colour and multi-zone pattern tests
    Phase 3  — Direct UDP: animated effects across all strips
    """
    n = len(ips)

    RED    = (255,   0,   0)
    GREEN  = (  0, 255,   0)
    BLUE   = (  0,   0, 255)
    YELLOW = (255, 255,   0)
    CYAN   = (  0, 255, 255)
    PURPLE = (128,   0, 128)
    WHITE  = (255, 255, 255)
    OFF    = (  0,   0,   0)

    def send_all(r: int, g: int, b: int) -> None:
        for ip in ips:
            set_color(ip, r, g, b)

    sep = "─" * 58

    # ── Phase 1: govee-led-wez library control ────────────────────────────────
    print(f"\n{sep}")
    print("  Phase 1 — govee-led-wez GoveeController API")
    print(sep)

    lib_steps = [
        ("White (lib)", GoveeColor(red=255, green=255, blue=255)),
        ("Red   (lib)", GoveeColor(red=255, green=0,   blue=0)),
        ("Green (lib)", GoveeColor(red=0,   green=255, blue=0)),
        ("Blue  (lib)", GoveeColor(red=0,   green=0,   blue=255)),
    ]

    for label, color in lib_steps:
        print(f"  → {label}")
        for dev in ctrl.devices.values():
            try:
                await ctrl.set_brightness(dev, 100)
                await ctrl.set_color(dev, color)
            except Exception as exc:
                print(f"      ✗ {dev.device_id}: {exc}")
        await asyncio.sleep(STEP_DELAY)

    # ── Phase 2: direct UDP solid-colour and zone tests ───────────────────────
    print(f"\n{sep}")
    print("  Phase 2 — Direct UDP: per-device zone patterns")
    print(f"  {n} strips  →  {n} independently-addressed colour segments")
    print(sep)

    # 2a. All same colour
    for label, color in [("All White", WHITE), ("All Red", RED),
                          ("All Green", GREEN), ("All Blue", BLUE)]:
        print(f"  → {label}")
        send_all(*color)
        await asyncio.sleep(STEP_DELAY)

    # 2b. Gradient across strips  (each strip = one hue step)
    print("  → Rainbow gradient across strips (each strip = 1 hue zone)")
    for idx, ip in enumerate(ips):
        set_color(ip, *hsv_color(idx / n))
    await asyncio.sleep(STEP_DELAY * 2)

    # 2c. Two-group split
    mid = n // 2
    print(f"  → Two groups: first {mid} = Red, last {n - mid} = Blue")
    for ip in ips[:mid]:
        set_color(ip, *RED)
    for ip in ips[mid:]:
        set_color(ip, *BLUE)
    await asyncio.sleep(STEP_DELAY)

    # 2d. Three-group split
    t = n // 3
    print(f"  → Three groups: {t}/{t}/{n - 2*t} — Red / Green / Blue")
    for ip in ips[:t]:
        set_color(ip, *RED)
    for ip in ips[t:2*t]:
        set_color(ip, *GREEN)
    for ip in ips[2*t:]:
        set_color(ip, *BLUE)
    await asyncio.sleep(STEP_DELAY)

    # 2e. Alternating Yellow / Purple
    print("  → Alternating Yellow / Purple per strip")
    for idx, ip in enumerate(ips):
        set_color(ip, *(YELLOW if idx % 2 == 0 else PURPLE))
    await asyncio.sleep(STEP_DELAY)

    # ── Phase 3: animated effects ─────────────────────────────────────────────
    print(f"\n{sep}")
    print("  Phase 3 — Animated effects across all strips")
    print(sep)

    # 3a. Colour chase — lit strip sweeps through the array
    print("  → Chase: one active strip sweeps across all 9 strips (3 passes)")
    for _ in range(3):
        for active in range(n):
            for idx, ip in enumerate(ips):
                set_color(ip, *(CYAN if idx == active else (10, 10, 10)))
            await asyncio.sleep(0.12)

    # 3b. Rotating rainbow — hue offset shifts each frame
    print("  → Rotating rainbow (60 frames)")
    for frame in range(60):
        offset = frame / 60
        for idx, ip in enumerate(ips):
            set_color(ip, *hsv_color((idx / n + offset)))
        await asyncio.sleep(0.08)

    # 3c. Pulse all strips together
    print("  → Brightness pulse (white, 3 cycles)")
    for _ in range(3):
        for bri in list(range(10, 101, 10)) + list(range(100, 9, -10)):
            for ip in ips:
                set_brightness(ip, bri)
            await asyncio.sleep(0.04)

    # Restore to a pleasant warm white
    print("  → Restore warm white @ 60%")
    for ip in ips:
        set_color(ip, 255, 197, 143)
        set_brightness(ip, 60)

    # ── Phase 4: within-strip ptReal segment control ──────────────────────────
    print(f"\n{sep}")
    print("  Phase 4 — Within-strip ptReal segment control")
    print("  Power-cycling to exit colorwc mode, then addressing individual segments.")
    print(sep)

    MAX_SEGS = 15  # covers 8 / 10 / 12 / 15 segment RGBIC strips

    # colorwc silently disables ptReal — power cycle resets the device to accept it
    print("  → Power cycling all devices …")
    for ip in ips:
        turn_off(ip)
        time.sleep(0.05)
    await asyncio.sleep(0.8)
    for ip in ips:
        turn_on(ip)
        time.sleep(0.05)
    await asyncio.sleep(1.5)

    # Prime every segment (one ptReal per segment required to enter segment mode)
    print(f"  → Priming {MAX_SEGS} segments per device (all white) …")
    await asyncio.gather(*[
        set_segments_async(ip, [(255, 255, 255)] * MAX_SEGS) for ip in ips
    ])
    await asyncio.sleep(0.5)

    # 4a. Rainbow — each segment a distinct hue within the strip
    print("  → Segment rainbow (15 hue steps within each strip)")
    rainbow = [hsv_color(seg / MAX_SEGS) for seg in range(MAX_SEGS)]
    await asyncio.gather(*[set_segments_async(ip, rainbow) for ip in ips])
    await asyncio.sleep(STEP_DELAY * 2)

    # 4b. Alternating Red / Blue per segment
    print("  → Alternating Red / Blue segments")
    alt = [(255, 0, 0) if seg % 2 == 0 else (0, 0, 255) for seg in range(MAX_SEGS)]
    await asyncio.gather(*[set_segments_async(ip, alt) for ip in ips])
    await asyncio.sleep(STEP_DELAY)

    # 4c. Half warm orange / half cool blue
    print("  → Half warm orange / half cool blue")
    half = MAX_SEGS // 2
    half_colors = [(255, 120, 0)] * half + [(0, 80, 255)] * (MAX_SEGS - half)
    await asyncio.gather(*[set_segments_async(ip, half_colors) for ip in ips])
    await asyncio.sleep(STEP_DELAY)

    # 4d. Chase — sweep one lit segment across the strip
    #     Only 2 ptReal sends per step (light up / dim back) — no rate-limit wait needed
    print("  → Segment chase within strips (3 passes)")
    await asyncio.gather(*[
        set_segments_async(ip, [(10, 10, 10)] * MAX_SEGS) for ip in ips
    ])
    for _ in range(3):
        for active in range(MAX_SEGS):
            for ip in ips:
                send_ptreal(ip, active, 0, 255, 255)   # cyan active segment
            await asyncio.sleep(0.20)
            for ip in ips:
                send_ptreal(ip, active, 10, 10, 10)    # dim back

    # 4e. Restore warm white via ptReal (keeps device in segment mode)
    print("  → Restore warm white via segments @ 60%")
    warm = [(255, 197, 143)] * MAX_SEGS
    await asyncio.gather(*[set_segments_async(ip, warm) for ip in ips])
    for ip in ips:
        set_brightness(ip, 60)

    print(f"\n{sep}")
    print("  All tests complete.")
    print(sep)

# ─── Entry point ─────────────────────────────────────────────────────────────

async def main() -> None:
    script_dir  = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(script_dir, "config.json")

    config     = load_config(config_path)
    config_ips: List[str] = config.get("govee", {}).get("deviceIps", [])

    print("\n─── Device discovery ──────────────────────────────────────────")

    # 1. govee-led-wez multicast discovery
    multicast_ips = await discover_lan()

    # 2. Merge with config IPs (preserve order, no duplicates)
    seen: set = set()
    all_ips: List[str] = []
    for ip in multicast_ips + config_ips:
        if ip not in seen:
            seen.add(ip)
            all_ips.append(ip)

    if not all_ips:
        print("No Govee IPs found. Enable LAN Control in the Govee Home app.")
        return

    # 3. Probe each IP for reachability and current state
    print(f"  Probing {len(all_ips)} device(s) …")
    status_map = probe_all(all_ips)
    reachable = [ip for ip, s in status_map.items() if s is not None]
    unreachable = [ip for ip, s in status_map.items() if s is None]

    print(f"\n  {'IP':<20} {'status'}")
    print(f"  {'──'*20}")
    for ip in all_ips:
        s = status_map[ip]
        if s:
            on  = "ON " if s.get("onOff") else "off"
            bri = s.get("brightness", "?")
            c   = s.get("color", {})
            print(f"  {ip:<20} {on}  bri={bri:>3}%  "
                  f"rgb=({c.get('r',0):3},{c.get('g',0):3},{c.get('b',0):3})")
        else:
            print(f"  {ip:<20} ✗ no response")

    if not reachable:
        print("\nNo devices responded. Check network / LAN Control settings.")
        return

    if unreachable:
        print(f"\n  Skipping {len(unreachable)} unreachable device(s): {unreachable}")

    print(f"\n  Running tests on {len(reachable)} reachable device(s).")

    # 4. Turn everything on and set full brightness before tests
    for ip in reachable:
        turn_on(ip)
        set_brightness(ip, 100)
    await asyncio.sleep(0.5)

    # 5. Build govee-led-wez controller with the reachable IPs injected
    ctrl = build_controller_with_ips(reachable)
    ctrl.start_lan_poller()
    await asyncio.sleep(1)  # allow poller to start

    # 6. Run the test suite
    await run_segment_tests(reachable, ctrl)

    await ctrl.async_stop()


if __name__ == "__main__":
    asyncio.run(main())
