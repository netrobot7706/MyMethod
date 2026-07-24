# Lyre 产品架构设计文档

> **文档版本**：v2.2（终审冻结版）  
> **对应产品**：Lyre 4-推杆 MIDI 控制器  
> **遵循规范**：《信息管线星型架构 v1.1》  
> **关联协议**：《MIDI 控制器自描述配置协议 v2.6》  
> **最后更新**：2026-07-24

---

## 1. 产品概述

| 项目 | 说明 |
|------|------|
| **产品名称** | Lyre |
| **产品定义** | 4 路 100mm 行程推杆的 USB MIDI 控制器，支持上位机完全配置与高精度校准，配备 WS2812 状态指示灯。 |
| **硬件平台** | RP2040-Zero（双核 Cortex-M0+，**本设计仅使用 Core 0**） |
| **关键外设** | 4 路电位器 (ADC GPIO26–29)、1 路板载 WS2812 LED (GPIO16)、可选 SPI Flash（用于 LittleFS） |
| **固件技术栈** | Arduino IDE + TinyUSB + Adafruit NeoPixel / PIO + LittleFS / EEPROM 模拟 |
| **上位机** | Web App（通过 Web MIDI SysEx 与设备通信） |
| **核心指标** | 推杆移动 → MIDI 输出端到端延迟 < 10ms；任意位置静止时**零** MIDI 输出；物理行程端点稳定覆盖 MIDI 0 和 127。 |

---

## 2. 架构核心原则

本架构严格遵循《信息管线星型架构 v1.1》的三大铁律：

1. **管线间绝对隔离**：任何管线内部代码（HAL、CORE）绝不允许直接调用其他管线的内部实现。  
2. **市场是唯一交汇点**：所有跨管线信息交换必须且只能通过 `market/` 目录下的 API 头文件进行。  
3. **CORE 层零外部依赖**：CORE 层只包含领域通用算法，不依赖任何外部管线或产品特有业务，可在不同产品间直接拷贝复用。

此外，本设计强调一条**驱动原则**：  
**所有管线均为被动服务者，主循环是唯一的主动调度者。** 任何管线不应主动发起对其他管线的输出操作，所有输出由主循环根据管线的数据响应统一执行。唯一的**受控例外**是 `cmd_cfg_task()`，它在主循环驱动下按状态机步骤调用其他管线，但每次调用均立即返回，不长时间阻塞。

---

## 3. 管线划分与市场 API 清单

系统分解为 **5 条完全独立的管线**，每个管线只通过 `market/` 暴露最小化接口。

| 管线 | 目录 | 职责 | 市场 API 文件 |
|------|------|------|----------------|
| **Potentiometer** | `pipelines/potentiometer/` | 4 路推杆 ADC 采样、数字滤波、校准映射、变化检测；提供事件数据。 | `market/pot_api.h` |
| **Command & Config** | `pipelines/cmd_config/` | SysEx 协议处理、RAM 配置快照维护、提供查询接口。 | `market/cmd_cfg_api.h` |
| **Storage** | `pipelines/storage/` | 配置数据的 Flash 持久化（支持分步写入）。 | `market/storage_api.h` |
| **MIDI** | `pipelines/midi/` | USB MIDI 底层收发（CC、SysEx），缓冲管理。 | `market/midi_api.h` |
| **LED** | `pipelines/led/` | WS2812 灯效状态机、优先级调度。 | `market/led_api.h` |

**隔离要求**：`pipelines/*` 内任何 `.c` 文件禁止包含其他管线的内部头文件，只允许包含本管线的内部头文件和 `market/xxx_api.h`。

---

## 4. 市场 API 接口设计（跨管线契约）

以下所有接口均以“方便调用者”为设计导向，每个头文件顶部使用 `@consumers` 和 `@dependencies` 明确依赖关系，`cmd_cfg_api.h` 额外使用 `@constraint` 限制副作用边界。

### 4.1 `market/midi_api.h`

