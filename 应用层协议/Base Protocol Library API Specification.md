Base Protocol Library API Specification

**Version:** 1.16  
**Target Audience:** AI programmers integrating and extending the Veloce base protocol  
**Language:** C99  
**Dependencies:** `jigsaw.h` (MIDI transport), `base_proto_config.h`

---

## 1. Overview

The `base_proto` library provides a minimal, safe, and reusable application‑layer protocol handler for Veloce MIDI controllers. It handles frame parsing, command dispatch, connection state management, heartbeats, asynchronous operations, and error reporting over a Jigsaw MIDI transport. All public symbols are declared in `base_proto.h`. The implementation is fully static, requiring no dynamic memory allocation and suitable for bare‑metal or RTOS environments with a single main loop and an ISR.

The library is designed to be inherited by product‑specific firmware. AI programmers add their own commands by defining a `cmd_def_t` table and providing the corresponding handler callbacks. System commands (`handshake`, `ping`, `factory_reset`) are built in and always available.

---

## 2. Configuration (`base_proto_config.h`)

The user must provide a configuration header that defines:

| Macro                     | Required | Description | Range / Default |
|---------------------------|----------|-------------|-----------------|
| `BASE_PROTO_MAX_FRAME_LEN` | **Yes**  | Maximum payload length (between `[` and `]`) | 512 – 8192 |
| `JIGSAW_ENTER_CRITICAL()`  | **Yes**  | Disable interrupts / enter critical section | – |
| `JIGSAW_EXIT_CRITICAL()`   | **Yes**  | Restore interrupts / exit critical section | – |
| `BASE_PROTO_MAX_FIELDS`    | No       | Maximum number of key‑value pairs per frame | 20 (default) |
| `JIGSAW_TX_BUF_SIZE`       | No       | Jigsaw transmit buffer size | `BASE_PROTO_MAX_FRAME_LEN` |
| `JIGSAW_RX_TIMEOUT_MS`     | No       | Transport‑layer receive timeout (ms) | 500 |

If any mandatory macro is missing, compilation fails with `#error`.

---

## 3. Data Types & Callbacks

### 3.1 Opaque Context

```c
typedef struct base_proto_ctx_t base_proto_ctx_t;
```

All library state is held in this structure. The user allocates it statically or on the stack and never accesses its fields directly.

### 3.2 Enumerations

**Connection State**
```c
typedef enum {
    BASE_PROTO_IDLE,      // waiting for handshake
    BASE_PROTO_CONNECTED  // handshake completed, config-domain commands allowed
} base_proto_state_t;
```

**Command Domain**
```c
typedef enum { CMD_SYSTEM, CMD_CONFIG } cmd_domain_t;
```

**Command Flags**
```c
typedef enum {
    CMD_FLAG_NONE              = 0,
    CMD_FLAG_REQUIRE_CONNECTED = (1 << 0), // command only valid in CONNECTED state
    CMD_FLAG_ASYNC             = (1 << 1), // asynchronous operation, needs _ack or async_fail
} cmd_flags_t;
```

### 3.3 Callback Signatures

```c
typedef void (*midi_send_cb_t)(uint8_t status, uint8_t data1, uint8_t data2);
typedef void (*enter_critical_cb_t)(void);
typedef void (*exit_critical_cb_t)(void);
typedef void (*state_change_cb_t)(base_proto_state_t new_state);
typedef void (*factory_reset_cb_t)(void);
typedef void (*async_abort_cb_t)(const char *cmd_name);
```

- **`midi_send_cb_t`** – Transmits a single MIDI CC message. Called from both ISR and task context; must be reentrant.
- **`enter/exit_critical_cb_t`** – Typically remapped to `JIGSAW_ENTER_CRITICAL()`/`JIGSAW_EXIT_CRITICAL()`.
- **`state_change_cb_t`** – Invoked when the connection state changes (IDLE ↔ CONNECTED).
- **`factory_reset_cb_t`** – Invoked by the built‑in `factory_reset` command. The implementation must perform the reset (e.g., erase Flash) and when finished call `base_proto_send_response(ctx, "factory_reset_ack", NULL);`.
- **`async_abort_cb_t`** – Invoked when an asynchronous command is cancelled due to timeout, connection loss, or explicit abort. The handler should clean up any hardware state.

### 3.4 Command Definition Structure

