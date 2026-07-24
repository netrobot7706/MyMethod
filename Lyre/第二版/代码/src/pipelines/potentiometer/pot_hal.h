/**
 * @file    pot_hal.h
 * @brief   电位器管线 - 硬件抽象层内部接口
 */

#ifndef POT_HAL_H
#define POT_HAL_H

#include <stdint.h>

#define POT_HAL_SAMPLE_COUNT  16  // 平均窗口大小，必须为偶数
#define POT_HAL_DISCARD       2   // 丢弃的前几次采样

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief 初始化 ADC 及相关 GPIO（GPIO26-29）
 */
void pot_hal_init(void);

/**
 * @brief 对指定通道进行滤波采样（多采样平均）
 *
 * @param channel ADC 输入编号 (0-3, 对应 GPIO26-29)
 * @return        12-bit 采样值 (0-4095)
 */
uint16_t pot_hal_read_channel(uint8_t channel);

#ifdef __cplusplus
}
#endif

#endif // POT_HAL_H
