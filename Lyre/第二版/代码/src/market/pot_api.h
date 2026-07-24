/**
 * @file    market/pot_api.h
 * @brief   电位器管线市场 API
 * @consumers  main loop, cmd_cfg_app (仅 raw)
 * @dependencies  cmd_cfg_api（内部）
 *
 * 所有跨管线访问电位器功能的入口均在此定义。
 */

#ifndef POT_API_H
#define POT_API_H

#include <stdint.h>
#include <stdbool.h>

#define POT_COUNT  4   // 全项目唯一推杆数量定义

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief 初始化电位器管线（设置引脚、加载初始状态等）
 */
void pot_init(void);

/**
 * @brief 执行一轮完整的采样→滤波→校准→映射→变化检测
 *
 * 由主循环每 10ms 调用一次。
 */
void pot_poll(void);

/**
 * @brief 获取指定推杆的 MIDI 事件
 *
 * @pre 必须在 pot_poll() 之后、下一次 pot_poll() 之前调用。
 *      违反此前置条件将导致行为未定义（可能重复发送或丢失事件）。
 *
 * @param index   推杆索引 (0..POT_COUNT-1)
 * @param channel 输出 MIDI 通道
 * @param cc      输出 CC 控制器号
 * @param value   输出 MIDI 值 (0-127)
 * @return        若存在待发送事件返回 true，否则 false
 */
bool pot_get_midi_event(uint8_t index, uint8_t *channel, uint8_t *cc, uint8_t *value);

/**
 * @brief 配置或校准写入后必须调用，清除所有推杆的历史稳定值，
 *        防止参数变更导致误触发或漏触发 MIDI 事件。
 */
void pot_reset_stable_values(void);

/**
 * @brief 获取指定控件的原始 ADC 值（立即触发独立采样，与 pot_poll 内部 ADC 访问互斥）。
 *
 * @note 若 Pot 管线处于暂停状态，返回 0xFFFF（视为错误值）。
 *
 * @param index 推杆索引 (0..POT_COUNT-1)
 * @return      12-bit ADC 值 (0-4095)，或 0xFFFF 表示错误/暂停
 */
uint16_t pot_get_raw(uint8_t index);

/**
 * @brief 批量获取所有推杆的原始 ADC 值。
 *
 * @note 暂停状态下所有元素均为 0xFFFF。
 *
 * @param raw_values 输出缓冲区，至少 POT_COUNT 长度
 * @param count      缓冲区容量，应为 POT_COUNT
 */
void pot_get_all_raw(uint16_t *raw_values, uint8_t count);

/**
 * @brief 暂停/恢复 Pot 管线的采样与处理（Flash 写入期间调用）
 *
 * @param pause true 暂停，false 恢复
 */
void pot_set_pause(bool pause);

#ifdef __cplusplus
}
#endif

#endif // POT_API_H
