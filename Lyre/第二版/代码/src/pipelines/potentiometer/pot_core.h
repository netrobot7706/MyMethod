/**
 * @file    pot_core.h
 * @brief   电位器管线 - 核心算法层内部接口
 *
 * CORE 层零外部依赖，仅包含领域通用算法。
 */

#ifndef POT_CORE_H
#define POT_CORE_H

#include <stdint.h>
#include <stdbool.h>

// 迟滞区宽度（12-bit LSB）
#define POT_CORE_HYSTERESIS  16

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief 单通道迟滞状态（12-bit 运算域）
 */
typedef struct {
    uint16_t last_raw;       // 上次有效发送时的原始值 (12-bit 域)，0xFFFF 表示“从未发送”
    uint8_t  last_midi;      // 上次发送的 MIDI 值 (0-127)，0xFF 表示“从未发送”
} pot_core_state_t;

/**
 * @brief 初始化/重置核心状态
 *
 * @param state 待初始化的状态结构体指针
 */
void pot_core_init(pot_core_state_t *state);

/**
 * @brief 重置核心状态（效果同 init，供配置变更后调用）
 *
 * @param state 待重置的状态结构体指针
 */
void pot_core_reset(pot_core_state_t *state);

/**
 * @brief 对原始值进行迟滞比较与 MIDI 映射
 *
 * @param raw_in_12bit    当前滤波后的原始值（0-4095），调用者保证有效性
 * @param cal_min_12bit   校准最小值（12-bit 域）
 * @param cal_max_12bit   校准最大值（12-bit 域）
 * @param state           该通道的状态记录（会更新）
 * @param midi_out        输出 MIDI 值 (0-127)，仅当返回 true 时有效
 * @return                是否需要发送新 MIDI 事件
 */
bool pot_core_process(uint16_t raw_in_12bit,
                      uint16_t cal_min_12bit, uint16_t cal_max_12bit,
                      pot_core_state_t *state,
                      uint8_t *midi_out);

#ifdef __cplusplus
}
#endif

#endif // POT_CORE_H
