# Lyre 四推杆 MIDI 控制器 - 产品固件架构设计文档

> **文档版本**：v1.2 (最终定稿)  
> **最后更新**：2026-07-21  
> **遵循规范**：《信息管线星型架构 v1.1》(ARCHITECTURE.md)  
> **协议依赖**：《Veloce 基础命令协议 v1.4》、《Lyre 产品命令协议 v1.4》、《Jigsaw MIDI Transport V3.27》、《Base Protocol Library V1.16》

---

## 1. 产品概述

### 1.1. 产品定义
Lyre 是一款基于 RP2040-Zero 的便携式 USB MIDI 控制器，配备 4 个 100mm 行程线性电位器。所有上位机通信（Jigsaw 协议）与 MIDI 控制消息均通过**单一 USB MIDI 接口**传输。

### 1.2. 技术栈
- **MCU**：RP2040 (Dual Cortex-M0+, 264KB SRAM)
- **IDE/框架**：Arduino IDE (基于 RP2040 Arduino Core)
- **核心依赖库**：
  - `TinyUSB`：USB 设备枚举与 MIDI 类驱动（**无 CDC**）
  - `LittleFS`：Flash 文件系统，用于配置持久化
  - `Adafruit NeoPixel`：WS2812 LED 驱动
- **已有代码资产**：
  - `base_proto.c/.h`：Veloce 基础命令协议解析引擎 (v1.16)
  - `jigsaw.c/.h`：Jigsaw MIDI Transport 透明字节流传输层 (v3.27)

---

## 2. 管线划分与职责定义

根据 Lyre 的功能需求，系统划分为 **5 条管线**。

### 2.1. 电位器管线 (Potentiometer Pipeline)
负责 4 路模拟信号的采集、滤波与映射计算。

| 层级 | 模块 | 职责 | 依赖 |
|:---|:---|:---|:---|
| **HAL** | `pot_hal` | ADC 引脚配置 (GPIO26-29)、12-bit 原始值读取 | RP2040 ADC 寄存器 |
| **CORE** | `pot_core` | 滑动平均滤波、死区/迟滞处理、Raw→MIDI 线性映射算法 | 无外部依赖 |
| **APP** | `pot_app` | 周期性驱动采集，调用配置管线获取映射参数，调用 MIDI 管线发送，调用 LED 管线触发闪烁 | 市场 API |

### 2.2. MIDI 引擎管线 (MIDI Engine Pipeline)
**系统的唯一 USB 数据出入口**。负责所有 MIDI 消息的组装、USB 发送，以及 USB 接收消息的分发。

| 层级 | 模块 | 职责 | 依赖 |
|:---|:---|:---|:---|
| **HAL** | `midi_hal` | TinyUSB MIDI 类接口调用 (`tud_midi_stream_write`, USB 中断处理) | TinyUSB |
| **CORE** | `midi_core` | CC 消息组装、状态变化检测（仅值变化时发送） | 无 |
| **APP** | `midi_app` | 暴露发送 API (`midi_send_cc`)；提供接收回调注册机制 | 无 |

### 2.3. 命令与配置管线 (Command & Config Pipeline)
负责 Jigsaw 字节流管理、协议解析、命令分发与配置快照管理。**本管线无 HAL 层**，底层收发完全依赖 MIDI 管线提供的函数指针。

| 层级 | 模块 | 职责 | 依赖 |
|:---|:---|:---|:---|
| **CORE** | `jigsaw` | Jigsaw MIDI Transport：MIDI CC ↔ 字节流编解码、ACK/NAK 管理 | 无（通过函数指针收发） |
| **CORE** | `base_proto` | 帧同步状态机、KV 解析、命令表分发、心跳/握手/超时管理 | 无（依赖 `jigsaw` 和注入的回调） |
| **APP** | `cmd_app` | 实现 Lyre 产品命令 Handler，维护状态机；**作为 Jigsaw/base_proto 与 MIDI 管线的桥梁** | 市场 API (midi, storage) |
| **APP** | `config_mgr` | RAM 配置快照管理、双缓冲原子切换、出厂默认值加载 | 市场 API (storage) |

