审计确认与最终完整代码输出：

经过逐轮审计和修复，以下问题已被确认真实存在并已全部修正：
- H-1：SysEx 一次性写入空间检查不足
- H-2：热插拔后发送通道未清理导致死锁
- M-1：分段发送 0xF0 可能重复
- M-3/L-1：临界区保护因 include guard 失效
- L-2：描述符重复填充
- L-3：缺少配置描述符
- N-1：分段路径在起始字节未发时发送数据
- N-3：MIDI 描述符参数错误
- L2-H1：rx_enqueue 缺少帧长度上限校验
- L2-M1：一次性写入未检查 tx_write 返回值
- L2-M2：send_cc 缺少 channel 范围校验
- L2-L1：SPSC 模型注释
- L2-L2：字符串描述符回调 NULL 保护
- L2-L3：临界区不可重入改为嵌套安全
- L2-V1：分段路径 tx_written 未使用实际写入量
- L2-V2：分段路径 0xF0/0xF7 未检查返回值
- L2-V5：增加显式 tud_task() 调用
- L2-V3：多实例临界区约束注释

L2-V4 确认为误报，无需修改。

以下为整合所有修复后的完整代码。

---

## 文件 1：`market/midi_api.h`

```c
/**
 * @consumers  main loop, cmd_cfg_app
 * @dependencies 无
 */

#ifndef MARKET_MIDI_API_H
#define MARKET_MIDI_API_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MIDI_SYSEX_MAX_LEN  770

void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value);
bool midi_send_sysex(const uint8_t *data, uint16_t len);
bool midi_has_sysex(void);
uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen);
bool midi_is_connected(void);
void midi_task(void);

#ifdef __cplusplus
}
#endif

#endif /* MARKET_MIDI_API_H */
```

---

## 文件 2：`pipelines/midi/midi_core_parser.h`

```c
#ifndef PIPELINES_MIDI_MIDI_CORE_PARSER_H
#define PIPELINES_MIDI_MIDI_CORE_PARSER_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PARSER_IDLE,
    PARSER_RECEIVING
} midi_parser_state_t;

typedef struct {
    midi_parser_state_t state;
    uint8_t  *buffer;
    uint16_t  len;
    uint16_t  max_len;
    void (*frame_handler)(const uint8_t *frame, uint16_t len);
} midi_parser_t;

void midi_parser_init(midi_parser_t *parser,
                      uint8_t *buffer, uint16_t max_len,
                      void (*handler)(const uint8_t *frame, uint16_t len));
void midi_parser_feed(midi_parser_t *parser, const uint8_t *data, uint32_t len);
void midi_parser_reset(midi_parser_t *parser);

#ifdef __cplusplus
}
#endif

#endif /* PIPELINES_MIDI_MIDI_CORE_PARSER_H */
```

---

## 文件 3：`pipelines/midi/midi_core_parser.c`

```c
#include "midi_core_parser.h"
#include <string.h>

void midi_parser_init(midi_parser_t *parser,
                      uint8_t *buffer, uint16_t max_len,
                      void (*handler)(const uint8_t *frame, uint16_t len))
{
    parser->state = PARSER_IDLE;
    parser->buffer = buffer;
    parser->len = 0;
    parser->max_len = max_len;
    parser->frame_handler = handler;
}

void midi_parser_feed(midi_parser_t *parser, const uint8_t *data, uint32_t len)
{
    for (uint32_t i = 0; i < len; i++) {
        uint8_t byte = data[i];

        switch (parser->state) {
        case PARSER_IDLE:
            if (byte == 0xF0) {
                parser->state = PARSER_RECEIVING;
                parser->len = 0;
            }
            break;

        case PARSER_RECEIVING:
            // 1. 实时消息 (0xF8–0xFF) 忽略
            if (byte >= 0xF8) continue;

            // 2. 新 SysEx 开始 (0xF0)：重新开始接收
            if (byte == 0xF0) {
                parser->len = 0;
                continue;
            }

            // 3. SysEx 结束 (0xF7)：完成帧
            if (byte == 0xF7) {
                if (parser->len > 0 && parser->len <= parser->max_len) {
                    parser->frame_handler(parser->buffer, parser->len);
                }
                parser->state = PARSER_IDLE;
                continue;
            }

            // 4. 其他状态字节 (0x80–0xF7) -> 协议错误，丢弃帧
            if (byte >= 0x80) {
                parser->state = PARSER_IDLE;
                continue;
            }

            // 5. 数据字节 (<0x80)
            if (parser->len < parser->max_len) {
                parser->buffer[parser->len++] = byte;
            } else {
                // 溢出，丢弃帧
                parser->state = PARSER_IDLE;
            }
            break;
        }
    }
}

void midi_parser_reset(midi_parser_t *parser)
{
    parser->state = PARSER_IDLE;
    parser->len = 0;
}
```