```c
typedef struct {
    const char   *name;            // command name (e.g., "read_pot")
    cmd_handler_t handler;         // handler function
    cmd_domain_t  domain;          // CMD_SYSTEM or CMD_CONFIG
    uint32_t      flags;           // bitmask of cmd_flags_t
    const char   *required_keys;   // space‑separated required field names (NULL or "" = none)
    const char   *forbidden_keys;  // space‑separated forbidden field names; "*" forbids any field except "cmd"
    uint32_t      timeout_ms;      // async timeout in ms (0 uses default 5000)
} cmd_def_t;
```

Use **C99 designated initializers** to avoid ordering issues:
```c
{ .name = "read_adc", .handler = read_adc_handler, .domain = CMD_CONFIG, .flags = CMD_FLAG_REQUIRE_CONNECTED, ... }
```

---

## 4. API Functions

### 4.1 Initialization

```c
void base_proto_init(base_proto_ctx_t *ctx,
                     const char *device_id,
                     const char *fw_version,
                     const char *biz_proto_ver,
                     uint16_t max_frame_len,
                     const cmd_def_t *cmd_table,
                     size_t cmd_count,
                     midi_send_cb_t midi_send,
                     enter_critical_cb_t enter_crit,
                     exit_critical_cb_t exit_crit,
                     state_change_cb_t on_state_change,
                     factory_reset_cb_t factory_reset_cb,
                     async_abort_cb_t async_abort_cb);
```

- `device_id` – unique device identifier (e.g., `"Veloce-A1B2"`). Must be a safe string.
- `fw_version` – product firmware version.
- `biz_proto_ver` – product‑specific protocol version.
- `max_frame_len` – actual maximum frame length for this product, clamped to `[32, BASE_PROTO_MAX_FRAME_LEN]`.
- `cmd_table` – array of user‑defined commands. **Must remain valid for the lifetime of the context.**
- `cmd_count` – number of entries in `cmd_table`.
- Callbacks may be `NULL` if not used, except `midi_send`, `enter_crit`, `exit_crit`.

Initializes all internal state, the Jigsaw transport, and the double‑buffer receiver. After this call the device is in `BASE_PROTO_IDLE`.

### 4.2 ISR Entry

```c
void base_proto_on_midi_cc(base_proto_ctx_t *ctx, uint8_t ch,
                           uint8_t cc, uint8_t val, uint32_t now_ms);
```

Must be called **only from the MIDI receive ISR** when a CC message arrives. `now_ms` is a free‑running millisecond counter. It:

- Feeds the byte to the Jigsaw transport for frame reassembly.
- When a complete frame is received, swaps the double‑buffer pointers and sets `frame_ready`. The actual parsing is deferred to the task loop.
- Pumps any pending Jigsaw TX messages by calling `ctx->midi_send`.

**Critical sections are used** around the buffer swap to avoid races with the task loop.

### 4.3 Main Task Loop

```c
void base_proto_task(base_proto_ctx_t *ctx, uint32_t now_ms);
```

Must be called **periodically in the main loop**, ideally every 5–10 ms. `now_ms` must be the same time base as passed to `base_proto_on_midi_cc`. This function performs sequentially:

1. **Jigsaw tick** – advances transport‑layer timers, triggers retransmissions, and drains TX.
2. **Frame collection** – copies the ready frame from the ISR buffer and feeds it byte‑by‑byte to the parser.
3. **Frame timeout** – if a partial frame has been started (`[` received but no `]` for 1000 ms), the parser resets and an error is posted.
4. **Command dispatch** – if a complete and valid frame has been parsed, it runs `dispatch_command()`.
5. **Error posting** – any parse error accumulated by the ISR or parser is sent.
6. **TX priority scheduler** – sends pending frames in this order:
   - Commands (response) – highest priority, can be overridden only by `pong` or an asynchronous `_ack`.
   - Error frames – sent only when no command frame is waiting (to avoid starving retries).
   - Async data frames – lowest priority, can be overwritten.
7. **Async timeout** – checks and cancels expired asynchronous commands.
8. **Connection timeout** – if in `CONNECTED` state and no activity for 30 s, resets to `IDLE`, cancels async, clears all buffers, and invokes the state change callback.

### 4.4 Sending Frames

All send functions are **callable only from the task context** (i.e., from command handlers or the main loop). They format a frame and mark it for transmission. Actual TX is handled by the task loop scheduler.

| Function | Priority | Buffer | Overwrite Policy |
|----------|----------|--------|------------------|
| `base_proto_send_response` | High | `cmd_tx_buf` | Rejects if another command is pending, **except** for `pong` or the `_ack` of the currently active async command, which can overwrite. |
| `base_proto_send_error_safe` / `BASE_PROTO_SEND_ERROR` | Medium | `err_tx_buf` | Independent buffer; can be overwritten by a newer error if unsent. |
| `base_proto_send_async` | Low | `async_tx_buf` | Can be overwritten by a newer async frame; old frame is discarded silently. |
| `base_proto_async_fail` | – | – | Cancels the active async command and then calls `base_proto_send_error_safe`. |

