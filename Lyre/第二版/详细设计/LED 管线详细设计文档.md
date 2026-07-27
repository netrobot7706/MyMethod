# LED 管线详细设计文档

**文档版本**：v1.0  
**对应架构**：《Lyre MK2 产品架构设计文档 v2.2》§5.5  
**管线目录**：`pipelines/led/`  
**市场契约**：`market/led_api.h`（已冻结，本文档不修改其接口签名）

---

## 1. 设计总览

### 1.1 设计目标

| 目标 | 说明 |
|------|------|
| CORE 层最大通用化 | 提供与产品无关的 LED 动画引擎，可在任何 WS2812/RGB LED 产品间直接拷贝复用 |
| APP 层极薄 | 仅包含 Lyre 产品的色板定义、亮度参数和事件→动画映射表，基本无逻辑实现 |
| 被动服务 | 管线不主动发起任何输出，所有状态推进由主循环调用 `led_task()` 驱动 |
| 优先级自动调度 | 高优先级动画结束后自动回落到基础层，无需调用者管理恢复逻辑 |

### 1.2 三层职责划分

```
┌─────────────────────────────────────────────────────────────────┐
│  market/led_api.h  （冻结契约，不可修改）                         │
├─────────────────────────────────────────────────────────────────┤
│  led_app.c  （APP 层）                                          │
│  · Lyre 色板常量定义                                             │
│  · 亮度曲线参数                                                  │
│  · 事件→动画参数映射表                                            │
│  · 实现 led_api.h 中所有函数（极薄胶水，翻译产品语义→CORE 调用）    │
├─────────────────────────────────────────────────────────────────┤
│  led_core.c  （CORE 层，零外部依赖，可跨产品复用）                 │
│  · 颜色模型与运算                                                │
│  · 亮度引擎（gamma 校正）                                        │
│  · 时间管理器（tick 驱动）                                       │
│  · 动画原语（static / blink / breathe / fade / pulse）           │
│  · 优先级层调度器                                                │
│  · 每帧求值 → 输出最终 RGB                                       │
├─────────────────────────────────────────────────────────────────┤
│  led_hal.c  （HAL 层，硬件相关）                                  │
│  · RP2040 PIO WS2812 驱动                                       │
│  · 提供 led_hal_set_pixel(r, g, b) 和 led_hal_show()            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 依赖方向

```
led_app.c ──→ led_core.h ──→ led_hal.h
   │                              │
   └──→ market/led_api.h          └──→ hardware (PIO, GPIO)
```

- `led_core.c` **不**包含 `led_hal.h`，CORE 通过函数指针回调输出最终颜色（依赖反转）。
- `led_app.c` 包含 `led_core.h` 和 `led_hal.h`，负责在初始化时将 HAL 输出函数注入 CORE。

---

## 2. HAL 层详细设计（`led_hal.c / led_hal.h`）

### 2.1 职责

将 CORE 层计算出的最终 RGB 值通过 RP2040 PIO 状态机发送至 WS2812 像素。

### 2.2 接口定义

```c
// led_hal.h
#ifndef LED_HAL_H
#define LED_HAL_H

#include <stdint.h>
#include <stdbool.h>

/**
 * 初始化 WS2812 PIO 驱动。
 * @param gpio      数据引脚编号（Lyre: 16）
 * @param num_pixels 像素数量（Lyre: 1）
 * @return true 成功；false PIO 资源不可用
 */
bool led_hal_init(uint8_t gpio, uint16_t num_pixels);

/**
 * 设置指定像素的 GRB 原始值（直接写入帧缓冲，不立即发送）。
 * @param index 像素索引（0-based）
 * @param r, g, b 各通道 0-255
 */
void led_hal_set_pixel(uint16_t index, uint8_t r, uint8_t g, uint8_t b);

/**
 * 将帧缓冲一次性发送至 WS2812 链。
 * 阻塞时间 = num_pixels × 30µs（1 像素 ≈ 30µs，可忽略）。
 */
void led_hal_show(void);

/**
 * 关闭所有像素并发送（硬件级熄灭，用于低功耗场景）。
 */
