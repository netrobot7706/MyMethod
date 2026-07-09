# Lyre 固件开发规格书 v3.3

## 0. 文档信息

| 项目 | 内容 |
| :--- | :--- |
| 产品代号 | Lyre |
| 文档版本 | v3.3 (量产加固版) |
| 日期 | 2026-07-11 |
| v3.2→v3.3 变更 | ① **Factory Reset WDT 防护**：`factory_reset` 分支前后显式 `watchdog_update()` + `tud_task()`。② **信号链首值 0 丢失修复**：增加 `has_sent` 标志，首次强制发送；Stage 1 开启瞬间先填充当前值消除 0 污染。③ **save_config 掉电一致性**：先写 Flash 校验返回值，成功后再提交 RAM。④ **启动错误上报修复**：`config_manager_init` 返回错误码，MIDI 栈就绪后再上报。⑤ **Stage 2 重命名**：`deadzone` → `endpoint_clamp`，消除语义歧义。⑥ **raw_json_ptr 悬空修复**：`on_json_ready` 增加静态缓冲区拷贝。⑦ **配置版本号**：`device_config_t` 增加 `uint16_t version` 字段。⑧ **WS2812 脏标记**：`ws2812_hal` 增加 dirty flag，未变更时物理刷新耗时为 0。⑨ **缓冲区扩容**：`tx_buf` → 512B，`sysex_buf` → 768B。⑩ **ADC count=0 防御**：`adc_sampler_read` 入口钳位。 |

## 1. 产品概述

Lyre 是一款 4 推杆 USB MIDI 控制器。设备仅枚举为 USB MIDI 设备（量产模式下无 CDC 串口），所有配置/校准/日志通信通过 Json over SysEx 协议完成。固件需独立完成：200Hz ADC 采集 → 5 级可开关信号调理 → MIDI CC 发送、上位机指令响应、配置持久化、LED 状态反馈、异常日志上报。

## 2. 硬件规格与引脚

| 组件 | 规格 |
| :--- | :--- |
| 主控 | RP2040-Zero (双核 Cortex-M0+, 264KB RAM, 2MB Flash) **注：v3.3 仅使用单核** |
| 推杆 ×4 | 100mm 行程线性电位器 |
| LED | 板载 WS2812 RGB LED |

引脚分配：

| 功能 | 引脚 | 备注 |
| :--- | :--- | :--- |
| 推杆1 ADC | GPIO26 (A0) | |
| 推杆2 ADC | GPIO27 (A1) | |
| 推杆3 ADC | GPIO28 (A2) | |
| 推杆4 ADC | GPIO29 (A3) | 国产 RP2040-Zero 扩展引脚，已验证可用 |
| WS2812 数据 | GPIO16 | 以实际板为准 |

模拟前端：电位器由 `V_clear`（3V3 经 22Ω + 10µF + 0.1µF 滤波）供电；信号经 1kΩ + 0.1µF RC 低通滤波后入 ADC。

## 3. 技术栈与开发约束

| 项 | 选型 | 说明 |
| :--- | :--- | :--- |
| IDE | Arduino IDE | 基于 arduino-pico core |
| USB 协议栈 | TinyUSB | 量产仅启用 MIDI；开发期条件编译启用 CDC |
| 调度架构 | **单核主循环** | 所有任务在单一 `loop()` 中顺序执行，无并发、无锁 |
| ADC 采样率 | **200Hz (5ms/次)** | 主循环 1ms 计数器驱动，每 5 次循环触发 1 次 17×4 过采样，单次耗时 ~140µs |
| Flash 写入 | 主循环内同步执行 | 写入期间主循环暂停 ~400ms，**内部安全喂狗 + 上位机重连容忍** |
| 看门狗 | **硬件 WDT (2000ms)** | `setup()` 中 `watchdog_enable(2000, 1)`，`loop()` 末尾 + **Flash 写入内部** + **factory_reset 前后** 喂狗 |
| 字符串安全 | `snprintf` 裁剪 | 所有 `snprintf` 返回值必须经过 `len >= sizeof(buf) ? sizeof(buf)-1 : len` 防御性裁剪 |
| Flash 写入策略 | 校准仅改 RAM | `calibrate` / `set_signal_stage` 仅更新运行时配置；Flash 写入统一由 `save_config` 触发 |
| Flash 写入顺序 | 🔥 **先 Flash 后 RAM** | `save_config` 必须先 `config_manager_save()` 校验成功，再提交 RAM |
| 信号采集与调理 | 自实现 5 级可开关链 | 每级独立使能+参数可调，**所有分母参数必须强钳位**，**init 必须 memset 清零 + has_sent 标志** |
| 持久化存储 | LittleFS | arduino-pico core 原生支持 |
| LED 驱动 | Adafruit NeoPixel | RP2040 PIO 驱动，🔥 **必须实现脏标记** |
| SysEx 传输层 | sysex_encoder / sysex_decoder | 纯 C 编解码器（已完成） |
| JSON 解析 | ArduinoJson v6.x 或 cJSON | — |
| 量产日志 | **SysEx Log Event** | 异常状态通过 `{"event":"log","msg":"..."}` 主动上报，不依赖 CDC |
| 配置版本管理 | 🔥 **`uint16_t version`** | `device_config_t` 含 version 字段，magic+version 双重校验 |

⚠️ **核心约束：**

-   **不使用 Control Surface 库。** 所有 MIDI 路由、信号滤波均由固件自行实现。
-   **单核架构。** 不使用 Core 1，不使用 `setup1()`/`loop1()`，不使用任何多核同步原语。
-   **Flash 写入函数必须驻留 RAM。** 仅 `flash_store_write_file()` 及其直接调用的底层函数需要 `__not_in_flash_func()`，其余模块不需要。
-   **USB 发送前必须检查连接状态。** 调用 `tud_midi_mounted()` ，未连接则跳过发送。
-   **防除零与边界钳位。** 信号链中所有涉及分母的参数（如 `filter_window_size`, `range`），在运算前必须进行非零和边界强钳位。
-   **看门狗强制。** 主循环末尾必须包含 `watchdog_update()`；Flash 写入内部通过 `CFG_WDT_SAFE_WRITE` 宏安全喂狗；🔥 **factory_reset 前后显式喂狗**。
-   **USB 状态保持。** 上位机发送 `save_config` / `factory_reset` 后必须等待 ≥1000ms 并准备重连，固件侧写入前后显式 `tud_task()`。
-   **信号链初始化。** `signal_conditioner_init()` 必须 `memset` 清零整个结构体，将 `filter_window_size` 设为默认值 4，🔥 **`has_sent` 设为 false**。
-   🔥 **JSON 生命周期安全。** `on_json_ready()` 必须将 JSON 拷贝到静态缓冲区后再传递给 `cmd_handler_process()`，禁止传递原始指针。
-   🔥 **配置写入顺序。** `save_config` 必须先写 Flash 校验成功，再提交 RAM，确保掉电一致性。
-   🔥 **启动错误延后上报。** `config_manager_init()` 返回错误码，由 `main.ino` 在 MIDI 栈初始化完成后统一上报。

🚫 **严禁使用：**

-   `multicore_lockout`
-   `spinlock` / `mutex` / `semaphore`
-   `queue_t` / 任何核间通信机制
-   `__not_in_flash_func()` （除 Flash 写入函数外）
-   USB 断连缓冲 / 重连状态机
-   CRC 校验
-   阻塞式连续 ADC 过采样（**仅允许 200Hz 触发的 17 次过采样**）

