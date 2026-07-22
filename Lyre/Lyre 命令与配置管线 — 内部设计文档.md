# Lyre 命令与配置管线 — 内部设计文档

> **文档版本**：v1.0  
> **最后更新**：2026-07-22  
> **父文档**：《Lyre 产品固件架构设计文档 v1.2》(LYRE_ARCHITECTURE.md)  
> **性质**：管线内部实现细节，**不对外暴露**，仅限管线内部开发者参考

---

## 1. 文件拆分方案

`cmd_config` 管线拆分为 **4 个源文件**，职责清晰分离：

| 文件 | 职责 | 行数估算 |
|:---|:---|:---|
| `cmd_app.c` | 桥梁代码：初始化、MIDI 回调注册、主循环驱动、命令表定义 | ~120 行 |
| `cmd_handlers.c/.h` | 产品命令 Handler 实现（read_cfg, write_cfg, read_adc, factory_reset） | ~200 行 |
| `config_mgr.c/.h` | RAM 配置快照管理、双缓冲原子切换、出厂默认值 | ~100 行 |
| `base_proto_config.h` | base_proto 编译期配置宏 | ~20 行 |

### 1.1 目录结构

```text
pipelines/cmd_config/
├── jigsaw.c/.h               # 已有资产，不修改
├── base_proto.c/.h           # 已有资产，不修改
├── base_proto_config.h       # 编译期配置
├── cmd_app.c                 # 桥梁 + 命令表 + 主循环驱动
├── cmd_handlers.c/.h         # 命令 Handler 实现
└── config_mgr.c/.h           # 配置快照管理
```

### 1.2 模块依赖关系

```text
cmd_app.c
  ├── 依赖：midi_api.h（注册回调、发送）
  ├── 依赖：storage_api.h（加载/保存）
  ├── 依赖：led_api.h（状态指示）
  ├── 依赖：cmd_handlers.h（命令表引用）
  ├── 依赖：config_mgr.h（配置管理）
  └── 依赖：base_proto.h（协议引擎）

cmd_handlers.c
  ├── 依赖：base_proto.h（base_proto_get_* 读取参数、base_proto_send_response 发送响应）
  ├── 依赖：config_mgr.h（读取/更新配置快照）
  ├── 依赖：storage_api.h（Flash 写入）
  ├── 依赖：led_api.h（触发 LED 事件）
  └── 依赖：pot_api.h（读取 ADC 原始值）

config_mgr.c
  └── 依赖：storage_api.h（仅用于类型定义 lyre_config_t）
```

---

## 2. config_mgr：双缓冲原子切换

### 2.1 内存布局

```c
// config_mgr.c 内部

// 双缓冲：两个静态实例，交替使用
static lyre_config_t buf_a;
static lyre_config_t buf_b;

// 全局指针，指向当前有效的配置
static const lyre_config_t* active_config = &buf_a;

// 写入标记，用于延迟写 Flash
static volatile bool write_pending = false;
static lyre_config_t* pending_buf = NULL;  // 指向正在准备的缓冲区
```

### 2.2 原子切换原理

RP2040 是 32 位 ARM Cortex-M0+，**单字（32-bit）指针写入是硬件原子的**。编译器对 `active_config = &buf_b;` 会生成一条 `STR` 指令，不会被中断打断。

```c
// 原子切换实现
void config_mgr_commit(void) {
    // 1. 确保 pending_buf 的数据已完整写入
    __DMB();  // Data Memory Barrier，确保之前的写入对后续读取可见

    // 2. 原子切换指针（单条 STR 指令）
    if (active_config == &buf_a) {
        active_config = &buf_b;
    } else {
        active_config = &buf_a;
    }

    // 3. 确保指针切换对后续读取可见
    __DMB();
}
```

### 2.3 pot_app 高频读取的安全性

`pot_app` 每 10ms 调用 `config_get_pot_config(i)`，可能恰好在 `config_mgr_commit()` 切换指针的瞬间。

**安全保证**：
- `pot_app` 读取的是 `active_config->pots[i]`，这是一个**完整的 `pot_config_t` 结构体拷贝**。
- 由于指针切换是原子的，`pot_app` 要么读到**旧配置**（切换前），要么读到**新配置**（切换后），绝不会读到"写了一半"的数据。
- `config_get_pot_config()` 的实现：

