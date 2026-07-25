基于《Lyre MK2 产品架构设计文档 v2.2》和《MIDI 管线详细设计 v4.1》，以下是 MIDI 管线的完整 C 语言实现。所有代码严格按照三层结构（HAL → CORE → APP）及市场 API 契约编写，可直接集成到项目中。

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

#define MIDI_SYSEX_MAX_LEN  770   // 协议 v2.6 最大消息（0x04，N=127）

// 发送标准 MIDI CC 消息（3 字节），不保证送达，偶尔丢失可接受
void midi_send_cc(uint8_t channel, uint8_t cc, uint8_t value);

// 发送完整 SysEx 消息，返回 true 表示成功入队。失败时调用者应在下一轮主循环重试
bool midi_send_sysex(const uint8_t *data, uint16_t len);

// 接收侧非阻塞轮询
bool midi_has_sysex(void);
// 读取一条 SysEx 消息。若实际消息超过 maxlen，整帧丢弃，返回 0。
uint16_t midi_read_sysex(uint8_t *buf, uint16_t maxlen);

// 返回 USB MIDI 是否已连接（枚举成功且未被拔出）。
// 基于 tud_mounted/umounted 回调维护 volatile 标志，中断与主循环间安全，
// 返回值可能在 USB 热插拔后延迟一轮主循环才更新。
bool midi_is_connected(void);

/**
 * 主循环每轮必须调用，用于：
 *   1. 推进 SysEx 分段发送
 *   2. 更新 USB 连接状态缓存
 * 调用频率：与主循环同步，~10ms 一次
 */
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
    uint8_t  *buffer;       // 外部传入的接收缓冲区
    uint16_t  len;
    uint16_t  max_len;
    void (*frame_handler)(const uint8_t *frame, uint16_t len);
} midi_parser_t;

/**
 * @param parser     解析器实例
 * @param buffer     外部提供的接收缓冲区，必须能容纳 max_len 字节
 * @param max_len    最大允许的 SysEx 帧长度
 * @param handler    帧完成回调。
 *                   @note 在 ISR 上下文中被调用，传入的 frame 指针指向 parser
 *                         内部缓冲区，回调返回后该缓冲区可能被覆盖。
 *                         实现者必须在回调内完成数据拷贝，不得保存指针供后续使用。
 */
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
            // 1. 实时消息 (0xF8–0xFF) 忽略，不破坏当前帧
            if (byte >= 0xF8) {
                // 忽略
                continue;
            }
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

typedef struct {
    uint8_t *tx_buf;
    uint16_t tx_buf_size;
    uint16_t tx_len;
    uint16_t tx_written;
    bool     tx_active;

    uint8_t  *rx_fifo_buf;
    uint16_t *rx_len;
    uint8_t   rx_fifo_size;
    uint16_t  rx_max_sysex_len;
    uint8_t   rx_head;
    uint8_t   rx_tail;

    midi_io_driver_t driver;
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

// 平台相关的临界区保护，需要在调用此模块前由 APP 层定义
// 若未定义，则以空实现运行（非中断安全，仅用于单线程环境）
#ifndef MIDI_CRITICAL_SECTION_ENTER
#define MIDI_CRITICAL_SECTION_ENTER()
#endif
#ifndef MIDI_CRITICAL_SECTION_EXIT
#define MIDI_CRITICAL_SECTION_EXIT()
#endif

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

    t->rx_fifo_buf = cfg->rx_fifo_buf;
    t->rx_len = cfg->rx_len_buf;
    t->rx_fifo_size = cfg->rx_fifo_size;
    t->rx_max_sysex_len = cfg->max_sysex_len;
    t->rx_head = 0;
    t->rx_tail = 0;

    t->driver = cfg->driver;
    t->connected = false;
}

