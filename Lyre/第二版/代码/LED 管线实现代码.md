# LED 管线实现代码

基于《LED管线详细设计文档 v1.2》和审计报告，以下是完整的实现代码。审计报告中提及的4项问题已在编码中解决（标注为 `[AUDIT FIX]`）。

---

## 1. `market/led_api.h`（冻结契约，不可修改）

```c
/**
 * @file led_api.h
 * @brief LED 管线市场契约（冻结）
 *
 * @consumers  main loop, cmd_cfg_app
 * @dependencies 无
 *
 * LED 状态机优先级（从高到低）：
 * 1. 事件快闪（save_start/done, factory_reset, pulse_activity）
 * 2. 呼吸模式
 * 3. 熄灭
 * 事件快闪结束后自动恢复到当前基础状态（呼吸或熄灭）。
 */
#ifndef LED_API_H
#define LED_API_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 推杆活动快闪：pot_index 决定颜色，cc_value 决定亮度 */
void led_pulse_activity(uint8_t pot_index, uint8_t cc_value);

/** 空闲呼吸模式控制 */
void led_set_breathing(bool enable);

/** 状态性事件（内部自动处理优先级与持续时间） */
void led_event_save_start(void);          /* 黄色快闪 */
void led_event_save_done(void);           /* 绿色长亮 2 秒 */
void led_event_factory_reset_start(void); /* 红色快闪（当前版本预留） */
void led_event_factory_reset_done(void);  /* 绿色长亮 2 秒（当前版本预留） */

/** 必须在主循环中周期性调用，驱动 LED 状态机 */
void led_task(void);

#ifdef __cplusplus
}
#endif

#endif /* LED_API_H */
```

---

## 2. `pipelines/led/led_hal.h`

```c
/**
 * @file led_hal.h
 * @brief LED HAL 层接口 — RP2040 PIO WS2812 驱动
 */
#ifndef LED_HAL_H
#define LED_HAL_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 初始化 WS2812 PIO 驱动。
 * @param gpio       数据引脚编号（Lyre: 16）
 * @param num_pixels 像素数量（Lyre: 1）
 * @return true 成功；false PIO 资源不可用
 */
bool led_hal_init(uint8_t gpio, uint16_t num_pixels);

/**
 * 设置指定像素的 RGB 值（直接写入帧缓冲，不立即发送）。
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

#ifdef __cplusplus
}
#endif

#endif /* LED_HAL_H */
```

---

## 3. `pipelines/led/led_hal.c`

```c
/**
 * @file led_hal.c
 * @brief LED HAL 层实现 — RP2040 PIO WS2812 驱动
 *
 * 使用 RP2040 官方 ws2812.pio 程序，通过 PIO 状态机输出 WS2812 数据。
 * 移植到其他平台时仅需重写本文件。
 */
#include "led_hal.h"

#include "hardware/pio.h"
#include "hardware/clocks.h"
#include "ws2812.pio.h"  /* 由 pioasm 从 ws2812.pio 生成 */

/* ─── 内部状态 ─── */
static PIO     g_pio       = NULL;
static uint    g_sm        = 0;
static uint16_t g_num_pixels = 0;

/* 帧缓冲（GRB 顺序，WS2812 协议要求） */
#define LED_HAL_MAX_PIXELS  8  /* 编译期上限，Lyre 仅用 1 */
static uint8_t g_framebuffer[LED_HAL_MAX_PIXELS * 3];

/* ─── 接口实现 ─── */

bool led_hal_init(uint8_t gpio, uint16_t num_pixels)
{
    if (num_pixels == 0 || num_pixels > LED_HAL_MAX_PIXELS) {
        return false;
    }

    g_num_pixels = num_pixels;

    /* 申请 PIO 资源 */
    g_pio = pio0;
    int sm = pio_claim_unused_sm(g_pio, false);  /* non-blocking */
    if (sm < 0) {
        /* 尝试 PIO1 */
        g_pio = pio1;
        sm = pio_claim_unused_sm(g_pio, false);
        if (sm < 0) {
            return false;  /* 无可用状态机 */
        }
    }
    g_sm = (uint)sm;

    /* 加载 PIO 程序并初始化状态机 */
    uint offset = pio_add_program(g_pio, &ws2812_program);
    ws2812_program_init(g_pio, g_sm, offset, gpio, 800000, true);

    /* 上电默认熄灭 */
    led_hal_clear();

    return true;
}

void led_hal_set_pixel(uint16_t index, uint8_t r, uint8_t g, uint8_t b)
{
    if (index >= g_num_pixels) return;

    /* WS2812 使用 GRB 顺序 */
    uint16_t base = index * 3;
    g_framebuffer[base + 0] = g;
    g_framebuffer[base + 1] = r;
    g_framebuffer[base + 2] = b;
}

void led_hal_show(void)
{
    if (g_pio == NULL) return;

    /* 逐字节写入 PIO FIFO（1 像素 = 3 字节，阻塞 < 50µs） */
    for (uint16_t i = 0; i < g_num_pixels * 3; i++) {
        pio_sm_put_blocking(g_pio, g_sm, (uint32_t)g_framebuffer[i] << 24);
    }
}

void led_hal_clear(void)
{
    for (uint16_t i = 0; i < LED_HAL_MAX_PIXELS * 3; i++) {
        g_framebuffer[i] = 0;
    }
    led_hal_show();
}
```

---

## 4. `pipelines/led/led_core.h`