```c
/**
 * @consumers  main loop, cmd_cfg_app
 * @dependencies 无
 */

#define MIDI_SYSEX_MAX_LEN  770   // 协议 v2.6 最大消息（0x04，N=127）

// 发送标准 MIDI CC 消息（3 字节），不保证送达，偶尔丢失可接受
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value);

// 发送完整 SysEx 消息，返回 true 表示成功入队。失败时调用者应在下一轮主循环重试
bool midi_send_sysex(const uint8_t *data, uint16_t len);

// 接收侧非阻塞轮询
bool midi_has_sysex(void);
// 读取一条 SysEx 消息。若实际消息超过 maxlen，整帧丢弃，返回 0。
uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen);

// 返回 USB MIDI 是否已连接（枚举成功且未被拔出）。
// 基于 tud_mounted/umounted 回调维护 volatile 标志，中断与主循环间安全，
// 返回值可能在 USB 热插拔后延迟一轮主循环才更新。
bool midi_is_connected(void);
```

### 4.2 `market/cmd_cfg_api.h`

```c
/**
 * @consumers  main (init, loop), pot_app
 * @dependencies  storage_api, midi_api, pot_api, led_api
 *
 * @constraint  本管线中，仅 cmd_cfg_task() 允许调用其他管线 API（受控例外，见 ADR-006）。
 *              其余所有函数（cmd_cfg_process_sysex、config_get_* 等）
 *              必须为纯计算/查询，不得产生任何跨管线副作用。
 */

// 启动时加载配置到 RAM 快照（失败自动恢复出厂默认）
void cmd_cfg_init(void);

// 处理一条完整 SysEx 消息（仅做校验 + 设置状态标志，不阻塞）
void cmd_cfg_process_sysex(const uint8_t *data, uint16_t len);

// 每轮主循环必须调用，内部驱动配置写入状态机（包括 LED/Pot/Storage/MIDI 调用）
void cmd_cfg_task(void);

// 查询当前库下物理推杆的 MIDI 映射
bool config_get_pot_mapping(uint8_t phys_index, uint8_t *cc, uint8_t *channel);

// 查询物理推杆的校准数据（14-bit ADC 边界）
bool config_get_calibration(uint8_t phys_index, uint16_t *cal_min, uint16_t *cal_max);

// 返回当前活跃库编号（单库设备固定为 0）
uint8_t config_get_current_bank(void);

// 批量查询接口，保证单次调用内数据一致性
typedef struct {
    uint8_t cc;
    uint8_t channel;
} pot_mapping_t;

bool config_get_all_pot_mappings(pot_mapping_t *mappings, uint8_t *count);

typedef struct {
    uint16_t cal_min;
    uint16_t cal_max;
} pot_calibration_t;

bool config_get_all_calibrations(pot_calibration_t *calibrations, uint8_t *count);

// 状态机状态查询（供主循环同步使用）
typedef enum {
    CFG_IDLE = 0,
    CFG_SAVE_START,
    CFG_SAVING,
    CFG_SAVE_DONE,
    CFG_ACK_PENDING
} cfg_state_t;
cfg_state_t cmd_cfg_get_state(void);
```

### 4.3 `market/pot_api.h`

```c
/**
 * @consumers  main loop, cmd_cfg_app (仅 raw)
 * @dependencies  cmd_cfg_api（内部）
 */

#define POT_COUNT  4   // 全项目唯一推杆数量定义

// 初始化 Pot 管线（设置引脚、加载初始映射等）
void pot_init(void);

// 执行一轮完整的采样→滤波→校准→映射→变化检测。
// 由主循环每 10ms 调用一次。
void pot_poll(void);

// 获取指定推杆的 MIDI 事件。
// @pre 必须在 pot_poll() 之后、下一次 pot_poll() 之前调用。
//      违反此前置条件将导致行为未定义（可能重复发送或丢失事件）。
// @note 若两次 pot_poll() 之间推杆发生多次变化，仅返回最终值
//       （CC 是绝对值语义，此行为符合预期）。
bool pot_get_midi_event(uint8_t index, uint8_t *channel, uint8_t *cc, uint8_t *value);

// 配置或校准写入后必须调用，清除所有推杆的历史稳定值，
// 防止参数变更导致误触发或漏触发 MIDI 事件。
void pot_reset_stable_values(void);

// 获取指定控件的原始 ADC 值（立即触发独立采样，与 pot_poll 内部 ADC 访问互斥）。
// 若 Pot 管线处于暂停状态，返回 0xFFFF（视为错误值）。
uint16_t pot_get_raw(uint8_t index);

// 批量获取所有推杆的原始 ADC 值。
// @note 暂停状态下所有元素均为 0xFFFF。
void pot_get_all_raw(uint16_t *raw_values, uint8_t count);

// 暂停/恢复 Pot 管线的采样与处理（Flash 写入期间调用）
void pot_set_pause(bool pause);
```

