/**
 * @file    pot_app.c
 * @brief   电位器管线 - 应用层实现
 *
 * 组合 HAL 和 CORE，完成全流程处理，并通过市场 API 获取配置。
 * 实现 market/pot_api.h 中所有接口。
 */

#include "pot_app.h"
#include "pot_hal.h"
#include "pot_core.h"
#include "market/cmd_cfg_api.h"   // 通过市场获取配置
#include <stdint.h>
#include <stdbool.h>

/* -------------------------------------------------------------------------- */
/*  内部状态                                                                  */
/* -------------------------------------------------------------------------- */

static struct {
    volatile bool paused;               // 暂停标志（volatile 防御性要求，设计文档 §6 强制）
    bool event_pending[POT_COUNT];      // 事件就绪标志
    uint8_t event_channel[POT_COUNT];   // 事件 MIDI 通道
    uint8_t event_cc[POT_COUNT];        // 事件 CC 号
    uint8_t event_value[POT_COUNT];     // 事件 MIDI 值
    pot_core_state_t core_states[POT_COUNT]; // 核心算法状态
} pot_ctx;

/* -------------------------------------------------------------------------- */
/*  公开 API 实现                                                             */
/* -------------------------------------------------------------------------- */

void pot_init(void) {
    // 初始化硬件
    pot_hal_init();

    // 初始化核心状态
    for (int i = 0; i < POT_COUNT; i++) {
        pot_core_init(&pot_ctx.core_states[i]);
    }

    // 清空应用层状态
    pot_ctx.paused = false;
    for (int i = 0; i < POT_COUNT; i++) {
        pot_ctx.event_pending[i] = false;
    }
}

void pot_poll(void) {
    // 暂停时不处理
    if (pot_ctx.paused) return;

    // 1. 拉取配置快照（批量接口保证一致性与原子性）
    pot_mapping_t mappings[POT_COUNT];
    pot_calibration_t cals[POT_COUNT];
    uint8_t count;

    // 若配置不可用，本轮不进行任何采样，避免产生错误事件
    if (!config_get_all_pot_mappings(mappings, &count) || count < POT_COUNT) return;
    if (!config_get_all_calibrations(cals, &count) || count < POT_COUNT) return;

    // 2. HAL 采样（12-bit）
    uint16_t raw_12[POT_COUNT];
    for (int i = 0; i < POT_COUNT; i++) {
        raw_12[i] = pot_hal_read_channel(i);
    }

    // 3. CORE 处理 + 事件缓存
    for (int i = 0; i < POT_COUNT; i++) {
        uint8_t midi_val;
        if (pot_core_process(raw_12[i],
                             cals[i].cal_min, cals[i].cal_max,
                             &pot_ctx.core_states[i],
                             &midi_val))
        {
            pot_ctx.event_pending[i] = true;
            pot_ctx.event_channel[i] = mappings[i].channel;
            pot_ctx.event_cc[i]      = mappings[i].cc;
            pot_ctx.event_value[i]   = midi_val;
        }
    }
}

bool pot_get_midi_event(uint8_t index, uint8_t *channel, uint8_t *cc, uint8_t *value) {
    // 前置条件由主循环保证（在两次 pot_poll 之间调用）
    if (index >= POT_COUNT || !channel || !cc || !value) return false;

    if (pot_ctx.event_pending[index]) {
        *channel = pot_ctx.event_channel[index];
        *cc      = pot_ctx.event_cc[index];
        *value   = pot_ctx.event_value[index];
        pot_ctx.event_pending[index] = false;
        return true;
    }
    return false;
}

void pot_reset_stable_values(void) {
    for (int i = 0; i < POT_COUNT; i++) {
        pot_core_reset(&pot_ctx.core_states[i]);
        pot_ctx.event_pending[i] = false;  // 丢弃所有残留事件
    }
}

uint16_t pot_get_raw(uint8_t index) {
    if (index >= POT_COUNT) return 0xFFFF;

    // 暂停状态返回错误值
    if (pot_ctx.paused) return 0xFFFF;

    // 独立采样，与 pot_poll 内部访问互斥（单核无抢占，函数调用顺序已保证）
    return pot_hal_read_channel(index);
}

void pot_get_all_raw(uint16_t *raw_values, uint8_t count) {
    if (!raw_values || count < POT_COUNT) return;

    if (pot_ctx.paused) {
        for (int i = 0; i < POT_COUNT; i++) {
            raw_values[i] = 0xFFFF;
        }
        return;
    }

    for (int i = 0; i < POT_COUNT; i++) {
        raw_values[i] = pot_hal_read_channel(i);
    }
}

void pot_set_pause(bool pause) {
    pot_ctx.paused = pause;
}