## 4. 系统架构（10 模块乐高化设计）

### 4.1 分层与模块地图

```
┌──────────────────────────────────────────────────────────────────────┐
│                          产品业务层 (Lyre 专属)                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐ │
│  │  cmd_handler   │  │  config_codec  │  │      main.ino          │ │
│  │ (JSON→Event)   │  │(JSON⟷Struct)   │  │(单核主循环 Mediator)    │ │
│  └───────┬────────┘  └───────┬────────┘  └───────────┬────────────┘ │
├──────────┼───────────────────┼───────────────────────┼──────────────┤
│          │             通用能力层 (跨项目复用)          │              │
│  ┌───────┴──────┐  ┌─────────┴───────┐  ┌────────────┴───────────┐ │
│  │config_manager│  │ midi_dispatcher │  │       led_engine       │ │
│  │(Blob存储代理) │  │ (MIDI路由逻辑)   │  │  (主循环计数器控制)     │ │
│  └──────┬───────┘  └───────┬─────────┘  └───────────┬────────────┘ │
├─────────┼──────────────────┼────────────────────────┼──────────────┤
│                    硬件抽象层 (HAL / 传输层)           │              │
│  ┌──────┴───────┐  ┌───────┴────────┐  ┌────────────┴───────────┐ │
│  │ flash_store  │  │midi_transport  │  │      ws2812_hal        │ │
│  │(LittleFS+WDT)│  │(TinyUSB读写封装)│  │ (NeoPixel+脏标记)      │ │
│  └──────────────┘  └────────────────┘  └────────────────────────┘ │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐ │
│  │ adc_sampler  │──│signal_condition│  │  sysex_codec (已完成)   │ │
│  │(200Hz 17x OS)│  │er(5级可开关链)  │  └────────────────────────┘ │
│  └──────────────┘  └────────────────┘                              │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 单核主循环职责

```
每 1ms 执行一轮 loop()：
  1. adc_counter++，若 adc_counter >= 5:
       adc_counter = 0
       ADC 过采样（4 路，17 次读/丢首值/16 次平均，~140µs）
       5 级信号调理（每级可开关，含边界钳位 + has_sent 首值保障）
       如有变化且 USB 已连接 → 发送 MIDI CC + 触发 LED
  2. midi_transport_task()
  3. midi_dispatcher_poll() → 收到 JSON → 静态拷贝 → cmd_handler_process()
  4. led_engine_update()（计数器驱动）
  5. watchdog_update()  ← 必须放在最后
```

### 4.3 模块职责与复用性矩阵

| 模块 | 文件 | 职责边界 | 复用性 |
| :--- | :--- | :--- | :--- |
| adc_sampler | adc_sampler.h/c | 200Hz 触发的 17 次过采样（读 17 丢 1 平均 16）+ 🔥 count=0 防御 | 🟢 通用 |
| signal_conditioner | signal_conditioner.h/c | 5 级可开关信号调理链（含防除零钳位 + memset + 🔥 has_sent + 🔥 开启瞬间填充） | 🟢 通用 |
| midi_transport | midi_transport.h/c | TinyUSB MIDI API 薄封装（含 mounted 检查） | 🟢 通用 |
| midi_dispatcher | midi_dispatcher.h/c | 解析入站字节流，识别 SysEx 边界并提取 JSON 载荷 | 🟡 半通用 |
| flash_store | flash_store.h/c | LittleFS 文件读写 + CFG_WDT_SAFE_WRITE 安全喂狗 | 🟢 通用 |
| config_manager | config_manager.h/c | 🔥 Blob 存储代理：Magic+Version 双重校验 + 返回错误码 | 🟢 通用 |
| ws2812_hal | ws2812_hal.h/c | Adafruit NeoPixel + 🔥 **脏标记**（颜色未变不刷新） | 🟢 通用 |
| led_engine | led_engine.h/c | 主循环计数器驱动的简单 LED 控制 | 🟡 半通用 |
| cmd_handler | cmd_handler.h/c | JSON 指令解析，抛出只读结构化事件 | 🔴 专属 |
| config_codec | config_codec.h/c | `device_config_t` ⟷ JSON 双向转换 + Log Event 序列化 | 🔴 专属 |
| main | main.ino | 单核 setup/loop 入口，Mediator 事件路由，WDT 喂狗，🔥 JSON 静态拷贝，🔥 延后错误上报 | 🔴 专属 |

## 5. USB 设备枚举

单枚举 USB MIDI Class Compliant 设备，不含 CDC。
描述符须符合 USB MIDI v1.0 规范。
arduino-pico core 下，通过 `Adafruit_TinyUSB.h` 配置 MIDI-only 枚举。
条件编译：`#define DEBUG_MODE 1` 时保留 CDC 串口；`#define DEBUG_MODE 0`（量产）时关闭 CDC，**异常日志通过 SysEx Log Event 上报**。

## 6. 信号链模块：采集与调理

### 6.1 信号流

```
物理推杆 → RC硬件滤波 → RP2040 ADC → [adc_sampler 200Hz 17x过采样] → [signal_conditioner 5级可开关链] → MIDI CC 输出
```

### 6.2 `adc_sampler` 规格（200Hz 触发 + 17 次过采样）

| 参数 | 值 | 说明 |
| :--- | :--- | :--- |
| 触发频率 | 200Hz (5ms/次) | 主循环 1ms 计数器驱动，每 5 次循环触发 1 次完整过采样 |
| 单次过采样 | 17 次连续读取 × 4 路 | 每次触发耗时 ~140µs，占 5ms 时间片约 2.8% |
| 平均方式 | 丢弃第 1 次，后 16 次算术平均 | `count=16` 参数表示有效平均次数，内部实际读取 `count+1` 次 |

```c
// adc_sampler.h
#ifndef ADC_SAMPLER_H
#define ADC_SAMPLER_H
#include <stdint.h>

/**
 * @brief 执行过采样并返回平均值
 * @param pin   ADC 引脚编号
 * @param count 有效平均次数（内部实际读取 count+1 次，丢弃首次不稳定值）
 * @return 12-bit ADC 平均值 (0-4095)
 *
 * 当 count=16 时，内部连续读取 17 次，丢弃第 1 次，
 * 对后 16 次求算术平均。由主循环以 200Hz 频率调度。
 * 🔥 v3.3: count=0 时强制钳位为 1，防止除零。
 */
uint16_t adc_sampler_read(uint8_t pin, uint8_t count);
#endif
```

### 6.3 `signal_conditioner` 规格（5 级可开关链 + 防御加固 + 首值保障）

#### 设计原则

RP2040 ADC 硬件噪声大，简单处理会产生幽灵 MIDI 消息。5 级处理全部保留，但**每级可独立开关+参数可调**。固件完成后，逐级开关测试，找到每块 PCB 的最佳参数组合。不是"默认全部开启"，而是"全部可关闭，按需开启"。

#### ⚠️ v3.3 防御加固要求

-   **所有涉及分母的参数，在运算前必须进行非零和边界强钳位。**
-   `signal_conditioner_init()` 必须 `memset(sc, 0, sizeof(*sc))` 清零整个结构体，然后将 `filter_window_size` 设为默认值 4。
-   🔥 **`has_sent` 标志初始化为 false，首次 `process()` 必须强制发送（含 MIDI 值 0）。**
-   🔥 **Stage 1 滤波开启瞬间（`has_sent == false` 或 `filter_enable` 首次生效），必须将 `filter_buffer` 全部填充为当前采样值，消除 0 污染。**

