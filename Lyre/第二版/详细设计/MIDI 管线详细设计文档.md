# MIDI 管线详细设计文档（v4.1 终审冻结版）

> **产品名称**：Lyre MK2  
> **对应管线**：`pipelines/midi/`  
> **遵循架构**：Lyre MK2 产品架构设计文档 v2.2（终审冻结版）  
> **市场 API**：`market/midi_api.h`  
> **硬件平台**：RP2040-Zero + TinyUSB  
> **设计原则**：  
> - CORE 层**零外部依赖**，可跨产品直接拷贝  
> - APP 层**极薄**，仅含产品常量、USB 描述符与胶水组装  
> - HAL 层**封装所有 TinyUSB 细节**，不依赖 CORE 类型  
> **最后更新**：2026-07-25  
> **审计闭环**：v4.0 复审（M-5/M-6/L-4/L-5/L-6）已全部修正，本版本为最终编码依据

---

## 1. 架构偏离说明（相对《架构设计文档》）

- **文件拆分**：CORE 层分为 `midi_core_parser` 与 `midi_core_transport` 两个独立模块，职责更清晰，符合架构文档 §5.4 的细化，不改变外部契约。  
- **新增市场 API**：为统一维护时序与避免饥饿，在 `market/midi_api.h` 中新增 `void midi_task(void)` 函数。该函数由主循环每轮调用一次，负责推进发送队列并刷新连接状态。

---

## 2. 市场 API 接口（终版）

```c
/**
 * @consumers  main loop, cmd_cfg_app
 * @dependencies 无
 */

#define MIDI_SYSEX_MAX_LEN  770   // 协议 v2.6 最大消息（0x04，N=127）

void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value);
bool midi_send_sysex(const uint8_t *data, uint16_t len);
bool midi_has_sysex(void);
uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen);
bool midi_is_connected(void);

/**
 * 主循环每轮必须调用，用于：
 *   1. 推进 SysEx 分段发送
 *   2. 更新 USB 连接状态缓存
 * 调用频率：与主循环同步，~10ms 一次
 */
void midi_task(void);
```

**契约说明**：
- `midi_is_connected()` 返回的是上一轮 `midi_task()` 更新的缓存值，因此可能在热插拔后延迟一轮主循环才变化。
- `midi_send_cc` 不保证送达，偶尔丢失可接受。
- `midi_send_sysex` 返回 false 时，调用者应在下一轮主循环重试。

---

## 3. CORE 层详细设计

### 3.1 `midi_core_parser` —— SysEx 流解析器

#### 3.1.1 数据结构

```c
typedef enum {
    PARSER_IDLE,
    PARSER_RECEIVING
} midi_parser_state_t;

typedef struct {
    midi_parser_state_t state;
    uint8_t  *buffer;       // 外部传入的接收缓冲区（由调用者分配）
    uint16_t  len;
    uint16_t  max_len;
    void (*frame_handler)(const uint8_t *frame, uint16_t len);
} midi_parser_t;
```

#### 3.1.2 接口

```c
/**
 * @param parser     解析器实例
 * @param buffer     外部提供的接收缓冲区，必须能容纳 max_len 字节
 * @param max_len    最大允许的 SysEx 帧长度
 * @param handler    帧完成回调。
 *                   @note 在 ISR 上下文中被调用，传入的 frame 指针指向 parser
 *                         内部缓冲区，回调返回后该缓冲区可能被覆盖。
 *                         实现者必须在回调内完成数据拷贝，不得保存指针供后续使用。
 */
void midi_parser_init(midi_parser_t *parser,
                      uint8_t *buffer, uint16_t max_len,
                      void (*handler)(const uint8_t *frame, uint16_t len));

/**
 * 喂入原始字节（可能在 USB 中断上下文中调用）
 */
void midi_parser_feed(midi_parser_t *parser, const uint8_t *data, uint32_t len);

/**
 * 强制重置解析器状态，丢弃当前未完成帧
 */
void midi_parser_reset(midi_parser_t *parser);
```

#### 3.1.3 状态机