### 4.4 `market/storage_api.h`

```c
/**
 * @consumers  cmd_cfg_app, cmd_cfg_init
 * @dependencies 无
 */

/**
 * 启动分步写入。
 * @param data  纯配置 payload（不含 header）。Storage 管线内部自动添加
 *              magic + version + payload_len + CRC 后写入 Flash。
 * @param len   payload 字节数。
 * @return true 成功启动，false 表示 Flash 不可用或参数错误。
 */
bool storage_save_config_begin(const uint8_t *data, size_t len);

// 每次调用写入一个 Flash 页，返回 true 表示全部写完，false 表示还有剩余。
// 应在主循环中持续调用，写入期间不长时间阻塞（每页 <5ms）。
bool storage_save_config_step(void);

// 中止写入并回滚（如写入过程中设备断电前的清理）
void storage_save_config_abort(void);

/**
 * 完整读取配置。
 * @param buf      输出缓冲区，接收纯配置 payload（header 已由 Storage 剥离）。
 * @param max_len  缓冲区容量。
 * @param out_len  实际 payload 字节数。
 * @return true 成功；false 表示 magic/version 不匹配、CRC 校验失败或 Flash 读取错误。
 *         调用者无需区分具体失败原因，统一回退出厂默认。
 */
bool storage_load_config(uint8_t *buf, size_t max_len, size_t *out_len);

// 擦除配置区（恢复出厂设置使用）
bool storage_erase_config(void);
```

### 4.5 `market/led_api.h`

```c
/**
 * @consumers  main loop, cmd_cfg_app
 * @dependencies 无
 *
 * LED 状态机优先级（从高到低）：
 * 1. 事件快闪（save_start/done, factory_reset, pulse_activity）
 * 2. 呼吸模式
 * 3. 熄灭
 * 事件快闪结束后自动恢复到当前基础状态（呼吸或熄灭）。
 */

// 推杆活动快闪：pot_index 决定颜色，cc_value 决定亮度
void led_pulse_activity(uint8_t pot_index, uint8_t cc_value);

// 空闲呼吸模式控制
void led_set_breathing(bool enable);

// 状态性事件（内部自动处理优先级与持续时间）
void led_event_save_start(void);          // 黄色快闪
void led_event_save_done(void);           // 绿色长亮 2 秒
void led_event_factory_reset_start(void); // 红色快闪（当前版本预留）
void led_event_factory_reset_done(void);  // 绿色长亮 2 秒（当前版本预留）

// 必须在主循环中周期性调用，驱动 LED 状态机
void led_task(void);
```

---

## 5. 管线内部三层结构

每条管线均遵循 HAL → CORE → APP 分层，依赖方向自上而下。部分管线可能缺少某一层，符合规范。

### 5.1 Potentiometer 管线

```
pot_hal.c   → HAL：RP2040 ADC 多通道读取，硬件相关
pot_core.c  → CORE：滑动平均滤波、死区计算、迟滞处理（纯算法，零外部依赖，可跨产品复用）
pot_app.c   → APP：
                1. 调用 cmd_cfg_api 获取校准值与映射（CC、通道）
                2. 组合 CORE 滤波值完成 ADC→MIDI 线性映射
                3. 与上一次稳定值比较，标记变化
                4. 实现 pot_poll / pot_get_midi_event / pot_get_raw / pot_reset_stable_values
```

**移植性**：HAL 和 CORE 可直接拷贝到其他 RP2040 或 STM32 项目（仅 HAL 需适配 ADC 驱动）。APP 层在新产品中只需修改 `POT_COUNT` 宏定义即可。

### 5.2 Command & Config 管线

```
              无独立 HAL（输入来自 main 通过 midi_api 喂入）
cmd_core.c  → CORE：SysEx 帧解析引擎、校验和验证、命令表分发（纯协议处理，可跨产品复用）
cmd_cfg_app.c → APP：实例化 Lyre 的命令表（0x03/04/07/08/0B/0C/0D/0E/0F/10/11/12），
                   维护 RAM 配置快照（物理描述、虚拟控件、校准值），
                   通过 cmd_cfg_task 状态机处理配置/校准写入，发送应答。
```

**移植性**：`cmd_core` 直接拷贝，`cmd_cfg_app` 仅需调整命令表内容和配置结构体定义。

### 5.3 Storage 管线