#### 5 级处理链定义

| Stage | 名称 | 开关参数 | 可调参数 | 关闭时行为 | 防御钳位要求 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 数字滤波 | `filter_enable` | `filter_window_size` (4/8/16/32) | 直接透传原始值 | **>32 钳位为 32，==0 钳位为 4** |
| 2 | 🔥 端点钳位 | `endpoint_clamp_enable` | `endpoint_margin` (ADC 原始值) | 跳过 | margin > 2047 钳位为 2047 |
| 3 | 迟滞处理 | `hysteresis_enable` | `hysteresis_threshold` (ADC 变化量) | 跳过 | threshold > 2047 钳位为 2047 |
| 4 | 校准映射 | `calibration_enable` | `cal_min`, `cal_max` | 线性映射 [0,4095]→[0,127] | **range <= 0 时返回 -1，不执行除法** |
| 5 | 变化阈值 | `change_threshold_enable` | `change_threshold` (MIDI 值 ±N) | 任何变化都发送 | threshold < 0 钳位为 0，> 127 钳位为 127 |

#### 数据结构

```c
// signal_conditioner.h
#ifndef SIGNAL_CONDITIONER_H
#define SIGNAL_CONDITIONER_H
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    // Stage 1: 数字滤波
    bool     filter_enable;
    uint8_t  filter_window_size;   // 4/8/16/32，运行时强钳位
    uint16_t filter_buffer[32];
    uint8_t  filter_buf_idx;
    bool     filter_first_frame;   // 🔥 v3.3: 滤波首次生效标记

    // Stage 2: 🔥 端点钳位（原 deadzone，v3.3 重命名）
    bool     endpoint_clamp_enable;
    uint16_t endpoint_margin;

    // Stage 3: 迟滞处理
    bool     hysteresis_enable;
    uint16_t hysteresis_threshold;
    uint16_t last_trigger_raw;

    // Stage 4: 校准映射
    bool     calibration_enable;
    uint16_t cal_min;
    uint16_t cal_max;

    // Stage 5: 变化阈值
    bool     change_threshold_enable;
    int8_t   change_threshold;
    int8_t   last_sent_midi;

    // 🔥 v3.3: 首值发送保障
    bool     has_sent;
} signal_conditioner_t;

void signal_conditioner_init(signal_conditioner_t *sc);
int8_t signal_conditioner_process(signal_conditioner_t *sc, uint16_t raw);
void signal_conditioner_set_calibration(signal_conditioner_t *sc,
                                        uint16_t cal_min, uint16_t cal_max);
void signal_conditioner_set_stage_params(signal_conditioner_t *sc,
                                         const char *stage_name,
                                         bool enable,
                                         int32_t param_value);
#endif
```

#### 🔥 v3.3 init 实现要求

```c
void signal_conditioner_init(signal_conditioner_t *sc) {
    memset(sc, 0, sizeof(*sc));
    sc->filter_window_size = 4;
    sc->filter_first_frame = true;   // 🔥 v3.3
    sc->has_sent = false;            // 🔥 v3.3: 首次强制发送
    sc->last_sent_midi = -1;         // 🔥 v3.3: 非法值，确保首次任何值都能触发
}
```

#### 算法伪代码（含 v3.3 全部防御）

```c
int8_t signal_conditioner_process(signal_conditioner_t *sc, uint16_t raw) {
    uint16_t value = raw;

    // Stage 1: 数字滤波 + 防御钳位 + 🔥 开启瞬间填充
    if (sc->filter_enable) {
        if (sc->filter_window_size > 32) sc->filter_window_size = 32;
        if (sc->filter_window_size == 0) sc->filter_window_size = 4;

        // 🔥 v3.3: 滤波首次生效时，用当前值填满缓冲区，消除 0 污染
        if (sc->filter_first_frame) {
            for (uint8_t i = 0; i < sc->filter_window_size; i++) {
                sc->filter_buffer[i] = value;
            }
            sc->filter_first_frame = false;
        }

        sc->filter_buffer[sc->filter_buf_idx] = value;
        sc->filter_buf_idx = (sc->filter_buf_idx + 1) % sc->filter_window_size;
        uint32_t sum = 0;
        for (uint8_t i = 0; i < sc->filter_window_size; i++) sum += sc->filter_buffer[i];
        value = (uint16_t)(sum / sc->filter_window_size);
    }

    // Stage 2: 🔥 端点钳位（原 deadzone）
    if (sc->endpoint_clamp_enable) {
        uint16_t margin = sc->endpoint_margin;
        if (margin > 2047) margin = 2047;
        if (value < margin) value = margin;
        if (value > 4095 - margin) value = 4095 - margin;
    }

    // Stage 3: 迟滞处理
    if (sc->hysteresis_enable) {
        uint16_t thr = sc->hysteresis_threshold;
        if (thr > 2047) thr = 2047;
        int16_t diff = (int16_t)value - (int16_t)sc->last_trigger_raw;
        if (abs(diff) <= thr) {
            value = sc->last_trigger_raw;
        } else {
            sc->last_trigger_raw = value;
        }
    }

    // Stage 4: 校准映射 + 防除零
    int8_t midi_val;
    if (sc->calibration_enable) {
        int32_t range = (int32_t)sc->cal_max - (int32_t)sc->cal_min;
        if (range <= 0) return -1;
        int32_t diff_raw = (int32_t)value - (int32_t)sc->cal_min;
        if (diff_raw < 0) diff_raw = 0;
        midi_val = (int8_t)((diff_raw * 127) / range);
        if (midi_val > 127) midi_val = 127;
    } else {
        midi_val = (int8_t)((uint32_t)value * 127 / 4095);
    }

    // Stage 5: 变化阈值
    if (sc->change_threshold_enable) {
        int8_t thr = sc->change_threshold;
        if (thr < 0) thr = 0;
        if (thr > 127) thr = 127;
        // 🔥 v3.3: 首次发送时跳过变化阈值检查
        if (sc->has_sent && abs(midi_val - sc->last_sent_midi) <= thr) {
            return -1;
        }
    }

    // 🔥 v3.3: 首值发送保障 —— has_sent 为 false 时强制发送
    if (!sc->has_sent || midi_val != sc->last_sent_midi) {
        sc->has_sent = true;
        sc->last_sent_midi = midi_val;
        return midi_val;
    }
    return -1;
}
```

#### 调试推荐流程

```
Step 1: 全部关闭 → 观察 200Hz 原始 ADC 噪声水平
Step 2: 开启 Stage 1 滤波 → 调整 window_size，观察滤波效果（无 0 污染跳变）
Step 3: 开启 Stage 5 变化阈值 → 确认幽灵消息消除
Step 4: 根据手感和精度需求，决定是否开启 Stage 2/3/4
Step 5: 确定最终参数，写入配置
```

## 7. MIDI 路由层：传输与分发

### 7.1 `midi_transport` 规格

纯 TinyUSB 封装。**发送前必须检查 `tud_midi_mounted()`**，未连接则跳过。不做断连缓冲、不做重连状态机。

```c
// midi_transport.h
#ifndef MIDI_TRANSPORT_H
#define MIDI_TRANSPORT_H
#include <stdint.h>
#include <stddef.h>

void midi_transport_init(void);
void midi_transport_task(void);
uint32_t midi_transport_read(uint8_t *buf, uint32_t bufsize);
void midi_transport_send_cc(uint8_t channel, uint8_t cc_num, uint8_t value);
void midi_transport_send_sysex(const uint8_t *data, size_t len);
#endif
```

