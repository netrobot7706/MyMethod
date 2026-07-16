## Jigsaw MIDI Transport Library V3.27 – AI Developer’s Contract & API Reference

### 1. Overview
Jigsaw is a reliable transport layer built on top of MIDI Control Change messages. It provides:
- Silent, byte‑by‑byte transparent frame transfer over MIDI CC#3/CC#9.
- 16‑bit additive checksum, start/end framing.
- Optional ACK handshake, NAK with reason codes, automatic retries.
- Bus arbitration (host wins) and full‑duplex bidirectional support.
- ISR‑safe API with concurrency protection.

**Target audience**: AI agents and LLM‑based code generators.  
**Protocol version**: Byte Over CC Channel‑Bit Transport V1.4.1.  
**Library version**: 3.27.

### 2. Integration Header

Include the library in a C project:
```c
#include "jigsaw.h"
```
No additional dependencies beyond standard C library (`stdint`, `stddef`, `stdbool`, `string`).

### 3. Compile‑time Configuration

Define the following macros **before** including `jigsaw.h` or via compiler flags:

| Macro | Default | Description |
|-------|---------|-------------|
| `JIGSAW_ENTER_CRITICAL()` | `((void)0)` | Enter critical section (disable interrupts / acquire lock) |
| `JIGSAW_EXIT_CRITICAL()` | `((void)0)` | Exit critical section (re‑enable interrupts / release lock) |
| `JIGSAW_ACK_ENABLED` | `1` | Enable ACK handshake (0 = disable, Start→Data immediately; WAIT_ACK never returned) |
| `JIGSAW_AUTO_RETRY` | `1` | Automatic retransmission on NAK (0 = manual only) |
| `JIGSAW_ACK_TIMEOUT_MS` | `500` | ACK wait timeout in milliseconds |
| `JIGSAW_TX_BUF_SIZE` | `256` | Internal TX buffer size (bytes) – only used when `JIGSAW_ZERO_COPY_TX` is **not** defined |
| `JIGSAW_MAX_FRAME_SIZE` | `8192` | Maximum frame payload length (bytes) |
| `JIGSAW_BATCH_INTERVAL_MS` | `10` | Interval between batches of MIDI messages (milliseconds) |
| `JIGSAW_BATCH_SIZE` | `64` | Number of data bytes per batch |
| `JIGSAW_RX_TIMEOUT_MS` | `500` | RX inactivity watchdog timeout (milliseconds) |
| `JIGSAW_MAX_RETRIES` | `3` | Maximum NAK retransmission attempts (after initial try) |
| `JIGSAW_ZERO_COPY_TX` | *(undefined)* | If defined, TX buffer is not used; caller must keep data valid until transmission completes |

### 4. Type Declarations

#### 4.1 Opaque Context
```c
typedef struct jigsaw_ctx_t jigsaw_ctx_t;
```
All state is stored in this struct. Application must instantiate one instance (global/static), never copied.

#### 4.2 Error / Status Codes (`jigsaw_status_t`)
| Enum Value | Integer | Meaning |
|------------|---------|---------|
| `JIGSAW_OK` | 0 | Operation succeeded |
| `JIGSAW_ERR_PARAM` | -1 | Invalid parameter (null pointer, zero length) |
| `JIGSAW_ERR_BUS_BUSY` | -2 | Bus is occupied (RX active or not free) |
| `JIGSAW_ERR_TX_BUSY` | -3 | TX state machine not idle |
| `JIGSAW_ERR_RETRY_LIMIT` | -4 | Maximum retries exhausted |
| `JIGSAW_ERR_NO_FRAME` | -5 | No valid received frame available |
| `JIGSAW_ERR_OVERFLOW` | -6 | Frame too large for buffer |
| `JIGSAW_ERR_SIGNAL_PENDING` | -7 | Pending signal (ACK/NAK) must be drained first |

#### 4.3 RX Event (`jigsaw_rx_event_t`)
Returned by `jigsaw_rx_feed`.