### 2.4. 存储管线 (Storage Pipeline)
负责配置的持久化读写。

| 层级 | 模块 | 职责 | 依赖 |
|:---|:---|:---|:---|
| **HAL** | `flash_hal` | RP2040 Flash 底层操作（LittleFS 适配层） | RP2040 Flash |
| **CORE** | `storage_core` | LittleFS 初始化、文件读写封装、CRC 校验 | LittleFS |
| **APP** | `storage_app` | 提供面向业务的 `save_config()` / `load_config()` 接口 | 无 |

### 2.5. LED 管线 (LED Pipeline) - 动作引擎模式
负责 WS2812 状态指示与动画效果。**采用配置表驱动的动作引擎架构，CORE层跨产品零修改复用。**

| 层级 | 模块 | 职责 | 依赖 |
|:---|:---|:---|:---|
| **HAL** | `led_hal` | NeoPixel 驱动、PWM/DMA 时序控制 | Adafruit NeoPixel |
| **CORE** | `led_core` | **动作引擎**：解析原子动作序列，管理时间轴，优先级仲裁，状态切换 | 无外部依赖 |
| **APP** | `led_app` | **配置表驱动**：定义Lyre状态→动作序列映射，暴露 `led_trigger(event)` | 市场 API (无外部依赖) |

**核心设计**：
- **原子动作**：`SET_RGB`, `SET_BRIGHTNESS`, `FADE_TO`, `DELAY`, `REPEAT`
- **动作序列**：原子动作的有序组合，支持循环
- **状态**：命名的动作序列 + 优先级
- **优先级仲裁**：高优先级状态可中断低优先级状态，低优先级状态结束后自动恢复高优先级

---

## 3. 市场 API 清单 (Marketplace APIs)

### 3.1. `market/midi_api.h` — MIDI 引擎管线（核心枢纽）
```c
/**
 * @consumers pot_app (发送 CC), cmd_app (注册接收回调, 发送 Jigsaw CC)
 * @dependencies 无
 */

// --- 发送 API ---
// 发送标准 MIDI CC 消息 (推杆控制用)
void midi_send_cc(uint8_t channel, uint8_t cc_num, uint8_t value);

// --- 接收 API (依赖注入点) ---
// 定义回调函数类型：当 USB 收到 CC 消息时触发
// status = 0xB0 | ch, data1 = cc_num, data2 = value
typedef void (*midi_cc_rx_callback_t)(uint8_t status, uint8_t data1, uint8_t data2, uint32_t timestamp_ms);

// 注册接收回调（cmd_app 在初始化时调用，将 base_proto_on_midi_cc 注入）
void midi_register_cc_callback(midi_cc_rx_callback_t cb);

// --- 底层发送 API (供 base_proto 的 midi_send_cb_t 使用) ---
// 直接发送原始 MIDI 字节 (status, data1, data2)，用于 Jigsaw 信号和 ACK/NAK
void midi_send_raw(uint8_t status, uint8_t data1, uint8_t data2);

// --- 系统驱动 API ---
void midi_app_poll(void);  // 主循环调用：处理 TinyUSB MIDI 后台任务 (tud_task)
```

### 3.2. `market/pot_api.h` — 电位器管线
```c
/**
 * @consumers cmd_app (read_adc 命令需要)
 * @dependencies cmd_cfg_api.h, midi_api.h, led_api.h
 */
uint16_t pot_get_raw(uint8_t index);      // 获取滤波后的 ADC 原始值 (0-4095)
void     pot_app_poll(void);              // 主循环调用：驱动采集-映射-发送流程
```

