# LED 管线详细设计文档 v1.2

**文档版本**：v1.2  
**对应架构**：《Lyre MK2 产品架构设计文档 v2.2》§5.5  
**管线目录**：`pipelines/led/`  
**市场契约**：`market/led_api.h`（已冻结，本文档不修改其接口签名）  
**变更说明**：基于 v1.1 审计报告闭环修订，修复 2 项中等缺陷，吸收 3 项低风险改进。

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
│  · 任意公开 API 首次调用时自动完成 HAL+CORE 初始化                 │
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
 * @param gpio       数据引脚编号（Lyre: 16）
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
 * @return 插值结果。t=0 精确返回 a，t=255 精确返回 b。
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
 * 替换 gamma 查找表。
 * CORE 内部拷贝 256 字节至静态缓冲区，调用者无需保证指针生命周期。
 * @param table  指向 256 字节数组的指针。传 NULL 恢复默认 gamma 2.2 表。
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
    LED_ANIM_PULSE,     // 脉冲：瞬间亮起 → 平方衰减至 0
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
            uint16_t period;         // 一个完整呼吸周期 (ms)，必须 ≥ 2
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
            uint16_t decay_duration;  // 从峰值衰减到 0 的时间 (ms)，必须 ≥ 1
        } pulse_params;
    };
} led_anim_params_t;


/* ═══════════════════════════════════════════════════════════
 * 第五部分：优先级层调度器
 * ═══════════════════════════════════════════════════════════ */

/**
 * 层 ID 定义。数值越大优先级越高。
 * CORE 层不硬编码层数量，由 APP 层通过 led_core_init() 指定。
 * 编译期上限：LED_CORE_MAX_LAYERS。
 */
typedef uint8_t led_layer_id_t;

#define LED_CORE_MAX_LAYERS  8   // 编译期上限，静态分配

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
 * @param num_layers     优先级层数量（必须 1 ≤ num_layers ≤ LED_CORE_MAX_LAYERS）
 * @param output_cb      输出回调：每帧求值完成后调用，将最终颜色送至 HAL。
 *                       签名：void (*)(led_color_t final_color)
 * @return true 成功；false 参数错误（num_layers 越界或 output_cb 为 NULL）
 *
 * @note output_cb 实现了 CORE→HAL 的依赖反转，CORE 不直接依赖 HAL。
 * @note 内部使用静态数组分配，无动态内存分配。
 * @note 调用此函数会重置内部时钟（time_ms = 0）及所有层状态。
 */
typedef void (*led_output_cb_t)(led_color_t color);
bool led_core_init(uint8_t num_layers, led_output_cb_t output_cb);