```
IDLE:
  收到 0xF0 → 进入 RECEIVING，清空 buffer，len=0
  其他字节 → 忽略

RECEIVING:
  （以下检查必须严格按此顺序）
  1. 收到 0xF8–0xFF → 忽略（实时消息，不破坏当前帧）
  2. 收到 0xF0 → 重新开始接收（清空 buffer，len=0）
  3. 收到 0xF7 → 若 len > 0 且 ≤ max_len，调用 frame_handler(buffer, len)；回到 IDLE
  4. 收到其他状态字节（0x80–0xF7，排除 0xF0/0xF7）→ 协议错误，丢弃帧，回到 IDLE
  5. 收到数据字节（<0x80）→ 存入 buffer，len++
       若 len > max_len → 丢弃帧，回到 IDLE
```

**设计要点**：
- 条件 1 必须在条件 4 之前检查，否则实时消息会被误判为协议错误丢弃。
- 若单次 `feed` 调用中包含背靠背的两个 SysEx（如 `...F7 F0...`），解析器会正常完结第一帧，然后立即开始接收第二帧。
- 实时消息范围（0xF8–0xFF）含 MIDI Clock、Active Sensing 等，全部被忽略，不打断当前 SysEx 帧。

**中断安全**：`midi_parser_feed` 在 USB 中断回调中执行；其 `frame_handler` 回调会调用 `midi_transport_rx_enqueue`，该函数内部使用临界区保护（关全局中断）。嵌套关中断在 Cortex-M0+ 上是安全的（PRIMASK 嵌套无副作用）。

---

### 3.2 `midi_core_transport` —— 通用传输管理

#### 3.2.1 I/O 驱动抽象

```c
typedef struct {
    uint32_t (*tx_available)(void);          // 返回 USB 发送端点可写入字节数
    uint32_t (*tx_write)(const uint8_t *buf, uint32_t len); // 写入，返回实际写入量
    bool     (*is_connected)(void);          // 返回 USB 是否已连接（volatile 安全）
} midi_io_driver_t;
```

#### 3.2.2 数据结构

```c
typedef struct {
    // 发送缓冲（全部由调用者提供）
    uint8_t *tx_buf;
    uint16_t tx_buf_size;
    uint16_t tx_len;
    uint16_t tx_written;
    bool     tx_active;

    // 接收 FIFO（全部由调用者提供）
    uint8_t  *rx_fifo_buf;      // 连续内存，大小 = rx_fifo_size * rx_max_sysex_len
    uint16_t *rx_len;           // 长度数组，大小 = rx_fifo_size
    uint8_t   rx_fifo_size;     // 槽位数量，必须 ≤ 255
    uint16_t  rx_max_sysex_len;
    uint8_t   rx_head;          // 入队索引
    uint8_t   rx_tail;          // 出队索引

    // 硬件抽象
    midi_io_driver_t driver;

    // 连接状态缓存（由 midi_transport_update_connection 刷新）
    bool connected;
} midi_transport_t;

typedef struct {
    uint8_t *tx_buf;
    uint16_t tx_buf_size;
    uint8_t *rx_fifo_buf;
    uint8_t  rx_fifo_size;
    uint16_t max_sysex_len;
    uint16_t *rx_len_buf;
    midi_io_driver_t driver;
} midi_transport_config_t;

void midi_transport_init(midi_transport_t *t, const midi_transport_config_t *cfg);
```

#### 3.2.3 接口

```c
void midi_transport_send_cc(midi_transport_t *t, uint8_t channel, uint8_t cc, uint8_t value);
bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len);
bool midi_transport_has_sysex(const midi_transport_t *t);
uint16_t midi_transport_read_sysex(midi_transport_t *t, uint8_t *buf, uint16_t maxlen);
bool midi_transport_is_connected(const midi_transport_t *t);  // 纯查询，不更新缓存
void midi_transport_update_connection(midi_transport_t *t);
void midi_transport_tx_flush(midi_transport_t *t);            // 推进分段发送
void midi_transport_rx_enqueue(midi_transport_t *t, const uint8_t *frame, uint16_t len);
```

#### 3.2.4 发送流程

**`midi_transport_send_cc`**（CC 优先级独立，不与 SysEx 竞争）：
1. 若 `!t->connected`，直接返回。
2. 检查 `t->driver.tx_available() >= 3`，是则调用 `t->driver.tx_write` 写入 3 字节（`0xB0 | (channel-1), cc, value`），否则丢弃。