### 3.3. `market/cmd_cfg_api.h` — 命令与配置管线
```c
/**
 * @consumers pot_app (获取映射参数), main (初始化与驱动)
 * @dependencies midi_api.h (注册回调/发送), storage_api.h (加载/保存)
 */

// --- 配置查询 API (供 pot_app 高频调用) ---
typedef struct {
    uint8_t  midi_ch;   // 1-16
    uint8_t  cc;        // 0-127
    uint16_t min;       // ADC 校准最小值
    uint16_t max;       // ADC 校准最大值
} pot_config_t;

const pot_config_t* config_get_pot_config(uint8_t index);  // 返回只读快照指针
bool config_is_connected(void);                             // 查询上位机连接状态

// --- 系统驱动 API ---
void cmd_app_init(void);         // 初始化：注册 MIDI 回调，加载配置，初始化 base_proto
void cmd_app_task(void);         // 主循环调用：驱动 base_proto_task，处理超时/心跳
```

### 3.4. `market/storage_api.h` — 存储管线
```c
/**
 * @consumers cmd_app (write_cfg/factory_reset 时调用)
 * @dependencies 无
 */
typedef struct {
    pot_config_t pots[4];
    uint32_t     crc32;
} lyre_config_t;

bool storage_load_config(lyre_config_t* cfg);
bool storage_save_config(const lyre_config_t* cfg); // 同步阻塞写入
bool storage_factory_reset(void);
```

### 3.5. `market/led_api.h` — LED 管线（极简接口）
```c
/**
 * @consumers pot_app (MIDI活动), cmd_app (状态指示)
 * @dependencies 无
 */
typedef enum {
    LED_EVT_IDLE = 0,           // 默认状态（白色呼吸）
    LED_EVT_MIDI_ACTIVITY,      // MIDI发送（绿色快闪）
    LED_EVT_SAVING,             // 保存配置中（黄色快闪）
    LED_EVT_SAVE_DONE,          // 保存完成（绿色长亮2s）
    LED_EVT_FACTORY_RESETTING,  // 恢复出厂中（红色快闪）
    LED_EVT_FACTORY_DONE,       // 恢复出厂完成（绿色长亮2s）
    LED_EVT_TEST_MODE,          // 测试模式（紫色闪烁）
} led_event_t;

void led_trigger(led_event_t evt);  // 触发状态（内部按优先级仲裁）
void led_app_tick(void);            // 主循环调用：驱动动作引擎
```

---

## 4. 核心交互机制：MIDI 管线与 base_proto 的桥梁

命令管线（cmd_config）没有 HAL，它通过**依赖注入（函数指针）** 的方式，将 MIDI 管线的发送能力传递给 `base_proto` 和 `jigsaw`，同时将 MIDI 管线的接收能力传递给 `base_proto`。

### 4.1. 初始化阶段 (Setup)
在 `main.cpp` 的 `setup()` 中，`cmd_app_init()` 负责搭建桥梁：
1. 调用 `midi_register_cc_callback()`，将 `base_proto_on_midi_cc` 的包装函数注册给 MIDI 管线。
2. 调用 `base_proto_init()`，将 `midi_send_raw` 的函数地址作为 `midi_send_cb_t` 传递给 base_proto。
3. 传递临界区宏 `JIGSAW_ENTER_CRITICAL` / `JIGSAW_EXIT_CRITICAL` 给 base_proto。