| Event | Value | Description |
|-------|-------|-------------|
| `JIGSAW_RX_IDLE` | 0 | No state change; byte ignored or processed silently |
| `JIGSAW_RX_BYTE_ACCEPTED` | 1 | Data byte accepted into frame buffer |
| `JIGSAW_RX_FRAME_COMPLETE` | 2 | Frame successfully received and checksum verified |
| `JIGSAW_RX_NAK_RECEIVED` | 3 | NAK (with optional reason) received from peer |
| `JIGSAW_RX_ACK_RECEIVED` | 4 | ACK received (handled internally, for information only) |
| `JIGSAW_RX_ERR_CHECKSUM` | -1 | Checksum mismatch (frame discarded) |
| `JIGSAW_RX_ERR_OVERFLOW` | -2 | RX buffer overflow (frame discarded) |
| `JIGSAW_RX_ERR_PROTOCOL` | -3 | Protocol violation (unexpected signal) |

#### 4.4 TX Event (`jigsaw_tx_event_t`)
Returned by `jigsaw_tx_next_message`.

| Event | Value | Description |
|-------|-------|-------------|
| `JIGSAW_TX_IDLE` | 0 | No message to send |
| `JIGSAW_TX_MSG_READY` | 1 | MIDI message ready; use `ch, cc, val` to send |
| `JIGSAW_TX_BATCH_END` | 2 | Batch interval reached; wait for `JIGSAW_TICK_TX_CONTINUE` before calling again |
| `JIGSAW_TX_WAIT_ACK` | 3 | Sent START, now waiting for ACK from peer; **stop calling** until `JIGSAW_TICK_TX_CONTINUE` |
| `JIGSAW_TX_FRAME_COMPLETE` | 4 | Entire frame (including checksum) has been sent |
| `JIGSAW_TX_FRAME_FAILED` | 5 | Frame transmission failed after retries |
| `JIGSAW_TX_ABORTED` | 6 | Frame transmission aborted due to peer start (pre‑emption) |

#### 4.5 Tick Event (`jigsaw_tick_event_t`)
Returned by `jigsaw_tick`.

| Event | Value | Description |
|-------|-------|-------------|
| `JIGSAW_TICK_NOTHING` | 0 | No action required |
| `JIGSAW_TICK_TX_CONTINUE` | 1 | Call `jigsaw_tx_next_message` to resume TX |
| `JIGSAW_TICK_RX_TIMEOUT` | 2 | RX watchdog timeout occurred; state reset |

### 5. Lifecycle

#### `jigsaw_init`
```c
jigsaw_status_t jigsaw_init(jigsaw_ctx_t *ctx, uint8_t *rx_buf, size_t rx_buf_size);
```
**Purpose**: Initialise the protocol engine.  
**Parameters**:
- `ctx` – pointer to uninitialized context (global/static)
- `rx_buf` – pointer to receive buffer (must remain valid for lifetime)
- `rx_buf_size` – size of `rx_buf` (max `JIGSAW_MAX_FRAME_SIZE`)

**Return**: `JIGSAW_OK` or `JIGSAW_ERR_PARAM`.  
**Contract**: Must be called **once** before any other API. Call from task context (not ISR).

#### `jigsaw_reset`
```c
void jigsaw_reset(jigsaw_ctx_t *ctx);
```
**Purpose**: Reset all RX/TX state and release bus. Clears pending signals, retry counters, buffers.  
**Thread safety**: Task context only; caller must ensure no concurrent access to `ctx`.

### 6. Receiving Data

#### `jigsaw_rx_feed`
```c
jigsaw_rx_event_t jigsaw_rx_feed(jigsaw_ctx_t *ctx, uint8_t ch, uint8_t cc, uint8_t val, uint32_t now_ms);
```
**Purpose**: Feed a received MIDI CC message to the parser.  
**Parameters**:
- `ch` – 0‑based MIDI channel (status & 0x0F)
- `cc` – CC number
- `val` – CC value
- `now_ms` – current monotonic millisecond timestamp (wraps around safely, library uses unsigned difference)

**Return**: `jigsaw_rx_event_t` – see Section 4.3.  
**Contract**: ISR‑safe. Messages not matching protocol channels/CC numbers return `JIGSAW_RX_IDLE` and are silently ignored. The timestamp must be monotonically increasing; wraparound is handled correctly by the library.  
**Concurrency**: Multiple ISRs may call this function concurrently, provided critical section macros are properly implemented to serialize access.