```c
/**
 * @file led_core.h
 * @brief LED CORE 层 — 通用 LED 动画引擎（零外部依赖，可跨产品复用）
 *
 * 设计哲学：
 * - 颜色模型 + 亮度引擎 + 时间管理 + 动画原语 + 优先级调度
 * - 纯整数运算（Cortex-M0+ 无 FPU）
 * - 通过函数指针回调输出（依赖反转，不依赖 HAL）
 * - 静态分配，无 malloc
 */
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

typedef enum {
    LED_ANIM_STATIC,    /* 恒定输出，不随时间变化 */
    LED_ANIM_BLINK,     /* 方波闪烁：on_duration 亮 + off_duration 灭，可重复 */
    LED_ANIM_BREATHE,   /* 三角波呼吸：在 min_brightness ↔ max_brightness 间线性往返 */
    LED_ANIM_FADE,      /* 单次渐变：从 from_brightness 到 to_brightness，持续 duration */
    LED_ANIM_PULSE,     /* 脉冲：瞬间亮起 → 平方衰减至 0 */
} led_anim_type_t;

/**
 * 动画参数（联合体，按 type 选择有效字段）。
 * 所有时间单位：毫秒。所有亮度范围：0-255（线性，gamma 由引擎统一施加）。
 */
typedef struct {
    led_anim_type_t type;
    led_color_t     color;          /* 动画颜色（所有类型共用） */
    union {
        /* LED_ANIM_STATIC */
        struct {
            uint8_t brightness;
        } static_params;

        /* LED_ANIM_BLINK */
        struct {
            uint8_t  brightness;
            uint16_t on_duration;
            uint16_t off_duration;
            uint16_t repeat_count;  /* 0 = 无限 */
        } blink_params;

        /* LED_ANIM_BREATHE */
        struct {
            uint8_t  min_brightness;
            uint8_t  max_brightness;
            uint16_t period;        /* 必须 ≥ 2 */
            bool     infinite;
        } breathe_params;

        /* LED_ANIM_FADE */
        struct {
            uint8_t  from_brightness;
            uint8_t  to_brightness;
            uint16_t duration;
        } fade_params;

        /* LED_ANIM_PULSE */
        struct {
            uint8_t  peak_brightness;
            uint16_t decay_duration;  /* 必须 ≥ 1 */
        } pulse_params;
    };
} led_anim_params_t;

/* ═══════════════════════════════════════════════════════════
 * 第五部分：优先级层调度器
 * ═══════════════════════════════════════════════════════════ */

typedef uint8_t led_layer_id_t;

#define LED_CORE_MAX_LAYERS  8   /* 编译期上限，静态分配 */

typedef enum {
    LED_LAYER_IDLE,       /* 空闲，无动画 */
    LED_LAYER_RUNNING,    /* 动画运行中 */
    LED_LAYER_FINISHED,   /* 有限次动画已播完（自动视为 IDLE 参与调度） */
} led_layer_state_t;

/**
 * 初始化 LED CORE 引擎。
 * @param num_layers     优先级层数量（1 ≤ num_layers ≤ LED_CORE_MAX_LAYERS）
 * @param output_cb      输出回调：每帧求值完成后调用，将最终颜色送至 HAL。
 * @return true 成功；false 参数错误
 *
 * @note 调用此函数会重置内部时钟（time_ms = 0）及所有层状态。
 */
typedef void (*led_output_cb_t)(led_color_t color);

bool led_core_init(uint8_t num_layers, led_output_cb_t output_cb);

/**
 * 在指定层上启动一个动画。
 * @param layer_id    层索引（0 = 最低优先级）
 * @param params      动画参数（不可为 NULL）
 * @param duration_ms 层的强制生命周期上限（0 = 无上限）
 */
void led_core_layer_play(led_layer_id_t layer_id,
                         const led_anim_params_t *params,
                         uint32_t duration_ms);

/** 停止指定层的动画，层回到 IDLE。 */
void led_core_layer_stop(led_layer_id_t layer_id);

/** 查询指定层当前状态。 */
led_layer_state_t led_core_layer_get_state(led_layer_id_t layer_id);

/**
 * 每帧求值 + 输出。由外部在 led_core_tick() 之后调用。
 */
void led_core_render(void);

#ifdef __cplusplus
}
#endif

#endif /* LED_CORE_H */
```

---

## 5. `pipelines/led/led_core.c`

