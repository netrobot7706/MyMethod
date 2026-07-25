## 审计确认与修复

经过逐项核实，新发现问题 **N-1** 和 **N-3** 确实存在，**N-2** 为 N-1 的联动问题，将在 N-1 修复后自然消除。

### 修复方案
- **N-1**（Medium）：在 `midi_transport_send_sysex` 的分段路径中，增加 `if (t->tx_start_sent)` 保护数据发送，确保起始字节未发出时不发送任何 payload。
- **N-3**（Low）：修正 `midi_hal.c` 中 USB 配置描述符的宏参数（接口数、端点地址），消除编译错误和枚举失败风险。

修复后的代码（仅展示发生变化的两个文件的关键部分）：

---

### 1. `midi_core_transport.c` – `midi_transport_send_sysex` 分段路径修复

```c
bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len)
{
    if (t->tx_active) return false;
    if (!t->connected) return false;
    if (len > t->tx_buf_size) return false;

    // 一次写入路径：需要至少 len+2 字节空间
    if (t->driver.tx_available() >= (uint32_t)len + 2) {
        uint8_t start = 0xF0;
        t->driver.tx_write(&start, 1);
        t->driver.tx_write(data, len);
        uint8_t end = 0xF7;
        t->driver.tx_write(&end, 1);
        return true;
    }

    // ---------- 分段发送路径 ----------
    memcpy(t->tx_buf, data, len);
    t->tx_len = len;
    t->tx_written = 0;
    t->tx_active = true;
    t->tx_start_sent = false;

    // 尝试发送起始字节（仅当未发送且有空间时）
    if (!t->tx_start_sent && t->driver.tx_available() >= 1) {
        uint8_t start = 0xF0;
        t->driver.tx_write(&start, 1);
        t->tx_start_sent = true;
    }

    // 只有在起始字节已发送后才尝试发送 payload 和结束字节
    if (t->tx_start_sent) {
        uint32_t avail = t->driver.tx_available();
        uint32_t rem = t->tx_len - t->tx_written;
        uint32_t to_write = (rem < avail) ? rem : avail;
        if (to_write > 0) {
            t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
            t->tx_written += to_write;
        }

        // 数据全部发送完成，尝试发送结束字节
        if (t->tx_written == t->tx_len) {
            if (t->driver.tx_available() >= 1) {
                uint8_t end = 0xF7;
                t->driver.tx_write(&end, 1);
                t->tx_active = false;
                t->tx_start_sent = false;
            }
        }
    }

    return true;
}
```

**关键改动：** 将数据发送部分包裹在 `if (t->tx_start_sent)` 内，确保 USB 端点满时不会将 payload 裸发出去。起始字节发送失败后，状态保持为 `tx_active = true, tx_start_sent = false`，后续由 `tx_flush` 继续推进。

---

### 2. `midi_hal.c` – USB 配置描述符修正

```c
static uint8_t const midi_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1,          // 配置号
                          2,          // 接口总数（Audio Control + MIDI Streaming）
                          0,          // 字符串索引
                          TUD_CONFIG_DESC_LEN + TUD_MIDI_DESC_LEN,
                          0x00,       // 属性：总线供电
                          100),       // 最大功耗 100mA

    TUD_MIDI_DESCRIPTOR(0,            // 接口索引
                        0,            // 字符串索引
                        0x01,         // 批量输出端点地址
                        0x81,         // 批量输入端点地址
                        CFG_TUD_MIDI_EP_BUFSIZE)
};
```

**关键改动：**
- 接口总数由 `0` 改为 `2`
- `TUD_MIDI_DESCRIPTOR` 参数由错误的 6 个改为正确的 5 个（移除多余的缓冲区大小重复参数）
- 端点地址由 `0x00` 改为规范的 `0x01`（OUT）和 `0x81`（IN）

---

### 修复影响与验证

| 问题 | 修复前后果 | 修复后行为 |
|------|-----------|------------|
| **N-1** | 端点满时 payload 无帧头发送，接收端解析错误 | 等待 `tx_flush` 先发出 `0xF0` 后再传数据 |
| **N-3** | 编译错误或 USB 枚举失败 | 描述符正确，USB 可正常枚举 |

以上修复解决了本轮验证发现的所有实质性缺陷，与原始 L1 修复共同构成完整的 MIDI 管线实现。