void led_hal_clear(void);

#endif // LED_HAL_H
```

### 2.3 实现要点

| 项目 | 说明 |
|------|------|
| PIO 程序 | 使用 RP2040 官方 `ws2812.pio`，时钟分频至 800kHz 数据速率 |
| 帧缓冲 | 内部维护 `uint8_t framebuffer[num_pixels * 3]`（GRB 顺序） |
| 时序 | `led_hal_show()` 通过 PIO DMA 或 PIO FIFO 写入，阻塞 < 50µs（1 像素） |
| 电源安全 | 上电默认调用 `led_hal_clear()` 确保 LED 熄灭 |

### 2.4 移植性

更换硬件平台时仅需重写本文件。CORE 和 APP 层完全不感知底层驱动实现。

---

## 3. CORE 层详细设计（`led_core.c / led_core.h`）

### 3.1 设计哲学

CORE 层是一个**通用 LED 动画引擎**，提供以下正交的基本能力：

| 基本能力 | 说明 |
|----------|------|
| **颜色** | RGB 颜色模型、颜色混合 |
| **亮度** | 0–255 亮度标量、gamma 校正曲线 |
| **时间** | tick 驱动的时间推进、持续时间管理 |
| **动画原语** | 基于上述三要素组合出的基本动画模式 |
| **优先级调度** | 多层叠加，高优先级覆盖低优先级，自动回落 |

### 3.2 头文件完整定义

```c
// led_core.h
#ifndef LED_CORE_H
#define LED_CORE_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ═══════════════════════════════════════════════════════════
 * 第一部分：颜色模型
 * ═══════════════════════════════════════════════════════════ */

typedef struct {
    uint8_t r;
    uint8_t g;
    uint8_t b;
} led_color_t;

#define LED_COLOR_BLACK   ((led_color_t){  0,   0,   0})
#define LED_COLOR_WHITE   ((led_color_t){255, 255, 255})

/**
 * 将颜色按亮度标量缩放。
 * @param color      输入颜色
 * @param brightness 亮度 0-255（0=全黑，255=原色）
 * @return 缩放后的颜色
 */
led_color_t led_color_scale(led_color_t color, uint8_t brightness);

/**
 * 线性插值混合两个颜色。
 * @param a, b  端点颜色
 * @param t     插值因子 0-255（0=全a，255=全b）
 */
led_color_t led_color_lerp(led_color_t a, led_color_t b, uint8_t t);


/* ═══════════════════════════════════════════════════════════
 * 第二部分：亮度引擎
 * ═══════════════════════════════════════════════════════════ */

/**
 * Gamma 校正：将线性亮度 [0-255] 映射为感知均匀的 PWM 值。
 * 默认 gamma = 2.2，使用 256 字节查找表实现（O(1)）。
 * APP 层可通过 led_core_set_gamma_table() 替换为产品专属曲线。
 */
uint8_t led_core_gamma(uint8_t linear_brightness);

/**
 * 替换 gamma 查找表（256 字节）。
 * @param table  指向 256 字节数组的指针（生命周期由调用者保证）
 *               传 NULL 恢复默认 gamma 2.2 表。
 */
void led_core_set_gamma_table(const uint8_t *table);


/* ═══════════════════════════════════════════════════════════
 * 第三部分：时间管理器
 * ═══════════════════════════════════════════════════════════ */

/**
 * 推进内部时钟。必须由外部周期性调用（通常每轮主循环一次）。
 * @param elapsed_ms  距上次调用的实际经过时间（毫秒）
 */
void led_core_tick(uint32_t elapsed_ms);

/**
 * 获取内部累计时间（毫秒），用于动画相位计算。
 */
uint32_t led_core_get_time_ms(void);


/* ═══════════════════════════════════════════════════════════
 * 第四部分：动画原语（Animation Primitives）
 * ═══════════════════════════════════════════════════════════ */

/**
 * 动画类型枚举。
 * 每种类型代表一种"亮度随时间变化"的基本模式。
 */