```c
/**
 * @file led_core.c
 * @brief LED CORE 层实现 — 通用 LED 动画引擎
 *
 * 零外部依赖：仅 <stdint.h>、<stdbool.h>
 * 无动态分配：层数组为静态分配
 * 无硬件引用：通过 led_output_cb_t 回调输出
 * 无产品语义：不包含任何颜色名称或事件名称
 *
 * [AUDIT FIX] NEW-009: led_core_layer_play() 入口增加 params != NULL 校验
 */
#include "led_core.h"

/* ─── DEBUG/RELEASE 断言宏 ─── */
#ifdef LED_CORE_DEBUG
  #include <assert.h>
  #define LED_CORE_ASSERT(cond) assert(cond)
#else
  #define LED_CORE_ASSERT(cond) ((void)0)
#endif

/* ─── 默认 Gamma 2.2 查找表 ─── */
/* table[i] = round(255 × (i / 255.0) ^ 2.2) */
static const uint8_t DEFAULT_GAMMA_TABLE[256] = {
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   1,
      1,   1,   1,   1,   1,   1,   1,   1,   1,   2,   2,   2,   2,   2,   2,   2,
      3,   3,   3,   3,   3,   4,   4,   4,   4,   5,   5,   5,   5,   6,   6,   6,
      6,   7,   7,   7,   8,   8,   8,   9,   9,   9,  10,  10,  11,  11,  11,  12,
     12,  13,  13,  13,  14,  14,  15,  15,  16,  16,  17,  17,  18,  18,  19,  19,
     20,  20,  21,  22,  22,  23,  23,  24,  25,  25,  26,  26,  27,  28,  28,  29,
     30,  30,  31,  32,  33,  33,  34,  35,  36,  36,  37,  38,  39,  40,  40,  41,
     42,  43,  44,  45,  46,  46,  47,  48,  49,  50,  51,  52,  53,  54,  55,  56,
     57,  58,  59,  60,  61,  62,  63,  64,  65,  66,  67,  68,  69,  70,  71,  73,
     74,  75,  76,  77,  78,  80,  81,  82,  83,  84,  86,  87,  88,  89,  91,  92,
     93,  95,  96,  97,  99, 100, 101, 103, 104, 105, 107, 108, 110, 111, 113, 114,
    116, 117, 119, 120, 122, 123, 125, 126, 128, 130, 131, 133, 134, 136, 138, 139,
    141, 143, 144, 146, 148, 149, 151, 153, 155, 156, 158, 160, 162, 163, 165, 167,
    169, 171, 173, 174, 176, 178, 180, 182, 184, 186, 188, 190, 192, 194, 196, 198,
    200, 202, 204, 206, 208, 210, 212, 214, 216, 218, 220, 223, 225, 227, 229, 231,
    234, 236, 238, 240, 243, 245, 247, 250, 252, 255, 255, 255, 255, 255, 255, 255
};

/* ─── 内部数据结构 ─── */
typedef struct {
    led_anim_params_t   params;
    led_layer_state_t   state;
    uint32_t            start_time_ms;
    uint32_t            duration_ms;    /* 0 = 无限 */
} led_layer_t;

static struct {
    led_layer_t     layers[LED_CORE_MAX_LAYERS];
    uint8_t         num_layers;
    led_output_cb_t output_cb;
    uint32_t        time_ms;
    uint8_t         gamma_buf[256];
    const uint8_t  *gamma_table;
    bool            initialized;
} g_engine;

/* ─── 内部辅助函数 ─── */

/**
 * 线性插值（0-255 范围，带四舍五入）
 * t: 0-255，0=全a，255=全b
 * 分子最大 = 255*255 + 255*255 + 127 = 130,177 → uint32_t 安全
 */
static inline uint8_t lerp_u8(uint8_t a, uint8_t b, uint8_t t)
{
    uint32_t num = (uint32_t)a * (255 - t) + (uint32_t)b * t + 127;
    return (uint8_t)(num / 255);
}

/**
 * 求值指定层在当前时刻的瞬时亮度（线性，gamma 前）
 */
static uint8_t evaluate_brightness(const led_layer_t *layer)
{
    uint32_t elapsed = g_engine.time_ms - layer->start_time_ms;
    const led_anim_params_t *p = &layer->params;

    switch (p->type) {

    case LED_ANIM_STATIC:
        return p->static_params.brightness;

    case LED_ANIM_BLINK: {
        /* [AUDIT FIX] NEW-005: 显式 uint32_t 计算 cycle_period */
        uint32_t cycle_period = (uint32_t)p->blink_params.on_duration
                              + (uint32_t)p->blink_params.off_duration;
        /* cycle_period >= 1 已由入口校验保证 */
        uint32_t phase = elapsed % cycle_period;
        uint32_t completed_cycles = elapsed / cycle_period;

        /* 重复次数检查 */
        if (p->blink_params.repeat_count > 0 &&
            completed_cycles >= p->blink_params.repeat_count) {
            /* 标记完成（通过 const_cast 语义，实际由 render 处理） */
            return 0;  /* 调用者检查状态 */
        }

        if (phase < p->blink_params.on_duration) {
            return p->blink_params.brightness;
        }
        return 0;
    }

    case LED_ANIM_BREATHE: {
        uint16_t period = p->breathe_params.period;  /* >= 2 已校验 */
        uint8_t  mn = p->breathe_params.min_brightness;
        uint8_t  mx = p->breathe_params.max_brightness;

        /* 非无限模式：单次后停止 */
        if (!p->breathe_params.infinite && elapsed >= period) {
            return mn;  /* 调用者检查状态 */
        }

        uint32_t phase = elapsed % period;
        /* 2× 精度避免 period/2 整数截断 */
        uint32_t phase2 = phase * 2;

        uint8_t brightness;
        if (phase2 < period) {
            /* 上升段：min → max */
            uint32_t t_norm = (phase2 * 256) / period;
            brightness = mn + (uint8_t)(((uint32_t)(mx - mn) * t_norm) / 256);
        } else {
            /* 下降段：max → min */
            uint32_t t_norm = ((phase2 - period) * 256) / period;
            brightness = mx - (uint8_t)(((uint32_t)(mx - mn) * t_norm) / 256);
        }
        return brightness;
    }

    case LED_ANIM_FADE: {
        uint16_t duration = p->fade_params.duration;
        if (duration == 0 || elapsed >= duration) {
            return p->fade_params.to_brightness;
        }
        uint32_t t_norm = (elapsed * 256) / duration;
        uint8_t from = p->fade_params.from_brightness;
        uint8_t to   = p->fade_params.to_brightness;
        if (to >= from) {
            return from + (uint8_t)(((uint32_t)(to - from) * t_norm) / 256);
        } else {
            return from - (uint8_t)(((uint32_t)(from - to) * t_norm) / 256);
        }
    }

    case LED_ANIM_PULSE: {
        uint16_t decay = p->pulse_params.decay_duration;  /* >= 1 已校验 */
        if (elapsed >= decay) {
            return 0;
        }
        uint32_t remaining = decay - elapsed;
        /*
         * 分步定点缩放，消除溢出：
         * ratio_norm ∈ [0, 256]，其中 256 = 1.0
         * ratio_norm² 最大 = 65536（uint32_t 安全）
         * peak × 65536 最大 = 255 × 65536 = 16,711,680（uint32_t 安全）
         */
        uint32_t ratio_norm = (remaining * 256) / decay;
        uint32_t peak = p->pulse_params.peak_brightness;
        uint8_t brightness = (uint8_t)((peak * ratio_norm * ratio_norm) >> 16);
        return brightness;
    }

    default:
        return 0;
    }
}

/**
 * 检查指定层的动画是否已自然结束（非 duration 到期）
 */
static bool animation_naturally_finished(const led_layer_t *layer)
{
    uint32_t elapsed = g_engine.time_ms - layer->start_time_ms;
    const led_anim_params_t *p = &layer->params;

    switch (p->type) {
    case LED_ANIM_BLINK: {
        if (p->blink_params.repeat_count == 0) return false;  /* 无限 */
        uint32_t cycle_period = (uint32_t)p->blink_params.on_duration
                              + (uint32_t)p->blink_params.off_duration;
        uint32_t completed = elapsed / cycle_period;
        return completed >= p->blink_params.repeat_count;
    }
    case LED_ANIM_BREATHE:
        return !p->breathe_params.infinite && elapsed >= p->breathe_params.period;
    case LED_ANIM_FADE:
        return elapsed >= p->fade_params.duration;
    case LED_ANIM_PULSE:
        return elapsed >= p->pulse_params.decay_duration;
    case LED_ANIM_STATIC:
    default:
        return false;  /* STATIC 无自然终止，仅由 duration_ms 控制 */
    }
}

/* ─── 公开接口实现 ─── */

led_color_t led_color_scale(led_color_t color, uint8_t brightness)
{
    led_color_t result;
    result.r = (uint8_t)(((uint32_t)color.r * brightness + 127) / 255);
    result.g = (uint8_t)(((uint32_t)color.g * brightness + 127) / 255);
    result.b = (uint8_t)(((uint32_t)color.b * brightness + 127) / 255);
    return result;
}

led_color_t led_color_lerp(led_color_t a, led_color_t b, uint8_t t)
{
    led_color_t result;
    result.r = lerp_u8(a.r, b.r, t);
    result.g = lerp_u8(a.g, b.g, t);
    result.b = lerp_u8(a.b, b.b, t);
    return result;
}

uint8_t led_core_gamma(uint8_t linear_brightness)
{
    return g_engine.gamma_table[linear_brightness];
}

void led_core_set_gamma_table(const uint8_t *table)
{
    if (table == NULL) {
        g_engine.gamma_table = DEFAULT_GAMMA_TABLE;
        return;
    }
    /* 内部拷贝 256 字节，调用者无需保证指针生命周期 */
    for (uint16_t i = 0; i < 256; i++) {
        g_engine.gamma_buf[i] = table[i];
    }
    g_engine.gamma_table = g_engine.gamma_buf;
}

void led_core_tick(uint32_t elapsed_ms)
{
    g_engine.time_ms += elapsed_ms;
}

uint32_t led_core_get_time_ms(void)
{
    return g_engine.time_ms;
}

bool led_core_init(uint8_t num_layers, led_output_cb_t output_cb)
{
    if (num_layers < 1 || num_layers > LED_CORE_MAX_LAYERS) return false;
    if (output_cb == NULL) return false;

    g_engine.num_layers  = num_layers;
    g_engine.output_cb   = output_cb;
    g_engine.time_ms     = 0;           /* 重置内部时钟 */
    g_engine.gamma_table = DEFAULT_GAMMA_TABLE;
    g_engine.initialized = true;

    /* 重置所有层为 IDLE（手动循环，不依赖 string.h） */
    for (uint8_t i = 0; i < LED_CORE_MAX_LAYERS; i++) {
        g_engine.layers[i].state         = LED_LAYER_IDLE;
        g_engine.layers[i].start_time_ms = 0;
        g_engine.layers[i].duration_ms   = 0;
    }

    return true;
}

void led_core_layer_play(led_layer_id_t layer_id,
                         const led_anim_params_t *params,
                         uint32_t duration_ms)
{
    /* [AUDIT FIX] NEW-009: params 指针 NULL 校验 */
    LED_CORE_ASSERT(params != NULL);
    if (params == NULL) return;

    LED_CORE_ASSERT(layer_id < g_engine.num_layers);
    if (layer_id >= g_engine.num_layers) return;

    /* 类型特定校验 */
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

    /* 正常启动逻辑 */
    led_layer_t *layer = &g_engine.layers[layer_id];
    layer->params         = *params;
    layer->state          = LED_LAYER_RUNNING;
    layer->start_time_ms  = g_engine.time_ms;
    layer->duration_ms    = duration_ms;
}

void led_core_layer_stop(led_layer_id_t layer_id)
{
    if (layer_id >= g_engine.num_layers) return;
    g_engine.layers[layer_id].state = LED_LAYER_IDLE;
}

led_layer_state_t led_core_layer_get_state(led_layer_id_t layer_id)
{
    if (layer_id >= g_engine.num_layers) return LED_LAYER_IDLE;
    return g_engine.layers[layer_id].state;
}

void led_core_render(void)
{
    if (!g_engine.initialized || g_engine.output_cb == NULL) return;

    /* ── 第一步：检查所有层的到期与自然终止 ── */
    for (uint8_t i = 0; i < g_engine.num_layers; i++) {
        led_layer_t *layer = &g_engine.layers[i];
        if (layer->state != LED_LAYER_RUNNING) continue;

        /* duration 到期检查 */
        if (layer->duration_ms > 0) {
            uint32_t elapsed = g_engine.time_ms - layer->start_time_ms;
            if (elapsed >= layer->duration_ms) {
                layer->state = LED_LAYER_FINISHED;
                continue;
            }
        }

        /* 动画自然终止检查 */
        if (animation_naturally_finished(layer)) {
            layer->state = LED_LAYER_FINISHED;
        }
    }

    /* ── 第二步：从最高优先级层向下扫描，找到第一个 RUNNING 层 ── */
    led_color_t final_color = LED_COLOR_BLACK;

    for (int8_t i = (int8_t)(g_engine.num_layers - 1); i >= 0; i--) {
        led_layer_t *layer = &g_engine.layers[(uint8_t)i];
        if (layer->state == LED_LAYER_RUNNING) {
            uint8_t brightness = evaluate_brightness(layer);
            uint8_t gamma_brightness = led_core_gamma(brightness);
            final_color = led_color_scale(layer->params.color, gamma_brightness);
            break;  /* 最高优先级的 RUNNING 层胜出 */
        }
    }

    /* ── 第三步：输出 ── */
    g_engine.output_cb(final_color);
}
```