### 7.2 `midi_dispatcher` 规格

在主循环中轮询调用。

```c
// midi_dispatcher.h
#ifndef MIDI_DISPATCHER_H
#define MIDI_DISPATCHER_H
#include <stdint.h>
#include <stddef.h>

typedef void (*midi_json_ready_callback_t)(const char *json, size_t len);
void midi_dispatcher_init(midi_json_ready_callback_t json_ready_cb);
void midi_dispatcher_poll(void);
#endif
```

### 7.3 SysEx 编解码器集成

入站链：
```
midi_dispatcher_poll() → sysex_decoder_process() → 提取 JSON → on_json_ready() → 静态拷贝 → cmd_handler_process()
```

出站链：
```
cmd_handler 构造 JSON → sysex_encode → midi_transport_send_sysex()
```

## 8. 业务层：指令处理 (`cmd_handler`)

### 8.1 指令总表

| 指令 | 上位机发送 | 固件应答 | 说明 |
| :--- | :--- | :--- | :--- |
| handshake | `{"cmd":"handshake"}` | `{"cmd":"handshake_ack","id":"LYRE-001","ver":"1.0"}` | 设备识别 |
| read_config | `{"cmd":"read_config"}` | `{"cmd":"config_data",...}` | 读 Flash 配置 |
| get_runtime_config | `{"cmd":"get_runtime_config"}` | `{"cmd":"runtime_config_data",...}` | 读 RAM 配置 |
| get_adc | `{"cmd":"get_adc","ch_num":1}` | `{"cmd":"adc_value","ch_num":1,"raw":2048}` | 读 ADC 快照值 |
| test_config | `{"cmd":"test_config","ch_num":1,"ch":2,"cc":7}` | `{"cmd":"test_config_ack","status":"ok"}` | 临时改配置(不写Flash) |
| save_config | `{"cmd":"save_config",...}` | `{"cmd":"save_config_ack","status":"ok/error"}` | 🔥 **先写 Flash 校验成功再提交 RAM。上位机发送后等待 ≥1000ms** |
| factory_reset | `{"cmd":"factory_reset"}` | `{"cmd":"factory_reset_ack","status":"ok/error"}` | 🔥 **恢复出厂（写 Flash），前后显式喂狗+USB 刷新** |
| calibrate | `{"cmd":"calibrate","ch_num":1,"min":200,"max":3800}` | `{"cmd":"calibrate_ack","status":"ok"}` | ⚠️ 仅更新 RAM，不写 Flash |
| set_signal_stage | `{"cmd":"set_signal_stage","ch_num":1,"stage":"filter","enable":true,"param":16}` | `{"cmd":"set_signal_stage_ack","status":"ok"}` | 🔥 运行时调整信号链参数，🔥 stage 名使用 `endpoint_clamp` 替代 `deadzone` |

⚠️ Flash 寿命保护策略：`calibrate` 和 `set_signal_stage` 指令**仅更新 RAM**。Flash 写入仅在收到 `save_config` 或 `factory_reset` 时触发。

### 8.2 事件定义与接口

```c
// cmd_handler.h
#ifndef CMD_HANDLER_H
#define CMD_HANDLER_H
#include <stdint.h>
#include <stddef.h>

typedef enum {
    CMD_EVENT_HANDSHAKE = 0,
    CMD_EVENT_REQ_CONFIG,
    CMD_EVENT_REQ_RUNTIME_CONFIG,
    CMD_EVENT_REQ_ADC_VALUE,
    CMD_EVENT_TEST_CONFIG,
    CMD_EVENT_SAVE_CONFIG,
    CMD_EVENT_FACTORY_RESET,
    CMD_EVENT_UPDATE_CALIBRATION,
    CMD_EVENT_SET_SIGNAL_STAGE,
} cmd_event_type_t;

typedef struct {
    cmd_event_type_t type;
    const char      *raw_json_ptr;  // 🔥 指向静态拷贝，生命周期安全
    size_t           json_len;
    union {
        struct { uint8_t ch_num; }                   adc_req;
        struct { uint8_t ch_num; uint16_t min, max; } calibration;
        struct { uint8_t ch_num; uint8_t cc; uint8_t channel; } test_config;
        struct { uint8_t ch_num; char stage[16]; bool enable; int32_t param; } signal_stage;
    } data;
} cmd_event_t;

typedef void (*cmd_event_callback_t)(const cmd_event_t *event);
void cmd_handler_init(cmd_event_callback_t cb);
void cmd_handler_process(const char *json, size_t len);
#endif
```

## 9. 配置存储层

### 9.1 配置数据结构

```c
// device_config.h
#ifndef DEVICE_CONFIG_H
#define DEVICE_CONFIG_H
#include <stdint.h>
#include <stdbool.h>

#define POT_COUNT       4
#define CONFIG_MAGIC    0x4C595245  // "LYRE"
#define CONFIG_VERSION  1           // 🔥 v3.3: 配置版本号

// 🔥 v3.3: 重命名 deadzone → endpoint_clamp
typedef struct {
    bool     filter_enable;
    uint8_t  filter_window_size;
    bool     endpoint_clamp_enable;
    uint16_t endpoint_margin;
    bool     hysteresis_enable;
    uint16_t hysteresis_threshold;
    bool     calibration_enable;
    bool     change_threshold_enable;
    int8_t   change_threshold;
} signal_chain_config_t;

typedef struct {
    uint8_t  channel;
    uint8_t  cc;
    uint16_t cal_min;
    uint16_t cal_max;
    signal_chain_config_t signal_chain;
} pot_config_t;

typedef struct {
    uint32_t     magic;
    uint16_t     version;           // 🔥 v3.3: 当前为 1
    pot_config_t pots[POT_COUNT];
} device_config_t;

static const device_config_t FACTORY_DEFAULT_CONFIG = {
    .magic   = CONFIG_MAGIC,
    .version = CONFIG_VERSION,      // 🔥 v3.3
    .pots = {
        { .channel = 1, .cc = 1, .cal_min = 100, .cal_max = 4000,
          .signal_chain = {
              .filter_enable = false, .filter_window_size = 8,
              .endpoint_clamp_enable = false, .endpoint_margin = 0,
              .hysteresis_enable = false, .hysteresis_threshold = 0,
              .calibration_enable = true,
              .change_threshold_enable = false, .change_threshold = 0
          } },
        // ... 其余 3 路相同
    },
};
#endif
```

### 9.2 `config_manager` 规格（🔥 v3.3 错误码 + 版本校验）

**v3.3 变更**：`config_manager_init()` 不再直接发送日志，改为返回错误码。由 `main.ino` 在 MIDI 栈就绪后统一上报。读取时校验 `magic + version` 双重条件。