```c
// cmd_app.c 中的桥梁初始化代码
static base_proto_ctx_t proto_ctx;

// 包装函数：适配 MIDI 管线的回调签名与 base_proto 的 ISR 入口
static void on_midi_cc_bridge(uint8_t status, uint8_t data1, uint8_t data2, uint32_t ts) {
    uint8_t ch = status & 0x0F;
    uint8_t cc = data1;
    uint8_t val = data2;
    // 直接调用 base_proto 的 ISR 入口
    base_proto_on_midi_cc(&proto_ctx, ch, cc, val, ts);
}

void cmd_app_init(void) {
    // 1. 加载配置
    lyre_config_t cfg;
    if (!storage_load_config(&cfg)) {
        // 加载失败，使用出厂默认值
        config_mgr_load_defaults();
    } else {
        config_mgr_update_snapshot(&cfg);
    }

    // 2. 定义 Lyre 产品命令表
    static const cmd_def_t lyre_cmds[] = {
        { .name = "read_cfg",  .handler = read_cfg_handler,  .domain = CMD_CONFIG, .flags = CMD_FLAG_REQUIRE_CONNECTED, .required_keys = "", .forbidden_keys = "*", .timeout_ms = 0 },
        { .name = "write_cfg", .handler = write_cfg_handler, .domain = CMD_CONFIG, .flags = CMD_FLAG_REQUIRE_CONNECTED, .required_keys = "0_midi_ch 0_cc 0_min 0_max 1_midi_ch 1_cc 1_min 1_max 2_midi_ch 2_cc 2_min 2_max 3_midi_ch 3_cc 3_min 3_max", .forbidden_keys = "", .timeout_ms = 0 },
        { .name = "read_adc",  .handler = read_adc_handler,  .domain = CMD_CONFIG, .flags = CMD_FLAG_REQUIRE_CONNECTED, .required_keys = "pot", .forbidden_keys = "", .timeout_ms = 0 },
    };

    // 3. 初始化 base_proto，注入 MIDI 发送能力和临界区
    base_proto_init(&proto_ctx,
                    "Veloce-A1B2", "1.0", "1.4", 512,
                    lyre_cmds, sizeof(lyre_cmds)/sizeof(lyre_cmds[0]),
                    midi_send_raw,              // <-- 注入 MIDI 发送函数指针
                    JIGSAW_ENTER_CRITICAL,      // <-- 注入临界区进入
                    JIGSAW_EXIT_CRITICAL,       // <-- 注入临界区退出
                    on_state_change,            // <-- 状态变化回调 (IDLE/CONNECTED)
                    on_factory_reset,           // <-- 恢复出厂回调
                    NULL);                      // <-- async_abort_cb (Lyre 无异步命令)

    // 4. 注册 MIDI 接收回调，将 USB 收到的 CC 消息喂给 base_proto
    midi_register_cc_callback(on_midi_cc_bridge);
}
```

### 4.2. 接收方向 (Host → Device)
1. **TinyUSB 中断**：USB 收到 MIDI 数据包。
2. **MIDI HAL**：解析出 CC 消息 `(status, data1, data2)`。
3. **MIDI APP**：调用已注册的回调函数 `on_midi_cc_bridge()`。
4. **CMD APP (桥梁)**：调用 `base_proto_on_midi_cc()`，将字节喂给 Jigsaw 进行帧重组。
5. **base_proto ISR**：Jigsaw 完成帧后，交换双缓冲区，设置 `frame_ready` 标志。**同时立即 drain 控制信号（ACK/NAK）**，通过注入的 `midi_send_raw` 发送。

### 4.3. 发送方向 (Device → Host)
1. **主循环**：调用 `cmd_app_task()` -> `base_proto_task()`。
2. **base_proto Task**：
   - 检查 `frame_ready`，若有完整帧则解析并分发命令。
   - 命令 Handler 调用 `base_proto_send_response()` 组装响应帧。
   - `base_proto_task` 内部的 TX 调度器调用注入的 `midi_send_raw` 函数指针，将 Jigsaw 数据（包含 payload 和 checksum）通过 MIDI CC 消息发送出去。

---

## 5. 核心业务流定义 (Drive Flows)

### 5.1. 业务流 1：电位器采样与 MIDI 发送（主业务流）
```text
驱动源：周期性驱动，主循环每 10ms 触发一次 (100Hz)

主循环 (10ms Tick)
  │
  ▼
pot_app_poll()
  ├── [同步] pot_core：4 路 ADC 读取 + 滤波                     ≤ 0.5ms
  ├── [同步] config_get_pot_config()：获取映射参数              ≤ 0.01ms
  ├── [本地] Raw → MIDI CC 映射 + 状态变化检测                  ≤ 0.01ms
  ├── [同步] midi_send_cc()：仅值变化时发送                     ≤ 0.5ms
  └── [同步] led_trigger(LED_EVT_MIDI_ACTIVITY)                 ≤ 0.01ms
```