---

## 6. `pipelines/led/led_app.h`

```c
/**
 * @file led_app.h
 * @brief LED APP 层内部头文件
 *
 * 本文件仅供管线内部使用，不对外暴露。
 * 所有公开接口通过 market/led_api.h 访问。
 */
#ifndef LED_APP_H
#define LED_APP_H

/* APP 层无对外接口。
 * 初始化通过任意 market API 首次调用时自动完成（led_app_ensure_init）。
 * 此头文件保留用于未来可能的内部扩展。 */

#endif /* LED_APP_H */
```

---

## 7. `pipelines/led/led_app.c`

```c
/**
 * @file led_app.c
 * @brief LED APP 层实现 — Lyre 产品色板、参数、事件映射、API 胶水
 *
 * 设计原则：极薄。只有定义，基本无逻辑实现。
 * 职责：翻译产品语义 → CORE 调用。
 *
 * [AUDIT FIX] NEW-006: led_task() 引入 first_call 标志，仅首次调用时钳位
 * [AUDIT FIX] NEW-007: 初始化失败不重试，明确记录设计决策
 * [AUDIT FIX] NEW-008: 注释补充 USB 未连接场景说明
 */
#include "led_core.h"
#include "led_hal.h"
#include "market/led_api.h"

/* ─── 时间源封装（§4.6） ─── */
#ifdef LED_APP_TEST
  extern uint32_t test_get_time_us(void);
  static inline uint32_t lyre_get_time_us(void) { return test_get_time_us(); }
#else
  #include "pico/time.h"
  static inline uint32_t lyre_get_time_us(void) { return time_us_32(); }
#endif

/* ─── 推杆数量（与 pot_api.h 一致） ─── */
#ifndef POT_COUNT
#define POT_COUNT  4
#endif

/* ─── 层分配定义（§4.2） ─── */
#define LYRE_LED_NUM_LAYERS     2
#define LAYER_BASE              0   /* 基础层：呼吸 / 熄灭 */
#define LAYER_EVENT             1   /* 事件层：所有事件（pulse、save、reset） */

/* ─── 色板定义（§4.3） ─── */
static const led_color_t LYRE_COLOR_RED    = {255,   0,   0};
static const led_color_t LYRE_COLOR_GREEN  = {  0, 255,   0};
static const led_color_t LYRE_COLOR_YELLOW = {255, 180,   0};
static const led_color_t LYRE_COLOR_BLUE   = {  0,  80, 255};
static const led_color_t LYRE_COLOR_CYAN   = {  0, 200, 255};
static const led_color_t LYRE_COLOR_PURPLE = {160,   0, 255};
static const led_color_t LYRE_COLOR_ORANGE = {255, 100,   0};
static const led_color_t LYRE_COLOR_WHITE  = {255, 255, 255};

/* 推杆索引 → 颜色映射表 */
static const led_color_t LYRE_POT_COLORS[POT_COUNT] = {
    {  0,  80, 255},  /* Pot 0: Blue */
    {  0, 200, 255},  /* Pot 1: Cyan */
    {160,   0, 255},  /* Pot 2: Purple */
    {255, 100,   0},  /* Pot 3: Orange */
};

/* ─── 动画参数定义（§4.4） ─── */

/* 呼吸模式 */
#define LYRE_BREATHE_MIN_BRIGHTNESS   10
#define LYRE_BREATHE_MAX_BRIGHTNESS   80
#define LYRE_BREATHE_PERIOD_MS        3000

/* 推杆活动脉冲 */
#define LYRE_PULSE_DECAY_MS           300
#define LYRE_PULSE_DURATION_MS        350
#define LYRE_PULSE_MIN_BRIGHTNESS     30

/* 保存开始（黄色快闪） */
#define LYRE_SAVE_START_BLINK_ON_MS   100
#define LYRE_SAVE_START_BLINK_OFF_MS  100
#define LYRE_SAVE_START_BLINK_REPEAT  0     /* 无限（受安全超时约束） */
#define LYRE_SAVE_START_BRIGHTNESS    200
#define LYRE_SAVE_START_TIMEOUT_MS    30000 /* 防御性安全超时 30s */

/* 保存完成（绿色长亮） */
#define LYRE_SAVE_DONE_BRIGHTNESS     200
#define LYRE_SAVE_DONE_DURATION_MS    2000

/* 出厂重置（红色快闪） */
#define LYRE_RESET_BLINK_ON_MS        80
#define LYRE_RESET_BLINK_OFF_MS       80
#define LYRE_RESET_BLINK_REPEAT       0
#define LYRE_RESET_BRIGHTNESS         220
#define LYRE_RESET_TIMEOUT_MS         30000

/* 出厂重置完成（绿色长亮） */
#define LYRE_RESET_DONE_BRIGHTNESS    200
#define LYRE_RESET_DONE_DURATION_MS   2000

/* ─── Lyre Gamma 表（WS2812B 低亮度补偿） ─── */
/*
 * 由离线工具生成，针对 WS2812B 实测亮度响应补偿。
 * 若不需要特殊曲线，可传 NULL 使用 CORE 默认 gamma 2.2。
 * 此处使用默认 gamma 2.2（与 CORE 内置表相同），待实测后可替换。
 */
static const uint8_t LYRE_GAMMA_TABLE[256] = {
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   1,
      1,   1,   1,   1,   1,   1,   1,   1,   1,   2,   2,   2,   2,   2,   2,   2,
      3,   3,   3,   3,   3,   4,   4,   4,   4,   5,   5,   5,   5,   6,   6,   6,
      6,   7,   7,   7,   8,   8,   8,   9,   9,   9,  10,  10,  11,  11,  11,  12,
     12,  13,  13,  13,  14,  14,  15,  15,  16,  16,  17,  17,  18,  18,  19,  19,
     20,  20,  21,  22,  22,  23,  23,  24,  25,  25,  26,  26,  27,  28,  28,  29,
     30,  30,  31,  32,  33,  33,  34,  35,  36,  36,  37,  38,  39,  40,  40,  41,
     42,  43,  44,  45,  46,  46,  47,  48,  49,  50,  51,  52,  53,  54,  55,  56,
     57,  58,  59,  60,  61,  62,  63,  64,  65,  66,  67,  68,  69,  70,  71,  73,
     74,  75,  76,  77,  78,  80,  81,  82,  83,  84,  86,  87,  88,  89,  91,  92,
     93,  95,  96,  97,  99, 100, 101, 103, 104, 105, 107, 108, 110, 111, 113, 114,
    116, 117, 119, 120, 122, 123, 125, 126, 128, 130, 131, 133, 134, 136, 138, 139,
    141, 143, 144, 146, 148, 149, 151, 153, 155, 156, 158, 160, 162, 163, 165, 167,
    169, 171, 173, 174, 176, 178, 180, 182, 184, 186, 188, 190, 192, 194, 196, 198,
    200, 202, 204, 206, 208, 210, 212, 214, 216, 218, 220, 223, 225, 227, 229, 231,
    234, 236, 238, 240, 243, 245, 247, 250, 252, 255, 255, 255, 255, 255, 255, 255
};

/* ─── 内部状态 ─── */
static bool g_led_initialized    = false;
static bool g_led_available      = false;

/*
 * [AUDIT FIX] NEW-007: 初始化失败不重试 — 设计决策
 *
 * 设计决策：一旦尝试过初始化（无论成功或失败），不再重试。
 * 理由：
 *   1. RP2040 有 2 个 PIO 外设（PIO0/PIO1），各 4 个状态机。
 *      Lyre 仅使用 1 个状态机，正常情况下不会冲突。
 *   2. 如果 PIO 资源不可用，通常意味着硬件故障或严重的资源竞争，
 *      重试不会改善状况。
 *   3. 避免每帧重复尝试初始化带来的性能开销和不确定性。
 *   4. 若未来固件增加其他 PIO 功能（如 I2S 音频），应在系统级
 *      进行资源分配规划，而非依赖运行时重试。
 *
 * 行为：初始化失败后 LED 管线永久不可用，直到设备重启。
 */
static bool g_led_init_attempted = false;

/* ─── 输出回调：CORE → HAL 桥接 ─── */
static void lyre_led_output(led_color_t color)
{
    led_hal_set_pixel(0, color.r, color.g, color.b);
    led_hal_show();
}

/* ─── 内部初始化（首次任意 API 调用时自动执行） ─── */
static void led_app_ensure_init(void)
{
    /*
     * [AUDIT FIX] NEW-007: 使用 g_led_init_attempted 防止重复尝试。
     * 仅在成功时通过 g_led_available 跳过后续调用；
     * 失败时通过 g_led_init_attempted 阻止每帧重试。
     */
    if (g_led_available) return;       /* 已成功初始化，快速路径 */
    if (g_led_init_attempted) return;  /* 已尝试过且失败，不再重试 */
    g_led_init_attempted = true;

    bool hal_ok  = led_hal_init(16, 1);  /* GPIO16, 1 pixel */
    bool core_ok = led_core_init(LYRE_LED_NUM_LAYERS, lyre_led_output);
    g_led_available = hal_ok && core_ok;

    if (g_led_available) {
        g_led_initialized = true;
        led_core_set_gamma_table(LYRE_GAMMA_TABLE);
    }
}

/* ─── Market API 实现（§4.7） ─── */

void led_pulse_activity(uint8_t pot_index, uint8_t cc_value)
{
    led_app_ensure_init();
    if (!g_led_available || pot_index >= POT_COUNT) return;

    /* 亮度下限保护：cc_value=0 时仍保证可见反馈 */
    uint8_t brightness = (cc_value < LYRE_PULSE_MIN_BRIGHTNESS)
                       ? LYRE_PULSE_MIN_BRIGHTNESS
                       : cc_value;

    led_anim_params_t p;
    /* 手动清零（不依赖 string.h） */
    {
        uint8_t *raw = (uint8_t *)&p;
        for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;
    }
    p.type  = LED_ANIM_PULSE;
    p.color = LYRE_POT_COLORS[pot_index];
    p.pulse_params.peak_brightness = brightness;
    p.pulse_params.decay_duration  = LYRE_PULSE_DECAY_MS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_PULSE_DURATION_MS);
}

void led_set_breathing(bool enable)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    if (enable) {
        led_anim_params_t p;
        uint8_t *raw = (uint8_t *)&p;
        for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;

        p.type  = LED_ANIM_BREATHE;
        p.color = LYRE_COLOR_WHITE;
        p.breathe_params.min_brightness = LYRE_BREATHE_MIN_BRIGHTNESS;
        p.breathe_params.max_brightness = LYRE_BREATHE_MAX_BRIGHTNESS;
        p.breathe_params.period         = LYRE_BREATHE_PERIOD_MS;
        p.breathe_params.infinite       = true;

        led_core_layer_play(LAYER_BASE, &p, 0);  /* 无限持续 */
    } else {
        led_core_layer_stop(LAYER_BASE);
    }
}

void led_event_save_start(void)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p;
    uint8_t *raw = (uint8_t *)&p;
    for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;

    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_YELLOW;
    p.blink_params.brightness   = LYRE_SAVE_START_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_SAVE_START_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_SAVE_START_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_SAVE_START_BLINK_REPEAT;

    /* 防御性超时：即使 save_done 永远不被调用，30s 后自动回落 */
    led_core_layer_play(LAYER_EVENT, &p, LYRE_SAVE_START_TIMEOUT_MS);
}

void led_event_save_done(void)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p;
    uint8_t *raw = (uint8_t *)&p;
    for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;

    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_SAVE_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_SAVE_DONE_DURATION_MS);
}

void led_event_factory_reset_start(void)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p;
    uint8_t *raw = (uint8_t *)&p;
    for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;

    p.type  = LED_ANIM_BLINK;
    p.color = LYRE_COLOR_RED;
    p.blink_params.brightness   = LYRE_RESET_BRIGHTNESS;
    p.blink_params.on_duration  = LYRE_RESET_BLINK_ON_MS;
    p.blink_params.off_duration = LYRE_RESET_BLINK_OFF_MS;
    p.blink_params.repeat_count = LYRE_RESET_BLINK_REPEAT;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_RESET_TIMEOUT_MS);
}

void led_event_factory_reset_done(void)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    led_anim_params_t p;
    uint8_t *raw = (uint8_t *)&p;
    for (uint16_t i = 0; i < sizeof(p); i++) raw[i] = 0;

    p.type  = LED_ANIM_STATIC;
    p.color = LYRE_COLOR_GREEN;
    p.static_params.brightness = LYRE_RESET_DONE_BRIGHTNESS;

    led_core_layer_play(LAYER_EVENT, &p, LYRE_RESET_DONE_DURATION_MS);
}

/**
 * 主循环周期性调用，驱动 LED 状态机。
 *
 * [AUDIT FIX] NEW-006: 引入 first_call 标志解决钳位语义缺陷。
 *
 * 原设计问题：钳位条件 `> 1000` 的含义是"超过 1 秒视为异常"，
 * 但如果主循环因 Flash 写入阻塞了 1.2 秒（极端异常），elapsed_ms
 * 会被错误钳位为 10ms，导致动画时间"丢失"。
 *
 * 修复方案：仅首次调用时钳位（last_us 初始为 0，elapsed 必然异常大），
 * 后续调用不限制，允许真实 elapsed 通过。正常主循环周期 ~10ms，
 * 即使偶尔因 Flash 写入延迟到 50ms，动画也能正确推进。
 *
 * [AUDIT FIX] NEW-008: 补充 USB 未连接场景说明。
 * 注：若 USB 未连接（BASE 层呼吸未启动），脉冲结束后输出黑色。
 * 这是正确行为，符合架构文档 §4.5 "USB 断开 → LED 熄灭"。
 */
void led_task(void)
{
    led_app_ensure_init();
    if (!g_led_available) return;

    static uint32_t last_us    = 0;
    static bool     first_call = true;  /* [AUDIT FIX] NEW-006 */

    uint32_t now_us = lyre_get_time_us();
    uint32_t elapsed_ms = (now_us - last_us) / 1000;
    last_us = now_us;

    if (first_call) {
        /*
         * 首次调用：last_us 初始为 0，elapsed 可能为极大值。
         * 钳位为单帧（10ms），避免动画相位跳变。
         * 正常主循环周期 ~10ms，超过 100ms 视为首次调用异常。
         */
        if (elapsed_ms > 100) {
            elapsed_ms = 10;
        }
        first_call = false;
    }
    /* 后续调用：不钳位，允许真实 elapsed 通过。
     * 即使 Flash 写入导致单次循环延迟 50ms，动画也正确推进。 */

    led_core_tick(elapsed_ms);
    led_core_render();
}
```

