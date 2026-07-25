# MIDI 管线详细设计文档（v2.0）

> **产品名称**：Lyre MK2  
> **对应管线**：`pipelines/midi/`  
> **遵循架构**：Lyre MK2 产品架构设计文档 v2.2  
> **市场 API**：`market/midi_api.h`  
> **硬件平台**：RP2040-Zero + TinyUSB  
> **设计原则**：CORE 层零外部依赖，APP 层极薄，仅做产品胶水与参数配置  
> **最后更新**：2026-07-25

---

## 1. 设计范围与职责

本详细设计覆盖 **MIDI 管线内部实现**，包括 HAL、CORE、APP 三层的模块划分、数据结构、处理流程、状态机及接口契约。外部使用方式请参阅《架构设计文档》第 6 章业务流定义。

MIDI 管线对外提供五个市场 API：

```c
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value);
bool midi_send_sysex(const uint8_t *data, uint16_t len);
bool midi_has_sysex(void);
uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen);
bool midi_is_connected(void);
```

内部职责：
- USB MIDI 物理收发（HAL 层，TinyUSB 耦合）
- SysEx 流实时解析（CORE 层，纯协议引擎，可跨平台复用）
- 通用 USB MIDI 传输管理：发送缓冲与分段重试、接收 FIFO、连接状态维护（CORE 层，基于抽象 I/O 驱动，零平台依赖）
- 产品特定参数（缓冲深度、最大帧长）与胶水组装（APP 层）

---

## 2. 管线内部结构

```
market/midi_api.h
        ↑
    midi_app.c/h          ← APP 层：产品胶水（仅常量定义、I/O 驱动组装、API 委托）
        ↑
    midi_core_transport.c/h   ← CORE 层：通用传输管理（发送队列、接收 FIFO、连接标志）
    midi_core_parser.c/h      ← CORE 层：SysEx 流解析状态机
        ↑
    midi_hal.c/h          ← HAL 层：TinyUSB 回调、底层读写函数
```

**依赖方向**：APP 依赖 CORE，CORE 不依赖 HAL（通过依赖注入解耦），HAL 仅被 APP 在初始化时传入 CORE。  
所有 CORE 模块代码可直接拷贝到新平台，无需任何修改；移植时只需替换 HAL 实现并传入新的驱动函数指针。

---

## 3. CORE 层详细设计

CORE 层由两个独立模块组成：`midi_core_parser` 和 `midi_core_transport`。二者之间也通过回调接口通信，无直接编译依赖。

### 3.1 `midi_core_parser` —— SysEx 流解析器

**职责**：将字节流实时解析为完整 SysEx 帧（0xF0 … 0xF7），帧边界识别，处理错误恢复。

**设计约束**：不包含任何硬件相关代码，不持有缓冲队列，仅输出完整帧。

#### 3.1.1 数据结构

```c
typedef enum {
    PARSER_IDLE,
    PARSER_RECEIVING
} parser_state_t;

typedef struct {
    parser_state_t state;
    uint8_t        buffer[MIDI_SYSEX_MAX_LEN];  // 由初始化时传入或使用宏，但宏由外部定义
    uint16_t       len;
    uint16_t       max_len;
    void (*frame_handler)(const uint8_t *frame, uint16_t len); // 帧完成回调
} midi_parser_t;
```

> **注意**：为避免 CORE 层包含产品宏，`max_len` 在初始化时由调用者（APP 层）传入。

#### 3.1.2 接口

```c
// 初始化解析器，设置最大帧长和帧完成回调
void midi_parser_init(midi_parser_t *parser, uint16_t max_len,
                      void (*handler)(const uint8_t *frame, uint16_t len));

// 喂入原始字节（通常在中断上下文中调用）
void midi_parser_feed(midi_parser_t *parser, const uint8_t *data, uint32_t len);

// 重置解析器状态（出错时内部调用，也可外部主动重置）
void midi_parser_reset(midi_parser_t *parser);
```