#### `jigsaw_rx_get_frame`
```c
jigsaw_status_t jigsaw_rx_get_frame(const jigsaw_ctx_t *ctx, const uint8_t **data, size_t *len);
```
**Purpose**: Retrieve the most recently completed valid frame.  
**Parameters**:
- `data` – output pointer to frame payload (inside `rx_buf`)
- `len` – output length of payload in bytes

**Return**: `JIGSAW_OK` if frame available, `JIGSAW_ERR_NO_FRAME` if none.  
**Contract**: ISR‑safe (uses critical section internally). The pointer is valid until the next call to `jigsaw_rx_feed` or `jigsaw_rx_release_frame`. If you defer processing to the main loop, ensure no new `jigsaw_rx_feed` call occurs before you have consumed the frame — otherwise the buffer may be overwritten.

#### `jigsaw_rx_release_frame` — **REQUIRED**
```c
void jigsaw_rx_release_frame(jigsaw_ctx_t *ctx);
```
**Purpose**: Mark the current frame as consumed, allowing a new frame to be recorded.  
**Contract**: ISR‑safe. **You MUST call this immediately after processing a completed frame.** Do not rely on a subsequent Start signal to clear the flag.

#### `jigsaw_rx_get_nak_reason`
```c
uint8_t jigsaw_rx_get_nak_reason(const jigsaw_ctx_t *ctx);
```
**Purpose**: Retrieve the NAK reason code (0 = none, 0x01 = checksum error, 0x02 = timeout).  
**Contract**: Task context.

### 7. Transmitting Data

#### `jigsaw_tx_submit`
```c
jigsaw_status_t jigsaw_tx_submit(jigsaw_ctx_t *ctx, const uint8_t *data, size_t len);
```
**Purpose**: Submit a frame for transmission.  
**Parameters**:
- `data` – pointer to data to send (copied internally unless `JIGSAW_ZERO_COPY_TX` is defined)
- `len` – number of bytes (1 .. `JIGSAW_MAX_FRAME_SIZE`; 0 returns `JIGSAW_ERR_PARAM`)

**Return**: `JIGSAW_OK` on success, `JIGSAW_ERR_BUS_BUSY` if bus not free, `JIGSAW_ERR_TX_BUSY` if TX state machine not idle, `JIGSAW_ERR_SIGNAL_PENDING` if pending signals exist.  
**Contract**: Task context only. If `JIGSAW_ZERO_COPY_TX` is defined, the caller must keep `data` valid until `jigsaw_tx_is_complete()` returns `true` (or `JIGSAW_TX_FRAME_COMPLETE`/`JIGSAW_TX_FRAME_FAILED` is returned from `jigsaw_tx_next_message`).

#### `jigsaw_tx_next_message`
```c
jigsaw_tx_event_t jigsaw_tx_next_message(jigsaw_ctx_t *ctx, uint8_t *ch, uint8_t *cc, uint8_t *val);
```
**Purpose**: Obtain the next MIDI message to send.  
**Parameters**: output `ch`, `cc`, `val` (valid only when return value is `JIGSAW_TX_MSG_READY`).  
**Return**: `jigsaw_tx_event_t` – see Section 4.4.  
**Contract**: ISR‑safe. In a drain loop, stop when the event is any of: `JIGSAW_TX_IDLE`, `JIGSAW_TX_FRAME_COMPLETE`, `JIGSAW_TX_FRAME_FAILED`, `JIGSAW_TX_WAIT_ACK`, or `JIGSAW_TX_BATCH_END`. For `JIGSAW_TX_MSG_READY`, construct a MIDI CC message: `(0xB0 | ch), cc, val` and send it.

#### `jigsaw_tx_restart`
```c
jigsaw_status_t jigsaw_tx_restart(jigsaw_ctx_t *ctx);
```
**Purpose**: Manually restart the last submitted frame (e.g., after abort or NAK when auto‑retry is off).  
**Return**: `JIGSAW_OK`, `JIGSAW_ERR_BUS_BUSY`, `JIGSAW_ERR_SIGNAL_PENDING`, `JIGSAW_ERR_RETRY_LIMIT`.  
**Contract**: Task context only. Consumes one NAK retry count.

### 8. Timing & Status