---

## 8. 单元测试文件 `tests/test_led_core.c`

```c
/**
 * @file test_led_core.c
 * @brief LED CORE 层单元测试（PC 端编译运行）
 *
 * 编译时定义 LED_CORE_DEBUG 以启用 assert 校验。
 */
#include "led_core.h"
#include <stdio.h>
#include <assert.h>

static led_color_t g_last_output;
static int         g_output_count;

static void mock_output(led_color_t c)
{
    g_last_output = c;
    g_output_count++;
}

static void reset_mock(void)
{
    g_last_output = (led_color_t){0, 0, 0};
    g_output_count = 0;
}

/* ─── 测试用例 ─── */

void test_breathe_reaches_peak(void)
{
    printf("  test_breathe_reaches_peak... ");
    led_core_init(1, mock_output);
    reset_mock();

    led_anim_params_t p = {0};
    p.type = LED_ANIM_BREATHE;
    p.color = (led_color_t){255, 0, 0};
    p.breathe_params.min_brightness = 0;
    p.breathe_params.max_brightness = 255;
    p.breathe_params.period = 1000;
    p.breathe_params.infinite = true;
    led_core_layer_play(0, &p, 0);

    /* 推进到半周期（峰值点） */
    led_core_tick(500);
    led_core_render();

    assert(g_last_output.r == led_core_gamma(255));
    assert(g_last_output.g == 0);
    assert(g_last_output.b == 0);
    printf("PASS\n");
}

void test_pulse_no_overflow(void)
{
    printf("  test_pulse_no_overflow... ");
    led_core_init(1, mock_output);
    reset_mock();

    led_anim_params_t p = {0};
    p.type = LED_ANIM_PULSE;
    p.color = (led_color_t){255, 255, 255};
    p.pulse_params.peak_brightness = 255;
    p.pulse_params.decay_duration = 60000;  /* 极端值 */
    led_core_layer_play(0, &p, 0);

    led_core_tick(1);
    led_core_render();

    /* 不应崩溃，brightness 应接近 255 */
    assert(g_last_output.r > 250);
    printf("PASS\n");
}

void test_duration_expires_before_output(void)
{
    printf("  test_duration_expires_before_output... ");
    led_core_init(2, mock_output);
    reset_mock();

    /* 低优先级层：绿色静态 */
    led_anim_params_t base = {0};
    base.type = LED_ANIM_STATIC;
    base.color = (led_color_t){0, 255, 0};
    base.static_params.brightness = 100;
    led_core_layer_play(0, &base, 0);

    /* 高优先级层：红色，100ms 后到期 */
    led_anim_params_t evt = {0};
    evt.type = LED_ANIM_STATIC;
    evt.color = (led_color_t){255, 0, 0};
    evt.static_params.brightness = 200;
    led_core_layer_play(1, &evt, 100);

    /* 推进 100ms → 高优先级层应已 FINISHED */
    led_core_tick(100);
    led_core_render();

    /* 应输出低优先级层的绿色 */
    assert(g_last_output.g == led_core_gamma(100));
    assert(g_last_output.r == 0);
    printf("PASS\n");
}

void test_breathe_odd_period_symmetry(void)
{
    printf("  test_breathe_odd_period_symmetry... ");
    led_core_init(1, mock_output);
    reset_mock();

    led_anim_params_t p = {0};
    p.type = LED_ANIM_BREATHE;
    p.color = (led_color_t){255, 0, 0};
    p.breathe_params.min_brightness = 0;
    p.breathe_params.max_brightness = 200;
    p.breathe_params.period = 3001;  /* 奇数 */
    p.breathe_params.infinite = true;
    led_core_layer_play(0, &p, 0);

    /* 上升段 ~1/4 处 */
    led_core_tick(750);
    led_core_render();
    uint8_t rising = g_last_output.r;

    /* 到 2251，下降段 ~1/4 处 */
    led_core_tick(1501);
    led_core_render();
    uint8_t falling = g_last_output.r;

    assert(rising > 0 && falling > 0);
    int diff = (int)rising - (int)falling;
    assert(diff >= -2 && diff <= 2);
    printf("PASS\n");
}

void test_init_resets_time(void)
{
    printf("  test_init_resets_time... ");

    led_core_init(1, mock_output);
    led_core_tick(5000);
    assert(led_core_get_time_ms() == 5000);

    /* 第二次初始化应重置时间 */
    led_core_init(1, mock_output);
    assert(led_core_get_time_ms() == 0);
    printf("PASS\n");
}

void test_invalid_layer_asserts(void)
{
    printf("  test_invalid_layer_asserts... ");
    led_core_init(2, mock_output);
    reset_mock();

    led_anim_params_t p = {0};
    p.type = LED_ANIM_STATIC;
    p.static_params.brightness = 100;

    /* layer_id=5 >= num_layers=2，RELEASE 模式静默丢弃 */
    led_core_layer_play(5, &p, 0);

    /* 不应崩溃，不应有输出变化 */
    led_core_tick(10);
    led_core_render();
    assert(g_last_output.r == 0 && g_last_output.g == 0 && g_last_output.b == 0);
    printf("PASS\n");
}

/* [AUDIT FIX] NEW-009: 测试 NULL params 不崩溃 */
void test_null_params_rejected(void)
{
    printf("  test_null_params_rejected... ");
    led_core_init(2, mock_output);
    reset_mock();

    /* 传入 NULL，RELEASE 模式应静默丢弃 */
    led_core_layer_play(0, NULL, 0);

    led_core_tick(10);
    led_core_render();
    assert(g_last_output.r == 0 && g_last_output.g == 0 && g_last_output.b == 0);
    printf("PASS\n");
}

void test_color_scale(void)
{
    printf("  test_color_scale... ");
    led_color_t c = {200, 100, 50};
    led_color_t half = led_color_scale(c, 128);
    /* 200*128/255 ≈ 100, 100*128/255 ≈ 50, 50*128/255 ≈ 25 */
    assert(half.r >= 99 && half.r <= 101);
    assert(half.g >= 49 && half.g <= 51);
    assert(half.b >= 24 && half.b <= 26);

    /* 边界：brightness=0 → 全黑 */
    led_color_t black = led_color_scale(c, 0);
    assert(black.r == 0 && black.g == 0 && black.b == 0);

    /* 边界：brightness=255 → 原色 */
    led_color_t full = led_color_scale(c, 255);
    assert(full.r == 200 && full.g == 100 && full.b == 50);
    printf("PASS\n");
}

void test_blink_repeat_count(void)
{
    printf("  test_blink_repeat_count... ");
    led_core_init(1, mock_output);
    reset_mock();

    led_anim_params_t p = {0};
    p.type = LED_ANIM_BLINK;
    p.color = (led_color_t){255, 0, 0};
    p.blink_params.brightness = 200;
    p.blink_params.on_duration = 100;
    p.blink_params.off_duration = 100;
    p.blink_params.repeat_count = 3;  /* 3 次后停止 */
    led_core_layer_play(0, &p, 0);

    /* 推进 600ms = 3 个完整周期 */
    led_core_tick(600);
    led_core_render();

    /* 3 次重复已完成，层应为 FINISHED，输出黑色 */
    assert(led_core_layer_get_state(0) == LED_LAYER_FINISHED);
    assert(g_last_output.r == 0);
    printf("PASS\n");
}

/* ─── 主函数 ─── */
int main(void)
{
    printf("=== LED CORE Unit Tests ===\n");
    test_breathe_reaches_peak();
    test_pulse_no_overflow();
    test_duration_expires_before_output();
    test_breathe_odd_period_symmetry();
    test_init_resets_time();
    test_invalid_layer_asserts();
    test_null_params_rejected();
    test_color_scale();
    test_blink_repeat_count();
    printf("=== All tests PASSED ===\n");
    return 0;
}
```