### 5.2. 业务流 2：Jigsaw 接收与命令处理 (配置域)
```text
驱动源：事件驱动 (USB 中断) + 周期性驱动 (主循环)

[中断上下文]
TinyUSB MIDI 回调
  ▼
midi_hal → midi_app → on_midi_cc_bridge() (cmd_app 注入的回调)
  └── [同步] base_proto_on_midi_cc()：喂入字节，内部 drain ACK/NAK   ≤ 0.1ms

[主循环上下文]
cmd_app_task()
  └── [同步] base_proto_task()
        ├── Jigsaw tick：处理超时、批次间隔
        ├── 帧收集：从 ISR 双缓冲区拷贝完整帧
        ├── 帧解析：KV 提取、命令分发
        │     ├── 系统域 (ping/handshake) → base_proto 内部处理并回复
        │     └── 配置域 (write_cfg/read_cfg) → 调用 Lyre Handler
        │           ├── [同步] storage_save_config() (阻塞 ≤200ms) ⚠️
        │           ├── [本地] config_mgr 原子切换快照
        │           └── [同步] base_proto_send_response() 提交响应帧
        └── TX 调度：通过 midi_send_raw 发送响应帧和错误帧
```

### 5.3. 业务流 3：上位机写入配置 (write_cfg)
```text
驱动源：事件驱动，base_proto 解析出 write_cfg 命令

write_cfg_handler(base_proto_ctx_t *ctx)
  ├── [本地] base_proto_get_uint() 提取 16 个字段                     ≤ 0.05ms
  ├── [本地] 校验字段完整性与合法性 (min < max, 范围检查)             ≤ 0.05ms
  │     ├── 失败 → BASE_PROTO_SEND_ERROR(ctx, 3, "invalid_fields")
  │
  ├── [同步] led_trigger(LED_EVT_SAVING)                              ≤ 0.01ms
  │
  ├── [同步阻塞] storage_save_config()：写入 LittleFS                 ≤ 200ms ⚠️
  │     ├── 失败 → BASE_PROTO_SEND_ERROR(ctx, 4, "flash_write_error")
  │     └── 此期间 ADC 采集与 MIDI 发送暂停（设计决策，见 PRD 3.6.2）
  │
  ├── [本地] config_mgr_update_snapshot()：双缓冲原子切换 RAM 快照    ≤ 0.01ms
  │
  ├── [同步] led_trigger(LED_EVT_SAVE_DONE)                           ≤ 0.01ms
  │
  └── [同步] base_proto_send_response(ctx, "write_cfg_ack", NULL)     ≤ 0.1ms
```

---

## 6. 并发与数据一致性

### 6.1. base_proto 的 ISR 安全与双缓冲
严格遵循 Base Protocol Library V1.16 的 **AI Invariants**：
- **ISR 中**：`base_proto_on_midi_cc` 只负责喂入字节、交换双缓冲区、drain 控制信号（ACK/NAK）。**绝不**在 ISR 中解析帧或执行业务逻辑。
- **主循环中**：`base_proto_task` 负责帧收集、解析、命令分发和 TX 调度。
- **临界区保护**：在 `base_proto_config.h` 中定义 `JIGSAW_ENTER_CRITICAL()` 和 `JIGSAW_EXIT_CRITICAL()`，使用 RP2040 的 `__disable_irq()` / `__enable_irq()` 保护双缓冲区交换和 `frame_ready` 标志。

### 6.2. 配置快照的原子读取
`config_get_pot_config()` 返回指向只读静态快照的指针。`write_cfg` 更新时，在后台 Buffer 准备数据，完毕后通过**原子指针切换**更新全局指针。`pot_app` 读取时始终获得一致性快照，无需加锁。

### 6.3. Flash 写入期间的系统行为
根据 PRD 3.6.2，`storage_save_config()` 采用**同步阻塞**（≤200ms）。
- 写入期间主循环被阻塞，`pot_app_poll()` 不执行，ADC 不采样，MIDI 不发送。
- **base_proto 的影响**：由于主循环阻塞，`base_proto_task()` 不会被调用，Jigsaw 的批量发送会暂停。但 USB 中断仍然活跃，若此时收到新的 MIDI 消息，ISR 中的 `base_proto_on_midi_cc()` 仍能正常工作（喂入字节、drain 信号），但不会触发新的命令处理。
- **恢复**：写入完成后主循环恢复，`base_proto_task()` 继续处理待发送的响应帧。