typedef enum {
    LED_ANIM_STATIC,    // 恒定输出，不随时间变化
    LED_ANIM_BLINK,     // 方波闪烁：on_duration 亮 + off_duration 灭，可重复
    LED_ANIM_BREATHE,   // 三角波呼吸：在 min_brightness ↔ max_brightness 间线性往返
    LED_ANIM_FADE,      // 单次渐变：从 from_brightness 到 to_brightness，持续 duration
    LED_ANIM_PULSE,     // 脉冲：瞬间亮起 → 指数衰减至 0
} led_anim_type_t;

/**
 * 动画参数（联合体，按 type 选择有效字段）。
 * 所有时间单位：毫秒。所有亮度范围：0-255（线性，gamma 由引擎统一施加）。
 */
typedef struct {
    led_anim_type_t type;
    led_color_t     color;          // 动画颜色（所有类型共用）

    union {
        // LED_ANIM_STATIC
        struct {
            uint8_t brightness;     // 恒定亮度
        } static_params;

        // LED_ANIM_BLINK
        struct {
            uint8_t  brightness;    // 亮态亮度
            uint16_t on_duration;   // 亮持续时间 (ms)
            uint16_t off_duration;  // 灭持续时间 (ms)
            uint16_t repeat_count;  // 重复次数（0 = 无限）
        } blink_params;

        // LED_ANIM_BREATHE
        struct {
            uint8_t  min_brightness; // 呼吸谷值
            uint8_t  max_brightness; // 呼吸峰值
            uint16_t period;         // 一个完整呼吸周期 (ms)
            bool     infinite;       // true = 持续呼吸；false = 单次后停止
        } breathe_params;

        // LED_ANIM_FADE
        struct {
            uint8_t  from_brightness;
            uint8_t  to_brightness;
            uint16_t duration;       // 渐变持续时间 (ms)
        } fade_params;

        // LED_ANIM_PULSE
        struct {
            uint8_t  peak_brightness; // 脉冲峰值亮度
            uint16_t decay_duration;  // 从峰值衰减到 0 的时间 (ms)
        } pulse_params;
    };
} led_anim_params_t;


/* ═══════════════════════════════════════════════════════════
 * 第五部分：优先级层调度器
 * ═══════════════════════════════════════════════════════════ */

/**
 * 层 ID 定义。数值越大优先级越高。
 * CORE 层不硬编码层数量，由 APP 层通过 led_core_init() 指定。
 */
typedef uint8_t led_layer_id_t;

/**
 * 层状态。
 */
typedef enum {
    LED_LAYER_IDLE,       // 空闲，无动画
    LED_LAYER_RUNNING,    // 动画运行中
    LED_LAYER_FINISHED,   // 有限次动画已播完（自动视为 IDLE 参与调度）
} led_layer_state_t;

/**
 * 初始化 LED CORE 引擎。
 * @param num_layers     优先级层数量（Lyre: 3）
 * @param output_cb      输出回调：每帧求值完成后调用，将最终颜色送至 HAL。
 *                       签名：void (*)(led_color_t final_color)
 * @return true 成功；false 参数错误
 *
 * @note output_cb 实现了 CORE→HAL 的依赖反转，CORE 不直接依赖 HAL。
 */
typedef void (*led_output_cb_t)(led_color_t color);
bool led_core_init(uint8_t num_layers, led_output_cb_t output_cb);

/**
 * 在指定层上启动一个动画。
 * @param layer_id   层索引（0 = 最低优先级）
 * @param params     动画参数
 * @param duration_ms 动画总持续时间（0 = 无限，直到被显式停止或更高优先级覆盖后自然结束）
 *
 * @note 若该层已有动画正在运行，立即被新动画替换（无过渡）。
 */
void led_core_layer_play(led_layer_id_t layer_id,
                         const led_anim_params_t *params,
                         uint32_t duration_ms);

/**
 * 停止指定层的动画，层回到 IDLE。
 */
void led_core_layer_stop(led_layer_id_t layer_id);

/**
 * 查询指定层当前状态。
 */
led_layer_state_t led_core_layer_get_state(led_layer_id_t layer_id);