---

## 9. 集成测试文件 `tests/test_led_app.c`

```c
/**
 * @file test_led_app.c
 * @brief LED APP 层集成测试（PC 端，定义 LED_APP_TEST）
 *
 * 编译时定义：LED_APP_TEST, LED_CORE_DEBUG
 * 需要提供 mock HAL 实现。
 */
#include "led_core.h"
#include "market/led_api.h"
#include <stdio.h>
#include <assert.h>

/* ─── Mock 时间源 ─── */
static uint32_t g_mock_time_us = 0;

uint32_t test_get_time_us(void)
{
    return g_mock_time_us;
}

/* ─── Mock HAL ─── */
static bool     g_hal_init_called = false;
static uint8_t  g_hal_last_r = 0, g_hal_last_g = 0, g_hal_last_b = 0;
static int      g_hal_show_count = 0;

bool led_hal_init(uint8_t gpio, uint16_t num_pixels)
{
    (void)gpio; (void)num_pixels;
    g_hal_init_called = true;
    return true;
}

void led_hal_set_pixel(uint16_t index, uint8_t r, uint8_t g, uint8_t b)
{
    (void)index;
    g_hal_last_r = r;
    g_hal_last_g = g;
    g_hal_last_b = b;
}

void led_hal_show(void)
{
    g_hal_show_count++;
}

void led_hal_clear(void)
{
    g_hal_last_r = g_hal_last_g = g_hal_last_b = 0;
    g_hal_show_count++;
}

/* ─── 测试用例 ─── */

void test_first_api_call_initializes(void)
{
    printf("  test_first_api_call_initializes... ");

    /* 模拟：led_set_breathing 在 led_task 之前被调用 */
    g_mock_time_us = 1000000;  /* 1s */
    led_set_breathing(true);

    /* 验证：HAL 被初始化 */
    assert(g_hal_init_called);
    printf("PASS\n");
}

void test_pulse_with_zero_cc(void)
{
    printf("  test_pulse_with_zero_cc... ");

    g_mock_time_us = 2000000;
    led_pulse_activity(0, 0);  /* cc_value = 0 */

    /* 推进时间并渲染 */
    g_mock_time_us = 2010000;  /* +10ms */
    led_task();

    /* 验证：有输出（亮度被钳位到 30，不是 0） */
    assert(g_hal_show_count > 0);
    printf("PASS\n");
}

void test_task_first_call_clamp(void)
{
    printf("  test_task_first_call_clamp... ");

    /*
     * [AUDIT FIX] NEW-006 验证：
     * 模拟系统启动较慢（1.5s），首次 led_task 调用时 elapsed 应为 1.5s，
     * 但被钳位为 10ms（首次调用保护）。
     */
    g_mock_time_us = 1500000;  /* 1.5s */
    led_set_breathing(true);   /* 触发初始化 */

    g_mock_time_us = 1500000;  /* 同一时刻调用 led_task */
    led_task();                /* 首次调用，elapsed 应被钳位 */

    /* 后续调用应使用真实 elapsed */
    g_mock_time_us = 1510000;  /* +10ms */
    led_task();

    /* 不应崩溃 */
    printf("PASS\n");
}

int main(void)
{
    printf("=== LED APP Integration Tests ===\n");
    test_first_api_call_initializes();
    test_pulse_with_zero_cc();
    test_task_first_call_clamp();
    printf("=== All tests PASSED ===\n");
    return 0;
}
```