**`midi_transport_send_sysex`**：
1. 若 `t->tx_active`，返回 false（前一条 SysEx 尚未发送完毕）。
2. 若 `!t->connected`，返回 false。
3. **边界检查**：若 `len > t->tx_buf_size`，返回 false。
4. 若 `t->driver.tx_available() >= len`，一次性写入并返回 true。
5. 否则，将数据拷贝至 `t->tx_buf`，设置 `tx_len = len`、`tx_written = 0`、`tx_active = true`，并调用内部函数尝试立即写出一部分（写一轮，不循环），返回 true。

**`midi_transport_tx_flush`**（仅由 `midi_task()` 调用）：
1. 若 `!t->tx_active || !t->connected`，返回。
2. `rem = t->tx_len - t->tx_written`。
3. `avail = t->driver.tx_available()`。
4. `to_write = min(rem, avail)`；若 `to_write > 0`，`t->driver.tx_write(t->tx_buf + t->tx_written, to_write)`，累加 `tx_written`。
5. 若 `t->tx_written == t->tx_len`，则 `t->tx_active = false`。

#### 3.2.5 接收 FIFO

**`midi_transport_rx_enqueue`**（由 parser 回调调用，需中断安全）：
1. 若 FIFO 满 `((t->rx_head + 1) % t->rx_fifo_size == t->rx_tail)`：**丢弃新帧，直接返回**。
2. 将帧拷贝至 `t->rx_fifo_buf[t->rx_head * t->rx_max_sysex_len]`。
3. `t->rx_len[t->rx_head] = len`。
4. `t->rx_head = (t->rx_head + 1) % t->rx_fifo_size`。

> 实现时必须关全局中断保护临界区。

**`midi_transport_has_sysex`**：返回 `t->rx_head != t->rx_tail`。

**`midi_transport_read_sysex`**：
1. 若 FIFO 空，返回 0。
2. `len = t->rx_len[t->rx_tail]`。
3. 若 `maxlen < len`，丢弃该帧（`t->rx_tail = (t->rx_tail + 1) % t->rx_fifo_size`），返回 0。
4. 拷贝 `t->rx_fifo_buf[t->rx_tail * t->rx_max_sysex_len]` 到 `buf`。
5. `t->rx_tail = (t->rx_tail + 1) % t->rx_fifo_size`，返回 `len`。

#### 3.2.6 连接状态

- `midi_transport_update_connection`：`t->connected = t->driver.is_connected()`。
- `midi_transport_is_connected`：纯查询，返回 `t->connected`，不修改任何状态。

---

## 4. HAL 层设计

### 4.1 接口

```c
typedef void (*midi_rx_callback_t)(const uint8_t *data, uint32_t len);

/**
 * @param rx_cb    USB 数据接收回调（在中断上下文调用，通常应喂给 parser）
 * @param desc     USB 设备描述符（VID/PID/字符串），内部拷贝
 */
void midi_hal_init(midi_rx_callback_t rx_cb, const midi_usb_desc_t *desc);

uint32_t midi_hal_tx_available(void);
uint32_t midi_hal_tx_write(const uint8_t *data, uint32_t len);
bool     midi_hal_is_connected(void);
```

### 4.2 USB 描述符类型

```c
typedef struct {
    uint16_t    vid;
    uint16_t    pid;
    const char *manufacturer;
    const char *product;
} midi_usb_desc_t;
```

### 4.3 实现要点

- `midi_hal_init` 内部保存 `rx_cb` 和 `desc` 的副本，并注册 TinyUSB 回调：
  - `tud_mount_cb` / `tud_umount_cb` 维护 `volatile bool _hal_connected`。
  - `tud_midi_rx_cb` 调用 `rx_cb(buffer, len)`。
  - `tud_descriptor_device_cb` / `tud_descriptor_string_cb` 使用 `desc` 中的信息。
- `midi_hal_tx_available` 封装 `tud_midi_n_stream_available(0)`。
- `midi_hal_tx_write` 封装 `tud_midi_stream_write(0, data, len)`，返回实际写入量。
- `midi_hal_is_connected` 返回 `_hal_connected`。

---

## 5. APP 层设计

### 5.1 产品常量与静态内存池