---

## 文件 4：`pipelines/midi/midi_core_transport.h`

```c
#ifndef PIPELINES_MIDI_MIDI_CORE_TRANSPORT_H
#define PIPELINES_MIDI_MIDI_CORE_TRANSPORT_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t (*tx_available)(void);
    uint32_t (*tx_write)(const uint8_t *buf, uint32_t len);
    bool     (*is_connected)(void);
} midi_io_driver_t;

/*
 * 接收 FIFO 为单生产者-单消费者 (SPSC) 模型：
 * - rx_head 仅由中断上下文 (rx_enqueue) 修改
 * - rx_tail 仅由主循环上下文 (read_sysex) 修改
 * - 索引为 uint8_t，在 Cortex-M0+ 上原子
 */
typedef struct {
    // 发送缓冲
    uint8_t *tx_buf;
    uint16_t tx_buf_size;
    uint16_t tx_len;
    uint16_t tx_written;
    bool     tx_active;
    bool     tx_start_sent;   // 0xF0 是否已发出

    // 接收 FIFO
    uint8_t  *rx_fifo_buf;
    uint16_t *rx_len;
    uint8_t   rx_fifo_size;
    uint16_t  rx_max_sysex_len;
    uint8_t   rx_head;
    uint8_t   rx_tail;

    midi_io_driver_t driver;

    void (*enter_critical)(void);
    void (*exit_critical)(void);

    bool connected;
} midi_transport_t;

typedef struct {
    uint8_t *tx_buf;
    uint16_t tx_buf_size;
    uint8_t *rx_fifo_buf;
    uint8_t  rx_fifo_size;
    uint16_t max_sysex_len;
    uint16_t *rx_len_buf;
    midi_io_driver_t driver;
    void (*enter_critical)(void);
    void (*exit_critical)(void);
} midi_transport_config_t;

void midi_transport_init(midi_transport_t *t, const midi_transport_config_t *cfg);
void midi_transport_send_cc(midi_transport_t *t, uint8_t channel, uint8_t cc, uint8_t value);
bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len);
bool midi_transport_has_sysex(const midi_transport_t *t);
uint16_t midi_transport_read_sysex(midi_transport_t *t, uint8_t *buf, uint16_t maxlen);
bool midi_transport_is_connected(const midi_transport_t *t);
void midi_transport_update_connection(midi_transport_t *t);
void midi_transport_tx_flush(midi_transport_t *t);
void midi_transport_rx_enqueue(midi_transport_t *t, const uint8_t *frame, uint16_t len);

#ifdef __cplusplus
}
#endif

#endif /* PIPELINES_MIDI_MIDI_CORE_TRANSPORT_H */
```

---

## 文件 5：`pipelines/midi/midi_core_transport.c`