#### `jigsaw_tick`
```c
jigsaw_tick_event_t jigsaw_tick(jigsaw_ctx_t *ctx, uint32_t now_ms);
```
**Purpose**: Periodic housekeeping. Must be called regularly (every 1‑10 ms).  
**Parameters**: `now_ms` – monotonic millisecond timestamp.  
**Return**: `jigsaw_tick_event_t` – see Section 4.5.  
**Contract**: Task context. If it returns `JIGSAW_TICK_TX_CONTINUE`, continue calling `jigsaw_tx_next_message` to send data. `JIGSAW_TICK_RX_TIMEOUT` indicates an RX watchdog timeout (state reset, possible NAK queued).  
**Timing**: Calling less frequently (e.g., 50 ms) will not cause data loss, only degrade throughput; the library remains correct.

#### `jigsaw_bus_is_free`
```c
bool jigsaw_bus_is_free(const jigsaw_ctx_t *ctx);
```
**Purpose**: Check if the transport bus is available for a new transmission (no RX active and TX idle).  
**Contract**: ISR‑safe.

#### `jigsaw_tx_is_complete`
```c
bool jigsaw_tx_is_complete(const jigsaw_ctx_t *ctx);
```
**Purpose**: Check if the current TX operation has finished (success, failure, or abort).  
**Contract**: ISR‑safe.

#### `jigsaw_tx_is_aborted`
```c
bool jigsaw_tx_is_aborted(const jigsaw_ctx_t *ctx);
```
**Purpose**: Check if `tx_abort_pending` flag is set (peer started a transmission).  
**Contract**: ISR‑safe.

#### `jigsaw_tx_has_pending`
```c
bool jigsaw_tx_has_pending(const jigsaw_ctx_t *ctx);
```
**Purpose**: Check if there are pending signals (ACK/NAK) or NAK reason bytes to be sent. If `true`, continue calling `jigsaw_tx_next_message` until `false`.  
**Contract**: ISR‑safe.

### 9. Concurrency Model

| Function | ISR-safe? |
|----------|-----------|
| `jigsaw_init` | ❌ Task only |
| `jigsaw_reset` | ❌ Task only |
| `jigsaw_rx_feed` | ✅ |
| `jigsaw_rx_get_frame` | ✅ |
| `jigsaw_rx_release_frame` | ✅ |
| `jigsaw_rx_get_nak_reason` | ❌ Task only |
| `jigsaw_tx_submit` | ❌ Task only |
| `jigsaw_tx_next_message` | ✅ |
| `jigsaw_tx_restart` | ❌ Task only |
| `jigsaw_bus_is_free` | ✅ |
| `jigsaw_tx_is_complete` | ✅ |
| `jigsaw_tx_is_aborted` | ✅ |
| `jigsaw_tx_has_pending` | ✅ |
| `jigsaw_tick` | ❌ Task only |

Critical section macros (`JIGSAW_ENTER_CRITICAL` / `JIGSAW_EXIT_CRITICAL`) must be provided by the application to protect against concurrent ISR access. If macros are empty (single‑threaded), the library works but is not ISR‑safe.

### 10. Typical Integration Patterns

> **Note**: Functions like `midi_send()`, `get_monotonic_ms()`, and `sleep_ms()` are application‑provided pseudocode and not part of the library.

#### 10.1 Initialisation (once)
```c
static jigsaw_ctx_t jigsaw;
static uint8_t rx_buffer[8192];

#define JIGSAW_ENTER_CRITICAL() do { __disable_irq(); } while(0)
#define JIGSAW_EXIT_CRITICAL()  do { __enable_irq(); } while(0)

void init() {
    jigsaw_init(&jigsaw, rx_buffer, sizeof(rx_buffer));
}
```