```c
// config_manager.h
#ifndef CONFIG_MANAGER_H
#define CONFIG_MANAGER_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

// 🔥 v3.3: 错误码定义
#define CONFIG_ERR_NONE            0
#define CONFIG_ERR_FLASH_READ      1  // Flash 读取失败
#define CONFIG_ERR_MAGIC_MISMATCH  2  // Magic 不匹配
#define CONFIG_ERR_VERSION_MISMATCH 3 // 版本不匹配

/**
 * @brief 初始化配置管理器
 * @param default_blob 出厂默认配置
 * @param blob_size    配置结构体大小
 * @param runtime_blob 运行时配置缓冲区
 * @param out_err      🔥 v3.3: 输出错误码（见 CONFIG_ERR_* 定义）
 * @return true=成功（可能含非致命错误），false=严重失败
 */
bool config_manager_init(const void *default_blob, size_t blob_size,
                         void *runtime_blob, int *out_err);

/**
 * @brief 保存配置到 Flash
 * @return true=写入成功，false=写入失败
 */
bool config_manager_save(const void *runtime_blob, size_t blob_size);

/**
 * @brief 恢复出厂设置
 * @return true=成功，false=失败
 */
bool config_manager_factory_reset(void *runtime_blob, size_t blob_size);
#endif
```

### 9.3 `flash_store` 规格（v3.2 安全喂狗）

```c
// flash_store.h
#ifndef FLASH_STORE_H
#define FLASH_STORE_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define CFG_WDT_SAFE_WRITE  1

bool flash_store_init(void);
bool flash_store_read_file(const char *path, void *buf, size_t len);
bool flash_store_write_file(const char *path, const void *buf, size_t len);
bool flash_store_delete_file(const char *path);
#endif
```

> ⚠️ `flash_store_write_file()` 及其直接调用的底层函数**必须标记 `__not_in_flash_func()`**。
> 当 `CFG_WDT_SAFE_WRITE` 定义为 1 时，`flash_store_write_file()` 内部每次 LittleFS 块擦除/写入操作后必须调用 `watchdog_update()`。

### 9.4 `config_codec` 规格

```c
// config_codec.h
#ifndef CONFIG_CODEC_H
#define CONFIG_CODEC_H
#include "device_config.h"
#include <stddef.h>
#include <stdbool.h>

size_t config_codec_serialize(const device_config_t *cfg, char *out_buf, size_t buf_size);
bool config_codec_deserialize(const char *json, size_t len, device_config_t *out_cfg);
size_t config_codec_serialize_adc(uint8_t ch_num, uint16_t raw, char *out_buf, size_t buf_size);
size_t config_codec_serialize_log_event(const char *msg, char *out_buf, size_t buf_size);
#endif
```

## 10. LED 反馈层

### 10.1 LED 状态定义（简化版）

| 状态/事件 | 行为 | 颜色 |
| :--- | :--- | :--- |
| 空闲 | 常亮 | 白色 |
| MIDI CC 发送 | 快闪 50ms | 绿色 |
| 保存配置中 | 快闪 200ms | 黄色 |
| 保存完成 | 长亮 2s | 绿色 |
| 恢复出厂中 | 快闪 100ms | 红色 |

### 10.2 `led_engine` 规格（主循环计数器版）

```c
// led_engine.h
#ifndef LED_ENGINE_H
#define LED_ENGINE_H

typedef enum {
    LED_EVENT_NONE = 0,
    LED_EVENT_MIDI_SENT,
    LED_EVENT_SAVING,
    LED_EVENT_SAVE_DONE,
    LED_EVENT_FACTORY_RESET,
} led_event_t;

void led_engine_init(void);
void led_engine_trigger(led_event_t event);
void led_engine_update(void);  // 每 1ms 在主循环中调用
#endif
```

### 10.3 `ws2812_hal` 规格（🔥 v3.3 脏标记）

```c
// ws2812_hal.h
#ifndef WS2812_HAL_H
#define WS2812_HAL_H
#include <stdint.h>

void ws2812_hal_init(void);
void ws2812_hal_set_pixel(uint32_t color_rgb);
void ws2812_hal_show(void);
#endif
```

> 🔥 **v3.3 实现要求**：`ws2812_hal` 内部必须维护一个 `static uint32_t last_color` 和 `static bool dirty` 标志。`set_pixel()` 仅在 `color_rgb != last_color` 时置 `dirty = true`。`show()` 第一步检查 `if (!dirty) return;`，发送完成后 `dirty = false`。确保空闲状态和非颜色突变时，物理刷新耗时为 0。

## 11. 主循环架构 (`main.ino`) — 单核 Mediator + WDT

### 11.1 全局变量声明

```cpp
#include "device_config.h"
#include "signal_conditioner.h"

// --- 全局资源（单核，无需锁） ---
device_config_t      g_runtime_config;
signal_conditioner_t g_conditioners[POT_COUNT];
volatile uint16_t    g_adc_raw_cache[POT_COUNT];
const uint8_t        pot_pins[POT_COUNT] = {26, 27, 28, 29};

// 🔥 v3.3: JSON 静态拷贝缓冲区，消除悬空指针风险
static char          g_json_safe[512];
```

### 11.2 单核 setup（🔥 v3.3 正确初始化顺序 + 延后错误上报）

```cpp
void setup() {
    watchdog_enable(2000, 1);

    // --- 第一批：纯硬件 / 存储初始化 ---
    ws2812_hal_init();
    led_engine_init();
    flash_store_init();

    // --- 第二批：🔥 USB/MIDI 栈先行初始化 ---
    midi_transport_init();
    midi_dispatcher_init(on_json_ready);
    cmd_handler_init(on_cmd_event);

    // --- 第三批：🔥 配置管理器最后初始化（此时 MIDI 栈已就绪）---
    int cfg_err = CONFIG_ERR_NONE;
    config_manager_init(&FACTORY_DEFAULT_CONFIG, sizeof(device_config_t),
                        &g_runtime_config, &cfg_err);

    // 🔥 v3.3: 根据错误码，通过已就绪的 SysEx 通道上报
    if (cfg_err == CONFIG_ERR_MAGIC_MISMATCH) {
        send_log_event("LittleFS Magic Mismatch, Factory Reset");
    } else if (cfg_err == CONFIG_ERR_VERSION_MISMATCH) {
        send_log_event("Config Version Mismatch, Factory Reset");
    } else if (cfg_err == CONFIG_ERR_FLASH_READ) {
        send_log_event("Flash Read Failed, Using Defaults");
    }

    // --- 第四批：信号链初始化（依赖已加载的 g_runtime_config）---
    for (int i = 0; i < POT_COUNT; i++) {
        signal_conditioner_init(&g_conditioners[i]);
        signal_conditioner_set_calibration(&g_conditioners[i],
            g_runtime_config.pots[i].cal_min, g_runtime_config.pots[i].cal_max);
        // TODO: 加载其余信号链阶段参数
    }
}
```

### 11.3 单核 loop（200Hz ADC + 常规任务）

```cpp
void loop() {
    static uint32_t adc_counter = 0;

    // 200Hz ADC 过采样 (每 5ms 触发 1 次 17x 过采样，~140µs)
    adc_counter++;
    if (adc_counter >= 5) {
        adc_counter = 0;

        // 1. ADC 过采样（17次读/丢首值/16次平均 × 4路）
        uint16_t current_raw[POT_COUNT];
        for (int i = 0; i < POT_COUNT; i++) {
            current_raw[i] = adc_sampler_read(pot_pins[i], 16);
            g_adc_raw_cache[i] = current_raw[i];
        }

        // 2. 信号链处理 + MIDI 发送
        for (int i = 0; i < POT_COUNT; i++) {
            int8_t midi = signal_conditioner_process(&g_conditioners[i], current_raw[i]);
            if (midi >= 0) {
                midi_transport_send_cc(
                    g_runtime_config.pots[i].channel,
                    g_runtime_config.pots[i].cc,
                    midi);
                led_engine_trigger(LED_EVENT_MIDI_SENT);
            }
        }
    }

    // 3. USB 任务
    midi_transport_task();
    midi_dispatcher_poll();

    // 4. LED 更新（计数器驱动）
    led_engine_update();

    // 喂狗（必须放在 loop 最后）
    watchdog_update();
}
```