```c
#include "midi_core_transport.h"
#include <string.h>

void midi_transport_init(midi_transport_t *t, const midi_transport_config_t *cfg)
{
    t->tx_buf = cfg->tx_buf;
    t->tx_buf_size = cfg->tx_buf_size;
    t->tx_len = 0;
    t->tx_written = 0;
    t->tx_active = false;
    t->tx_start_sent = false;

    t->rx_fifo_buf = cfg->rx_fifo_buf;
    t->rx_len = cfg->rx_len_buf;
    t->rx_fifo_size = cfg->rx_fifo_size;
    t->rx_max_sysex_len = cfg->max_sysex_len;
    t->rx_head = 0;
    t->rx_tail = 0;

    t->driver = cfg->driver;
    t->enter_critical = cfg->enter_critical;
    t->exit_critical = cfg->exit_critical;
    t->connected = false;
}

void midi_transport_send_cc(midi_transport_t *t, uint8_t channel, uint8_t cc, uint8_t value)
{
    if (!t->connected) return;
    if (channel < 1 || channel > 16) return;

    if (t->driver.tx_available() >= 3) {
        uint8_t pkt[3];
        pkt[0] = 0xB0 | (channel - 1);
        pkt[1] = cc;
        pkt[2] = value;
        t->driver.tx_write(pkt, 3);  // CC 丢失可接受
    }
}

bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len)
{
    if (t->tx_active) return false;
    if (!t->connected) return false;
    if (len > t->tx_buf_size) return false;

    // 一次性写入路径
    if (t->driver.tx_available() >= (uint32_t)len + 2) {
        uint8_t start = 0xF0, end = 0xF7;
        if (t->driver.tx_write(&start, 1) != 1) return false;
        if (t->driver.tx_write(data, len) != len)   return false;
        if (t->driver.tx_write(&end, 1) != 1)       return false;
        return true;
    }

    // ---------- 分段发送 ----------
    memcpy(t->tx_buf, data, len);
    t->tx_len = len;
    t->tx_written = 0;
    t->tx_active = true;
    t->tx_start_sent = false;

    // 尝试发送起始字节
    if (!t->tx_start_sent && t->driver.tx_available() >= 1) {
        uint8_t start = 0xF0;
        if (t->driver.tx_write(&start, 1) == 1) {
            t->tx_start_sent = true;
        }
    }

    if (t->tx_start_sent) {
        uint32_t avail = t->driver.tx_available();
        uint32_t rem = t->tx_len - t->tx_written;
        uint32_t to_write = (rem < avail) ? rem : avail;
        if (to_write > 0) {
            uint32_t written = t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
            t->tx_written += (uint16_t)written;
        }

        if (t->tx_written == t->tx_len) {
            if (t->driver.tx_available() >= 1) {
                uint8_t end = 0xF7;
                if (t->driver.tx_write(&end, 1) == 1) {
                    t->tx_active = false;
                    t->tx_start_sent = false;
                }
            }
        }
    }

    return true;
}

void midi_transport_tx_flush(midi_transport_t *t)
{
    if (!t->tx_active) return;

    if (!t->connected) {
        t->tx_active = false;
        t->tx_start_sent = false;
        t->tx_written = 0;
        return;
    }

    // 发送起始字节
    if (!t->tx_start_sent) {
        if (t->driver.tx_available() >= 1) {
            uint8_t start = 0xF0;
            if (t->driver.tx_write(&start, 1) == 1) {
                t->tx_start_sent = true;
            } else {
                return;
            }
        } else {
            return;
        }
    }

    // 发送 payload
    uint32_t rem = t->tx_len - t->tx_written;
    uint32_t avail = t->driver.tx_available();
    uint32_t to_write = (rem < avail) ? rem : avail;
    if (to_write > 0) {
        uint32_t written = t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
        t->tx_written += (uint16_t)written;
    }

    // 发送结束字节
    if (t->tx_written == t->tx_len) {
        if (t->driver.tx_available() >= 1) {
            uint8_t end = 0xF7;
            if (t->driver.tx_write(&end, 1) == 1) {
                t->tx_active = false;
                t->tx_start_sent = false;
            }
        }
    }
}

bool midi_transport_has_sysex(const midi_transport_t *t)
{
    return t->rx_head != t->rx_tail;
}

uint16_t midi_transport_read_sysex(midi_transport_t *t, uint8_t *buf, uint16_t maxlen)
{
    if (t->rx_head == t->rx_tail) return 0;

    uint16_t len = t->rx_len[t->rx_tail];
    if (maxlen < len) {
        t->rx_tail = (uint8_t)(t->rx_tail + 1) % t->rx_fifo_size;
        return 0;
    }

    memcpy(buf, &t->rx_fifo_buf[t->rx_tail * t->rx_max_sysex_len], len);
    t->rx_tail = (uint8_t)(t->rx_tail + 1) % t->rx_fifo_size;
    return len;
}

bool midi_transport_is_connected(const midi_transport_t *t)
{
    return t->connected;
}

void midi_transport_update_connection(midi_transport_t *t)
{
    t->connected = t->driver.is_connected();
}

void midi_transport_rx_enqueue(midi_transport_t *t, const uint8_t *frame, uint16_t len)
{
    if (len == 0 || len > t->rx_max_sysex_len) return;

    if (t->enter_critical) t->enter_critical();

    if ((uint8_t)(t->rx_head + 1) % t->rx_fifo_size != t->rx_tail) {
        memcpy(&t->rx_fifo_buf[t->rx_head * t->rx_max_sysex_len], frame, len);
        t->rx_len[t->rx_head] = len;
        t->rx_head = (uint8_t)(t->rx_head + 1) % t->rx_fifo_size;
    }

    if (t->exit_critical) t->exit_critical();
}
```

---

## 文件 6：`pipelines/midi/midi_hal.h`