#### 10.2 MIDI Receive ISR / Callback
**Purpose**: Handle protocol signals (ACK/NAK) and complete frames with minimal latency.  
**Rule**: Process completed frames and signal draining here; bulk payload draining is handled in the Main Loop.
```c
void on_midi_cc(uint8_t status, uint8_t data1, uint8_t data2) {
    uint8_t ch = status & 0x0F;
    uint8_t cc = data1;
    uint8_t val = data2;
    uint32_t now = get_monotonic_ms();

    jigsaw_rx_event_t ev = jigsaw_rx_feed(&jigsaw, ch, cc, val, now);

    if (ev == JIGSAW_RX_FRAME_COMPLETE) {
        const uint8_t *data;
        size_t len;
        if (jigsaw_rx_get_frame(&jigsaw, &data, &len) == JIGSAW_OK) {
            // process frame here (or set a flag for main loop if you can guarantee
            // no further jigsaw_rx_feed calls before processing)
            jigsaw_rx_release_frame(&jigsaw);  // REQUIRED
        }
    }
    // Drain any pending signals (ACK/NAK) immediately.
    while (jigsaw_tx_has_pending(&jigsaw)) {
        uint8_t ch_out, cc_out, val_out;
        jigsaw_tx_event_t tx_ev = jigsaw_tx_next_message(&jigsaw, &ch_out, &cc_out, &val_out);
        if (tx_ev == JIGSAW_TX_MSG_READY) {
            midi_send(0xB0 | ch_out, cc_out, val_out);
        } else {
            break;  // IDLE, BATCH_END, WAIT_ACK, etc.
        }
    }
}
```

#### 10.3 Main Loop (or RTOS task)
**Purpose**: Drive the bulk data transmission and periodic housekeeping.  
**Rule**: Drain payload data when `jigsaw_tick` returns `TX_CONTINUE`.
```c
void main_loop() {
    uint32_t last_tick = get_monotonic_ms();
    while (1) {
        uint32_t now = get_monotonic_ms();
        if ((now - last_tick) >= 10) {
            jigsaw_tick_event_t t = jigsaw_tick(&jigsaw, now);
            if (t == JIGSAW_TICK_TX_CONTINUE) {
                while (1) {
                    uint8_t ch, cc, val;
                    jigsaw_tx_event_t ev = jigsaw_tx_next_message(&jigsaw, &ch, &cc, &val);
                    if (ev == JIGSAW_TX_IDLE || ev == JIGSAW_TX_FRAME_COMPLETE ||
                        ev == JIGSAW_TX_FRAME_FAILED || ev == JIGSAW_TX_WAIT_ACK ||
                        ev == JIGSAW_TX_BATCH_END) {
                        break;
                    }
                    if (ev == JIGSAW_TX_MSG_READY) {
                        midi_send(0xB0 | ch, cc, val);
                    }
                }
            }
            last_tick = now;
        }
        sleep_ms(1);
    }
}
```

#### 10.4 Sending a Frame
```c
void send_data(const uint8_t *payload, size_t len) {
    jigsaw_status_t s = jigsaw_tx_submit(&jigsaw, payload, len);
    if (s == JIGSAW_OK) {
        // Frame submitted. Actual MIDI output will happen in the Main Loop (10.3).
    } else if (s == JIGSAW_ERR_SIGNAL_PENDING) {
        // Call jigsaw_tx_next_message until jigsaw_tx_has_pending() becomes false,
        // then retry jigsaw_tx_submit.
    }
}
```

### 11. Error Handling

- After `JIGSAW_TX_FRAME_FAILED`, the application may call `jigsaw_tx_restart()` or submit a new frame (after ensuring bus is free).
- After `JIGSAW_TX_ABORTED`, automatic retry will happen if `JIGSAW_AUTO_RETRY` is enabled, else manual restart is required.
- If `jigsaw_tx_submit` returns `JIGSAW_ERR_SIGNAL_PENDING`, call `jigsaw_tx_next_message` repeatedly until `jigsaw_tx_has_pending()` returns `false`, then retry.
- If a frame is lost due to checksum error, the library automatically queues a NAK; the sender handles retransmission (if auto‑retry) or the application must handle it.

### 12. Buffer Lifecycle (Zero‑Copy Mode)

When `JIGSAW_ZERO_COPY_TX` is defined:
- **THE DATA BUFFER MUST REMAIN VALID** until `jigsaw_tx_is_complete()` returns `true` or one of the terminal TX events is emitted.
- **FAILURE TO KEEP DATA VALID WILL CAUSE UNDEFINED BEHAVIOR (MEMORY CORRUPTION / WILD POINTER READ).**
- **NEVER** use a local stack buffer for zero‑copy transmission unless you statically guarantee it outlives the transmission (essentially impossible for asynchronous I/O).

### 13. Protocol Constants (for reference)