```
storage_hal.c → HAL：LittleFS / EEPROM 模拟库的底层适配
storage_core.c → CORE：（可选）磨损均衡等，本项目可直接使用 LittleFS
storage_app.c → APP：提供 storage_save_config_begin/step/abort、load_config、erase_config 等业务接口
```

**移植性**：更换存储介质时只需修改 HAL 层；APP 接口保持不变。

### 5.4 MIDI 管线

```
midi_hal.c  → HAL：TinyUSB tud_midi 收发封装、队列操作
midi_core.c → CORE：（可选）MIDI 消息校验、发送调度
midi_app.c  → APP：对外 API（midi_send_cc, midi_send_sysex, 接收轮询, midi_is_connected）
```

**移植性**：除 HAL 与 TinyUSB 耦合外，其余可跨平台。

### 5.5 LED 管线

```
led_hal.c   → HAL：WS2812 数据输出（PIO / bit-bang）
led_core.c  → CORE：灯效状态机引擎（呼吸、闪烁、优先级调度，纯逻辑）
led_app.c   → APP：Lyre 专有色板、亮度曲线、事件绑定
```

**移植性**：HAL 针对具体像素数；CORE 可跨项目复用，APP 仅需改动颜色/时序配置。

---

## 6. 核心业务流定义（Drive Flows）

所有业务流均由主循环统一驱动，管线只响应调度。

### 6.1 业务流 1：电位器采样与 MIDI 发送

- **驱动源**：周期性驱动，主循环每 **10ms** 执行一次。
- **驱动路径**（主循环视角）：
  ```text
  main loop (10ms Tick)
    │
    ├─ [1] pot_poll()                              // 内部完成 ADC→滤波→映射→变化检测
    │
    ├─ [2] for i = 0..3:
    │        if (pot_get_midi_event(i, &ch, &cc, &val)) {
    │            midi_send_cc(ch, cc, val);          // 发送 MIDI CC
    │            led_pulse_activity(i, val);        // 触发活动灯效（推杆索引决定颜色）
    │        }
    │
    ├─ [3] bool connected = midi_is_connected();
    │      if (connected && !breathing_active) {
    │          led_set_breathing(true);             // USB 连接后启动呼吸灯
    │          breathing_active = true;
    │      } else if (!connected && breathing_active) {
    │          led_set_breathing(false);            // USB 拔出后停止呼吸灯
    │          breathing_active = false;
    │      }
    │
    └─ [4] led_task()                              // LED 状态机更新
  ```
- **时序约束**：步骤 [1]+[2] 合计耗时 < 5ms，确保端到端延迟（推杆物理变化 → USB 发送）< 10ms。  
- **节流保证**：Pot 管线内部已确保只有 ADC 映射后的 MIDI 值发生实质变化时，`pot_get_midi_event` 才返回 true，主循环无需额外比较。  
- **失败处理**：若某个推杆的 ADC 读取异常或配置缺失，其对应的 `pot_get_midi_event` 将永远返回 false，不会输出错误消息。  
- **暂停响应**：当 `pot_set_pause(true)` 被调用时，`pot_poll()` 直接返回不做任何更新，`pot_get_midi_event` 始终保持 false，MIDI 输出自然停止。  
- **呼吸灯管理**：USB 连接状态通过 `midi_is_connected()` 实时跟踪，确保热插拔时灯效正确切换。

### 6.2 业务流 2：上位机配置/校准写入（0x0D / 0x0F）

- **驱动源**：事件驱动，USB 收到 SysEx 命令 `0x0D` 或 `0x0F`。
- **主循环统一入口**：
  ```c
  void loop() {
      if (midi_has_sysex()) {
          midi_read_sysex(buf, MIDI_SYSEX_MAX_LEN);
          cmd_cfg_process_sysex(buf, len);   // 仅校验 + 设标志，不阻塞
      }
      cmd_cfg_task();   // 驱动状态机
      // ... pot_poll, MIDI 发送, LED 更新等
  }
  ```
- **`cmd_cfg_task()` 内部状态机流程**：

