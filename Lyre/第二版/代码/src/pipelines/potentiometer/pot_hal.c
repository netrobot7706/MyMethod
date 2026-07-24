/**
 * @file    pot_hal.c
 * @brief   电位器管线 - 硬件抽象层实现
 *
 * 依赖 RP2040 Pico SDK 的 ADC 函数。
 */

#include "pot_hal.h"
#include <hardware/adc.h>   // Pico SDK ADC API
#include <stddef.h>

/* -------------------------------------------------------------------------- */
/*  公开接口                                                                  */
/* -------------------------------------------------------------------------- */

void pot_hal_init(void) {
    // 初始化 ADC 硬件
    adc_init();

    // 配置 GPIO26-29 为模拟输入，禁用数字功能以避免漏电流
    adc_gpio_init(26);
    adc_gpio_init(27);
    adc_gpio_init(28);
    adc_gpio_init(29);
}

uint16_t pot_hal_read_channel(uint8_t channel) {
    // 参数范围检查：通道 0-3 对应 ADC 输入 0-3
    // 返回 0xFFFF 表示错误，与系统级错误值约定一致（超出 12‑bit ADC 有效范围）
    if (channel > 3) return 0xFFFF;

    // 选择 ADC 输入通道
    adc_select_input(channel);

    uint32_t sum = 0;

    // 先采样 (POT_HAL_SAMPLE_COUNT + POT_HAL_DISCARD) 次，丢弃前 POT_HAL_DISCARD 次
    for (int i = 0; i < (POT_HAL_SAMPLE_COUNT + POT_HAL_DISCARD); i++) {
        uint16_t val = adc_read();   // 读取 12-bit 结果

        if (i >= POT_HAL_DISCARD) {
            sum += val;
        }
    }

    // 四舍五入平均，依赖 POT_HAL_SAMPLE_COUNT 为偶数
    return (uint16_t)((sum + (POT_HAL_SAMPLE_COUNT / 2)) / POT_HAL_SAMPLE_COUNT);
}