### 6.4. MIDI 发送回调的重入性
`base_proto` 要求 `midi_send_cb_t` 必须是**可重入的**（从 ISR 和 Task 都会调用）。
- **解决方案**：`midi_send_raw()` 内部实现一个**线程安全的环形队列**（或 RP2040 的硬件 FIFO），ISR 和 Task 都将 MIDI 消息推入队列，由 `midi_app_poll()` 在主循环中统一从队列取出并调用 TinyUSB API 发送。
- **或者**：由于 RP2040 是双核架构，若使用单核运行所有逻辑，`midi_send_raw()` 可以直接调用 TinyUSB API（TinyUSB 本身是 ISR 安全的），但需确保 TinyUSB 的 `tud_task()` 不会被 ISR 打断。推荐使用队列方案，更符合架构规范的解耦原则。

---

## 7. 目录结构 (物理布局)

```text
lyre-firmware/
├── docs/
│   ├── ARCHITECTURE.md           # 通用架构规范 v1.1
│   └── LYRE_ARCHITECTURE.md      # 本文档
│
├── market/                       # 市场：所有管线的对外 API
│   ├── pot_api.h
│   ├── cmd_cfg_api.h
│   ├── midi_api.h
│   ├── storage_api.h
│   └── led_api.h
│
├── pipelines/                    # 管线内部实现（私有）
│   ├── potentiometer/
│   │   ├── pot_hal.c/.h
│   │   ├── pot_core.c/.h
│   │   └── pot_app.c
│   │
│   ├── midi_engine/
│   │   ├── midi_hal.c/.h         # TinyUSB MIDI 封装
│   │   ├── midi_core.c/.h
│   │   └── midi_app.c            # 提供 midi_register_cc_callback, midi_send_raw
│   │
│   ├── cmd_config/
│   │   ├── jigsaw.c/.h           # 已有资产：Jigsaw 传输层
│   │   ├── base_proto.c/.h       # 已有资产：基础协议引擎
│   │   ├── base_proto_config.h   # base_proto 编译期配置
│   │   ├── cmd_app.c             # 桥梁：注入回调，定义命令表，实现 Handler
│   │   └── config_mgr.c/.h       # 配置快照管理
│   │
│   ├── storage/
│   │   ├── flash_hal.c/.h
│   │   ├── storage_core.c/.h
│   │   └── storage_app.c
│   │
│   └── led/
│       ├── led_hal.c/.h
│       ├── led_core.c/.h
│       └── led_app.c
│
├── main.cpp                      # Arduino setup() / loop()
└── lyre.ino                      # Arduino 入口
```

---

## 8. 新产品复用评估

当开发下一款产品（如 *Veloce-Mini*：8 推杆、无 Flash、带 OLED）时：

| 模块 | 复用策略 | 工作量 |
|:---|:---|:---|
| `midi_engine` (HAL/CORE/APP) | **直接拷贝**，零修改 | 无 |
| `jigsaw` / `base_proto` | **直接拷贝**，零修改 | 无 |
| `pot_core` / `led_core` | **直接拷贝**，零修改 | 无 |
| `cmd_app` (桥梁逻辑 + 系统命令) | **部分复用**：桥梁初始化代码不变，修改命令表和 Handler | 低 |
| `pot_app` | **重写**：适配 8 推杆 | 中等 |
| `config_mgr` | **重写**：适配 8 推杆结构，去掉 Flash 加载 | 低 |
| `storage_pipeline` | **整体移除** | 无 |

**结论**：MIDI 管线与 base_proto 的解耦设计，使得底层通信栈（MIDI + Jigsaw + base_proto + cmd_app 桥梁）可以作为**标准通信中间件**在所有 Veloce 产品中高度复用。产品差异化仅需修改命令表、Handler 和配置管理器。

---