/**
 * 每帧求值 + 输出。由外部在 led_core_tick() 之后调用。
 * 内部逻辑：
 *   1. 从最高优先级层向下扫描，找到第一个 RUNNING 状态的层
 *   2. 计算该层动画在当前时刻的瞬时颜色
 *   3. 通过 output_cb 输出
 *   4. 若所有层均 IDLE/FINISHED，输出黑色
 */
void led_core_render(void);

#ifdef __cplusplus
}
#endif

#endif // LED_CORE_H
```

### 3.3 内部数据结构

```c
// led_core.c 内部（不对外暴露）

typedef struct {
    led_anim_params_t   params;         // 当前动画参数
    led_layer_state_t   state;          // 层状态
    uint32_t            start_time_ms;  // 动画启动时的 led_core_get_time_ms() 快照
    uint32_t            duration_ms;    // 总持续时间（0=无限）
    uint16_t            blink_cycle;    // blink 已完成的完整周期计数
} led_layer_t;

static struct {
    led_layer_t    *layers;         // 动态分配的层数组
    uint8_t         num_layers;
    led_output_cb_t output_cb;
    uint32_t        time_ms;        // 累计时间
    const uint8_t  *gamma_table;    // 当前 gamma 表指针
} g_engine;
```

### 3.4 动画求值算法

#### 3.4.1 STATIC

```
brightness(t) = params.static_params.brightness
```

#### 3.4.2 BLINK

```
cycle_period = on_duration + off_duration
phase = (t - start_time) % cycle_period

if phase < on_duration:
    brightness = params.blink_params.brightness
else:
    brightness = 0

// 重复次数检查
completed_cycles = (t - start_time) / cycle_period
if repeat_count > 0 && completed_cycles >= repeat_count:
    state → FINISHED
```

#### 3.4.3 BREATHE

```
half_period = period / 2
phase = (t - start_time) % period

if phase < half_period:
    // 上升段：min → max
    progress = phase / half_period          // 0.0 ~ 1.0
    brightness = min + (max - min) * progress
else:
    // 下降段：max → min
    progress = (phase - half_period) / half_period
    brightness = max - (max - min) * progress

if !infinite && (t - start_time) >= period:
    state → FINISHED
```

#### 3.4.4 FADE

```
elapsed = t - start_time
if elapsed >= duration:
    brightness = to_brightness
    state → FINISHED
else:
    progress = elapsed / duration           // 0.0 ~ 1.0
    brightness = from + (to - from) * progress
```

#### 3.4.5 PULSE

```
elapsed = t - start_time
if elapsed >= decay_duration:
    brightness = 0
    state → FINISHED
else:
    // 指数衰减：brightness = peak × (1 - elapsed/decay)^2
    // 使用平方衰减近似指数，避免浮点运算
    remaining = (decay_duration - elapsed)
    brightness = peak × (remaining × remaining) / (decay_duration × decay_duration)
```

### 3.5 优先级调度算法

```
led_core_render():
    final_color = BLACK

    // 从最高优先级层向最低扫描
    for i = (num_layers - 1) downto 0:
        if layers[i].state == RUNNING:
            brightness = evaluate_animation(layers[i], current_time)
            final_color = color_scale(layers[i].params.color, gamma(brightness))
            break   // 最高优先级的 RUNNING 层胜出

    // 检查持续时间到期
    for i = 0 to (num_layers - 1):
        if layers[i].state == RUNNING
           && layers[i].duration_ms > 0
           && (current_time - layers[i].start_time_ms) >= layers[i].duration_ms:
            layers[i].state = FINISHED

    output_cb(final_color)