/**
 * 在指定层上启动一个动画。
 * @param layer_id    层索引（0 = 最低优先级）
 * @param params      动画参数
 * @param duration_ms 层的强制生命周期上限（毫秒）。
 *                    0 = 无上限，仅由动画自身逻辑决定终止。
 *                    >0 = 到期后无论动画自身状态如何，层强制转为 FINISHED。
 *
 * @note 若该层已有动画正在运行，立即被新动画替换（无过渡）。
 * @note 当 duration_ms 与动画自身终止条件（如 repeat_count）同时存在时，
 *       **先到者生效**。duration_ms 是层的强制生命周期上限。
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
 *   1. 检查所有层的 duration 到期 → 标记 FINISHED
 *   2. 从最高优先级层向下扫描，找到第一个 RUNNING 状态的层
 *   3. 计算该层动画在当前时刻的瞬时颜色
 *   4. 通过 output_cb 输出
 *   5. 若所有层均 IDLE/FINISHED，输出黑色
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
} led_layer_t;

static struct {
    led_layer_t     layers[LED_CORE_MAX_LAYERS];  // 静态分配，无 malloc
    uint8_t         num_layers;
    led_output_cb_t output_cb;
    uint32_t        time_ms;        // 累计时间（led_core_init 时重置为 0）
    uint8_t         gamma_buf[256]; // gamma 表内部拷贝缓冲区
    const uint8_t  *gamma_table;    // 指向 gamma_buf 或内置默认表
    bool            initialized;
} g_engine;
```

### 3.4 动画求值算法

> 所有算法使用纯整数运算，禁止浮点。时间变量 `t` 均指 `led_core_get_time_ms()`。

#### 3.4.1 STATIC

```
brightness(t) = params.static_params.brightness
```

#### 3.4.2 BLINK

```
// cycle_period 以 uint32_t 计算（C 语言整数提升保证 uint16_t + uint16_t → int/uint32_t）
uint32_t cycle_period = (uint32_t)on_duration + (uint32_t)off_duration

elapsed = t - start_time
phase = elapsed % cycle_period

if phase < on_duration:
    brightness = params.blink_params.brightness
else:
    brightness = 0

// 重复次数检查
completed_cycles = elapsed / cycle_period
if repeat_count > 0 && completed_cycles >= repeat_count:
    state → FINISHED
```

#### 3.4.3 BREATHE（2× 精度，消除奇数 period 截断）

```
elapsed = t - start_time
phase = elapsed % period

// 使用 2× 精度避免 period/2 整数截断
phase2 = phase * 2                    // 范围 [0, 2*(period-1)]

if phase2 < period:
    // 上升段：min → max
    // progress = phase2 / period，定点 0-256
    t_norm = (phase2 * 256) / period
    brightness = min + ((max - min) * t_norm) / 256
else:
    // 下降段：max → min
    t_norm = ((phase2 - period) * 256) / period
    brightness = max - ((max - min) * t_norm) / 256

if !infinite && elapsed >= period:
    state → FINISHED
```

**约束**：`period` 必须 ≥ 2（由 `led_core_layer_play()` 入口校验）。

#### 3.4.4 FADE

```
elapsed = t - start_time
if elapsed >= duration:
    brightness = to_brightness
    state → FINISHED
else:
    t_norm = (elapsed * 256) / duration     // 定点 0-255
    brightness = from + ((to - from) * t_norm) / 256
```

#### 3.4.5 PULSE（分步定点缩放，消除溢出）

```
elapsed = t - start_time
if elapsed >= decay_duration:
    brightness = 0
    state → FINISHED
else:
    remaining = decay_duration - elapsed

    // 第一步：计算归一化比率 ratio = remaining / decay_duration
    // 定点表示：ratio_norm ∈ [0, 256]，其中 256 = 1.0
    ratio_norm = (remaining * 256) / decay_duration    // uint32_t，最大 256

    // 第二步：平方衰减 brightness = peak × ratio²
    // ratio_norm² 最大 = 256² = 65536
    // peak × ratio_norm² 最大 = 255 × 65536 = 16,711,680 → 安全在 uint32_t 内
    brightness = (peak * ratio_norm * ratio_norm) >> 16
```

**溢出安全证明**：
- `ratio_norm` 最大值 = 256（`remaining == decay_duration` 时）
- `ratio_norm * ratio_norm` = 65536（`uint32_t` 安全）
- `peak * 65536` = 255 × 65536 = 16,711,680（`uint32_t` 安全）
- 右移 16 位后范围 [0, 255]

**约束**：`decay_duration` 必须 ≥ 1（由 `led_core_layer_play()` 入口校验）。

### 3.5 优先级调度算法

```
led_core_render():

    // ── 第一步：检查所有层的 duration 到期（先于输出）──
    for i = 0 to (num_layers - 1):
        if layers[i].state == RUNNING
           && layers[i].duration_ms > 0
           && (current_time - layers[i].start_time_ms) >= layers[i].duration_ms:
            layers[i].state = FINISHED

    // ── 第二步：从最高优先级层向下扫描，找到第一个 RUNNING 层 ──
    final_color = BLACK

    for i = (num_layers - 1) downto 0:
        if layers[i].state == RUNNING:
            brightness = evaluate_animation(layers[i], current_time)
            final_color = color_scale(layers[i].params.color, gamma(brightness))
            break   // 最高优先级的 RUNNING 层胜出

    // ── 第三步：输出 ──
    output_cb(final_color)
```

**关键行为**：
- 到期检查在输出之前执行，确保到期帧不会多输出一帧动画颜色。
- 高优先级层结束后（FINISHED），下一次 `led_core_render()` 自动穿透到下一个 RUNNING 层，实现"事件快闪结束后自动恢复呼吸"的语义，无需 APP 层编写恢复逻辑。

### 3.6 整数运算约束

CORE 层**禁止使用浮点运算**（Cortex-M0+ 无 FPU）。所有插值、衰减均使用定点整数实现：

```c
// 线性插值（0-255 范围，带四舍五入）
// t: 0-255，0=全a，255=全b
static inline uint8_t lerp_u8(uint8_t a, uint8_t b, uint8_t t) {
    // (a*(255-t) + b*t + 127) / 255
    // 分子最大 = 255*255 + 255*255 + 127 = 130,177 → uint32_t 安全
    uint32_t num = (uint32_t)a * (255 - t) + (uint32_t)b * t + 127;
    return (uint8_t)(num / 255);
}
```

**精度说明**：`t=0` 精确返回 `a`，`t=255` 精确返回 `b`。中间值误差 ≤ 1 LSB。

### 3.7 默认 Gamma 表

内置 gamma 2.2 的 256 字节查找表（编译期常量），公式：

```
table[i] = round(255 × (i / 255.0) ^ 2.2)
```

`led_core_set_gamma_table()` 将传入的 256 字节**拷贝**至 `g_engine.gamma_buf` 内部静态缓冲区。传 NULL 时恢复指向内置默认表。调用者无需保证传入指针的生命周期。

### 3.8 可复用性声明

| 项目 | 说明 |
|------|------|
| 零外部依赖 | 仅依赖 `<stdint.h>`、`<stdbool.h>`。不使用 `<string.h>`、`<stdlib.h>` |
| 无动态分配 | 层数组为静态分配（`LED_CORE_MAX_LAYERS`），无 `malloc/free` |
| 无硬件引用 | 通过 `led_output_cb_t` 回调输出，不引用任何 GPIO/PIO/寄存器 |
| 无产品语义 | 不包含任何颜色名称（如"黄色"）、事件名称（如"save"）|
| 跨平台验证 | 可在 PC 端用 stdout 作为 output_cb 进行单元测试 |

### 3.9 入口参数校验

`led_core_layer_play()` 在启动动画前执行以下校验：

| 校验项 | 条件 | 失败行为 |
|--------|------|----------|
| layer_id 范围 | `layer_id < num_layers` | DEBUG: assert 触发；RELEASE: 静默丢弃 |
| BREATHE period | `period >= 2` | DEBUG: assert 触发；RELEASE: 静默丢弃 |
| PULSE decay_duration | `decay_duration >= 1` | DEBUG: assert 触发；RELEASE: 静默丢弃 |
| BLINK cycle_period | `(uint32_t)on_duration + off_duration >= 1` | DEBUG: assert 触发；RELEASE: 静默丢弃 |

**DEBUG/RELEASE 行为说明**：

```c
// led_core.c 内部
#ifdef LED_CORE_DEBUG
  #include <assert.h>
  #define LED_CORE_ASSERT(cond) assert(cond)
#else
  #define LED_CORE_ASSERT(cond) ((void)0)
#endif

void led_core_layer_play(led_layer_id_t layer_id,
                         const led_anim_params_t *params,
                         uint32_t duration_ms) {
    LED_CORE_ASSERT(layer_id < g_engine.num_layers);
    if (layer_id >= g_engine.num_layers) return;

    // 类型特定校验
    switch (params->type) {
        case LED_ANIM_BREATHE:
            LED_CORE_ASSERT(params->breathe_params.period >= 2);
            if (params->breathe_params.period < 2) return;
            break;
        case LED_ANIM_PULSE:
            LED_CORE_ASSERT(params->pulse_params.decay_duration >= 1);
            if (params->pulse_params.decay_duration < 1) return;
            break;
        case LED_ANIM_BLINK:
            LED_CORE_ASSERT((uint32_t)params->blink_params.on_duration
                          + params->blink_params.off_duration >= 1);
            if ((uint32_t)params->blink_params.on_duration
              + params->blink_params.off_duration < 1) return;
            break;
        default:
            break;
    }

    // ... 正常启动逻辑 ...
}
```

**构建配置**：开发阶段在 CMakeLists.txt 中定义 `LED_CORE_DEBUG`；发布构建不定义，assert 被编译为空操作，零开销。

### 3.10 `led_core_init()` 重置语义

`led_core_init()` 执行以下完整重置：

```c
bool led_core_init(uint8_t num_layers, led_output_cb_t output_cb) {
    if (num_layers < 1 || num_layers > LED_CORE_MAX_LAYERS) return false;
    if (output_cb == NULL) return false;

    g_engine.num_layers = num_layers;
    g_engine.output_cb  = output_cb;
    g_engine.time_ms    = 0;           // 重置内部时钟
    g_engine.gamma_table = DEFAULT_GAMMA_TABLE;
    g_engine.initialized = true;

    // 重置所有层为 IDLE（手动循环，不依赖 string.h）
    for (uint8_t i = 0; i < LED_CORE_MAX_LAYERS; i++) {
        g_engine.layers[i].state = LED_LAYER_IDLE;
        g_engine.layers[i].start_time_ms = 0;
        g_engine.layers[i].duration_ms = 0;
    }

    return true;
}
```

**注意**：多次调用 `led_core_init()` 是安全的（幂等重置），主要服务于单元测试场景。

---

## 4. APP 层详细设计（`led_app.c / led_app.h`）

### 4.1 设计原则

> **APP 层极薄：只有定义，基本无实现。**

APP 层的职责仅限于：
1. **定义** Lyre 产品的色板常量
2. **定义** 亮度/时序参数
3. **定义** 层分配方案
4. **实现** `market/led_api.h` 中的函数（极薄胶水，翻译产品语义→CORE 调用）
5. **任意公开 API 首次调用时自动完成初始化**（解决架构文档 setup() 无 LED 初始化入口的约束）

### 4.2 层分配定义

```c
// led_app.c 内部定义（不对外暴露）

// Lyre 使用 2 个优先级层（数值越大优先级越高）
// 依据：架构文档 §4.5 将 pulse_activity 与 save/reset 事件
//       同归"事件快闪"最高优先级，因此共享同一层。
#define LYRE_LED_NUM_LAYERS     2

#define LAYER_BASE              0   // 基础层：呼吸 / 熄灭
#define LAYER_EVENT             1   // 事件层：所有事件（pulse、save、reset）
```

**设计理由**：架构文档 §4.5 定义的优先级为"事件快闪 > 呼吸"，其中 `pulse_activity`、`save_start/done`、`factory_reset_start/done` 均属于"事件快闪"类别。将它们放在同一层，后触发的事件自然覆盖前一个，语义正确且实现最简。

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
#define LYRE_PULSE_MIN_BRIGHTNESS     30    // 最低亮度下限（cc_value < 此值时使用此值）

// ─── 保存开始（黄色快闪）参数 ───
#define LYRE_SAVE_START_BLINK_ON_MS   100
#define LYRE_SAVE_START_BLINK_OFF_MS  100
#define LYRE_SAVE_START_BLINK_REPEAT  0     // 无限闪烁（受安全超时约束）
#define LYRE_SAVE_START_BRIGHTNESS    200
#define LYRE_SAVE_START_TIMEOUT_MS    30000 // 防御性安全超时（30s）

// ─── 保存完成（绿色长亮）参数 ───
#define LYRE_SAVE_DONE_BRIGHTNESS     200
#define LYRE_SAVE_DONE_DURATION_MS    2000  // 长亮 2 秒后自动回落

// ─── 出厂重置（红色快闪）参数 ───
#define LYRE_RESET_BLINK_ON_MS        80
#define LYRE_RESET_BLINK_OFF_MS       80
#define LYRE_RESET_BLINK_REPEAT       0
#define LYRE_RESET_BRIGHTNESS         220
#define LYRE_RESET_TIMEOUT_MS         30000 // 防御性安全超时（30s）

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

### 4.6 时间源封装

```c
// 薄封装：隔离平台时间 API，便于 PC 端测试时 mock
// 生产构建：直接调用 RP2040 SDK
// 测试构建：替换为可控时间源

#ifdef LED_APP_TEST
  // 单元测试时由测试框架提供
  extern uint32_t test_get_time_us(void);
  static inline uint32_t lyre_get_time_us(void) { return test_get_time_us(); }
#else
  #include "pico/time.h"
  static inline uint32_t lyre_get_time_us(void) { return time_us_32(); }
#endif
```

### 4.7 Market API 实现（极薄胶水）

```c
// led_app.c

#include "led_core.h"
#include "led_hal.h"
#include "market/led_api.h"
// pico/time.h 通过 §4.6 的 lyre_get_time_us() 间接引入

// ─── 内部状态 ───
static bool g_led_initialized = false;
static bool g_led_available   = false;

// ─── 输出回调：CORE → HAL 桥接 ───
static void lyre_led_output(led_color_t color) {
    led_hal_set_pixel(0, color.r, color.g, color.b);
    led_hal_show();
}

// ─── 内部初始化（首次任意 API 调用时自动执行） ───
static void led_app_ensure_init(void) {
    if (g_led_initialized) return;
    g_led_initialized = true;

    bool hal_ok  = led_hal_init(16, 1);  // GPIO16, 1 pixel
    bool core_ok = led_core_init(LYRE_LED_NUM_LAYERS, lyre_led_output);

    g_led_available = hal_ok && core_ok;

    if (g_led_available) {
        led_core_set_gamma_table(LYRE_GAMMA_TABLE);  // 内部拷贝，无生命周期问题
    }
}

// ─── led_api.h 接口实现 ───

void led_pulse_activity(uint8_t pot_index, uint8_t cc_value) {
    led_app_ensure_init();
    if (!g_led_available || pot_index >= POT_COUNT) return;

    // 亮度下限保护：cc_value=0 时仍保证可见反馈
    uint8_t brightness = (cc_value < LYRE_PULSE_MIN_BRIGHTNESS)
                       ? LYRE_PULSE_MIN_BRIGHTNESS
                       : cc_value;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_PULSE;
    p.color = LYRE_POT_COLORS[pot_index];
    p.pulse_params.peak_brightness = brightness;
    p.pulse_params.decay_duration  = LYRE_PULSE_DECAY_MS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_PULSE_DURATION_MS);
}

void led_set_breathing(bool enable) {
    led_app_ensure_init();
    if (!g_led_available) return;

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
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_YELLOW;
    p.blink_params.brightness   = LYRE_SAVE_START_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_SAVE_START_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_SAVE_START_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_SAVE_START_BLINK_REPEAT;

    // 防御性超时：即使 save_done 永远不被调用，30s 后自动回落
    led_core_layer_play(LAYER_EVENT, &p, LYRE_SAVE_START_TIMEOUT_MS);
}

void led_event_save_done(void) {
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_SAVE_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_SAVE_DONE_DURATION_MS);
}

void led_event_factory_reset_start(void) {
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_RED;
    p.blink_params.brightness   = LYRE_RESET_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_RESET_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_RESET_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_RESET_BLINK_REPEAT;

    // 防御性超时
    led_core_layer_play(LAYER_EVENT, &p, LYRE_RESET_TIMEOUT_MS);
}

void led_event_factory_reset_done(void) {
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p = {0};
    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_RESET_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_RESET_DONE_DURATION_MS);
}

void led_task(void) {
    led_app_ensure_init();
    if (!g_led_available) return;

    // 使用硬件定时器获取真实经过时间，避免动画节奏漂移
    static uint32_t last_us = 0;
    uint32_t now_us = lyre_get_time_us();
    uint32_t elapsed_ms = (now_us - last_us) / 1000;
    last_us = now_us;

    // 首次调用时 elapsed_ms 可能为极大值（last_us 初始为 0），钳位保护
    if (elapsed_ms > 1000) elapsed_ms = 10;

    led_core_tick(elapsed_ms);
    led_core_render();
}
```

### 4.8 APP 层代码量统计

| 内容 | 行数（约） |
|------|-----------|
| 色板 + 参数宏定义 | ~45 行 |
| 时间源封装 | ~10 行 |
| Market API 实现（7 个函数） | ~85 行 |
| 初始化 + 回调 + 守卫 | ~20 行 |
| **合计** | **~160 行** |

无条件分支逻辑（除初始化守卫和可用性检查外）、无状态机、无循环——纯定义 + 纯翻译。

### 4.9 初始化策略说明

| 约束 | 来源 | 本设计的应对 |
|------|------|-------------|
| `setup()` 仅含 `pot_init()` + `cmd_cfg_init()` | 架构文档 §6.4 | 不在 setup() 中调用 LED 初始化 |
| main 不可包含管线内部头文件 | 架构文档 §3 / §9 | `led_app_init()` 不对外暴露 |
| LED 管线必须被初始化 | 功能需求 | 任意公开 API 首次调用时通过 `static bool` 守卫自动完成 |
| 被动服务原则 | 架构文档 §5 | 所有 API 均由 main 被动调用，初始化是首次执行的副作用 |
| 步骤 [2]/[3] 可能先于 [4] 执行 | 架构文档 §6.1 | 每个 API 入口均调用 `led_app_ensure_init()`，无论哪个先被调用都能正确初始化 |

**首次调用时序保证**：

```
第一轮 loop():
  [1] pot_poll()
  [2] led_pulse_activity()  → led_app_ensure_init() → 初始化完成 → 正常执行
  [3] led_set_breathing()   → led_app_ensure_init() → 已初始化，跳过 → 正常执行
  [4] led_task()            → led_app_ensure_init() → 已初始化，跳过 → tick + render
```

无论步骤 [2]、[3]、[4] 中哪个最先被调用，初始化都会在该次调用中完成，后续调用直接跳过。不存在"首次调用被丢弃"的窗口。

---

## 5. 状态时序图

### 5.1 典型场景：USB 连接 → 推杆活动 → 配置保存

```
时间轴 ──────────────────────────────────────────────────────────────→

LAYER_EVENT (优先级1):  [IDLE]──[PULSE蓝 350ms]──[IDLE]──[BLINK黄]──[STATIC绿 2s]──[IDLE]
LAYER_BASE  (优先级0):  [IDLE]────────────[BREATHE白 无限]──────────────────────────────

最终输出:               黑 ─── 白呼吸 ─── 蓝脉冲 ─── 白呼吸 ─── 黄闪 ─── 绿亮 ─── 白呼吸
```

**自动回落机制**：
- PULSE 350ms 后 FINISHED → 穿透到 BREATHE
- STATIC 绿 2000ms 后 FINISHED → 穿透到 BREATHE
- 无需任何显式"恢复"调用

### 5.2 事件覆盖场景

```
场景：呼吸中 → save_start（黄闪）→ 推杆活动（脉冲覆盖黄闪）→ save_done（绿亮）

LAYER_EVENT:  [IDLE]──[BLINK黄 无限]──[PULSE蓝 350ms]──[IDLE]──[STATIC绿 2s]──[IDLE]
LAYER_BASE:   [BREATHE 无限]──────────────────────────────────────────────────────────

输出:         白呼吸 ── 黄闪 ── 蓝脉冲 ── 白呼吸 ── 绿亮 ── 白呼吸
```

**注意**：由于所有事件共享 LAYER_EVENT，`led_pulse_activity()` 会**替换**正在进行的黄闪。脉冲 350ms 结束后，黄闪不会自动恢复（因为已被替换），穿透到 BASE 层呼吸。这是"后到事件覆盖前一个"语义的自然结果。

如果产品要求"脉冲结束后恢复黄闪"，则需要将事件层拆分为两层。当前架构文档未提出此需求，2 层方案满足所有已定义场景。

### 5.3 防御性超时场景

```
场景：save_start 后状态机异常，save_done 永远不被调用

LAYER_EVENT:  [BLINK黄 无限]──────────────────────────────[30s 到期 → FINISHED]
LAYER_BASE:   [BREATHE 无限]──────────────────────────────────────────────────────

输出:         黄闪 ──────────────────────────────────── 白呼吸（自动恢复）
              |←────────── 30s 安全超时 ──────────────→|
```

用户看到黄闪 30 秒后自动恢复呼吸，可感知到"保存可能未成功"，设备不会永久卡在异常状态。

---

## 6. 与主循环的集成

```c
// main.c 中的调用方式（与架构文档 §6.1 一致）

void setup() {
    pot_init();
    cmd_cfg_init();
    // 注意：无 LED 初始化调用。LED 管线在首次任意 LED API 调用时自动初始化。
}

void loop() {
    // [1] pot_poll()
    // [2] MIDI 发送 + led_pulse_activity()   ← 若首次调用，此处完成初始化
    // [3] USB 连接检测 + led_set_breathing() ← 若 [2] 未触发，此处完成初始化
    // [4] led_task()                         ← 若 [2][3] 均未触发，此处完成初始化

    led_task();   // 内部：自动初始化 + 真实 elapsed + tick + render
}
```

**时序保证**：`led_task()` 执行耗时 < 50µs（纯整数运算 + 1 次 PIO 发送），对 ~10ms 主循环周期无实质影响。

---

## 7. 可测试性设计

### 7.1 CORE 层单元测试（PC 端）

```c
// test_led_core.c（在 PC 上编译运行，定义 LED_CORE_DEBUG）
#include "led_core.h"
#include <stdio.h>
#include <assert.h>

static led_color_t g_last_output;
static void mock_output(led_color_t c) { g_last_output = c; }

void test_breathe_reaches_peak() {
    led_core_init(1, mock_output);  // 重置 time_ms = 0

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

void test_pulse_no_overflow() {
    led_core_init(1, mock_output);  // 重置 time_ms = 0

    led_anim_params_t p = {0};
    p.type = LED_ANIM_PULSE;
    p.color = (led_color_t){255, 255, 255};
    p.pulse_params.peak_brightness = 255;
    p.pulse_params.decay_duration = 60000;  // 极端值，验证无溢出

    led_core_layer_play(0, &p, 0);

    led_core_tick(1);
    led_core_render();
    // 不应崩溃，brightness 应接近 255
    assert(g_last_output.r > 250);
}

void test_duration_expires_before_output() {
    led_core_init(2, mock_output);  // 重置 time_ms = 0

    // 低优先级层：呼吸
    led_anim_params_t base = {0};
    base.type = LED_ANIM_STATIC;
    base.color = (led_color_t){0, 255, 0};
    base.static_params.brightness = 100;
    led_core_layer_play(0, &base, 0);

    // 高优先级层：100ms 后到期
    led_anim_params_t evt = {0};
    evt.type = LED_ANIM_STATIC;
    evt.color = (led_color_t){255, 0, 0};
    evt.static_params.brightness = 200;
    led_core_layer_play(1, &evt, 100);

    // 推进 100ms → 高优先级层应已 FINISHED
    led_core_tick(100);
    led_core_render();

    // 应输出低优先级层的绿色，而非红色
    assert(g_last_output.g == led_core_gamma(100));
    assert(g_last_output.r == 0);
}

void test_breathe_odd_period_symmetry() {
    led_core_init(1, mock_output);  // 重置 time_ms = 0

    led_anim_params_t p = {0};
    p.type = LED_ANIM_BREATHE;
    p.color = (led_color_t){255, 0, 0};
    p.breathe_params.min_brightness = 0;
    p.breathe_params.max_brightness = 200;
    p.breathe_params.period = 3001;  // 奇数
    p.breathe_params.infinite = true;

    led_core_layer_play(0, &p, 0);

    // 上升段中点 vs 下降段中点应近似对称
    led_core_tick(750);   // 上升段 ~1/4 处
    led_core_render();
    uint8_t rising = g_last_output.r;

    led_core_tick(1501);  // 到 2251，下降段 ~1/4 处
    led_core_render();
    uint8_t falling = g_last_output.r;

    // 允许 ±2 LSB 误差（整数截断）
    assert(rising > 0 && falling > 0);
    int diff = (int)rising - (int)falling;
    assert(diff >= -2 && diff <= 2);
}

void test_init_resets_time() {
    // 第一次初始化并推进时间
    led_core_init(1, mock_output);
    led_core_tick(5000);
    assert(led_core_get_time_ms() == 5000);

    // 第二次初始化应重置时间
    led_core_init(1, mock_output);
    assert(led_core_get_time_ms() == 0);
}

void test_invalid_layer_asserts() {
    led_core_init(2, mock_output);

    // 以下调用在 DEBUG 构建中应触发 assert
    // 在 RELEASE 构建中应静默丢弃
    led_anim_params_t p = {0};
    p.type = LED_ANIM_STATIC;
    p.static_params.brightness = 100;

    led_core_layer_play(5, &p, 0);  // layer_id=5 >= num_layers=2
    // 不应崩溃（RELEASE 模式）
}
```

### 7.2 APP 层集成测试（PC 端）

```c
// test_led_app.c（定义 LED_APP_TEST，提供 mock 时间源）

static uint32_t g_mock_time_us = 0;
uint32_t test_get_time_us(void) { return g_mock_time_us; }

void test_first_api_call_initializes() {
    // 模拟：led_set_breathing 在 led_task 之前被调用
    g_mock_time_us = 1000000;  // 1s

    led_set_breathing(true);  // 应触发初始化并成功启动呼吸

    // 验证：BASE 层应为 RUNNING
    assert(led_core_layer_get_state(LAYER_BASE) == LED_LAYER_RUNNING);
}

void test_pulse_with_zero_cc() {
    led_app_ensure_init();  // 确保已初始化

    led_pulse_activity(0, 0);  // cc_value = 0

    // 验证：EVENT 层应为 RUNNING（亮度被钳位到 30，不是 0）
    assert(led_core_layer_get_state(LAYER_EVENT) == LED_LAYER_RUNNING);
}
```

---

## 8. 移植指南

将 LED CORE 层移植到新产品时，仅需：

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 1. 拷贝 `led_core.c/h` 到新项目 | 0 修改 | 零外部依赖，直接编译 |
| 2. 重写 `led_hal.c`（适配新硬件） | ~50 行 | 实现 `led_hal_init/set_pixel/show/clear` |
| 3. 重写 `led_app.c`（新色板 + 新参数 + 新 API 实现） | ~120 行 | 包含时间源适配（见下） |
| 4. 定义新的 `market/led_api.h`（按新产品需求） | 按需 | 冻结契约 |

**时间源适配**：APP 层通过 `lyre_get_time_us()` 获取微秒时间戳。移植时需替换为目标平台的等效实现：

| 平台 | 实现 |
|------|------|
| RP2040 | `time_us_32()`（Pico SDK） |
| STM32 | `HAL_GetTick() * 1000` 或 DWT 计数器 |
| ESP32 | `esp_timer_get_time()` |
| PC 测试 | mock 函数（`LED_APP_TEST` 宏） |

CORE 层代码**零修改**。

---

## 9. 文件清单

```
pipelines/led/
├── led_hal.h          // HAL 接口声明
├── led_hal.c          // RP2040 PIO WS2812 驱动实现
├── led_core.h         // CORE 接口声明（通用动画引擎）
├── led_core.c         // CORE 实现（颜色、亮度、时间、动画、调度）
├── led_app.h          // APP 内部头文件（仅声明 led_app_init，实际未对外使用）
└── led_app.c          // APP 实现（色板定义 + 参数定义 + API 胶水 + 自动初始化）

market/
└── led_api.h          // 冻结的市场契约（不在本管线目录内）
```

---

## 10. 设计决策记录

| ID | 决策 | 理由 |
|----|------|------|
| LED-DD-001 | CORE 通过函数指针回调输出，不直接调用 HAL | 实现依赖反转，CORE 可在 PC 端单元测试，零硬件依赖 |
| LED-DD-002 | 动画参数使用联合体而非多态 | C 语言无继承，联合体 + type 枚举是最简洁的零开销方案 |
| LED-DD-003 | PULSE 使用分步定点缩放（ratio_norm → 平方 → 移位） | M0+ 无 FPU；分步缩放保证 uint32_t 全范围安全，无需 uint64_t 除法 |
| LED-DD-004 | 层数量由 APP 层初始化时指定，CORE 不硬编码 | 不同产品可能需要不同层数；编译期上限 LED_CORE_MAX_LAYERS=8 防止越界 |
| LED-DD-005 | `led_task()` 使用硬件定时器获取真实 elapsed | 主循环周期为"~10ms"（约数），硬编码会导致动画节奏漂移；通过 `lyre_get_time_us()` 封装，便于测试 mock |
| LED-DD-006 | 所有事件（pulse、save、reset）共享同一最高优先级层（2 层方案） | 架构文档 §4.5 将 pulse_activity 与 save/reset 同归"事件快闪"最高优先级；后到事件自然覆盖前一个，语义正确且实现最简 |
| LED-DD-007 | Gamma 表由 CORE 内部拷贝（256 字节静态缓冲区） | 消除调用者对指针生命周期的负担；256 字节开销在 264KB SRAM 中可忽略 |
| LED-DD-008 | 无限闪烁动画设置 30s 防御性超时 | 防止状态机异常导致 LED 永久卡在闪烁状态；30s 远超正常操作时间，不影响正常流程 |
| LED-DD-009 | 任意公开 API 首次调用自动初始化（static bool 守卫） | 架构文档 §6.4 的 setup() 无 LED 初始化入口；步骤 [2]/[3] 可能先于 [4] 执行；每个 API 入口均调用 ensure_init 消除竞态窗口 |
| LED-DD-010 | 层数组使用静态分配（`LED_CORE_MAX_LAYERS`），无 malloc | 嵌入式系统应避免动态分配；Lyre 固定 2 层，8 层上限覆盖所有合理产品 |
| LED-DD-011 | `cc_value` 映射亮度时设置下限 30 | 推杆在端点位置（cc=0）时仍需可见活动反馈；活动反馈语义与推杆位置无关 |
| LED-DD-012 | `led_core_render()` 先检查到期再输出 | 避免到期帧多输出一帧动画颜色；确保有限时长动画精确结束 |
| LED-DD-013 | BREATHE 使用 2× 精度计算相位 | 消除奇数 period 的整数截断导致的波形不对称；CORE 作为通用引擎不能假设调用者总传偶数 |
| LED-DD-014 | 动画替换无过渡（瞬时切换） | 事件切换的瞬时性是产品语义的一部分（黄闪→绿亮 = "完成"）；预留 transition 参数属过度设计 |
| LED-DD-015 | BLINK 的 `repeat_count` 与 `duration_ms` 先到者生效 | 明确双重终止条件的交互语义；`duration_ms` 是层的强制生命周期上限 |
| LED-DD-016 | CORE 层不使用 `<string.h>`，初始化用手动循环 | 消除隐式依赖，保持头文件 include 列表与 §3.8 声明一致 |
| LED-DD-017 | `led_core_init()` 重置 `time_ms = 0` 及所有层状态 | 保证多次调用幂等；单元测试中连续用例互不干扰 |
| LED-DD-018 | DEBUG 构建下参数校验失败触发 assert，RELEASE 下静默丢弃 | 开发阶段快速定位错误；生产环境零开销、无崩溃风险 |
| LED-DD-019 | BLINK `cycle_period` 以 `uint32_t` 显式计算 | C 语言整数提升自然保证安全，但显式转换消除歧义，防止未来重构引入 uint16_t 存储 |
| LED-DD-020 | APP 层时间源通过 `lyre_get_time_us()` 薄封装 | 隔离平台 API 依赖；`LED_APP_TEST` 宏下可替换为 mock，支持 PC 端集成测试 |

---

## 附录 A：v1.1 → v1.2 变更摘要

| 章节 | 变更内容 | 对应审计 ID |
|------|----------|-------------|
| §0 | 新增 v1.1 缺陷闭环追踪表 | — |
| §3.2 | `led_core_init()` 文档补充"重置内部时钟"语义 | NEW-004 |
| §3.3 | 注释补充 `time_ms` 重置说明 | NEW-004 |
| §3.4.2 | `cycle_period` 显式标注 `uint32_t` 计算 | NEW-005 |
| §3.9 | 校验表增加"失败行为"列（DEBUG assert / RELEASE 静默）；BLINK 校验改为 `(uint32_t)` 显式转换；新增完整代码示例 | NEW-002, NEW-005 |
| §3.10（新增） | `led_core_init()` 完整重置逻辑代码 + 幂等性说明 | NEW-004 |
| §4.6（新增） | 时间源封装 `lyre_get_time_us()` + `LED_APP_TEST` 条件编译 | NEW-003 |
| §4.7 | 所有 7 个 API 函数入口增加 `led_app_ensure_init()` 调用；`led_task()` 改用 `lyre_get_time_us()` | NEW-001, NEW-003 |
| §4.9 | 初始化策略表新增"步骤 [2]/[3] 可能先于 [4]"行；新增首次调用时序保证示例 | NEW-001 |
| §7.1 | 新增 `test_init_resets_time`、`test_invalid_layer_asserts` | NEW-004, NEW-002 |
| §7.2（新增） | APP 层 PC 端集成测试示例（mock 时间源） | NEW-003 |
| §8 | 移植指南新增"时间源适配"表 | NEW-003 |
| §10 | 新增 LED-DD-017 ~ LED-DD-020 | NEW-001 ~ NEW-005 |