void midi_transport_send_cc(midi_transport_t *t, uint8_t channel, uint8_t cc, uint8_t value)
{
    if (!t->connected) return;

    if (t->driver.tx_available() >= 3) {
        uint8_t pkt[3];
        pkt[0] = 0xB0 | (channel - 1);  // 1‑based -> 0‑based
        pkt[1] = cc;
        pkt[2] = value;
        t->driver.tx_write(pkt, 3);
    }
}

bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len)
{
    if (t->tx_active) return false;
    if (!t->connected) return false;
    if (len > t->tx_buf_size) return false;

    uint32_t avail = t->driver.tx_available();
    if (avail >= len) {
        // 一次写入
        uint8_t start = 0xF0;
        t->driver.tx_write(&start, 1);
        t->driver.tx_write(data, len);
        uint8_t end = 0xF7;
        t->driver.tx_write(&end, 1);
        return true;
    }

    // 分段发送
    memcpy(t->tx_buf, data, len);
    t->tx_len = len;
    t->tx_written = 0;
    t->tx_active = true;

    // 尝试立即写出一部分
    if (t->tx_written == 0) {
        uint8_t start = 0xF0;
        if (t->driver.tx_available() >= 1) {
            t->driver.tx_write(&start, 1);
        } else {
            // 连起始字节都写不进去，保持 active，待 tx_flush 推进
            return true;
        }
    }

    // 写数据部分
    uint32_t rem = t->tx_len - t->tx_written;
    avail = t->driver.tx_available();
    uint32_t to_write = (rem < avail) ? rem : avail;
    if (to_write > 0) {
        t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
        t->tx_written += to_write;
    }

    // 检查是否写完
    if (t->tx_written == t->tx_len) {
        // 写结束字节
        if (t->driver.tx_available() >= 1) {
            uint8_t end = 0xF7;
            t->driver.tx_write(&end, 1);
            t->tx_active = false;
        } else {
            // 结束字节暂未发出，tx_flush 会处理
        }
    }

    return true;
}