```

**关键行为**：高优先级层结束后（FINISHED），下一次 `led_core_render()` 自动穿透到下一个 RUNNING 层，实现"事件快闪结束后自动恢复呼吸"的语义，无需 APP 层编写恢复逻辑。

### 3.6 整数运算约束

CORE 层**禁止使用浮点运算**（Cortex-M0+ 无 FPU）。所有插值、衰减均使用定点整数实现：

```c
// 示例：线性插值（0-255 范围）
static inline uint8_t lerp_u8(uint8_t a, uint8_t b, uint16_t t_norm) {
    // t_norm: 0-256 表示 0.0-1.0
    return (uint8_t)(((uint16_t)a * (256 - t_norm) + (uint16_t)b * t_norm) >> 8);
}
```

### 3.7 默认 Gamma 表

内置 gamma 2.2 的 256 字节查找表（编译期常量），公式：

```
table[i] = round(255 × (i / 255.0) ^ 2.2)
```

APP 层可替换为产品专属曲线（如 WS2812 低亮度段补偿）。

### 3.8 可复用性声明

| 项目 | 说明 |
|------|------|
| 零外部依赖 | 仅依赖 `<stdint.h>`、`<stdbool.h>`、`<string.h>` |
| 无硬件引用 | 通过 `led_output_cb_t` 回调输出，不引用任何 GPIO/PIO/寄存器 |
| 无产品语义 | 不包含任何颜色名称（如"黄色"）、事件名称（如"save"）|
| 跨平台验证 | 可在 PC 端用 stdout 作为 output_cb 进行单元测试 |

---

## 4. APP 层详细设计（`led_app.c / led_app.h`）

### 4.1 设计原则

> **APP 层极薄：只有定义，基本无实现。**

APP 层的职责仅限于：
1. **定义** Lyre 产品的色板常量
2. **定义** 亮度/时序参数
3. **定义** 层分配方案
4. **实现** `market/led_api.h` 中的函数（每个函数体 ≤ 5 行，纯翻译调用）

### 4.2 层分配定义

```c
// led_app.c 内部定义（不对外暴露）

// Lyre 使用 3 个优先级层（数值越大优先级越高）
#define LYRE_LED_NUM_LAYERS     3

#define LAYER_BASE              0   // 基础层：呼吸 / 熄灭
#define LAYER_ACTIVITY          1   // 活动层：推杆操作脉冲
#define LAYER_EVENT             2   // 事件层：save/reset 等状态事件
```

### 4.3 色板定义

```c
// Lyre 产品色板（APP 层唯一定义颜色的位置）
static const led_color_t LYRE_COLOR_RED    = {255,   0,   0};
static const led_color_t LYRE_COLOR_GREEN  = {  0, 255,   0};
static const led_color_t LYRE_COLOR_YELLOW = {255, 180,   0};
static const led_color_t LYRE_COLOR_BLUE   = {  0,  80, 255};
static const led_color_t LYRE_COLOR_CYAN   = {  0, 200, 255};
static const led_color_t LYRE_COLOR_PURPLE = {160,   0, 255};
static const led_color_t LYRE_COLOR_ORANGE = {255, 100,   0};
static const led_color_t LYRE_COLOR_WHITE  = {255, 255, 255};

// 推杆索引 → 颜色映射表
static const led_color_t LYRE_POT_COLORS[POT_COUNT] = {
    LYRE_COLOR_BLUE,    // Pot 0
    LYRE_COLOR_CYAN,    // Pot 1
    LYRE_COLOR_PURPLE,  // Pot 2
    LYRE_COLOR_ORANGE,  // Pot 3
};
```

### 4.4 动画参数定义

```c
// ─── 呼吸模式参数 ───
#define LYRE_BREATHE_MIN_BRIGHTNESS   10    // 呼吸谷值（线性）
#define LYRE_BREATHE_MAX_BRIGHTNESS   80    // 呼吸峰值（线性）
#define LYRE_BREATHE_PERIOD_MS        3000  // 一个完整呼吸周期

// ─── 推杆活动脉冲参数 ───
#define LYRE_PULSE_DECAY_MS           300   // 脉冲衰减时间
#define LYRE_PULSE_DURATION_MS        350   // 层总持续时间（略大于衰减）

// ─── 保存开始（黄色快闪）参数 ───
#define LYRE_SAVE_START_BLINK_ON_MS   100
#define LYRE_SAVE_START_BLINK_OFF_MS  100
#define LYRE_SAVE_START_BLINK_REPEAT  0     // 无限闪烁，直到被 save_done 覆盖
#define LYRE_SAVE_START_BRIGHTNESS    200