| 状态 | 执行动作 | 下一状态 |
|------|---------|----------|
| `CFG_IDLE` | 无操作 | — |
| `CFG_SAVE_START` | `led_event_save_start()`（黄色快闪），`pot_set_pause(true)`，调用 `storage_save_config_begin()` | `CFG_SAVING` |
| `CFG_SAVING` | 调用 `storage_save_config_step()`。若返回 true（写入完成），更新配置快照（双缓冲切换），**无论 0x0D 还是 0x0F 均调用 `pot_reset_stable_values()`** | `CFG_SAVE_DONE` |
| `CFG_SAVE_DONE` | `pot_set_pause(false)`，`led_event_save_done()`（绿色长亮 2 秒），发送 ACK。发送成功 → `CFG_IDLE`，发送失败 → `CFG_ACK_PENDING` | 见左 |
| `CFG_ACK_PENDING` | 重试发送 ACK。成功 → `CFG_IDLE`；失败且达最大次数（3 次）→ 记录错误并转 `CFG_IDLE` | 见左 |

- **设计说明**：0x0D 写入后也需调用 `pot_reset_stable_values()`，因为即使 MIDI 值相同，CC 号或通道的变化也会使旧历史值失效，可能导致新 CC 的第一帧被错误抑制。
- **时序约束**：`storage_save_config_step()` 每轮仅写入一个 Flash 页（通常 <5ms），LED 状态机和 SysEx 接收可正常调度，无长时间阻塞。  
- **失败处理**：校验失败时 `cmd_cfg_process_sysex()` 直接组装 NACK 并设置标志让 `cmd_cfg_task()` 发送；Flash 写入失败或 abort 时，RAM 快照不切换，恢复 Pot 并发送 NACK。

### 6.3 业务流 3：查询 ADC 原始值（0x11 → 0x12）

- **驱动源**：事件驱动，收到 `0x11` 命令。
- **前置条件**：仅在 `cmd_cfg_get_state() == CFG_IDLE` 时处理此命令，避免与 Flash 写入冲突。
- **驱动路径**：
  ```text
  cmd_cfg_process_sysex()
    └─ 命令处理:
         ├─ pot_get_all_raw(raws)            // 获取瞬时原始值
         ├─ 构造 0x12 响应帧（14-bit 编码）
         └─ 设置标志，由 cmd_cfg_task() 通过 midi_send_sysex() 发送
  ```
- **时序约束**：采样 + 发送 < 2ms。

### 6.4 业务流 4：启动配置加载

- **驱动源**：上电初始化（`setup()`）。
- **驱动路径**：
  ```text
  setup():
    ├─ pot_init()          // 初始化 ADC 硬件，此时尚未加载配置
    ├─ cmd_cfg_init()      // 加载配置到 RAM 快照（通过 storage_load_config()）
    │                      // 若加载失败则使用硬编码出厂默认，并尝试写入 Flash
    └─ 进入 loop()
  ```
- **初始化顺序保证**：Arduino 框架保证 `setup()` 完整执行后才进入 `loop()`，因此 `pot_poll()` 首次调用时配置已就绪，不存在访问未初始化配置的风险。
- **失败处理**：配置加载失败不影响设备基本功能，使用默认映射（CC=index+1，Ch=1）正常工作。

---

## 7. 并发与数据一致性设计

- **配置快照读取**：所有 `config_get_*` 查询函数内部采用**双缓冲 + 指针原子切换**。写入时先准备后台缓冲区，填充完毕后原子切换读指针，读写完全无锁，无中断延迟。批量查询接口保证单次调用内数据一致性。
- **Pot 管线暂停**：`pot_set_pause` 使用一个 `volatile bool` 标志，在 `pot_poll()` 入口处检查。该标志由 `cmd_cfg_task()` 在主循环中同步修改，单核模型下不存在竞争。
- **Flash 分步写入**：`storage_save_config_step()` 每轮主循环仅写入一个 Flash 页（<5ms），不会长时间阻塞其他管线。
- **ISR 与主循环通信**：`midi_is_connected()` 基于 `tud_mounted/umounted` 回调更新的 `volatile` 标志，中断安全。SysEx 接收通过 FIFO 队列传递，无共享状态。

---

## 8. 驱动源与时序总览

| 驱动源 | 触发者 | 频率/条件 | 涉及管线 | 说明 |
|--------|--------|-----------|----------|------|
| **周期性驱动** | 主循环 `loop()` | ~10ms | Pot, MIDI (send), LED | 保证 <10ms 延迟 |
| **事件驱动** | USB 接收队列非空 | 不定 | Cmd_Cfg, MIDI (rx) | 处理 SysEx 命令 |
| **初始化驱动** | `setup()` | 1 次 | Pot, Cmd_Cfg, Storage | 加载配置并初始化外设 |

