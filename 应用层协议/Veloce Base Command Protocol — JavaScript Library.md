Veloce Base Command Protocol — JavaScript Library v1.10

## Overview
This library implements the **Veloce Base Command Protocol** for direct browser usage. It provides a robust, transport‑agnostic command/response layer over a reliable, ordered byte stream (typically Web MIDI). The protocol uses a simple text‑based framing format: `[cmd=value;key=value;...]`. Every command expects an acknowledgement frame (except `ping`), and the library handles sequencing, retries, heartbeats, reconnection, and page‑visibility awareness.

**The internal transport (`JigsawSession`) is fully encapsulated** – you only interact with `VeloceBaseProtocol`.

---

## Getting Started (Browser Environment)

```js
const protocol = new VeloceBaseProtocol(inputPort, outputPort, options);
```

### Port Requirements
`inputPort` and `outputPort` must satisfy the following contracts:

```ts
// Common
interface VelocePort {
  state: 'connected' | 'disconnected';
  connection: 'open' | 'closed';
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

// Input port – data reception
// The library will add a 'midimessage' event listener internally.
interface VeloceInputPort extends VelocePort {
  addEventListener(type: 'midimessage', listener: (event: { data: Uint8Array }) => void): void;
  removeEventListener(type: 'midimessage', listener: (event: { data: Uint8Array }) => void): void;
}

// Output port – data sending
interface VeloceOutputPort extends VelocePort {
  send(data: Uint8Array): void;
}
```

These interfaces are compatible with standard Web MIDI API `MIDIInput` / `MIDIOutput`. The library will automatically register for `'midimessage'` events on the input port and call `send()` on the output port.

- **`options`** (optional) – `{ expectedBizProtoMajor?: number }`. If provided, the library compares the major version of the device’s `biz_proto_ver` during handshake and disables the `config` command domain on mismatch (causing `VersionMismatchError` for any subsequent config‑domain command).

---

## Core API: `VeloceBaseProtocol`

### Lifecycle Methods

#### `connect() -> Promise<void>`
Initiates the handshake sequence. State becomes `'HANDSHAKING'`, then `'CONNECTED'` on success. If already connected, resolves immediately. If a handshake is already in progress, returns the existing promise. On failure, state becomes `'DISCONNECTED'` and the promise rejects with `HandshakeError`.

> After a rejected `connect()`, the state returns to `'DISCONNECTED'`. You may call `connect()` again without recreating the instance.

#### `forceHandshake() -> Promise<void>`
Forcibly tears down any existing connection, re‑creates the transport, and performs a new handshake. Equivalent to `destroy` + `connect` but preserves the same instance and event listeners.

**When to use:**  
- When the library is still in `'CONNECTED'` state but you want a clean restart (e.g., after a device firmware update that requires re‑enumeration).  
- After a normal `onDisconnected` event, you should prefer a simple `connect()` because `forceHandshake()` is more aggressive.

#### `destroy()`
Stops heartbeats, flushes all pending commands, removes event listeners, and destroys the transport. After calling `destroy()`, the instance is no longer usable.

#### `getState() -> string`
Returns `'DISCONNECTED'`, `'HANDSHAKING'`, or `'CONNECTED'`.

#### `getDeviceInfo() -> Object | null`
Returns device information from the last successful handshake:
```ts
{
  id: string,
  ver: string,
  baseProtoVer: string,   // e.g. "1.10"
  bizProtoVer: string,
  maxFrameLen: number     // max payload size in bytes (UTF-8, excluding []). Typical range 128–1024.
}
```
Returns `null` if not connected.

---

### Sending Commands

#### `sendCommand(cmd, params) -> Promise<Map>`
Sends a command and waits for the corresponding `cmd_ack`. Resolves with a `Map` of response fields. Rejects immediately with `ConnectionLostError` if not connected.

```js
const resp = await protocol.sendCommand('set_volume', { vol: '75' });
```

**Restrictions on `cmd`:**  
- Must be a non‑empty string containing only alphanumeric characters and underscores (`[a-zA-Z0-9_]`).  
- The key name `'cmd'` is **reserved** and must not appear in `params` (it would conflict with the frame header).

**Restrictions on `params` keys and values:**  
- All keys and values must be strings.  
- **Illegal characters:** `[`, `]`, `;`, `=`, and space are forbidden. The library throws a native `Error` immediately if any such character is detected. Encode such data beforehand (e.g., URL‑encode or Base64).  
- Empty string values are **allowed** and will produce a field like `key=;` in the frame.

**Frame size:**  
The total byte length of the frame content (UTF‑8 encoded, between the brackets) must not exceed the negotiated `maxFrameLen` (in bytes). Oversized frames are rejected before transmission.

---

### Command Registration

#### `registerCommand(cmd, options)`
Pre‑configures timeout, retry, and cooldown behaviour. Unregistered commands use defaults (`domain: 'config'`, `timeoutMs: 2000`, `retries: 0`, `cooldownMs: 0`).