// ─── 保存完成（绿色长亮）参数 ───
#define LYRE_SAVE_DONE_BRIGHTNESS     200
#define LYRE_SAVE_DONE_DURATION_MS    2000  // 长亮 2 秒后自动回落

// ─── 出厂重置（红色快闪）参数 ───
#define LYRE_RESET_BLINK_ON_MS        80
#define LYRE_RESET_BLINK_OFF_MS       80
#define LYRE_RESET_BLINK_REPEAT       0
#define LYRE_RESET_BRIGHTNESS         220

// ─── 出厂重置完成（绿色长亮）参数 ───
#define LYRE_RESET_DONE_BRIGHTNESS    200
#define LYRE_RESET_DONE_DURATION_MS   2000
```

### 4.5 亮度曲线（可选覆盖）

```c
// Lyre 使用 WS2812 低亮度补偿曲线（可选）
// 若不需要特殊曲线，传 NULL 使用 CORE 默认 gamma 2.2
static const uint8_t LYRE_GAMMA_TABLE[256] = {
    // 由离线工具生成，针对 WS2812B 实测亮度响应补偿
    // 此处省略 256 字节具体数值，开发时填入
    ...
};
```

### 4.6 Market API 实现（极薄胶水）

```c
// led_app.c

#include "led_core.h"
#include "led_hal.h"
#include "market/led_api.h"

// ─── 输出回调：CORE → HAL 桥接 ───
static void lyre_led_output(led_color_t color) {
    led_hal_set_pixel(0, color.r, color.g, color.b);
    led_hal_show();
}

// ─── 初始化（由 main setup() 调用，不在 led_api.h 中，内部使用） ───
void led_app_init(void) {
    led_hal_init(16, 1);  // GPIO16, 1 pixel
    led_core_init(LYRE_LED_NUM_LAYERS, lyre_led_output);
    led_core_set_gamma_table(LYRE_GAMMA_TABLE);  // 或 NULL
}

// ─── led_api.h 接口实现 ───

void led_pulse_activity(uint8_t pot_index, uint8_t cc_value) {
    if (pot_index >= POT_COUNT) return;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_PULSE;
    p.color = LYRE_POT_COLORS[pot_index];
    p.pulse_params.peak_brightness = cc_value;  // cc_value 直接映射为亮度
    p.pulse_params.decay_duration  = LYRE_PULSE_DECAY_MS;

    led_core_layer_play(LAYER_ACTIVITY, &p, LYRE_PULSE_DURATION_MS);
}

void led_set_breathing(bool enable) {
    if (enable) {
        led_anim_params_t p = {0};
        p.type  = LED_ANIM_BREATHE;
        p.color = LYRE_COLOR_WHITE;
        p.breathe_params.min_brightness = LYRE_BREATHE_MIN_BRIGHTNESS;
        p.breathe_params.max_brightness = LYRE_BREATHE_MAX_BRIGHTNESS;
        p.breathe_params.period         = LYRE_BREATHE_PERIOD_MS;
        p.breathe_params.infinite       = true;

        led_core_layer_play(LAYER_BASE, &p, 0);  // 无限持续
    } else {
        led_core_layer_stop(LAYER_BASE);  // 停止 → 输出黑色
    }
}

void led_event_save_start(void) {
    led_anim_params_t p = {0};
    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_YELLOW;
    p.blink_params.brightness   = LYRE_SAVE_START_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_SAVE_START_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_SAVE_START_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_SAVE_START_BLINK_REPEAT;

    led_core_layer_play(LAYER_EVENT, &p, 0);  // 无限，直到被覆盖
}

void led_event_save_done(void) {
    led_anim_params_t p = {0};
    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_SAVE_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_SAVE_DONE_DURATION_MS);
}

void led_event_factory_reset_start(void) {
    led_anim_params_t p = {0};
    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_RED;
    p.blink_params.brightness   = LYRE_RESET_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_RESET_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_RESET_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_RESET_BLINK_REPEAT;

    led_core_layer_play(LAYER_EVENT, &p, 0);
}