所有驱动力均由主循环或硬件中断注入，管线本身不主动发起跨管线调用（`cmd_cfg_task()` 为受控例外）。

---

## 9. 工程化保障

1. **编译期物理隔离**：构建系统（PlatformIO / CMake）严格限制头文件搜索路径：  
   - `pipelines/*` 目录仅供本管线内部使用。  
   - `market/` 作为全局公共包含路径。  
   任何非法包含将在编译期报错。

2. **API 契约注释**：每个 `market/*.h` 均在文件头部标注 `@consumers`、`@dependencies`，并在关键接口上标注 `@pre`、`@note`、`@return` 等契约细节。`cmd_cfg_api.h` 额外使用 `@constraint` 限制受控例外的边界。

3. **依赖关系图**：
   - `pot_app` → `cmd_cfg_api`
   - `cmd_cfg_app` → `storage_api`, `midi_api`, `pot_api`, `led_api`
   - `main` → `pot_api`, `midi_api`, `led_api`, `cmd_cfg_api`
   - **无循环依赖，严格遵守市场唯一交汇点原则。**

4. **代码审查与 CI**：可在 CI 中配置脚本扫描 `#include` 指令，验证无跨管线内部包含，确保架构腐化被尽早发现。

---

## 10. 架构决策记录（ADR）

### ADR-001：Pot 管线不直接读取全局配置变量

**状态**：已批准  
**背景**：曾讨论将配置快照放入全局变量，使 Pot 直接访问，以消除对 `cmd_cfg_api` 的依赖。  
**决策**：**否决。** 维持通过 `config_get_pot_mapping()` 等函数查询。  
**理由**：
- 全局变量方案将显式接口依赖退化为隐式状态耦合，破坏可追溯性。
- 并发安全性被推卸给消费者，易产生撕裂读取。
- 单元测试必须完整模拟全局状态，可测试性显著下降。
- 当前方案通过函数调用实现数据快照的原子性，且符合“市场是唯一交汇点”的铁律。

### ADR-002：恢复出厂设置的触发方式不在本版本定义

**状态**：已批准  
**背景**：审计指出恢复出厂设置的业务流缺失，`led_api` 中已有相关接口但无触发方式定义。  
**决策**：暂不定义触发方式。  
**理由**：
- 触发方式属于产品需求层面（上位机命令或本地按键），而协议 v2.6 未定义 factory reset 命令，RP2040-Zero 无板载按键。
- 架构层面已提供 `storage_erase_config()` 和 `led_event_factory_reset_*()` 接口，足以支撑未来任何触发方式的实现。
- 此为上位机协议层的后续扩展工作，架构文档不承担定义新协议命令的责任。  
**后果**：`led_api.h` 中 factory_reset 相关接口保留，开发者可在 `cmd_cfg_app` 中预留一个未启用的命令槽，待协议更新后挂载。

### ADR-003：PRD 对 Control Surface 库的引用已偏离，架构文档不沿袭

**状态**：已批准  
**背景**：审计指出 PRD 1.3 提到“Control Surface 库原生滤波能力”，但架构设计已明确滤波由 `pot_core.c` 自行实现。  
**决策**：架构文档不沿袭此引用。  
**理由**：
- 架构文档是技术实现权威来源，PRD 中的历史描述不影响架构决策。
- `pot_core` 自研滤波算法可确保跨平台可移植性和零依赖，符合架构规范 CORE 层“免检产品”的要求。
- 已通知 PM 更新 PRD 1.3，移除对 Control Surface 库的引用。  
**后果**：开发人员应以架构文档为准，不引入 Control Surface 库。

### ADR-004：本设计仅使用 RP2040 Core 0

**状态**：已批准  
**背景**：审计询问 RP2040 双核使用策略。  
**决策**：本设计仅使用 Core 0，Core 1 保持复位状态。  
**理由**：
- 所有业务流的总负载（采样、滤波、映射检查、MIDI 发送、LED 状态机）在 10ms 周期内远低于 5ms，单核有余量。
- 引入 Core 1 将迫使所有管线接口考虑并发安全性（原子操作、互斥锁），显著增加复杂度，与“简单可靠”的产品目标相悖。
- 若未来产品形态要求更高的采样率或复杂 DSP，可重新评估双核方案，但届时架构需整体重新审计。  
**后果**：所有并发安全性假设基于单核无抢占模型成立。任何使用 Core 1 的尝试必须通过架构变更流程。