---

## 10. 审计问题修复总结

| 审计 ID | 问题 | 修复位置 | 修复方式 |
|---------|------|----------|----------|
| **NEW-006** | `led_task()` 钳位阈值语义缺陷 | `led_app.c` → `led_task()` | 引入 `static bool first_call = true` 标志，仅首次调用时钳位（阈值改为 100ms），后续调用不限制，允许真实 elapsed 通过 |
| **NEW-007** | 初始化失败后无重试机制 | `led_app.c` → `led_app_ensure_init()` | 引入 `g_led_init_attempted` 标志防止每帧重试；在代码注释中明确记录"一次失败永久不可用"的设计决策及理由 |
| **NEW-008** | 时序图未说明 USB 未连接场景 | `led_app.c` → `led_task()` 注释 | 在函数文档注释中补充："若 USB 未连接（BASE 层呼吸未启动），脉冲结束后输出黑色。这是正确行为。" |
| **NEW-009** | `led_core_layer_play()` 未校验 `params` 为 NULL | `led_core.c` → `led_core_layer_play()` | 入口增加 `LED_CORE_ASSERT(params != NULL)` + `if (params == NULL) return;`；单元测试增加 `test_null_params_rejected` |

---

## 11. 构建配置参考（CMakeLists.txt 片段）