### 11.4 🔥 v3.3 on_json_ready（静态拷贝消除悬空指针）

```cpp
void on_json_ready(const char *json, size_t len) {
    // 🔥 v3.3: 拷贝到静态缓冲区，确保 cmd_handler 拿到的是私有拷贝
    if (len >= sizeof(g_json_safe)) {
        len = sizeof(g_json_safe) - 1;  // 防御裁剪
    }
    memcpy(g_json_safe, json, len);
    g_json_safe[len] = '\0';
    cmd_handler_process(g_json_safe, len);
}
```

### 11.5 指令事件处理（🔥 v3.3 掉电一致性 + Factory Reset WDT 防护）

```cpp
void send_log_event(const char *msg) {
    char log_buf[128];
    size_t log_len = config_codec_serialize_log_event(msg, log_buf, sizeof(log_buf));
    if (log_len > 0 && log_len < sizeof(log_buf)) {
        uint8_t sysex_buf[256];
        size_t sysex_len = sysex_encode(sysex_buf, sizeof(sysex_buf),
                                        (const uint8_t*)log_buf, log_len);
        midi_transport_send_sysex(sysex_buf, sysex_len);
    }
}

void on_cmd_event(const cmd_event_t *event) {
    // 🔥 v3.3: 缓冲区扩容，确保 4 路完整配置 JSON 不被截断
    char tx_buf[512];
    size_t len = 0;

    switch (event->type) {
        case CMD_EVENT_HANDSHAKE:
            len = snprintf(tx_buf, sizeof(tx_buf),
                "{\"cmd\":\"handshake_ack\",\"id\":\"LYRE-001\",\"ver\":\"1.0\"}");
            break;

        case CMD_EVENT_REQ_CONFIG:
            len = config_codec_serialize(&g_runtime_config, tx_buf, sizeof(tx_buf));
            break;

        case CMD_EVENT_REQ_RUNTIME_CONFIG:
            len = config_codec_serialize(&g_runtime_config, tx_buf, sizeof(tx_buf));
            break;

        case CMD_EVENT_REQ_ADC_VALUE: {
            uint8_t ch = event->data.adc_req.ch_num;
            if (ch < POT_COUNT) {
                len = config_codec_serialize_adc(ch, g_adc_raw_cache[ch], tx_buf, sizeof(tx_buf));
            }
            break;
        }

        // 🔥 v3.3: 先 Flash 后 RAM，校验返回值，确保掉电一致性
        case CMD_EVENT_SAVE_CONFIG: {
            led_engine_trigger(LED_EVENT_SAVING);
            device_config_t shadow_config;
            if (config_codec_deserialize(event->raw_json_ptr, event->json_len, &shadow_config)) {

                // Flash 写入前刷新 USB 缓冲区
                tud_task();
                watchdog_update();

                // 🔥 v3.3: 先写 Flash，校验返回值
                bool ok = config_manager_save(&shadow_config, sizeof(device_config_t));

                watchdog_update();
                tud_task();

                if (ok) {
                    // 写入成功后，提交到运行时
                    memcpy(&g_runtime_config, &shadow_config, sizeof(device_config_t));
                    for (int i = 0; i < POT_COUNT; i++) {
                        signal_conditioner_set_calibration(&g_conditioners[i],
                            g_runtime_config.pots[i].cal_min, g_runtime_config.pots[i].cal_max);
                        // TODO: 更新其余信号链参数
                    }
                    len = snprintf(tx_buf, sizeof(tx_buf),
                        "{\"cmd\":\"save_config_ack\",\"status\":\"ok\"}");
                } else {
                    len = snprintf(tx_buf, sizeof(tx_buf),
                        "{\"cmd\":\"save_config_ack\",\"status\":\"error\",\"reason\":\"flash_write_failed\"}");
                }
            } else {
                len = snprintf(tx_buf, sizeof(tx_buf),
                    "{\"cmd\":\"save_config_ack\",\"status\":\"error\",\"reason\":\"json_parse_failed\"}");
            }
            led_engine_trigger(LED_EVENT_SAVE_DONE);
            break;
        }

        // 🔥 v3.3: Factory Reset 前后显式喂狗 + USB 刷新
        case CMD_EVENT_FACTORY_RESET: {
            led_engine_trigger(LED_EVENT_FACTORY_RESET);

            // 🔥 v3.3: 格式化前安全刷新
            tud_task();
            watchdog_update();

            bool ok = config_manager_factory_reset(&g_runtime_config, sizeof(device_config_t));

            // 🔥 v3.3: 格式化后立即喂狗，防止连续擦除触发 WDT
            watchdog_update();
            tud_task();

            if (ok) {
                for (int i = 0; i < POT_COUNT; i++) {
                    signal_conditioner_init(&g_conditioners[i]);
                    signal_conditioner_set_calibration(&g_conditioners[i],
                        g_runtime_config.pots[i].cal_min, g_runtime_config.pots[i].cal_max);
                }
                len = snprintf(tx_buf, sizeof(tx_buf),
                    "{\"cmd\":\"factory_reset_ack\",\"status\":\"ok\"}");
            } else {
                len = snprintf(tx_buf, sizeof(tx_buf),
                    "{\"cmd\":\"factory_reset_ack\",\"status\":\"error\",\"reason\":\"flash_write_failed\"}");
            }
            break;
        }

        case CMD_EVENT_UPDATE_CALIBRATION: {
            uint8_t ch = event->data.calibration.ch_num;
            if (ch < POT_COUNT) {
                g_runtime_config.pots[ch].cal_min = event->data.calibration.min;
                g_runtime_config.pots[ch].cal_max = event->data.calibration.max;
                signal_conditioner_set_calibration(&g_conditioners[ch],
                    event->data.calibration.min, event->data.calibration.max);
            }
            len = snprintf(tx_buf, sizeof(tx_buf), "{\"cmd\":\"calibrate_ack\",\"status\":\"ok\"}");
            break;
        }

        case CMD_EVENT_SET_SIGNAL_STAGE: {
            uint8_t ch = event->data.signal_stage.ch_num;
            if (ch < POT_COUNT) {
                signal_conditioner_set_stage_params(&g_conditioners[ch],
                    event->data.signal_stage.stage,
                    event->data.signal_stage.enable,
                    event->data.signal_stage.param);
            }
            len = snprintf(tx_buf, sizeof(tx_buf), "{\"cmd\":\"set_signal_stage_ack\",\"status\":\"ok\"}");
            break;
        }

        case CMD_EVENT_TEST_CONFIG: {
            uint8_t ch = event->data.test_config.ch_num;
            if (ch < POT_COUNT) {
                g_runtime_config.pots[ch].channel = event->data.test_config.channel;
                g_runtime_config.pots[ch].cc      = event->data.test_config.cc;
            }
            len = snprintf(tx_buf, sizeof(tx_buf), "{\"cmd\":\"test_config_ack\",\"status\":\"ok\"}");
            break;
        }

        default: break;
    }

    if (len >= sizeof(tx_buf)) len = sizeof(tx_buf) - 1;
    if (len > 0) {
        // 🔥 v3.3: sysex_buf 扩容至 768
        uint8_t sysex_buf[768];
        size_t sysex_len = sysex_encode(sysex_buf, sizeof(sysex_buf),
                                        (const uint8_t*)tx_buf, len);
        midi_transport_send_sysex(sysex_buf, sysex_len);
    }
}
```