### ADR-005：配置写入采用分步状态机而非单次同步阻塞

**状态**：已批准  
**背景**：PRD 3.6.2 要求同步阻塞写入，但若在 `cmd_cfg_process_sysex()` 内一次性阻塞 200ms 会导致 LED 状态机停滞、SysEx 接收溢出。  
**决策**：将写入过程拆分为分步状态机，通过 `storage_save_config_step()` 每轮主循环写一页，`cmd_cfg_task()` 驱动。  
**理由**：保持“同步阻塞”的对外语义，同时确保系统其他管线不被饥饿。每次步进阻塞 <5ms，对 LED 和 MIDI 接收无实质影响。  
**后果**：增加了 `storage_api` 和 `cmd_cfg` 状态机复杂度，但这是唯一满足所有约束的方案。

### ADR-006：`cmd_cfg_task()` 作为被动服务者原则的受控例外

**状态**：已批准  
**背景**：`cmd_cfg_task()` 内部主动调用 LED、Pot、Storage、MIDI 管线，违反了“管线不应主动调用其他管线”的原则。  
**决策**：将 `cmd_cfg_task()` 标记为**受控例外**。  
**理由**：该函数完全在主循环驱动下按状态机运行，每次调用立即返回，不破坏系统的可调度性。将其封装在 cmd_cfg 管线内部，主循环无需感知内部编排细节，保持了主循环的简洁性。  
**后果**：`cmd_cfg` 管线的 APP 层耦合度高于其他管线，但这是一个受审核允许的、有明确边界的例外。接口层已通过 `@constraint` 注释严格限制副作用范围。

---

## 附录 A：上位机通信协议参考（v2.6 摘要）

Lyre 的 **Command & Config 管线** 必须完整实现《MIDI 控制器自描述配置协议 v2.6》中的以下命令：

| 命令字 | 方向 | 功能 | 管线处理 |
|--------|------|------|----------|
| `0x03` / `0x04` | 查询/响应 | 物理设备信息 | cmd_cfg_app |
| `0x07` / `0x08` | 查询/响应 | 面板布局描述 | cmd_cfg_app |
| `0x0B` / `0x0C` | 查询/响应 | 虚拟控件与库配置 | cmd_cfg_app |
| `0x0D` / `0x0E` | 写入/应答 | 写入虚拟配置 | cmd_cfg_app |
| `0x0F` / `0x10` | 写入/应答 | 写入校准数据 | cmd_cfg_app |
| `0x11` / `0x12` | 查询/响应 | 查询 ADC 原始值 | cmd_cfg_app + pot_api |

Lyre 的参数：
- 物理控件数 `N = 4`（4 个推杆，无按钮）
- 库数量 `B = 1`（单库设备）
- 虚拟控件数 `V = 4`
- 布局树：4 个水平排列的推杆（`0x11` 叶子节点）

协议详细格式、校验和算法、14-bit 校准值编码、校准流程等请参见《MIDI 控制器自描述配置协议 v2.6》全文（已单独提供）。命令配置管线的 `cmd_core` 将实现通用 SysEx 解析引擎，与具体协议命令字解耦。

---

## 附录 B：项目文件结构建议

```
firmware/
├── pipelines/
│   ├── potentiometer/
│   │   ├── pot_hal.c / .h
│   │   ├── pot_core.c / .h
│   │   └── pot_app.c / .h
│   ├── cmd_config/
│   │   ├── cmd_core.c / .h
│   │   └── cmd_cfg_app.c / .h
│   ├── storage/
│   │   ├── storage_hal.c / .h
│   │   ├── storage_core.c / .h      (可选)
│   │   └── storage_app.c / .h
│   ├── midi/
│   │   ├── midi_hal.c / .h
│   │   ├── midi_core.c / .h
│   │   └── midi_app.c / .h
│   └── led/
│       ├── led_hal.c / .h
│       ├── led_core.c / .h
│       └── led_app.c / .h
├── market/
│   ├── pot_api.h
│   ├── cmd_cfg_api.h
│   ├── storage_api.h
│   ├── midi_api.h
│   └── led_api.h
├── main.c (或 main.ino)
└── platformio.ini (或 CMakeLists.txt)
```

---

*本文档为 Lyre 固件最终冻结基线，所有接口契约及业务流均经过四轮审计闭环。可作为模块详细设计及代码开发的唯一依据。*