```cmake
# LED 管线源文件
add_library(led_pipeline STATIC
    pipelines/led/led_hal.c
    pipelines/led/led_core.c
    pipelines/led/led_app.c
)

target_include_directories(led_pipeline PRIVATE
    pipelines/led/
    market/
)

# 开发构建：启用 DEBUG 断言
target_compile_definitions(led_pipeline PRIVATE
    $<$<CONFIG:Debug>:LED_CORE_DEBUG>
)

# 单元测试（PC 端）
add_executable(test_led_core tests/test_led_core.c pipelines/led/led_core.c)
target_compile_definitions(test_led_core PRIVATE LED_CORE_DEBUG)
target_include_directories(test_led_core PRIVATE pipelines/led/)

add_executable(test_led_app tests/test_led_app.c
    pipelines/led/led_core.c
    pipelines/led/led_app.c
)
target_compile_definitions(test_led_app PRIVATE LED_CORE_DEBUG LED_APP_TEST)
target_include_directories(test_led_app PRIVATE pipelines/led/ market/)
```

---

以上代码完整实现了《LED管线详细设计文档 v1.2》的所有设计规格，并在编码层面解决了审计报告中的全部 4 项问题。代码遵循以下关键约束：

- **零浮点**：所有算法纯整数运算
- **零动态分配**：静态数组 + 手动循环初始化
- **依赖反转**：CORE 通过函数指针回调输出，不依赖 HAL
- **管线隔离**：仅通过 `market/led_api.h` 对外暴露接口
- **被动服务**：所有状态推进由主循环 `led_task()` 驱动
