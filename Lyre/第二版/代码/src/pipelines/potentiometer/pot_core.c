/**
 * @file    pot_core.c
 * @brief   电位器管线 - 核心算法实现
 *
 * 包含迟滞比较、线性映射、变化检测等纯算法逻辑。
 */

#include "pot_core.h"
#include <stdint.h>
#include <stdbool.h>

/* -------------------------------------------------------------------------- */
/*  公开接口                                                                  */
/* -------------------------------------------------------------------------- */

void pot_core_init(pot_core_state_t *state) {
    if (state) {
        pot_core_reset(state);
    }
}

void pot_core_reset(pot_core_state_t *state) {
    if (state) {
        state->last_raw  = 0xFFFF;   // 哨兵：从未发送
        state->last_midi = 0xFF;     // 哨兵：从未发送（不在 0-127 范围内）
    }
}

bool pot_core_process(uint16_t raw_in_12bit,
                      uint16_t cal_min_12bit, uint16_t cal_max_12bit,
                      pot_core_state_t *state,
                      uint8_t *midi_out)
{
    // 参数有效性检查
    if (!state || !midi_out) return false;

    // 防御：校准值无效时直接放弃
    if (cal_max_12bit <= cal_min_12bit) {
        return false;
    }

    // 1. 迟滞判断
    uint16_t last = state->last_raw;
    if (last != 0xFFFF) {   // 非首次，检查是否超出死区
        int32_t diff = (int32_t)raw_in_12bit - (int32_t)last;
        if (diff >= -(POT_CORE_HYSTERESIS/2) && diff <= (POT_CORE_HYSTERESIS/2)) {
            return false;   // 未超出死区，不产生事件
        }
    }

    // 2. 线性映射到 MIDI (0-127)
    uint8_t midi;
    if (raw_in_12bit <= cal_min_12bit) {
        midi = 0;
    } else if (raw_in_12bit >= cal_max_12bit) {
        midi = 127;
    } else {
        uint32_t range = cal_max_12bit - cal_min_12bit;
        midi = (uint8_t)(((uint32_t)(raw_in_12bit - cal_min_12bit) * 127 + (range / 2)) / range);
    }

    // 3. MIDI 变化检测
    if (midi == state->last_midi) {
        // 关键设计约束：绝不更新 last_raw，避免死区滑动窗口导致慢速移动丢失事件。
        return false;
    }

    // 4. 更新状态并输出
    // last_raw 仅在 MIDI 值真正变化时才更新，保证死区以“上次有效发送位置”为中心。
    state->last_raw  = raw_in_12bit;
    state->last_midi = midi;
    *midi_out = midi;
    return true;
}