```js
protocol.registerCommand('reboot', {
  domain: 'system',
  timeoutMs: 5000,
  retries: 1,
  cooldownMs: 1000
});
```

- **`domain`** – `'config'` or custom. If the config domain is disabled (version mismatch), `sendCommand` throws `VersionMismatchError` before queuing.
- **`timeoutMs`** – ack wait time before retry/failure.
- **`retries`** – max retransmissions after timeout.
- **`cooldownMs`** – delay after ack before next command starts.

---

### Events

#### `setEventHandlers(handlers)`
Registers callbacks. **Important:** Calling this method again **completely replaces** all previous handlers (no merging).

```ts
handlers: {
  onAsyncFrame?: (cmd: string, fields: Map) => void;
  onDisconnected?: (reason: string) => void;
  onFatalError?: (error: Error) => void;
  onSuspended?: () => void;
  onResumed?: () => void;
}
```

- **`onAsyncFrame`** – Any frame not consumed by the command engine (e.g., unsolicited device notifications).
- **`onDisconnected`** – Connection lost (heartbeat failure, MIDI disconnect, etc.). **After this event, you can simply call `connect()` to reconnect.**
- **`onFatalError`** – Triggered **before** `onDisconnected` when an unrecoverable error occurs (e.g., code‑6 recovery exhausted, MIDI port closed). The instance is considered dead; you must `destroy()` it and create a new one.
- **`onSuspended` / `onResumed`** – Page visibility change (heartbeat paused/resumed).

---

## Error Types

| Class                      | `code` | Meaning |
|----------------------------|--------|---------|
| `TimeoutError`             | -1     | Command ack timeout. |
| `ConnectionLostError`      | -2     | Transport or heartbeat lost. |
| `HandshakeError`           | -3     | Handshake failed after all retries. |
| `PageHiddenTimeoutError`   | -4     | Page hidden too long; frame discarded. |
| `VersionMismatchError`     | -5     | Config‑domain command blocked by version mismatch. |
| `CommandError` (remote)    | ≥0     | Device sent `[cmd=error;code=N;msg=...]`. `remoteMsg` holds the message. |

Remote error code `6` triggers an automatic reconnection attempt (see AI Invariant).

---

## Business Protocol Reference (Minimal Example)

Until the full command dictionary is available, use these built‑in or example commands to test connectivity:

| cmd | params | ack fields | domain | notes |
|-----|--------|------------|--------|-------|
| `ping` | (none) | `status=ok` | system | Built‑in; do not register or send manually. Used by heartbeat. |
| `get_version` | (none) | `ver`, `base_proto_ver`, `biz_proto_ver` | system | Recommended: `timeoutMs: 2000` |
| `factory_reset` | (none) | `status=ok` | system | Already handled specially by the library. |

**Async frame examples (commonly received via `onAsyncFrame`):**
| cmd | fields | meaning |
|-----|--------|---------|
| `device_status` | `power=on/off`, `temp=<value>` | Device state change |
| `error` | `code=N`, `msg=...` | Asynchronous error from device (may be consumed by library if applicable) |

> Replace this section with your product’s actual command dictionary.

---

## Error Recovery Best Practices

- **`onDisconnected` received** → Just call `connect()` again.
- **`onFatalError` received** (instance dead) → Call `destroy()` and create a new `VeloceBaseProtocol`.
- **`connect()` rejection** → Safe to call `connect()` again immediately.
- **Need full reset while still `'CONNECTED'`** → Use `forceHandshake()`.
- **Transport‑level errors that immediately disconnect:** `'MIDI send failed'` and `'Transmission cancelled'` always cause a `ConnectionLostError` and trigger `onDisconnected`. Other transport errors only reject the current command.

---

## AI Invariant

1. **Single‑command sequencing** – At most one non‑ping command in‑flight.
2. **Handshake completeness** – After `connect()` resolves, `getDeviceInfo()` is non‑null.
3. **Frame size enforcement** – Oversized frames (byte count > negotiated `maxFrameLen`) are rejected before transmission.
4. **Ping/Pong heartbeat** – 10 s interval, 2 s pong timeout, 3 failures → disconnect. Suspended while page hidden.
5. **Page‑hidden grace** – Sends are queued for ≤5 s; then rejected with `PageHiddenTimeoutError`. Resumed on visibility.
6. **Remote error code 6** – Triggers up to 3 reconnection attempts. Success → command retried; exhaustion → `onFatalError` then `onDisconnected`.
7. **Command retry semantics** – Same frame retransmitted; timeout restarts each try.
8. **Cooldown** – After ack, next command waits `cooldownMs` before sending.
9. **Factory reset specialisation** – Always uses fixed timeout/retries.
10. **Domain gating** – Config domain disabled on version mismatch; throws `VersionMismatchError`.
11. **Transport error classification** – `'MIDI send failed'` and `'Transmission cancelled'` cause immediate disconnection. Others only reject the current command.
12. **Event listener cleanup** – `destroy()` removes all listeners and stops callbacks.
13. **Idempotency of connect** – Calling while connected/connecting is safe.