void led_event_factory_reset_done(void) {
    led_anim_params_t p = {0};
    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_RESET_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_RESET_DONE_DURATION_MS);
}

void led_task(void) {
    led_core_tick(10);   // 主循环周期 ≈ 10ms
    led_core_render();
}
```

### 4.7 APP 层代码量统计

| 内容 | 行数（约） |
|------|-----------|
| 色板 + 参数宏定义 | ~40 行 |
| Market API 实现（7 个函数） | ~70 行 |
| 初始化 + 回调 | ~10 行 |
| **合计** | **~120 行** |

无任何条件分支逻辑、无状态机、无循环——纯定义 + 纯翻译。

---

## 5. 状态时序图

### 5.1 典型场景：USB 连接 → 推杆活动 → 配置保存

```
时间轴 ──────────────────────────────────────────────────────────────→

LAYER_EVENT (优先级2):   [IDLE]────────────────────────────────[BLINK黄]──[STATIC绿 2s]──[IDLE]
LAYER_ACTIVITY(优先级1): [IDLE]──[PULSE蓝]──[IDLE]──[PULSE青]──[IDLE]──────────────────────────
LAYER_BASE (优先级0):    [IDLE]────────────[BREATHE白 无限]─────────────────────────────────────

最终输出:                黑 ─── 白呼吸 ─── 蓝脉冲 ─── 白呼吸 ─── 青脉冲 ─── 黄闪 ─── 绿亮 ─── 白呼吸
```

**自动回落机制**：
- PULSE 350ms 后 FINISHED → 穿透到 BREATHE
- STATIC绿 2000ms 后 FINISHED → 穿透到 BREATHE
- 无需任何显式"恢复"调用

### 5.2 优先级抢占场景

```
场景：呼吸中 → save_start（黄闪）→ 推杆活动（脉冲）→ save_done（绿亮）

LAYER_EVENT:    [IDLE]──────[BLINK黄 无限]────────────────[STATIC绿 2s]──[IDLE]
LAYER_ACTIVITY: [IDLE]──────────────────[PULSE 350ms]──────────────────────────
LAYER_BASE:     [BREATHE 无限]──────────────────────────────────────────────────

输出:           白呼吸 ─── 黄闪 ─── 黄闪 ─── 蓝脉冲(覆盖黄闪) ─── 黄闪 ─── 绿亮 ─── 白呼吸
                                         ↑
                              推杆脉冲优先级(1) < 事件(2)?
                              不对——LAYER_ACTIVITY=1 < LAYER_EVENT=2
                              所以黄闪期间推杆脉冲被遮蔽！
```

**设计决策**：根据架构文档优先级定义"事件快闪 > 呼吸"，`pulse_activity` 也属于"事件快闪"类别。因此需要调整层分配：

```c
// 修正：pulse_activity 与 save/reset 事件同属最高优先级层
// 但 pulse 持续时间极短（350ms），不会长期遮蔽事件
// 方案：将 ACTIVITY 和 EVENT 合并为同一层，后触发者覆盖先触发者

#define LYRE_LED_NUM_LAYERS     2
#define LAYER_BASE              0   // 呼吸 / 熄灭
#define LAYER_EVENT             1   // 所有事件（pulse、save、reset）
```

修正后时序：

```
LAYER_EVENT:  [IDLE]──[PULSE蓝 350ms]──[IDLE]──[BLINK黄]──[STATIC绿 2s]──[IDLE]
LAYER_BASE:   [BREATHE 无限]──────────────────────────────────────────────────

输出:         白呼吸 ── 蓝脉冲 ── 白呼吸 ── 黄闪 ── 绿亮 ── 白呼吸
```

这符合架构文档的语义：所有事件快闪共享最高优先级，后到事件自然覆盖前一个。

---

## 6. 与主循环的集成

```c
// main.c 中的调用方式（与架构文档 §6.1 一致）

void setup() {
    // ...
    led_app_init();   // 内部完成 HAL + CORE 初始化
}