## 12. 已知可接受的妥协（Known Acceptable Limitations）

| # | 现象 | 触发概率 | 用户影响 | 应对 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 保存配置时旋钮短暂失灵 (~400ms) | 极低 | 无感知 | 不处理 | Flash 写入期间主循环暂停，内部安全喂狗 |
| 2 | 保存/恢复出厂后 PC 端可能短暂断开 USB | 中 | 需等待自动重连 | **上位机发送后等待 ≥1000ms 并自动重连** | 固件侧已 tud_task() 缓解，协议层兜底 |
| 3 | Flash 数据损坏导致配置丢失 | 接近零 | 需重新校准 | magic+version 不匹配时恢复默认值 + SysEx Log 上报 | 不做 CRC |
| 4 | USB 意外断连后需重新插拔 | 低 | 中断演奏数秒 | 用户自行重插 | TinyUSB 自动重枚举 |
| 5 | 极端快速转动旋钮时偶尔跳值 | 低 | 几乎无感 | 人手物理阻尼 | 不做复杂预测算法 |
| 6 | LED 刷新偶尔不流畅 | 低 | 几乎无感 | 主循环优先级高于 LED | 不支持复杂动画 |
| 7 | 🔥 Flash 极端擦除时间逼近 WDT 阈值 | 极低 | 偶发复位 | **量产压力测试**验证最大写入时间 <1000ms | 不做架构改动，用测试换保险 |

## 13. 模块化开发顺序与测试策略

### 批次 1：零依赖基础模块（可并行开发）

| 模块 | 开发指令重点 | 单测策略 |
| :--- | :--- | :--- |
| adc_sampler | 17 次读/丢首值/16 次平均，200Hz 调度 + 🔥 count=0 钳位 | PC Mock + 验证首值丢弃 + count=0 测试 |
| signal_conditioner | 5 级可开关链 + 各级边界钳位 + memset + 🔥 has_sent + 🔥 开启瞬间填充 | PC 序列验证：非法参数注入、除零测试、上电瞬态测试、🔥 首值 0 测试 |
| flash_store | LittleFS 挂载与文件读写 + CFG_WDT_SAFE_WRITE | 烧录验证 + WDT 超时压力测试 + 🔥 量产满容量写入压力测试 |
| ws2812_hal | Adafruit NeoPixel 初始化 + 🔥 **脏标记** | 烧录验证 + 🔥 GPIO 脉冲测量空闲时物理刷新耗时 |
| midi_transport | TinyUSB MIDI + `tud_midi_mounted()` 检查 | 烧录 + MIDI 监测 |

### 批次 2：依赖批次 1 的逻辑模块

| 模块 | 依赖 | 开发指令重点 | 单测策略 |
| :--- | :--- | :--- | :--- |
| config_manager | flash_store | Blob 存储 + Magic+Version 双重校验 + 🔥 **返回错误码** | PC Mock + 版本不匹配测试 |
| midi_dispatcher | midi_transport | MIDI 状态解析 + SysEx 边界 | PC Mock |
| led_engine | ws2812_hal | 主循环计数器驱动 | PC Mock |

### 批次 3：产品业务层

| 模块 | 依赖 | 开发指令重点 | 单测策略 |
| :--- | :--- | :--- | :--- |
| config_codec | device_config.h | ArduinoJson 双向转换 + Log Event 序列化 + 🔥 version 字段 | PC JSON 验证 |
| cmd_handler | 无 | 纯事件派发 + 🔥 endpoint_clamp 重命名适配 | PC JSON 验证 |
| main.ino | 所有模块 | 单核主循环 + WDT + 🔥 初始化顺序 + 🔥 JSON 静态拷贝 + 🔥 先 Flash 后 RAM + 🔥 Factory Reset WDT 防护 | 全量集成测试 + 🔥 掉电恢复测试 |

### 单模块开发 AI Prompt 模板

```markdown
## 任务：实现 [模块名]

### 上下文
本项目是 Lyre USB MIDI 控制器固件（RP2040 单核架构，v3.3 量产加固版）。
当前任务是实现 [模块名] 模块。不得引入除 [依赖模块] 之外的任何外部依赖。

### 接口定义
[贴入该模块的 .h 文件]

### 实现要求
1. 只输出 .c / .cpp 文件，不得修改 .h 接口。
2. [贴入该模块的具体规格说明]。
3. 所有公开函数须有 doxygen 注释。
4. 边界条件须防御性编程（空指针、越界、除零、整型溢出）。
5. 🚫 严禁使用任何多核同步原语（spinlock/mutex/queue_t/multicore_lockout）。
6. 🚫 严禁使用 __not_in_flash_func()（除非是 flash_store_write_file 及其直接调用的底层函数）。
7. 本项目为单核架构，所有代码在主循环中顺序执行。
8. 🔥 信号链：所有分母参数运算前非零+边界强钳位；init 必须 memset 清零 + filter_window_size=4 + has_sent=false + last_sent_midi=-1 + filter_first_frame=true。
9. 🔥 ADC 采样：adc_sampler_read(pin, count) 内部读取 count+1 次，丢弃第 1 次，后 count 次平均；count=0 钳位为 1。
10. 🔥 Flash 存储：CFG_WDT_SAFE_WRITE=1 时 write_file 内部每次块操作后 watchdog_update()。
11. 🔥 config_manager：init 返回错误码（CONFIG_ERR_*），不直接发送日志；校验 magic + version 双重条件。
12. 🔥 ws2812_hal：必须实现脏标记，颜色未变时 show() 直接 return。
13. 🔥 主循环：末尾必须包含 watchdog_update()。

### 验收标准
1. [功能验收项]
2. [边界条件测试项]
3. 🔥 [防御钳位/WDT/USB保活/过采样语义/初始化/has_sent/脏标记/掉电一致性/版本号 专项测试项]
```

## 附录 A：SysEx 编解码器接口摘要（已实现）

```c
size_t sysex_encode(uint8_t *out_buf, size_t out_cap,
                    const uint8_t *json_data, size_t json_len);

sysex_decoder_t dec;
sysex_decoder_init(&dec, SUB_ID, on_json_ready, NULL);
sysex_decoder_process(&dec, sysex_data, sysex_len);
```

## 附录 B：审计修正追溯表（全历史）