```c
const pot_config_t* config_get_pot_config(uint8_t index) {
    // 读取当前活跃指针（原子读）
    const lyre_config_t* cfg = active_config;
    return &cfg->pots[index];
}
```

### 2.4 出厂默认值

```c
// config_mgr.c 内部
static const lyre_config_t factory_defaults = {
    .pots = {
        { .midi_ch = 1, .cc = 1,  .min = 0, .max = 4095 },
        { .midi_ch = 1, .cc = 2,  .min = 0, .max = 4095 },
        { .midi_ch = 1, .cc = 3,  .min = 0, .max = 4095 },
        { .midi_ch = 1, .cc = 4,  .min = 0, .max = 4095 },
    },
    .crc32 = 0  // 运行时计算
};

void config_mgr_load_defaults(void) {
    buf_a = factory_defaults;
    active_config = &buf_a;
}
```

---

## 3. write_cfg：延迟写入方案（推荐）

### 3.1 问题背景

- **PRD 3.6.2**：要求"收到写 Flash 指令后，直接执行写入，写入期间暂停 ADC 和 MIDI"。
- **base_proto v1.16 AI Invariant #8**：命令 Handler **不能阻塞**（long operations must be offloaded）。

**矛盾**：Flash 写入 ≤200ms，但 Handler 不能阻塞。

### 3.2 解决方案：延迟写入（Deferred Write）

**核心思想**：Handler 只做"准备数据"，立即返回；Flash 写入推迟到 `base_proto_task()` 返回后，由 `cmd_app_task()` 执行。

```text
时序图：

[base_proto_task]
  │
  ├── 解析出 write_cfg 命令
  │
  ├── 调用 write_cfg_handler()
  │     ├── 提取参数，校验合法性
  │     ├── 准备 pending_buf（写入备用缓冲区）
  │     ├── 设置 write_pending = true
  │     └── 立即返回（不写 Flash）
  │
  └── base_proto_task() 返回

[cmd_app_task]
  │
  ├── 检查 write_pending
  │     ├── true → 执行 storage_save_config(pending_buf)  ← 阻塞 ≤200ms
  │     │     ├── 成功 → config_mgr_commit() 原子切换指针
  │     │     │     └── base_proto_send_response("write_cfg_ack")
  │     │     └── 失败 → BASE_PROTO_SEND_ERROR(4, "flash_write_error")
  │     └── false → 跳过
```

### 3.3 代码骨架

```c
// cmd_handlers.c

void write_cfg_handler(base_proto_ctx_t *ctx) {
    // 1. 提取 16 个参数（4 个推杆 × 4 个字段）
    lyre_config_t* target = config_mgr_get_write_buffer();  // 获取备用缓冲区指针
    if (!target) {
        BASE_PROTO_SEND_ERROR(ctx, 4, "config_busy");
        return;
    }

    // 2. 逐个提取并校验
    for (int i = 0; i < 4; i++) {
        uint32_t ch, cc, min, max;
        char key_ch[16], key_cc[16], key_min[16], key_max[16];
        snprintf(key_ch,  sizeof(key_ch),  "%d_midi_ch", i);
        snprintf(key_cc,  sizeof(key_cc),  "%d_cc",      i);
        snprintf(key_min, sizeof(key_min), "%d_min",     i);
        snprintf(key_max, sizeof(key_max), "%d_max",     i);

        if (!base_proto_get_uint(ctx, key_ch,  &ch)  ||
            !base_proto_get_uint(ctx, key_cc,  &cc)  ||
            !base_proto_get_uint(ctx, key_min, &min) ||
            !base_proto_get_uint(ctx, key_max, &max)) {
            BASE_PROTO_SEND_ERROR(ctx, 3, "missing_fields");
            return;
        }

        // 业务校验
        if (ch < 1 || ch > 16) {
            BASE_PROTO_SEND_ERROR(ctx, 3, "ch_range_1_16");
            return;
        }
        if (cc > 127) {
            BASE_PROTO_SEND_ERROR(ctx, 3, "cc_range_0_127");
            return;
        }
        if (min >= max || min > 4095 || max > 4095) {
            BASE_PROTO_SEND_ERROR(ctx, 3, "min_max_invalid");
            return;
        }

        target->pots[i].midi_ch = (uint8_t)ch;
        target->pots[i].cc      = (uint8_t)cc;
        target->pots[i].min     = (uint16_t)min;
        target->pots[i].max     = (uint16_t)max;
    }

    // 3. 标记延迟写入
    config_mgr_set_write_pending();
    led_trigger(LED_EVT_SAVING);
}
```