```c
bool base_proto_send_response(base_proto_ctx_t *ctx, const char *cmd, ...);
```
Constructs a frame `[cmd=<cmd>;key1=val1;...]`. The variadic arguments are `key, value` pairs terminated by a `NULL` key. Returns `false` if the buffer is full or an unsafe character is encountered. **This is the only way to send responses and `_ack` frames.**

```c
bool base_proto_send_async(base_proto_ctx_t *ctx, const char *cmd, ...);
```
Identical variadic interface but uses the async buffer. Suitable for streaming data like `report_adc`.

```c
bool base_proto_send_error_safe(base_proto_ctx_t *ctx, uint8_t code, const char *msg);
```
Sends `[cmd=error;code=<code>;msg=<msg>]`. Any unsafe characters in `msg` are replaced with `_`. The `code` is a `uint8_t` printed as decimal. This buffer is independent of the command and async buffers.

```c
#define BASE_PROTO_SEND_ERROR(ctx, code, msg) \
    base_proto_send_error_safe((ctx), (code), (msg))
```
Convenience macro.

```c
bool base_proto_async_fail(base_proto_ctx_t *ctx, uint8_t code, const char *msg);
```
Must be called when an asynchronous operation fails. It cancels the async state and sends an error frame. Does nothing if no async command is active.

### 4.5 Field Access Functions

These functions read the fields of the **currently dispatched command frame**. They are only valid during the execution of a command handler; afterwards the parsed data may be overwritten.

```c
bool base_proto_get_str(const base_proto_ctx_t *ctx, const char *key, const char **value);
bool base_proto_get_int(const base_proto_ctx_t *ctx, const char *key, int32_t *value);
bool base_proto_get_uint(const base_proto_ctx_t *ctx, const char *key, uint32_t *value);
bool base_proto_has_field(const base_proto_ctx_t *ctx, const char *key);
uint8_t base_proto_field_count(const base_proto_ctx_t *ctx);
```

- `base_proto_get_str` sets `*value` to a pointer into the internal parsed buffer. **Do not free or modify it.** It remains valid only until the handler returns.
- Integer parsers use `strtol`/`strtoul` with overflow detection and reject empty strings, leading whitespace, and negative values (for unsigned).
- `base_proto_has_field` returns `true` if the key exists, even if its value is empty.
- `base_proto_field_count` returns the total number of parsed key‑value pairs (including `cmd`).

---

## 5. Writing Command Handlers

Command handlers have the signature:
```c
void my_handler(base_proto_ctx_t *ctx);
```
They are invoked **inside** `dispatch_command()` during `base_proto_task`. The following rules apply:

- **Do not block** – handlers execute in the main loop; long operations must be offloaded (e.g., start an async process and return).
- **All send functions are allowed** – use `base_proto_send_response` for the immediate reply.
- **Field access** – use the `base_proto_get_*` functions to extract parameters. The parsed command name is available through the internal API (if needed) but normally the handler already knows which command it serves.
- **State changes** – do not manually modify `ctx->state`. The library manages the connection state.
- **Asynchronous commands** – if the command has `CMD_FLAG_ASYNC`, the library **automatically** sets up the async tracking after the handler returns. The handler must eventually call `base_proto_send_response(ctx, "command_ack", ...)` or `base_proto_async_fail(ctx, code, msg)`. See Section 6.
- **Return value** – handlers return `void`. Errors are reported by sending an error frame (using `BASE_PROTO_SEND_ERROR`). The library does not inspect the handler’s return.

Example:
```c
static void read_config_handler(base_proto_ctx_t *ctx) {
    const char *param;
    if (base_proto_get_str(ctx, "param", &param)) {
        // ... fetch config, reply
        base_proto_send_response(ctx, "read_config", "value", config_value, NULL);
    } else {
        BASE_PROTO_SEND_ERROR(ctx, 3, "missing_parameter");
    }
}
```

---

## 6. Asynchronous Commands

Commands flagged with `CMD_FLAG_ASYNC` signal operations that cannot be completed immediately (e.g., `factory_reset`, long calibration). The protocol expects:

1. **Request** arrives, handler starts the operation.
2. **Eventually** the firmware sends `[cmd=<cmd_name>_ack;...]` or `[cmd=error;...]` using `base_proto_async_fail`.