- Control channel: 13 (MIDI Ch.14, 0‑based)
- Data channels: 14 (bit 7 = 0) and 15 (bit 7 = 1)
- Signal CC: 3
- Data CC: 9
- Start: `(0xBD, 0x03, 0x00)`
- End: `(0xBD, 0x03, 0x01)`
- Checksum Header: `(0xBD, 0x03, 0x02)`
- ACK: `(0xBD, 0x03, 0x10)`
- NAK: `(0xBD, 0x03, 0x11)`

### 14. Integration Checklist (for AI agents)

1. [ ] Define `JIGSAW_ENTER_CRITICAL`/`JIGSAW_EXIT_CRITICAL` appropriate to the platform.
2. [ ] Allocate a `jigsaw_ctx_t` and an RX buffer of at least 256 bytes (recommend 8 KB for full protocol).
3. [ ] Call `jigsaw_init` once.
4. [ ] In MIDI receive handler, call `jigsaw_rx_feed` for every CC message.
5. [ ] In main loop / periodic timer (10 ms), call `jigsaw_tick` and handle the return event.
6. [ ] When `jigsaw_tick` returns `TX_CONTINUE`, call `jigsaw_tx_next_message` in a loop, breaking on any non‑`MSG_READY` event.
7. [ ] Before submitting a new frame, ensure `jigsaw_bus_is_free` AND `!jigsaw_tx_has_pending`. If pending, drain signals first (see Invariant 3).
8. [ ] After submission, rely on the main loop tick‑driven drain to send the payload.
9. [ ] On `RX_FRAME_COMPLETE`, retrieve the frame with `jigsaw_rx_get_frame` and **immediately** call `jigsaw_rx_release_frame`.
10. [ ] If `TX_ABORTED` or `TX_FAILED` is received, handle according to application retry policy.

### 15. AI Invariants (Must Not Violate)

> **To AI Agents**: The following rules are non‑negotiable. Violating any of them will result in undefined behavior, deadlocks, or silent data corruption.

1. **Dual‑Loop Drain Discipline**:
   - You **MUST** call `jigsaw_tx_next_message` inside the **ISR** (Section 10.2) to send ACK/NAK signals with minimal latency.
   - You **MUST** call `jigsaw_tx_next_message` inside the **Main Loop** (Section 10.3) to send bulk data when `jigsaw_tick` returns `TX_CONTINUE`.
   - **Do NOT** drain bulk data inside the ISR; **do NOT** skip signal draining in the ISR.

2. **Frame Release is Mandatory**:
   - You **MUST** call `jigsaw_rx_release_frame` immediately after processing the data pointer obtained from `jigsaw_rx_get_frame`.
   - **Do NOT** rely on the arrival of the next Start signal to clear the frame flag.

3. **Pre‑Submission Bus Check**:
   - Before calling `jigsaw_tx_submit`, you **MUST** verify both `jigsaw_bus_is_free()` and `!jigsaw_tx_has_pending()`.
   - If `jigsaw_tx_has_pending()` returns `true`, drain all pending signals via `jigsaw_tx_next_message` until it returns `JIGSAW_TX_IDLE`. Only then call `jigsaw_tx_submit`.

4. **Zero‑Copy Memory Safety**:
   - If `JIGSAW_ZERO_COPY_TX` is defined, the buffer passed to `jigsaw_tx_submit` **MUST** remain alive until `jigsaw_tx_is_complete()` returns `true`.
   - **NEVER** use a stack‑allocated buffer for zero‑copy transmission.

5. **Tick Frequency**:
   - Call `jigsaw_tick` at least every 10 ms in the main loop. Lower frequency is safe but degrades throughput.

6. **ISR‑Safe Function Set**:
   - Refer to the table in Section 9. Do **not** call any function not marked ISR‑safe from an interrupt context.

7. **Timestamp Wraparound**:
   - The `now_ms` parameter to `jigsaw_rx_feed` and `jigsaw_tick` may safely wrap around (the library uses unsigned difference arithmetic).

8. **Frame Pointer Lifetime**:
   - The pointer returned by `jigsaw_rx_get_frame` is valid only until the next `jigsaw_rx_feed` or `jigsaw_rx_release_frame`. If you defer processing, you must guarantee no `jigsaw_rx_feed` call occurs in the meantime.

This document constitutes the complete public API contract. Any behavioral detail not described herein is considered internal and subject to change without notice.