void loop() {
    // [1] pot_poll()
    // [2] MIDI 发送 + led_pulse_activity()
    // [3] USB 连接检测 + led_set_breathing()
    // [4] led_task()          ← 驱动 CORE 时间推进 + 渲染输出

    led_task();   // 内部：led_core_tick(10) + led_core_render()
}
```

**时序保证**：`led_task()` 执行耗时 < 50µs（纯整数运算 + 1 次 PIO 发送），对 10ms 主循环周期无实质影响。

---

## 7. 可测试性设计

### 7.1 CORE 层单元测试（PC 端）

```c
// test_led_core.c（在 PC 上编译运行）
#include "led_core.h"
#include <stdio.h>

static led_color_t g_last_output;
static void mock_output(led_color_t c) { g_last_output = c; }

void test_breathe_reaches_peak() {
    led_core_init(1, mock_output);

    led_anim_params_t p = {0};
    p.type = LED_ANIM_BREATHE;
    p.color = (led_color_t){255, 0, 0};
    p.breathe_params.min_brightness = 0;
    p.breathe_params.max_brightness = 255;
    p.breathe_params.period = 1000;
    p.breathe_params.infinite = true;

    led_core_layer_play(0, &p, 0);

    // 推进到半周期（峰值点）
    led_core_tick(500);
    led_core_render();

    assert(g_last_output.r == led_core_gamma(255));  // 峰值
    assert(g_last_output.g == 0);
}
```

### 7.2 APP 层验证

APP 层逻辑极简，通过集成测试验证：
- 调用 `led_event_save_start()` 后，`led_core_layer_get_state(LAYER_EVENT) == RUNNING`
- 推进 2100ms 后，`led_event_save_done()` 的 STATIC 动画自动 FINISHED
- 最终输出回落到 BASE 层呼吸

---

## 8. 移植指南

将 LED CORE 层移植到新产品时，仅需：

| 步骤 | 工作量 |
|------|--------|
| 1. 拷贝 `led_core.c/h` 到新项目 | 0 修改 |
| 2. 重写 `led_hal.c`（适配新硬件） | ~50 行 |
| 3. 重写 `led_app.c`（新色板 + 新参数 + 新 API 实现） | ~100 行 |
| 4. 定义新的 `market/led_api.h`（按新产品需求） | 按需 |

CORE 层代码**零修改**。

---

## 9. 文件清单

```
pipelines/led/
├── led_hal.h          // HAL 接口声明
├── led_hal.c          // RP2040 PIO WS2812 驱动实现
├── led_core.h         // CORE 接口声明（通用动画引擎）
├── led_core.c         // CORE 实现（颜色、亮度、时间、动画、调度）
├── led_app.h          // APP 内部头文件（仅声明 led_app_init）
└── led_app.c          // APP 实现（色板定义 + 参数定义 + API 胶水）

market/
└── led_api.h          // 冻结的市场契约（不在本管线目录内）
```

---

## 10. 设计决策记录

| ID | 决策 | 理由 |
|----|------|------|
| LED-DD-001 | CORE 通过函数指针回调输出，不直接调用 HAL | 实现依赖反转，CORE 可在 PC 端单元测试，零硬件依赖 |
| LED-DD-002 | 动画参数使用联合体而非多态 | C 语言无继承，联合体 + type 枚举是最简洁的零开销方案 |
| LED-DD-003 | PULSE 使用平方衰减而非真指数 | M0+ 无 FPU，平方衰减视觉效果接近指数，纯整数可实现 |
| LED-DD-004 | 层数量由 APP 层初始化时指定，CORE 不硬编码 | 不同产品可能需要不同层数（如 8 像素灯带可能需要 per-pixel 层） |
| LED-DD-005 | `led_task()` 内部硬编码 tick=10ms | 与架构文档主循环周期一致；若未来需要精确时间，可改为传入 `elapsed_ms` 参数 |
| LED-DD-006 | 所有事件共享同一最高优先级层 | 架构文档定义事件快闪为同一优先级；后到事件自然覆盖前一个，语义正确且实现最简 |
| LED-DD-007 | Gamma 表可替换 | 不同 LED 型号（WS2812B vs SK6812）亮度响应不同，产品级校准不应侵入 CORE |