```c
#ifndef PIPELINES_MIDI_MIDI_HAL_H
#define PIPELINES_MIDI_MIDI_HAL_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*midi_rx_callback_t)(const uint8_t *data, uint32_t len);

typedef struct {
    uint16_t    vid;
    uint16_t    pid;
    const char *manufacturer;
    const char *product;
} midi_usb_desc_t;

void midi_hal_init(midi_rx_callback_t rx_cb, const midi_usb_desc_t *desc);

uint32_t midi_hal_tx_available(void);
uint32_t midi_hal_tx_write(const uint8_t *data, uint32_t len);
bool     midi_hal_is_connected(void);

// 驱动 TinyUSB 设备任务（必须在主循环中调用）
void midi_hal_task(void);

#ifdef __cplusplus
}
#endif

#endif /* PIPELINES_MIDI_MIDI_HAL_H */
```

---

## 文件 7：`pipelines/midi/midi_hal.c`

```c
#include "midi_hal.h"
#include <string.h>
#include "tusb.h"
#include "class/midi/midi.h"

static midi_rx_callback_t rx_callback = NULL;
static midi_usb_desc_t   usb_desc;
static volatile bool     _hal_connected = false;

static uint8_t device_descriptor[] = {
    18,             // bLength
    0x01,           // bDescriptorType: Device
    0x00, 0x02,     // bcdUSB 2.0
    0x00,           // bDeviceClass
    0x00,           // bDeviceSubClass
    0x00,           // bDeviceProtocol
    64,             // bMaxPacketSize0
    0x00, 0x00,     // idVendor (filled later)
    0x00, 0x00,     // idProduct
    0x00, 0x01,     // bcdDevice 1.0
    0x01,           // iManufacturer
    0x02,           // iProduct
    0x00,           // iSerialNumber
    0x01            // bNumConfigurations
};

static uint8_t const midi_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, 2, 0,
                          TUD_CONFIG_DESC_LEN + TUD_MIDI_DESC_LEN,
                          0x00, 100),
    TUD_MIDI_DESCRIPTOR(0, 0, 0x01, 0x81, CFG_TUD_MIDI_EP_BUFSIZE)
};

// ===== USB 回调 =====
uint8_t const * tud_descriptor_device_cb(void)
{
    return device_descriptor;
}

uint8_t const * tud_descriptor_configuration_cb(uint8_t index)
{
    (void)index;
    return midi_config_desc;
}

uint8_t const * tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;
    static uint8_t string_langid[] = { 4, 0x03, 0x09, 0x04 };
    if (index == 0) return string_langid;

    static uint8_t str_buf[64];
    const char *str = NULL;
    if (index == 1) str = usb_desc.manufacturer;
    else if (index == 2) str = usb_desc.product;
    else return NULL;

    if (str == NULL) return NULL;

    size_t len = strlen(str);
    if (len > 31) len = 31;
    str_buf[0] = (uint8_t)(2 + len * 2);
    str_buf[1] = 0x03;
    for (size_t i = 0; i < len; i++) {
        str_buf[2 + i*2] = str[i];
        str_buf[3 + i*2] = 0;
    }
    return str_buf;
}

void tud_mount_cb(void)   { _hal_connected = true; }
void tud_umount_cb(void)  { _hal_connected = false; }

void tud_midi_rx_cb(uint8_t itf, uint8_t const* buffer, uint16_t bufsize)
{
    (void)itf;
    if (rx_callback) rx_callback(buffer, bufsize);
}

// ===== API 实现 =====
void midi_hal_init(midi_rx_callback_t rx_cb, const midi_usb_desc_t *desc)
{
    rx_callback = rx_cb;
    if (desc) {
        memcpy(&usb_desc, desc, sizeof(midi_usb_desc_t));
        device_descriptor[8]  = desc->vid & 0xFF;
        device_descriptor[9]  = (desc->vid >> 8) & 0xFF;
        device_descriptor[10] = desc->pid & 0xFF;
        device_descriptor[11] = (desc->pid >> 8) & 0xFF;
    }
}

uint32_t midi_hal_tx_available(void) { return tud_midi_n_stream_available(0); }
uint32_t midi_hal_tx_write(const uint8_t *data, uint32_t len) { return tud_midi_stream_write(0, data, len); }
bool     midi_hal_is_connected(void) { return _hal_connected; }

void midi_hal_task(void)
{
    tud_task();
}
```

---

## 文件 8：`pipelines/midi/midi_app.h`