The library enforces:
- Only one asynchronous command may be active at a time; a new request while one is active yields error code 3 (`stream_active`).
- A timeout timer starts after the handler returns. If no `_ack` or error is received within `timeout_ms` (or 5000 ms default), the library cancels the async state, calls `async_abort_cb`, and sends `[cmd=error;code=7;msg=async_timeout]`.
- The `_ack` frame is treated specially: `base_proto_send_response` will **override** any pending command frame to ensure the ACK is sent promptly.
- The handler may send progress updates using `base_proto_send_async` while the operation is pending.

To end an asynchronous operation:
```c
base_proto_send_response(ctx, "my_cmd_ack", "result", val, NULL);
```
or on failure:
```c
base_proto_async_fail(ctx, 4, "hardware_error");
```
Calling `base_proto_send_response` with the appropriate `_ack` name automatically terminates the async state. Do **not** call `cancel_async` manually; it is a library‑internal function.

---

## 7. Error Handling

Errors are reported as frames `[cmd=error;code=<uint8>;msg=<string>]`. Pre‑defined error codes:

| Code | Meaning | Typical use |
|------|---------|-------------|
| 1 | Frame / transport error | `frame_too_long`, `frame_timeout`, `invalid_frame` |
| 2 | Unknown command | command name not in table |
| 3 | Invalid parameter | missing required key, out‑of‑range, forbidden field, duplicate key |
| 4 | Internal execution failure | e.g., Flash write error |
| 6 | Not connected | config‑domain command before handshake |
| 7 | Async timeout | async command did not finish in time |

Custom codes ≥8 may be defined by the product, but they must be documented.

The library internally posts errors via `set_parse_error` (ISR‑safe) which are then sent by the task loop. Handlers should send errors using `BASE_PROTO_SEND_ERROR`.

---

## 8. Internal Architecture (Summary)

- **Double‑buffered RX**: `app_rx_buf0/1` are swapped between ISR and task under critical sections. This avoids copying the frame in the ISR.
- **Parsing**: The task‑loop copies the raw frame bytes into a local buffer, then `feed_byte` runs a simple state machine (`IDLE / RECEIVING / IGNORE_UNTIL_BRACKET`) that handles `[`, `]`, and byte‑by‑byte accumulation. When a frame completes, `parse_frame_content` tokenises it in‑place by inserting null‑terminators at `=` and `;`. The resulting `parsed_keys[]` and `parsed_values[]` point directly into that buffer. The command handler therefore sees standard C strings.
- **TX scheduling**: Separate buffers for responses, errors, and async data guarantee that critical frames are never starved. The retry logic in `drain_tx` re‑queues failed error/response frames up to 2 times.
- **No recursion**: All API calls that generate TX frames merely set pending flags; actual TX is performed by the task loop, making the system naturally single‑threaded with respect to the protocol state.

---

## 9. AI Invariants

These are non‑negotiable constraints that **must** be respected by any AI‑generated code that uses or extends this library. Violating any of them will lead to undefined behaviour, crashes, or protocol misoperation.

1. **Context ownership**  
   `base_proto_ctx_t` must be allocated by the user and never copied or moved after `base_proto_init`. All subsequent calls must use the same pointer.

2. **Thread model**  
   - `base_proto_on_midi_cc` → **ISR context only**.  
   - `base_proto_task` and all send/field functions → **main loop / task context only**.  
   No other threads are allowed; the library is not thread‑safe beyond the critical section protection.

3. **Critical sections**  
   `JIGSAW_ENTER_CRITICAL()` / `JIGSAW_EXIT_CRITICAL()` must genuinely disable/enable **all interrupts** that can call `base_proto_on_midi_cc`. Failing to do so will corrupt the double‑buffer swap and the `frame_ready` flag.

4. **Immutable command table**  
   The `cmd_table` array passed to `base_proto_init` must remain valid and unmodified for the lifetime of the context. The library stores only a pointer; it does not copy the table.

5. **Frame length contract**  
   - `BASE_PROTO_MAX_FRAME_LEN` must be in [512, 8192] and must accommodate the largest frame the product will ever send or receive.  
   - The `max_frame_len` parameter to `base_proto_init` must be ≤ `BASE_PROTO_MAX_FRAME_LEN`. The library clamps it to 32…`BASE_PROTO_MAX_FRAME_LEN`.  
   - All frames constructed by the API are guaranteed to fit within `max_frame_len`; user handlers must not manually concatenate data into a frame that exceeds it.

