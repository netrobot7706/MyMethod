经过逐项核实，本次审计中新发现的 5 个问题中：

- **L2-V1 / L2-V2** 确实存在，并会导致数据完整性问题，必须修复。
- **L2-V4** 属于误报：TinyUSB 的 MIDI 设备类**确实提供** `tud_midi_rx_cb(uint8_t itf, uint8_t const* buffer, uint16_t bufsize)` 回调（弱符号），我们的实现是正确的，不会导致接收失效。
- **L2-V5** 值得重视：为消除对 Arduino 运行时 `yield()` 的隐性依赖，应显式驱动 TinyUSB 任务。
- **L2-V3** 当前无实际风险，采纳注释建议即可。

以下是修复后的代码变更。

---

## 修复 1：`midi_core_transport.c` — 分段路径返回值检查（L2-V1 / L2-V2）

```c
// ===== midi_transport_send_sysex 分段路径修改 =====
bool midi_transport_send_sysex(midi_transport_t *t, const uint8_t *data, uint16_t len)
{
    if (t->tx_active) return false;
    if (!t->connected) return false;
    if (len > t->tx_buf_size) return false;

    // 一次性写入路径（已含返回值检查）
    if (t->driver.tx_available() >= (uint32_t)len + 2) {
        uint8_t start = 0xF0, end = 0xF7;
        if (t->driver.tx_write(&start, 1) != 1) return false;
        if (t->driver.tx_write(data, len) != len)   return false;
        if (t->driver.tx_write(&end, 1) != 1)       return false;
        return true;
    }

    // ---------- 分段路径 ----------
    memcpy(t->tx_buf, data, len);
    t->tx_len = len;
    t->tx_written = 0;
    t->tx_active = true;
    t->tx_start_sent = false;

    // 尝试发送 0xF0
    if (!t->tx_start_sent && t->driver.tx_available() >= 1) {
        uint8_t start = 0xF0;
        if (t->driver.tx_write(&start, 1) == 1) {   // 检查返回值
            t->tx_start_sent = true;
        }
    }

    if (t->tx_start_sent) {
        uint32_t avail = t->driver.tx_available();
        uint32_t rem = t->tx_len - t->tx_written;
        uint32_t to_write = (rem < avail) ? rem : avail;
        if (to_write > 0) {
            uint32_t written = t->driver.tx_write(t->tx_buf + t->tx_written, to_write);
            t->tx_written += (uint16_t)written;      // 使用实际写入量
        }

        if (t->tx_written == t->tx_len) {
            uint8_t end = 0xF7;
            if (t->driver.tx_available() >= 1) {
                if (t->driver.tx_write(&end, 1) == 1) { // 检查返回值
                    t->tx_active = false;
                    t->tx_start_sent = false;
                }
            }
        }
    }

    return true;
}

// ===== midi_transport_tx_flush 对应修改 =====
void midi_transport_tx_flush(midi_transport_t *t)
{
    if (!t->tx_active) return;

    if (!t->connected) {
        t->tx_active = false;
        t->tx_start_sent = false;
        t->tx_written = 0;
        return;
    }

    // 发送 0xF0
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
        t->tx_written += (uint16_t)written;          // 使用实际写入量
    }

    // 发送 0xF7
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
```

---

## 修复 2：`midi_hal.h` / `midi_hal.c` — 增加 `midi_hal_task()`（L2-V5）

**midi_hal.h** 中声明：

```c
// 驱动 TinyUSB 设备任务（必须在主循环中周期性调用）
void midi_hal_task(void);
```

**midi_hal.c** 中实现：

```c
void midi_hal_task(void)
{
    tud_task();   // 推进 TinyUSB 内部状态机
}
```

---

## 修复 3：`midi_app.c` — 调用 `midi_hal_task()`（L2-V5）

```c
void midi_task(void) {
    midi_hal_task();                                   // 驱动 TinyUSB
    midi_transport_update_connection(&transport);
    midi_transport_tx_flush(&transport);
}
```

---

## 修复 4：注释补充（L2-V3）

在 `midi_app.c` 临界区函数前增加注释：

```c
/*
 * 临界区保护策略：
 * - 所有使用者共享同一屏蔽级别（全局中断禁用）。
 * - 若未来需要独立屏蔽级别（如仅屏蔽 USB 中断），需将 enter/exit 改为 per-instance 回调。
 */
static volatile uint32_t crit_primask_save;
static volatile int      crit_nesting = 0;

static void port_enter_critical(void) { ... }
static void port_exit_critical(void) { ... }
```

---

## 关于 L2-V4 的说明

TinyUSB 官方 MIDI 设备驱动（`src/class/midi/midi_device.c`）提供了弱符号回调：

```c
__attribute__((weak)) void tud_midi_rx_cb(uint8_t itf, uint8_t const* buffer, uint16_t bufsize);
```

我们的 `midi_hal.c` 中实现的签名与其完全一致，会正确覆盖该弱符号，接收功能可正常工作。因此 L2-V4 不构成缺陷。

---

## 修复清单

| 编号 | 修复内容 | 文件 |
|------|---------|------|
| L2-V1 | `tx_written` 使用实际写入量累加 | `midi_core_transport.c` |
| L2-V2 | 0xF0/0xF7 写入检查返回值 | `midi_core_transport.c` |
| L2-V5 | 新增 `midi_hal_task()` 并在 `midi_task()` 中调用 | `midi_hal.h/c`, `midi_app.c` |
| L2-V3 | 添加多实例约束注释 | `midi_app.c` |
| L2-V4 | 确认为误报，无需修改 | — |

所有修复均遵循原有架构，代码已就绪可进入集成验证。