#### 3.1.3 状态机

```
IDLE --(0xF0)--> RECEIVING (清空缓冲区，len=0)
RECEIVING:
   - 收到 0xF7 且 len <= max_len → 调用 frame_handler(buffer, len)，回到 IDLE
   - 收到非实时状态字节且非 0xF7 → 协议错误，丢弃帧，回到 IDLE
   - 收到 0xF0 → 重新开始接收（覆盖缓冲区）
   - 数据字节 → 存入 buffer，len++；若溢出 max_len，丢弃并回到 IDLE
   - 实时消息（0xF8-0xFF）→ 忽略（或选择丢弃，此处忽略以支持时钟透传）
```

**错误处理策略**：任何导致帧无效的情况均返回 IDLE，不影响后续有效帧的接收。

#### 3.1.4 线程安全

`midi_parser_feed` 可能在中断中调用，而 `frame_handler` 回调将操作 `midi_core_transport` 的接收 FIFO。因此，`frame_handler` 内部必须实现临界区保护（具体由 transport 保证）。

---

### 3.2 `midi_core_transport` —— 通用传输管理

**职责**：管理 USB MIDI 发送与接收的通用逻辑，不依赖任何硬件平台。包含：
- SysEx 发送队列（单条缓冲 + 分段重试）
- 接收 FIFO（存储多个已解析帧）
- USB 连接状态维护（依赖外部注入的判断函数）
- 提供与硬件无关的收发原语

**设计约束**：通过 `midi_io_driver_t` 抽象 I/O 操作，不直接调用 HAL 函数。

#### 3.2.1 I/O 驱动抽象

```c
typedef struct {
    uint32_t (*tx_available)(void);          // 返回可写入 USB 端点的字节数
    uint32_t (*tx_write)(const uint8_t *buf, uint32_t len); // 写入数据，返回实际写入量
    bool     (*is_connected)(void);          // 返回 USB 是否已连接（volatile 安全）
} midi_io_driver_t;
```

transport 内部仅通过此结构体访问硬件。

#### 3.2.2 数据结构

```c
typedef struct {
    // 发送
    uint8_t  tx_buf[MIDI_SYSEX_MAX_LEN];
    uint16_t tx_len;
    uint16_t tx_written;
    bool     tx_active;

    // 接收 FIFO（环形队列）
    uint8_t  rx_fifo[RX_FIFO_SIZE][MIDI_SYSEX_MAX_LEN];
    uint16_t rx_len[RX_FIFO_SIZE];
    uint8_t  rx_head;
    uint8_t  rx_tail;
    uint8_t  rx_fifo_size;
    uint16_t rx_max_sysex_len;

    // 硬件抽象驱动
    midi_io_driver_t driver;

    // 连接状态（缓存 is_connected 的值，由 task 更新）
    bool connected;
} midi_transport_t;
```

> `RX_FIFO_SIZE` 和 `MIDI_SYSEX_MAX_LEN` 在 transport 中依赖编译宏，但这些宏由 APP 层在包含 transport 头文件前定义，或通过初始化参数传入缓冲指针及容量。更灵活的方式：在初始化时由调用者提供预分配的内存池，transport 不负责内存分配。下面采用调用者传入指针的设计，彻底消除宏依赖。

#### 3.2.3 初始化

```c
typedef struct {
    uint8_t *rx_fifo_buffer;      // 指向 (fifo_size * max_sysex_len) 字节的缓冲
    uint8_t  rx_fifo_size;
    uint16_t max_sysex_len;
    midi_io_driver_t driver;
} midi_transport_config_t;

void midi_transport_init(midi_transport_t *t, const midi_transport_config_t *cfg);
```

初始化后，transport 将内部管理发送缓冲（发送缓冲可以内部静态分配最大长度，但此处仍需 `MIDI_SYSEX_MAX_LEN`，可改为由 config 传入 `tx_buffer` 指针及最大长度）。完全消除对全局宏的依赖：调用者提供所有内存和参数。