```c
// cmd_app.c

void cmd_app_task(void) {
    uint32_t now = millis();

    // 1. 驱动 base_proto
    base_proto_task(&proto_ctx, now);

    // 2. 检查延迟写入
    if (config_mgr_is_write_pending()) {
        lyre_config_t* pending = config_mgr_get_pending_buffer();

        // 同步写入 Flash（阻塞 ≤200ms）
        bool ok = storage_save_config(pending);

        if (ok) {
            config_mgr_commit();  // 原子切换指针
            base_proto_send_response(&proto_ctx, "write_cfg_ack", NULL);
            led_trigger(LED_EVT_SAVE_DONE);
        } else {
            BASE_PROTO_SEND_ERROR(&proto_ctx, 4, "flash_write_error");
            led_trigger(LED_EVT_IDLE);
        }

        config_mgr_clear_write_pending();
    }
}
```

### 3.4 写入期间的系统行为

| 行为 | 状态 | 说明 |
|:---|:---|:---|
| ADC 采集 | ⏸️ 暂停 | `pot_app_poll()` 不被调用 |
| MIDI 发送 | ⏸️ 暂停 | 无新的 CC 消息发出 |
| USB 中断 | ✅ 正常 | TinyUSB 中断仍活跃，`base_proto_on_midi_cc` 仍能喂入字节 |
| Jigsaw 信号 drain | ✅ 正常 | ISR 中仍可 drain ACK/NAK |
| base_proto 心跳 | ⏸️ 暂停 | 但 30s 超时远大于 200ms，不会误触发 |

**结论**：200ms 的短暂暂停对用户体验无影响（推杆采样率从 100Hz 降到 ~5Hz，人耳/手感无法察觉），且不会导致协议超时。

---

## 4. factory_reset 回调实现

### 4.1 流程

```c
// cmd_app.c

static void on_factory_reset(void) {
    led_trigger(LED_EVT_FACTORY_RESETTING);

    // 1. 擦除 Flash
    bool ok = storage_factory_reset();

    // 2. 恢复 RAM 默认值
    config_mgr_load_defaults();

    // 3. 发送 ACK（base_proto 要求必须调用）
    if (ok) {
        base_proto_send_response(&proto_ctx, "factory_reset_ack", NULL);
        led_trigger(LED_EVT_FACTORY_DONE);
    } else {
        base_proto_async_fail(&proto_ctx, 4, "flash_erase_error");
        led_trigger(LED_EVT_IDLE);
    }
}
```

### 4.2 注意事项

- `factory_reset_cb` 是在 `base_proto_task()` 内部调用的，因此**不能阻塞太久**。
- `storage_factory_reset()` 实现为"删除配置文件"（LittleFS `remove`），耗时 ≤50ms，可接受。
- 如果 Flash 擦除失败，调用 `base_proto_async_fail()` 取消异步状态并发送错误帧。

---

## 5. 状态变化回调

### 5.1 连接状态管理

```c
// cmd_app.c

static void on_state_change(base_proto_state_t new_state) {
    if (new_state == BASE_PROTO_CONNECTED) {
        led_trigger(LED_EVT_TEST_MODE);  // 紫色闪烁，表示已连接
    } else {
        led_trigger(LED_EVT_IDLE);       // 白色呼吸，表示空闲
    }
}
```

### 5.2 状态查询 API

```c
// config_mgr.c

static base_proto_state_t current_proto_state = BASE_PROTO_IDLE;

void config_mgr_set_proto_state(base_proto_state_t st) {
    current_proto_state = st;
}

bool config_is_connected(void) {
    return current_proto_state == BASE_PROTO_CONNECTED;
}
```

---

## 6. 命令表定义