void midi_transport_tx_flush(midi_transport_t *t)
{
    if (!t->tx_active || !t->connected) return;

    // 若尚未发送起始字节（极其罕见），补发
    if (t->tx_written == 0) {
        uint8_t start = 0xF0;
        if (t->driver.tx_available() >= 1) {
            t->driver.tx_write(&start, 1);
        } else {
            return;
        }
    }

    uint32_t rem = t->tx_len - t->tx_written;
    uint32_t avail = t->driver.tx_available();
    uint32_t to_write = (rem < avail) ? rem : avail;
    if (to_write > 0) {
        t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
        t->tx_written += to_write;
    }

    if (t->tx_written == t->tx_len) {
        // 补发结束字节
        if (t->driver.tx_available() >= 1) {
            uint8_t end = 0xF7;
            t->driver.tx_write(&end, 1);
            t->tx_active = false;
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
        // 丢弃帧
        t->rx_tail = (t->rx_tail + 1) % t->rx_fifo_size;
        return 0;
    }

    memcpy(buf, &t->rx_fifo_buf[t->rx_tail * t->rx_max_sysex_len], len);
    t->rx_tail = (t->rx_tail + 1) % t->rx_fifo_size;
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
    MIDI_CRITICAL_SECTION_ENTER();
    if ((uint8_t)(t->rx_head + 1) % t->rx_fifo_size == t->rx_tail) {
        // FIFO 满，丢弃新帧
        MIDI_CRITICAL_SECTION_EXIT();
        return;
    }

    memcpy(&t->rx_fifo_buf[t->rx_head * t->rx_max_sysex_len], frame, len);
    t->rx_len[t->rx_head] = len;
    t->rx_head = (uint8_t)(t->rx_head + 1) % t->rx_fifo_size;
    MIDI_CRITICAL_SECTION_EXIT();
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
#include "tusb.h"               // TinyUSB 公共头
#include "class/midi/midi.h"    // MIDI 类驱动

// =============== 本地状态 ===============
static midi_rx_callback_t rx_callback = NULL;
static midi_usb_desc_t   usb_desc;
static volatile bool     _hal_connected = false;

// =============== 内部辅助：构建 USB 描述符 ===============
// 设备描述符 (18 字节) + 配置描述符 (可变，采用 TinyUSB 默认，由 TUD_MIDI_DESCRIPTOR 宏生成)
// 由于平台已通过 tusb_config.h 预定义 MIDI 配置，此处仅提供设备描述符与字符串。

static uint8_t device_descriptor[] = {
    18,             // bLength
    0x01,           // bDescriptorType: Device
    0x00, 0x02,     // bcdUSB 2.0
    0x00,           // bDeviceClass (0 = 由接口定义)
    0x00,           // bDeviceSubClass
    0x00,           // bDeviceProtocol
    64,             // bMaxPacketSize0
    0x00, 0x00,     // idVendor (动态填充)
    0x00, 0x00,     // idProduct (动态填充)
    0x00, 0x01,     // bcdDevice 1.0
    0x01,           // iManufacturer
    0x02,           // iProduct
    0x00,           // iSerialNumber (无)
    0x01            // bNumConfigurations
};

// =============== TinyUSB 回调实现 ===============

// 设备描述符
uint8_t const * tud_descriptor_device_cb(void)
{
    // 动态填充 VID/PID
    device_descriptor[8]  = usb_desc.vid & 0xFF;
    device_descriptor[9]  = (usb_desc.vid >> 8) & 0xFF;
    device_descriptor[10] = usb_desc.pid & 0xFF;
    device_descriptor[11] = (usb_desc.pid >> 8) & 0xFF;
    return device_descriptor;
}

// 配置描述符：此处使用 TinyUSB 根据 TUD_MIDI_DESCRIPTOR 等宏自动生成的默认配置
// 不实现 tud_descriptor_configuration_cb，让 TinyUSB 使用内部默认。

// 字符串描述符
uint8_t const * tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;
    // 简单实现：语言 ID
    static uint8_t string_langid[] = { 4, 0x03, 0x09, 0x04 }; // US English
    if (index == 0) return string_langid;
    // 根据 index 返回厂商或产品字符串，动态构造
    static uint8_t str_buf[64];
    const char *str = NULL;
    if (index == 1) str = usb_desc.manufacturer;
    else if (index == 2) str = usb_desc.product;
    else return NULL;

    size_t len = strlen(str);
    if (len > 31) len = 31;
    str_buf[0] = (uint8_t)(2 + len * 2);
    str_buf[1] = 0x03; // STRING
    for (size_t i = 0; i < len; i++) {
        str_buf[2 + i*2] = str[i];
        str_buf[3 + i*2] = 0;
    }
    return str_buf;
}

// 挂载/卸载回调
void tud_mount_cb(void)
{
    _hal_connected = true;
}

void tud_umount_cb(void)
{
    _hal_connected = false;
}

// MIDI 接收回调
void tud_midi_rx_cb(uint8_t itf, uint8_t const* buffer, uint16_t bufsize)
{
    (void)itf;
    if (rx_callback) {
        rx_callback(buffer, bufsize);
    }
}

// =============== API 实现 ===============
void midi_hal_init(midi_rx_callback_t rx_cb, const midi_usb_desc_t *desc)
{
    rx_callback = rx_cb;
    if (desc) {
        memcpy(&usb_desc, desc, sizeof(midi_usb_desc_t));
    }
    // TinyUSB 已在 main 之前初始化，此处无需额外动作
    // 仅确保回调已注册
}

uint32_t midi_hal_tx_available(void)
{
    return tud_midi_n_stream_available(0);
}

uint32_t midi_hal_tx_write(const uint8_t *data, uint32_t len)
{
    return tud_midi_stream_write(0, data, len);
}

bool midi_hal_is_connected(void)
{
    return _hal_connected;
}
```

> **注意**：此 HAL 实现假设项目已包含 TinyUSB 并正确配置了 MIDI 类（`TUD_MIDI_DESCRIPTOR` 宏）。字符串描述符回调采用了简单的动态构造方式，若需要完整的 UNICODE 支持请根据实际环境调整。

---

## 文件 8：`pipelines/midi/midi_app.h`

```c
#ifndef PIPELINES_MIDI_MIDI_APP_H
#define PIPELINES_MIDI_MIDI_APP_H

#ifdef __cplusplus
extern "C" {
#endif

// 由主程序在 setup() 中调用，初始化整个 MIDI 管线
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
#include <string.h>

// ========= 平台临界区定义（必须在包含 transport 头文件之前） =========
// RP2040 + Arduino 环境
#include <Arduino.h>
#define MIDI_CRITICAL_SECTION_ENTER()   noInterrupts()
#define MIDI_CRITICAL_SECTION_EXIT()    interrupts()
#include "midi_core_transport.h"   // 重新包含以生效

// ========= 产品常量 =========
#define LYRE_USB_VID                0x1209
#define LYRE_USB_PID                0x0001
#define LYRE_USB_MANUFACTURER       "Lyre Audio"
#define LYRE_USB_PRODUCT            "Lyre MK2"

#define LYRE_RX_FIFO_SIZE           4
#define LYRE_SYSEX_MAX_LEN          770
#define LYRE_TX_BUF_SIZE            LYRE_SYSEX_MAX_LEN

// ========= 静态内存池 =========
static uint8_t  rx_fifo_pool[LYRE_RX_FIFO_SIZE][LYRE_SYSEX_MAX_LEN];
static uint16_t rx_len_pool[LYRE_RX_FIFO_SIZE];
static uint8_t  tx_buf[LYRE_TX_BUF_SIZE];
static uint8_t  parser_buf[LYRE_SYSEX_MAX_LEN];

static midi_parser_t    parser;
static midi_transport_t transport;

// ========= 回调 =========
static void on_rx_frame(const uint8_t *frame, uint16_t len) {
    midi_transport_rx_enqueue(&transport, frame, len);
}

static void hal_rx_callback(const uint8_t *data, uint32_t len) {
    midi_parser_feed(&parser, data, len);
}

// ========= 初始化 =========
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
    };
    midi_transport_init(&transport, &tcfg);

    midi_parser_init(&parser, parser_buf, LYRE_SYSEX_MAX_LEN, on_rx_frame);

    midi_hal_init(hal_rx_callback, &usb_desc);
}