CORE 层彻底零依赖。

#### 3.2.4 收发接口

```c
// 发送一个 3 字节 CC 消息（非阻塞，不保证送达）
void midi_transport_send_cc(midi_transport_t *t, uint8_t channel,
                            uint8_t cc, uint8_t value);

// 发送一条 SysEx 消息。成功入队返回 true，否则 false（需重试）
bool midi_transport_send_sysex(midi_transport_t *t,
                               const uint8_t *data, uint16_t len);

// 查询接收 FIFO 是否有数据
bool midi_transport_has_sysex(const midi_transport_t *t);

// 从 FIFO 读取一条 SysEx。若缓冲区不足则丢弃并返回0
uint16_t midi_transport_read_sysex(midi_transport_t *t,
                                   uint8_t *buf, uint16_t maxlen);

// 获取当前连接状态（由内部定期更新，或实时查询 driver）
bool midi_transport_is_connected(const midi_transport_t *t);

// 在接收回调中使用的入队函数（由 parser 回调调用）
void midi_transport_rx_enqueue(midi_transport_t *t,
                               const uint8_t *frame, uint16_t len);

// 发送队列刷新，应在主循环每次调用发送之前调用，推动分段发送
void midi_transport_tx_flush(midi_transport_t *t);

// 更新连接状态（可每轮主循环调用，从 driver 读取并缓存）
void midi_transport_update_connection(midi_transport_t *t);
```

#### 3.2.5 发送流程

**CC 发送**：
1. 调用 `tx_flush` 尝试发送旧 SysEx 残余。
2. 检查 `connected`（可通过缓存的标志，或直接调用 `driver.is_connected()`），未连接直接返回。
3. 若 `driver.tx_available() >= 3`，调用 `driver.tx_write` 写入 3 字节。否则丢弃。

**SysEx 发送**：
1. `tx_flush` 清理旧队列。
2. 若 `tx_active` 为 true，返回 false。
3. 若未连接，返回 false。
4. 若 `driver.tx_available() >= len`，直接一次性写入，返回 true。
5. 否则，拷贝数据到 `tx_buf`，设置 `tx_active = true, tx_written = 0`，并尝试写出一部分（调用 `tx_flush` 内逻辑），返回 true。

**tx_flush 逻辑**：
1. 若 `!tx_active` 或 `!connected`，则返回。
2. 获取剩余字节 `rem = tx_len - tx_written`。
3. 获取可用空间 `avail = driver.tx_available()`。
4. 写入 `to_write = min(rem, avail)`，通过 `driver.tx_write`。
5. 更新 `tx_written`，若全部写完则 `tx_active = false`。

#### 3.2.6 接收流程

- 接收 FIFO 入队由 `midi_transport_rx_enqueue` 完成，该函数将被 `midi_parser` 的 `frame_handler` 回调调用。
- 入队时若 FIFO 满，则丢弃最旧帧（移动 head）。
- 该函数需为中断安全，内部使用关全局中断保护临界区（或在本单核无抢占模型中，若 parser feed 仅在中断中调用，则需关中断；若 parser feed 也在主循环中调用，则必须关中断）。
- `midi_transport_has_sysex` 判断 `head != tail`。
- `midi_transport_read_sysex` 取出 tail 指向的帧并拷贝，若用户缓冲区 `maxlen < 实际长度`，返回 0 并丢弃该帧。

#### 3.2.7 连接状态管理

`midi_transport_update_connection` 应每轮主循环调用，内部执行 `t->connected = t->driver.is_connected()`。在发送和接收相关接口中直接使用 `t->connected` 作为快速判断，避免频繁访问 volatile 或跨模块调用。

---

## 4. HAL 层设计

HAL 层负责与 TinyUSB 的具体交互，提供符合 `midi_io_driver_t` 的函数和接收数据注入。

### 4.1 接口