| 版本 | 审计问题 | 修正措施 | 影响模块 |
| :--- | :--- | :--- | :--- |
| v2.1→v2.2 | 6 模块耦合度高 | 重构为 10 模块乐高化设计 | 全局 |
| v2.2→v2.3 | 迟滞带基于 MIDI 值降维 | 改为基于 12-bit ADC 原始值 | signal_conditioner |
| v2.2→v2.3 | 端点豁免引发 MIDI 洪水 | 增加 `last_sent` 变动判定 | signal_conditioner |
| v2.2→v2.3 | 禁用 CDC 调试地狱 | `DEBUG_MODE` 条件编译 | main.ino |
| v2.2→v2.3 | 主循环 ADC 轰炸 | 1ms 非阻塞时间片 | main.ino |
| v2.2→v2.3 | `cmd_handler` 强耦合 | 事件回调机制 | cmd_handler, main.ino |
| v2.3→v2.4 | 整数截断与下溢 | 先乘后除 + Clamp + 除零防御 | signal_conditioner |
| v2.3→v2.4 | 端点保护死区 | 端点发送后同步更新基准 | signal_conditioner |
| v2.3→v2.4 | `resp_buf` 双向污染 | 纯化单向事件流 | cmd_handler |
| v2.3→v2.4 | `main.ino` 胶水层肥胖 | 新增 `config_codec` | config_codec |
| v2.3→v2.4 | 物理非线性死区 | 默认校准值 100~4000 | device_config.h |
| v2.4→v2.5 | 迟滞粘滞与突跳 | 两级解耦过滤法 | signal_conditioner |
| v2.4→v2.5 | 保存配置数据流断层 | 事件携带 `raw_json_ptr` | cmd_handler, main.ino |
| v2.4→v2.5 | XIP Stall 妥协 | 双核隔离架构 | main.ino |
| v2.5→v2.6 | `g_config` 读写竞争 | 硬件自旋锁保护 | core_bridge, main.ino |
| v2.5→v2.6 | TinyUSB 跨核越权 | USB 栈收拢 Core 0 + `queue_t` | core_bridge, main.ino |
| v2.5→v2.6 | 边界迟滞突跳 | 边界动态归零 | signal_conditioner |
| v2.5→v2.6 | Arduino 多核启动冲突 | `setup1()`/`loop1()` 规范 | main.ino |
| v2.6→v2.7 | 锁内 ADC 采样超时 | ADC 移至锁外 | main.ino |
| v2.6→v2.7 | Core 1 碰 ADC | `g_adc_raw_cache` 快照 | main.ino |
| v2.6→v2.7 | `g_conditioners` 越权 | 校准修改纳入自旋锁 | main.ino |
| v2.6→v2.7 | `tx_packet_t` 溢出 | 扩容至 512 字节 | core_bridge |
| v2.6→v2.7 | JSON 无 `\0` | 强制预留 + 封底 | main.ino |
| v2.7→v2.8 | 动态校准整型下溢 | `set_calibration` 强制钳位 | signal_conditioner |
| v2.7→v2.8 | 锁内 USB 发送死锁 | 锁内仅存局部变量，锁外发送 | main.ino |
| v2.7→v2.8 | 核间 API 命名错位 | 统一 `send_json_as_sysex_to_core0` | main.ino |
| v2.7→v2.8 | `snprintf` 返回值越界 | 防御性裁剪 | main.ino |
| v2.8→v2.9 | `multicore_lockout` 致 USB 掉线 | 废除 Lockout，回归 Spinlock + 精准 RAM 宏 | main.ino, 全局约束 |
| v2.8→v2.9 | `calibrate` 高频写 Flash | calibrate 仅改 RAM，save_config 才写 Flash | cmd_handler, 指令表 |
| v2.8→v2.9 | 映射算式极端边界下溢 | int32_t 中间量 + 防御钳位 | signal_conditioner |
| v2.9→v3.0 | 双核架构过度设计 | 废除双核，改为单核主循环 | 全局 |
| v2.9→v3.0 | 信号链不可调 | 改为 5 级可开关链 | signal_conditioner, device_config |
| v2.9→v3.0 | CRC 校验过度 | 废除 CRC，仅保留 Magic Number | config_manager |
| v2.9→v3.0 | USB 断连状态机过度 | 废除缓冲/状态机，仅保留 mounted 检查 | midi_transport |
| v2.9→v3.0 | LED 复杂调度过度 | 废除状态机/定时器，改为主循环计数器 | led_engine |
| v2.9→v3.0 | 缺少 KAL 清单 | 新增已知可接受妥协清单 | 文档结构 |
| v3.0→v3.1 | ADC 阻塞式过采样致时间片抖动 | 改为 200Hz 触发（5ms/次） | adc_sampler, main.ino |
| v3.0→v3.1 | signal_conditioner 除零/越界风险 | 所有分母参数强钳位 | signal_conditioner |
| v3.0→v3.1 | Flash 写入致 USB 主机端掉线 | 写入前后显式 tud_task() + 上位机重连容忍 | main.ino, KAL |
| v3.0→v3.1 | 缺乏看门狗兜底 | 新增硬件 WDT (2000ms) | main.ino |
| v3.0→v3.1 | 量产无可观测性 | 新增 SysEx Log Event 上报机制 | config_codec, cmd_handler |
| v3.1→v3.2 | Flash 写入期间可能触发 WDT 复位 | flash_store 内部 CFG_WDT_SAFE_WRITE 安全喂狗 | flash_store |
| v3.1→v3.2 | ADC 过采样次数描述与调用不一致 | 明确 read(pin,16) = 读17丢1平均16 | adc_sampler |
| v3.1→v3.2 | 信号链滤波缓冲区未初始化 | init 增加 memset + filter_window_size 默认值 4 | signal_conditioner |
| v3.1→v3.2 | USB 断连风险可进一步降低 | KAL/指令表明确上位机 save_config 后等待 ≥1000ms | KAL, 指令表 |
| **v3.2→v3.3** | **Factory Reset 触发 WDT 复位** | **factory_reset 前后显式 watchdog_update() + tud_task()** | **main.ino** |
| **v3.2→v3.3** | **信号链首值 0 丢失 + 开启瞬间 0 污染** | **has_sent 标志 + filter_first_frame 填充当前值** | **signal_conditioner** |
| **v3.2→v3.3** | **save_config 掉电一致性** | **先写 Flash 校验成功再提交 RAM** | **main.ino** |
| **v3.2→v3.3** | **启动错误上报初始化顺序陷阱** | **config_manager_init 返回错误码，MIDI 栈就绪后延后上报** | **config_manager, main.ino** |
| **v3.2→v3.3** | **Stage 2 死区语义错位** | **重命名为 endpoint_clamp / endpoint_margin** | **signal_conditioner, device_config** |
| **v3.2→v3.3** | **raw_json_ptr 悬空指针风险** | **on_json_ready 增加 g_json_safe 静态拷贝** | **main.ino** |
| **v3.2→v3.3** | **配置结构体缺少版本号** | **增加 uint16_t version + magic+version 双重校验** | **device_config, config_manager** |
| **v3.2→v3.3** | **WS2812 无脏标记致推杆抖动** | **ws2812_hal 实现 dirty flag，未变不刷新** | **ws2812_hal** |
| **v3.2→v3.3** | **JSON 缓冲区 256B 可能截断** | **tx_buf→512B, sysex_buf→768B** | **main.ino** |
| **v3.2→v3.3** | **adc_sampler_read count=0 无防御** | **入口钳位 count=0→1** | **adc_sampler** |
| **v3.2→v3.3** | **Flash XIP Stall 极端边界** | **不做代码改动，量产压力测试验证最大写入时间 <1000ms** | **KAL #7, 测试策略** |

---

**文档版本 v3.3 量产加固版 — 2026-07-11**
经过 12 轮架构审计迭代。v3.3 在 v3.2 基础上修复了 Factory Reset WDT 防护、信号链首值丢失/0 污染、save_config 掉电一致性、启动错误上报时序、Stage 2 语义重命名、JSON 悬空指针、配置版本号、WS2812 脏标记、缓冲区扩容、ADC count=0 防御共 10 项生产级补丁。本文档为自包含完整规格书，可直接交付 AI 程序员进行逐模块代码生成。