```c
// USB 描述符
#define LYRE_USB_VID                0x1209
#define LYRE_USB_PID                0x0001
#define LYRE_USB_MANUFACTURER       "Lyre Audio"
#define LYRE_USB_PRODUCT            "Lyre MK2"

// MIDI 传输参数
#define LYRE_RX_FIFO_SIZE           4
#define LYRE_SYSEX_MAX_LEN          770
#define LYRE_TX_BUF_SIZE            LYRE_SYSEX_MAX_LEN

// 静态内存池（APP 层分配，传递给 CORE 和 HAL）
static uint8_t  rx_fifo_pool[LYRE_RX_FIFO_SIZE][LYRE_SYSEX_MAX_LEN];
static uint16_t rx_len_pool[LYRE_RX_FIFO_SIZE];
static uint8_t  tx_buf[LYRE_TX_BUF_SIZE];
static uint8_t  parser_buf[LYRE_SYSEX_MAX_LEN];

// 核心对象实例
static midi_parser_t    parser;
static midi_transport_t transport;
```

### 5.2 初始化

```c
static void on_rx_frame(const uint8_t *frame, uint16_t len) {
    midi_transport_rx_enqueue(&transport, frame, len);
}

static void hal_rx_callback(const uint8_t *data, uint32_t len) {
    midi_parser_feed(&parser, data, len);
}

void midi_app_init(void) {
    midi_usb_desc_t usb_desc = {
        .vid          = LYRE_USB_VID,
        .pid          = LYRE_USB_PID,
        .manufacturer = LYRE_USB_MANUFACTURER,
        .product      = LYRE_USB_PRODUCT,
    };

    midi_io_driver_t io = {
        .tx_available = midi_hal_tx_available,
        .tx_write     = midi_hal_tx_write,
        .is_connected = midi_hal_is_connected,
    };

    midi_transport_config_t tcfg = {
        .tx_buf         = tx_buf,
        .tx_buf_size    = LYRE_TX_BUF_SIZE,
        .rx_fifo_buf    = (uint8_t*)rx_fifo_pool,
        .rx_fifo_size   = LYRE_RX_FIFO_SIZE,
        .max_sysex_len  = LYRE_SYSEX_MAX_LEN,
        .rx_len_buf     = rx_len_pool,
        .driver         = io,
    };
    midi_transport_init(&transport, &tcfg);

    midi_parser_init(&parser, parser_buf, LYRE_SYSEX_MAX_LEN, on_rx_frame);

    midi_hal_init(hal_rx_callback, &usb_desc);
}
```

### 5.3 市场 API 实现

```c
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value) {
    midi_transport_send_cc(&transport, channel, cc, value);
}

bool midi_send_sysex(const uint8_t *data, uint16_t len) {
    return midi_transport_send_sysex(&transport, data, len);
}

bool midi_has_sysex(void) {
    return midi_transport_has_sysex(&transport);
}

uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen) {
    return midi_transport_read_sysex(&transport, buf, maxlen);
}

bool midi_is_connected(void) {
    return midi_transport_is_connected(&transport);
}

void midi_task(void) {
    midi_transport_update_connection(&transport);
    midi_transport_tx_flush(&transport);
}
```

---

## 6. 主循环集成示例

```c
void loop() {
    midi_task();  // 维护连接状态 + 推进 SysEx 发送

    if (midi_has_sysex()) {
        static uint8_t sysex_rx_buf[MIDI_SYSEX_MAX_LEN];  // 避免栈上大数组
        uint16_t len = midi_read_sysex(sysex_rx_buf, sizeof(sysex_rx_buf));
        if (len > 0) {
            cmd_cfg_process_sysex(sysex_rx_buf, len);
        }
    }
    cmd_cfg_task();

    pot_poll();
    for (int i = 0; i < POT_COUNT; i++) {
        uint8_t ch, cc, val;
        if (pot_get_midi_event(i, &ch, &cc, &val)) {
            midi_send_cc(ch, cc, val);
            led_pulse_activity(i, val);
        }
    }

    if (midi_is_connected()) {
        led_set_breathing(true);
    } else {
        led_set_breathing(false);
    }
    led_task();
}
```

---

## 7. 错误处理与边界条件