```c
// 初始化 TinyUSB MIDI，安装回调
void midi_hal_init(midi_parser_t *parser);

// 以下三个函数直接对应 I/O 驱动
uint32_t midi_hal_tx_available(void);
uint32_t midi_hal_tx_write(const uint8_t *data, uint32_t len);
bool     midi_hal_is_connected(void);

// 接收回调（内部使用）
void tud_midi_rx_cb(uint8_t cable, uint8_t const *buffer, uint32_t len);
```

### 4.2 实现细节

- `midi_hal_init`：
  - 注册 `tud_mount_cb`、`tud_umount_cb`，在回调中更新内部 `volatile bool _hal_connected`。
  - 保存传入的 `parser` 指针，供 `tud_midi_rx_cb` 使用。
- `midi_hal_tx_available`：返回 `tud_midi_n_stream_available(0)`。
- `midi_hal_tx_write`：调用 `tud_midi_stream_write(0, data, len)`，返回实际写入量。
- `midi_hal_is_connected`：返回 `_hal_connected`。
- `tud_midi_rx_cb`：调用 `midi_parser_feed(parser, buffer, len)`。

HAL 层不包含任何业务逻辑，仅做最薄封装。

---

## 5. APP 层设计

APP 层是真正的“产品胶水”，其唯一职责是将 HAL 与 CORE 粘合起来，定义该产品的具体参数，并将市场 API 映射到 CORE 实例。

### 5.1 全局实例与配置

```c
// 产品参数
#define LYRE_MIDI_RX_FIFO_SIZE       4
#define LYRE_MIDI_SYSEX_MAX_LEN      770
#define LYRE_MIDI_TX_BUF_SIZE        LYRE_MIDI_SYSEX_MAX_LEN

// 缓冲池
static uint8_t rx_fifo_pool[LYRE_MIDI_RX_FIFO_SIZE][LYRE_MIDI_SYSEX_MAX_LEN];
static uint8_t tx_buffer[LYRE_MIDI_TX_BUF_SIZE];

// 核心对象
static midi_parser_t    parser;
static midi_transport_t transport;
```

### 5.2 初始化

```c
void midi_app_init(void) {
    // 1. 构建 I/O 驱动
    midi_io_driver_t io = {
        .tx_available = midi_hal_tx_available,
        .tx_write     = midi_hal_tx_write,
        .is_connected = midi_hal_is_connected
    };

    // 2. 初始化 transport 配置
    midi_transport_config_t tcfg = {
        .rx_fifo_buffer = (uint8_t*)rx_fifo_pool,
        .rx_fifo_size   = LYRE_MIDI_RX_FIFO_SIZE,
        .max_sysex_len  = LYRE_MIDI_SYSEX_MAX_LEN,
        .tx_buffer      = tx_buffer,
        .tx_buffer_size = LYRE_MIDI_TX_BUF_SIZE,
        .driver         = io
    };
    midi_transport_init(&transport, &tcfg);

    // 3. 初始化解析器，注册回调到 transport 的入队函数
    midi_parser_init(&parser, LYRE_MIDI_SYSEX_MAX_LEN, transport_rx_callback);

    // 4. 初始化 HAL，传入 parser 供数据注入
    midi_hal_init(&parser);
}

// 回调函数（将 parser 输出注入 transport）
static void transport_rx_callback(const uint8_t *frame, uint16_t len) {
    midi_transport_rx_enqueue(&transport, frame, len);
}
```

### 5.3 市场 API 实现

```c
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value) {
    midi_transport_tx_flush(&transport);      // 每次发送前尝试推进发送队列
    midi_transport_update_connection(&transport);
    midi_transport_send_cc(&transport, channel, cc, value);
}

bool midi_send_sysex(const uint8_t *data, uint16_t len) {
    midi_transport_tx_flush(&transport);
    midi_transport_update_connection(&transport);
    return midi_transport_send_sysex(&transport, data, len);
}

bool midi_has_sysex(void) {
    return midi_transport_has_sysex(&transport);
}

uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen) {
    return midi_transport_read_sysex(&transport, buf, maxlen);
}

bool midi_is_connected(void) {
    // 直接查询 transport 缓存的连接状态（已在上一轮主循环更新）
    return midi_transport_is_connected(&transport);
}
```

