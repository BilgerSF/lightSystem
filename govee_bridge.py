#!/usr/bin/env python3
"""
govee_bridge.py — Govee LAN control bridge for Node.js, using govee_led_wez.

Node.js spawns this as a persistent child process and communicates with it
via stdin/stdout JSON-lines (one JSON object per line, newline-terminated).

Protocol
--------
  Request  (Node → Python):  {"id": <int>, "cmd": "<name>", ...params}
  Response (Python → Node):  {"id": <int>, "ok": true}
                              {"id": <int>, "ok": false, "error": "<msg>"}

Commands
--------
  init            {"ips": ["192.168.1.x", ...]}
  turn_on         {}
  turn_off        {}
  set_color       {"r": 0-255, "g": 0-255, "b": 0-255}
  set_brightness  {"value": 1-100}

Uses govee_led_wez.GoveeController exclusively.
For LAN devices the library sends commands as direct UDP datagrams
(no multicast / start_lan_poller needed when IPs are pre-populated).

Install dependency:
    pip install govee-led-wez
"""

import asyncio
import json
import sys
from typing import Dict, List, Optional, Tuple

from govee_led_wez import (
    GoveeColor,
    GoveeController,
    GoveeDevice,
    GoveeLanDeviceDefinition,
)

# ── Persistent event loop ─────────────────────────────────────────────────────
# govee_led_wez methods are async; we drive them from the synchronous main
# loop using a single reusable event loop.

_loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)

# ── Global state ──────────────────────────────────────────────────────────────

_controller: Optional[GoveeController] = None
_devices: List[GoveeDevice] = []


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_controller(ips: List[str]) -> Tuple[GoveeController, List[GoveeDevice]]:
    """
    Create a GoveeController pre-populated with a GoveeLanDeviceDefinition
    for each known IP.  Commands are sent via the library's internal
    _send_lan_command (direct UDP to ip_addr:4003) without multicast discovery.
    """
    ctrl = GoveeController()
    devs: List[GoveeDevice] = []
    for ip in ips:
        device_id = f"LAN:{ip}"
        dev = GoveeDevice(device_id=device_id, model="H6175")
        dev.lan_definition = GoveeLanDeviceDefinition(
            ip_addr=ip,
            device_id=device_id,
            model="H6175",
            ble_hardware_version="",
            ble_software_version="",
            wifi_hardware_version="",
            wifi_software_version="",
        )
        ctrl.devices[device_id] = dev
        devs.append(dev)
    return ctrl, devs


def _run(coro) -> None:
    """Run a coroutine on the persistent event loop and block until done."""
    _loop.run_until_complete(coro)


# ── Command handlers ──────────────────────────────────────────────────────────

def handle_init(msg: dict) -> dict:
    global _controller, _devices
    ips = [str(ip) for ip in msg.get("ips", [])]
    _controller, _devices = _build_controller(ips)
    return {"ok": True, "count": len(_devices)}


def handle_turn_on(_msg: dict) -> dict:
    async def _do() -> None:
        await asyncio.gather(*[
            _controller.set_power_state(dev, True) for dev in _devices
        ])
    _run(_do())
    return {"ok": True}


def handle_turn_off(_msg: dict) -> dict:
    async def _do() -> None:
        await asyncio.gather(*[
            _controller.set_power_state(dev, False) for dev in _devices
        ])
    _run(_do())
    return {"ok": True}


def handle_set_color(msg: dict) -> dict:
    r = max(0, min(255, int(msg["r"])))
    g = max(0, min(255, int(msg["g"])))
    b = max(0, min(255, int(msg["b"])))
    color = GoveeColor(red=r, green=g, blue=b)

    async def _do() -> None:
        await asyncio.gather(*[
            _controller.set_color(dev, color) for dev in _devices
        ])
    _run(_do())
    return {"ok": True}


def handle_set_brightness(msg: dict) -> dict:
    value = max(1, min(100, int(msg["value"])))

    async def _do() -> None:
        await asyncio.gather(*[
            _controller.set_brightness(dev, value) for dev in _devices
        ])
    _run(_do())
    return {"ok": True}


HANDLERS: Dict[str, object] = {
    "init":           handle_init,
    "turn_on":        handle_turn_on,
    "turn_off":       handle_turn_off,
    "set_color":      handle_set_color,
    "set_brightness": handle_set_brightness,
}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    """
    Read JSON-line commands from stdin, execute them, write JSON-line
    responses to stdout.  Runs until stdin is closed.
    """
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue

        msg_id = None
        try:
            msg = json.loads(raw)
            msg_id = msg.get("id")
            cmd = msg.get("cmd", "")
            handler = HANDLERS.get(cmd)
            if handler is None:
                result: dict = {"ok": False, "error": f"Unknown command: {cmd!r}"}
            else:
                result = handler(msg)  # type: ignore[operator]
            result["id"] = msg_id
            print(json.dumps(result), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"id": msg_id, "ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()