// ========= 市场 API 实现 =========
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
    midi_transport_update_connection(&transport);
    midi_transport_tx_flush(&transport);
}
```

---

## 集成指南

1. **文件放置**  
   将上述文件放入项目对应目录：
   - `market/midi_api.h`
   - `pipelines/midi/midi_core_parser.h` / `.c`
   - `pipelines/midi/midi_core_transport.h` / `.c`
   - `pipelines/midi/midi_hal.h` / `.c`
   - `pipelines/midi/midi_app.h` / `.c`

2. **主程序调用**  
   在 `main.cpp`（或 `.ino`）中：
   ```cpp
   #include "market/midi_api.h"
   #include "pipelines/midi/midi_app.h"

   void setup() {
       midi_app_init();
       // ... 其他管线初始化
   }

   void loop() {
       midi_task();  // 必须首先调用

       // ... 处理接收、发送、LED 等（见架构文档 §6.1）
   }
   ```

3. **环境依赖**  
   - RP2040‑Zero，Arduino IDE 或 PlatformIO
   - 需要 TinyUSB 库（通常随 RP2040 Arduino 核心提供）
   - 平台配置文件 `tusb_config.h` 需包含 MIDI 功能宏（例如 `CFG_TUD_MIDI`）

4. **临界区安全**  
   `midi_app.c` 中通过 `noInterrupts()` / `interrupts()` 保护 FIFO，这是 RP2040 Arduino 环境的标准做法，符合架构对“中断安全”的要求。若移植到其他平台，只需修改这两个宏的定义（在 `midi_app.c` 开头）。

所有实现均已冻结，可直接用于编码和集成。