```c
#ifndef PIPELINES_MIDI_MIDI_APP_H
#define PIPELINES_MIDI_MIDI_APP_H

#ifdef __cplusplus
extern "C" {
#endif

void midi_app_init(void);

#ifdef __cplusplus
}
#endif

#endif /* PIPELINES_MIDI_MIDI_APP_H */
```

---

## 文件 9：`pipelines/midi/midi_app.c`

```c
#include "midi_app.h"
#include "midi_core_parser.h"
#include "midi_core_transport.h"
#include "midi_hal.h"
#include <Arduino.h>
#include <cmsis_gcc.h>

#define LYRE_USB_VID                0x1209
#define LYRE_USB_PID                0x0001
#define LYRE_USB_MANUFACTURER       "Lyre Audio"
#define LYRE_USB_PRODUCT            "Lyre MK2"
#define LYRE_RX_FIFO_SIZE           4
#define LYRE_SYSEX_MAX_LEN          770
#define LYRE_TX_BUF_SIZE            LYRE_SYSEX_MAX_LEN

// 静态内存池
static uint8_t  rx_fifo_pool[LYRE_RX_FIFO_SIZE][LYRE_SYSEX_MAX_LEN];
static uint16_t rx_len_pool[LYRE_RX_FIFO_SIZE];
static uint8_t  tx_buf[LYRE_TX_BUF_SIZE];
static uint8_t  parser_buf[LYRE_SYSEX_MAX_LEN];

static midi_parser_t    parser;
static midi_transport_t transport;

/*
 * 临界区保护策略：
 * - 所有使用者共享同一屏蔽级别（全局中断禁用）
 * - 若未来需要独立屏蔽级别，请改为 per-instance 回调
 */
static volatile uint32_t crit_primask_save;
static volatile int      crit_nesting = 0;

static void port_enter_critical(void) {
    if (crit_nesting == 0) {
        crit_primask_save = __get_PRIMASK();
        __disable_irq();
    }
    crit_nesting++;
}

static void port_exit_critical(void) {
    crit_nesting--;
    if (crit_nesting == 0) {
        __set_PRIMASK(crit_primask_save);
    }
}

// 回调
static void on_rx_frame(const uint8_t *frame, uint16_t len) {
    midi_transport_rx_enqueue(&transport, frame, len);
}

static void hal_rx_callback(const uint8_t *data, uint32_t len) {
    midi_parser_feed(&parser, data, len);
}

// 初始化
void midi_app_init(void) {
    midi_usb_desc_t usb_desc = {
        .vid          = LYRE_USB_VID,
        .pid          = LYRE_USB_PID,
        .manufacturer = LYRE_USB_MANUFACTURER,
        .product      = LYRE_USB_PRODUCT,
    };

    midi_io_driver_t io = {
        .tx_available = midi_hal_tx_available,
        .tx_write     = midi_hal_tx_write,
        .is_connected = midi_hal_is_connected,
    };

    midi_transport_config_t tcfg = {
        .tx_buf         = tx_buf,
        .tx_buf_size    = LYRE_TX_BUF_SIZE,
        .rx_fifo_buf    = (uint8_t*)rx_fifo_pool,
        .rx_fifo_size   = LYRE_RX_FIFO_SIZE,
        .max_sysex_len  = LYRE_SYSEX_MAX_LEN,
        .rx_len_buf     = rx_len_pool,
        .driver         = io,
        .enter_critical = port_enter_critical,
        .exit_critical  = port_exit_critical,
    };
    midi_transport_init(&transport, &tcfg);

    midi_parser_init(&parser, parser_buf, LYRE_SYSEX_MAX_LEN, on_rx_frame);
    midi_hal_init(hal_rx_callback, &usb_desc);
}

// 市场 API 实现
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value) {
    midi_transport_send_cc(&transport, channel, cc, value);
}

bool midi_send_sysex(const uint8_t *data, uint16_t len) {
    return midi_transport_send_sysex(&transport, data, len);
}

bool midi_has_sysex(void) {
    return midi_transport_has_sysex(&transport);
}

uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen) {
    return midi_transport_read_sysex(&transport, buf, maxlen);
}

bool midi_is_connected(void) {
    return midi_transport_is_connected(&transport);
}

void midi_task(void) {
    midi_hal_task();                                   // 驱动 TinyUSB 状态机
    midi_transport_update_connection(&transport);
    midi_transport_tx_flush(&transport);
}
```

---

以上即为经过 L1、L2 全量审计修复后的最终 MIDI 管线代码，所有已知缺陷均已关闭，架构符合设计文档要求，可进入集成与测试阶段。