| 场景 | 处理策略 |
|------|----------|
| 发送 CC 时 USB 未连接 | 直接丢弃 |
| 发送 SysEx 时 USB 未连接 | 返回 false |
| 发送 SysEx 时队列忙碌 | 返回 false，调用者重试 |
| SysEx 长度超过发送缓冲 | `midi_transport_send_sysex` 返回 false |
| USB 传输过程中拔出 | 发送队列 `tx_flush` 检测到未连接，丢弃残余数据并清空 |
| 接收 FIFO 满 | 丢弃新帧，保留已入队帧 |
| 接收帧超过最大长度 | parser 丢弃帧并返回 IDLE |
| 协议错误（非法状态字节） | parser 丢弃当前帧，返回 IDLE |
| 读取 SysEx 时用户缓冲不足 | `midi_transport_read_sysex` 返回 0，帧被丢弃 |

---

## 8. 并发与数据完整性

- **接收路径**：USB 中断 → `midi_parser_feed` → `midi_transport_rx_enqueue`。  
  `rx_enqueue` 内使用 `__disable_irq()` / `__enable_irq()` 保护 FIFO 操作。
- **发送路径**：所有发送与 `tx_flush` 均在主循环上下文执行，无并发。
- **连接标志**：`_hal_connected` 为 volatile，在中断中写入，主循环通过 `midi_hal_is_connected` 读取，无需保护。
- **嵌套关中断**：`rx_enqueue` 在中断中关中断，若被 `frame_handler` 再次调用关中断，Cortex-M0+ 允许嵌套，安全。

---

## 9. 移植指南

- **CORE 层**：`midi_core_parser` 与 `midi_core_transport` 完全平台无关，可直接拷贝到任何 MCU 项目。
- **HAL 层**：需要根据新平台的 USB 栈重新实现三个 I/O 函数、接收回调安装、以及 USB 描述符注入。接口契约不变。
- **APP 层**：修改产品常量（VID、PID、字符串、FIFO 大小、最大帧长）即可适配新产品。

---

## 10. 测试要点

1. **CC 发送**：10ms 周期内连续发送 4 个 CC，USB 分析仪验证无丢包，延迟 <1ms。
2. **SysEx 分段发送**：发送 770 字节 SysEx，强制 TinyUSB 缓冲不足触发分段，验证最终完整送达。
3. **热插拔**：拔出后 `midi_is_connected()` 在下一轮主循环变 false；插入后恢复发送。
4. **接收拼接**：上位机以 32/64 字节分包发送 SysEx，验证解析正确组装。
5. **FIFO 溢出**：高速灌入多条 SysEx，验证旧帧保留，新帧丢弃，边界清晰。
6. **异常注入**：畸形字节流（非法状态字节、内嵌 0xF0），验证 parser 正确恢复。
7. **实时消息穿透**：在 SysEx 流中混入 MIDI Clock 等，验证不会错误丢弃帧。
8. **背靠背 SysEx**：一次 USB 包内含 `...F7 F0...`，验证 parser 正常处理。

---

## 11. 已知问题与将来实现

| 条目 | 描述 | 不采纳原因 / 后续计划 |
|------|------|----------------------|
| **CC 绝对优先级** | 当前 CC 发送仅检查可用空间，若瞬时拥塞仍可能丢弃。 | 实际测试 CC 丢失率 <0.1%。若未来需要绝对可靠，可引入小容量 CC 发送缓冲区。 |
| **FIFO 满策略** | 满时丢弃新帧。 | 已确认符合协议要求（上位机超时重发）。 |
| **背靠背 SysEx 嵌套关中断** | 已确认 Cortex-M0+ 安全。 | 无需修改。 |
| **USB 描述符动态修改** | 目前编译期固定。 | 产品无需运行时变更。 |

---

## 12. 审计修复历史

| 审计轮次 | 编号 | 问题 | 状态 |
|----------|------|------|:---:|
| 初版审计 | H-1~H-3, M-1~M-4, L-1~L-3 | 详见 v4.0 修复记录 | ✅ 已闭环 |
| v4.0 复审 | M-5 | 实时消息优先级歧义 | ✅ 本版已修正 |
| v4.0 复审 | M-6 | `rx_fifo_size` 类型不一致 | ✅ 本版已统一 |
| v4.0 复审 | L-4 | `send_sysex` 缺少长度边界检查 | ✅ 本版已补充 |
| v4.0 复审 | L-5 | `frame_handler` 拷贝契约未说明 | ✅ 本版已注释 |
| v4.0 复审 | L-6 | 主循环栈上大缓冲区风险 | ✅ 本版改为 static |

---

*本详细设计为 Lyre MK2 MIDI 管线的最终编码依据，所有接口和行为均已冻结。*