6. **Safe characters**  
   - All strings passed to send functions (`cmd`, keys, values) must contain only characters allowed by `is_safe_char`: **no** `[`, `]`, `;`, `=`, or space.  
   - Product IDs, versions, etc., must be pre‑sanitised. The library does not filter request/response payloads except for the error safe message.

7. **Parsed data lifetime**  
   Pointers returned by `base_proto_get_str` point into the parser’s temporary buffer. They are valid **only during the execution of the command handler**. Storing them across handler invocations or across `base_proto_task` calls is forbidden.

8. **No recursive `base_proto_task`**  
   Command handlers must not call `base_proto_task` (directly or indirectly). Doing so would corrupt the parser state, TX scheduler, and timeout handling.

9. **Async command completion**  
   For every `CMD_FLAG_ASYNC` command, exactly **one** of the following must eventually be called from task context:  
   - `base_proto_send_response(ctx, "<cmd>_ack", ...)`  
   - `base_proto_async_fail(ctx, code, msg)`  
   Failure to do so causes the async timeout to fire and abort the operation, but may leave hardware in an inconsistent state if the handler does not clean up.

10. **`factory_reset` callback**  
   The user‑supplied `factory_reset_cb` **must** call `base_proto_send_response(ctx, "factory_reset_ack", NULL)` after the reset is complete. The library does not send the ACK automatically.

11. **MIDI send callback reentrancy**  
   `midi_send` is called from the ISR (during `base_proto_on_midi_cc`) and from the task (during `drain_tx`). It must be reentrant, or the user must serialise access (e.g., by queueing messages from the ISR and sending them from the task). The library assumes it can be called from either context.

12. **Timebase**  
   The `now_ms` passed to both ISR and task functions must be the same monotonically increasing millisecond counter. All timeouts and the Jigsaw transport rely on it.

13. **Static buffer sizes**  
   The library uses fixed‑size buffers (`parse_buf`, `cmd_tx_buf`, `err_tx_buf`, `async_tx_buf`) of `BASE_PROTO_MAX_FRAME_LEN + 1`. The total RAM usage per context is roughly `4 * (BASE_PROTO_MAX_FRAME_LEN + 1) + 2 * (BASE_PROTO_MAX_FRAME_LEN + 2) + overhead`. Ensure the target MCU has sufficient static memory.

14. **Command table size**  
   The system commands occupy the first `NUM_SYS_CMDS` entries of the dispatcher’s search space; user commands are searched afterwards. Duplicate command names between system and user tables will be **silently masked** by the system handler; avoid such conflicts.

15. **Parsing error and command dispatch**  
   If a frame fails validation (missing `cmd`, duplicate keys, forbidden keys, missing required keys, etc.), the library sends an error frame and **does not invoke the handler**. The handler’s parameter validation should only confirm business‑logic constraints.

---

## 10. Example Integration

```c
#include "base_proto.h"

static base_proto_ctx_t proto_ctx;

// User command table
static void read_sensor_handler(base_proto_ctx_t *ctx) { ... }
static void write_param_handler(base_proto_ctx_t *ctx) { ... }

static const cmd_def_t user_cmds[] = {
    { .name="read_sensor", .handler=read_sensor_handler, .domain=CMD_CONFIG, .flags=CMD_FLAG_REQUIRE_CONNECTED, .required_keys="id", .forbidden_keys="", .timeout_ms=0 },
    { .name="write_param", .handler=write_param_handler, .domain=CMD_CONFIG, .flags=CMD_FLAG_ASYNC,      .required_keys="key value", .forbidden_keys="", .timeout_ms=3000 },
};

// Callbacks
static void my_midi_send(uint8_t s, uint8_t d1, uint8_t d2) { /* transmit byte */ }
static void on_state_change(base_proto_state_t st) { /* update LED */ }
static void on_factory_reset(void) { /* erase flash */ }

void main(void) {
    base_proto_init(&proto_ctx,
                    "Veloce-A1B2", "1.0", "1.0", 512,
                    user_cmds, sizeof(user_cmds)/sizeof(user_cmds[0]),
                    my_midi_send, JIGSAW_ENTER_CRITICAL, JIGSAW_EXIT_CRITICAL,
                    on_state_change, on_factory_reset, NULL);

    while (1) {
        uint32_t now = millis();
        base_proto_task(&proto_ctx, now);
        // ... other tasks
    }
}

// MIDI ISR
void MIDI_CC_IRQHandler(uint8_t ch, uint8_t cc, uint8_t val) {
    base_proto_on_midi_cc(&proto_ctx, ch, cc, val, millis());
}
```

---

*Document generated for AI programmer guidance. All constraints in Section 9 must be satisfied to guarantee correct protocol behaviour.*