**注意**：在主循环中，应确保在进入 pot 采样/MIDI 发送前调用一次 `midi_transport_update_connection`，或由市场 API 内部每次调用时更新。为减少函数调用开销，建议主循环周期开始时统一更新连接状态，此处选择在 API 内调用以保证独立安全。

---

## 6. 主循环集成

主循环典型调用流程（参考架构文档）：

```c
void loop() {
    // 更新 USB 连接状态
    midi_transport_update_connection(&transport);

    // ... pot_poll(), MIDI 发送等
    // 在 midi_send_cc 前已内部调用 tx_flush，无需显式调用
}
```

所有 MIDI 管线 API 均为同步、非阻塞调用，符合架构要求。

---

## 7. 并发与数据完整性

- **接收路径中断安全**：`tud_midi_rx_cb` 在 USB 中断上下文执行，最终调用 `midi_transport_rx_enqueue`。FIFO 操作通过短暂关中断（或使用 `__disable_irq()`/`__enable_irq()`）保护。
- **发送路径**：所有发送操作均在主循环上下文中执行，无并发问题。
- **连接标志**：`_hal_connected` 为 `volatile`，在中断中修改，主循环通过 `midi_hal_is_connected` 读取，无需临界区。

---

## 8. 错误处理与边界条件

| 场景 | 处理策略 |
|------|----------|
| 发送时 USB 未连接 | `midi_send_cc` 直接返回；`midi_send_sysex` 返回 false |
| USB 传输过程中拔出 | 发送队列 `tx_flush` 检测到未连接，丢弃剩余数据，队列清空 |
| 接收 FIFO 满 | 丢弃最旧帧，新帧入队（防止死锁） |
| 接收超大 SysEx | 解析器在超过 max_len 时丢弃并重置，不影响后续 |
| 发送队列忙碌时新 SysEx 到达 | `midi_send_sysex` 返回 false，由上层（如 cmd_cfg）重试 |
| 协议错误（非法状态字节） | 解析器丢弃当前帧，回到 IDLE 状态 |
| 读 SysEx 时用户缓冲不足 | 返回 0 并消耗帧，避免遗留 |

---

## 9. 移植指南

- **新平台接入**：
  1. 实现 `midi_hal` 的三个函数（`tx_available`、`tx_write`、`is_connected`）及接收回调注入机制。
  2. 在 APP 层调整 `LYRE_MIDI_RX_FIFO_SIZE` 和 `LYRE_MIDI_SYSEX_MAX_LEN` 等参数。
  3. `midi_core_parser` 和 `midi_core_transport` 源代码**完全不需要修改**，可直接编译。
- **单元测试**：可通过构造 `midi_io_driver_t` 的 mock 实现，在 PC 上测试 parser 和 transport 的所有逻辑。

---

## 10. 测试要点

1. **CC 发送压力**：连续 4 个 CC 在 10ms 内发送，分析仪无丢包。
2. **SysEx 分段**：发送 770 字节 SysEx，TinyUSB 缓冲不足时触发重试，最终完整送达。
3. **热插拔**：拔出后 `midi_is_connected` 迅速变 false；再次插入后发送恢复。
4. **接收拼接**：上位机分包发送 SysEx，验证解析正确拼接。
5. **FIFO 溢出**：高速灌入多条 SysEx，验证旧帧丢弃，新帧边界完整。
6. **异常注入**：畸形字节流（如 0xF0 内嵌 0xF0），解析器正确恢复。

---

*本详细设计严格遵循《信息管线星型架构 v1.1》及 Lyre MK2 架构文档，CORE 层实现零平台依赖，APP 层仅保留产品特定参数与胶水代码。MIDI 管线可整体跨产品移植，仅需替换 HAL 实现。*