```c
// cmd_app.c

static const cmd_def_t lyre_cmds[] = {
    {
        .name = "read_cfg",
        .handler = read_cfg_handler,
        .domain = CMD_CONFIG,
        .flags = CMD_FLAG_REQUIRE_CONNECTED,
        .required_keys = "",
        .forbidden_keys = "*",  // 不允许任何额外字段
        .timeout_ms = 0
    },
    {
        .name = "write_cfg",
        .handler = write_cfg_handler,
        .domain = CMD_CONFIG,
        .flags = CMD_FLAG_REQUIRE_CONNECTED,
        .required_keys = "0_midi_ch 0_cc 0_min 0_max "
                         "1_midi_ch 1_cc 1_min 1_max "
                         "2_midi_ch 2_cc 2_min 2_max "
                         "3_midi_ch 3_cc 3_min 3_max",
        .forbidden_keys = "",
        .timeout_ms = 0
    },
    {
        .name = "read_adc",
        .handler = read_adc_handler,
        .domain = CMD_CONFIG,
        .flags = CMD_FLAG_REQUIRE_CONNECTED,
        .required_keys = "pot",
        .forbidden_keys = "",
        .timeout_ms = 0
    },
};
```

---

## 7. 错误码映射

| 错误码 | 含义 | 触发场景 |
|:---|:---|:---|
| 1 | Frame / transport error | base_proto 内部处理 |
| 2 | Unknown command | base_proto 内部处理 |
| 3 | Invalid parameter | Handler 中校验失败（missing fields, range error） |
| 4 | Internal execution failure | Flash 写入失败、配置忙 |
| 6 | Not connected | 未握手时发送 config 命令，base_proto 内部处理 |
| 7 | Async timeout | base_proto 内部处理 |

**Lyre 产品自定义错误码（≥8）**：

| 错误码 | 含义 | 触发场景 |
|:---|:---|:---|
| 8 | `pot_must_be_0_to_3` | `read_adc` 的 `pot` 参数不在 0-3 范围内 |

---

## 8. 初始化完整流程

```c
// cmd_app.c

static base_proto_ctx_t proto_ctx;

static void on_midi_cc_bridge(uint8_t status, uint8_t data1, uint8_t data2, uint32_t ts) {
    uint8_t ch = status & 0x0F;
    uint8_t cc = data1;
    uint8_t val = data2;
    base_proto_on_midi_cc(&proto_ctx, ch, cc, val, ts);
}

void cmd_app_init(void) {
    // 1. 加载配置
    lyre_config_t cfg;
    if (!storage_load_config(&cfg)) {
        config_mgr_load_defaults();
    } else {
        config_mgr_update_snapshot(&cfg);
    }

    // 2. 初始化 base_proto
    base_proto_init(&proto_ctx,
                    "Veloce-A1B2",
                    "1.0.0",
                    "1.4",
                    512,
                    lyre_cmds,
                    sizeof(lyre_cmds)/sizeof(lyre_cmds[0]),
                    midi_send_raw,
                    JIGSAW_ENTER_CRITICAL,
                    JIGSAW_EXIT_CRITICAL,
                    on_state_change,
                    on_factory_reset,
                    NULL);

    // 3. 注册 MIDI 接收回调
    midi_register_cc_callback(on_midi_cc_bridge);
}
```

---

## 9. 主循环集成

```c
// main.cpp

void setup() {
    led_app_init();
    storage_app_init();
    midi_app_init();
    cmd_app_init();
    pot_app_init();
}

void loop() {
    midi_app_poll();       // TinyUSB 后台任务
    cmd_app_task();        // base_proto 驱动 + 延迟写入
    pot_app_poll();        // 电位器采集与 MIDI 发送
    led_app_tick();        // LED 动作引擎驱动
}
```

---

## 10. AI Invariants（命令与配置管线专用）

1. **命令表不可变**：`lyre_cmds` 数组必须为 `static const`，生命周期与 `proto_ctx` 相同。
2. **Handler 不阻塞**：所有命令 Handler 必须立即返回，Flash 写入通过延迟机制在 `cmd_app_task()` 中执行。
3. **配置指针原子性**：`active_config` 的切换必须使用单条 `STR` 指令，前后加 `__DMB()` 内存屏障。
4. **write_cfg 单次性**：同一时刻只能有一个 `write_pending`，若收到新的 `write_cfg` 而旧的未完成，返回错误码 4。
5. **factory_reset 必须 ACK**：`on_factory_reset` 回调必须调用 `base_proto_send_response("factory_reset_ack")` 或 `base_proto_async_fail()`。
6. **MIDI 回调重入**：`on_midi_cc_bridge` 可能在 ISR 和 Task 上下文中被调用，`base_proto_on_midi_cc` 内部已处理重入。
7. **parsed data 生命周期**：Handler 中 `base_proto_get_str()` 返回的指针仅在 Handler 执行期间有效，不可存储。
