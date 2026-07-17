## Veloce 基础命令协议模块 — 架构设计（编码规格书 v7）

### 1. 模块定位
- 完全封装 Jigsaw 传输层，对外零 Jigsaw 依赖。
- 提供应用帧解析、设备状态机、系统域命令实现、配置域命令注册/分发、应答帧构造发送。
- 产品层只实现业务逻辑，底座负责所有协议通用机制。

### 2. 类型定义

```c
// 应用状态
typedef enum {
    BASE_PROTO_IDLE,
    BASE_PROTO_CONNECTED
} base_proto_state_t;

// 回调函数类型
typedef void (*midi_send_cb_t)(uint8_t status, uint8_t data1, uint8_t data2);
typedef void (*enter_critical_cb_t)(void);
typedef void (*exit_critical_cb_t)(void);
typedef void (*state_change_cb_t)(base_proto_state_t new_state);
typedef void (*factory_reset_cb_t)(void);

// 命令域
typedef enum { CMD_SYSTEM, CMD_CONFIG } cmd_domain_t;

// 命令标志
typedef enum {
    CMD_FLAG_NONE               = 0,
    CMD_FLAG_REQUIRE_CONNECTED  = (1 << 0),
    CMD_FLAG_ASYNC              = (1 << 1),
} cmd_flags_t;

// 命令处理函数
typedef void (*cmd_handler_t)(struct base_proto_ctx_t *ctx);

// 命令定义
typedef struct {
    const char   *name;
    cmd_handler_t handler;
    cmd_domain_t  domain;
    uint32_t      flags;
    const char   *required_keys;  // 空格分隔，NULL 或 "" 无要求
    const char   *forbidden_keys; // 空格分隔，NULL 或 "" 无要求；
                                  // "*" 表示除 cmd 外禁止任何字段
    uint32_t      timeout_ms;     // 仅 ASYNC 有效，0 使用默认 5000ms
} cmd_def_t;

// 不透明上下文（产品层仅持有实例，不访问成员）
typedef struct base_proto_ctx_t base_proto_ctx_t;
```

### 3. 对外 API

```c
// 初始化
void base_proto_init(base_proto_ctx_t *ctx,
                     const char *device_id,
                     const char *fw_version,
                     const char *biz_proto_ver,
                     uint16_t max_frame_len,         // 必须 ≤ BASE_PROTO_MAX_FRAME_LEN
                     const cmd_def_t *cmd_table,
                     size_t cmd_count,
                     midi_send_cb_t midi_send,
                     enter_critical_cb_t enter_crit,
                     exit_critical_cb_t exit_crit,
                     state_change_cb_t on_state_change,
                     factory_reset_cb_t factory_reset_cb);   // 可选 NULL

// ISR 中喂入 MIDI CC
void base_proto_on_midi_cc(base_proto_ctx_t *ctx, uint8_t ch,
                           uint8_t cc, uint8_t val, uint32_t now_ms);

// 主循环任务处理（5~10ms 周期调用）
void base_proto_task(base_proto_ctx_t *ctx, uint32_t now_ms);

/**
 * 发送命令应答帧（仅任务上下文，高优先级，排队不覆盖）
 *
 * 参数: ctx, cmd, 后续为 key, value 对，必须以 NULL 终止。
 * 所有 value 必须为 const char* 类型（整数需提前转换为字符串）。
 * 若出现奇数个额外参数（缺少 value），函数返回 false 并忽略本次调用。
 *
 * 返回: true  = 帧已入队（将在下次 task 中提交至 Jigsaw）
 *       false = 参数错误或内部队列已满
 */
bool base_proto_send_response(base_proto_ctx_t *ctx, const char *cmd, ...);

/**
 * 发送异步数据帧（仅任务上下文，低优先级，可覆盖旧帧）
 *
 * 参数约定与 send_response 相同。
 * 覆盖语义：若前一个异步帧尚未提交至 Jigsaw（仍在内部队列中），
 * 新帧将直接替换旧帧内容；若已提交则无法撤回，新帧排队等待。
 */
bool base_proto_send_async(base_proto_ctx_t *ctx, const char *cmd, ...);

// 便捷错误帧宏（仅任务上下文）
// 注意：msg 必须使用下划线替代空格，不含 [ ] ; =
#define BASE_PROTO_SEND_ERROR(ctx, code, msg) \
    base_proto_send_response((ctx), "error", "code", #code, "msg", (msg), NULL)

// 参数获取辅助函数（任意上下文可用）
bool base_proto_get_str(const base_proto_ctx_t *ctx, const char *key, const char **value);
bool base_proto_get_int(const base_proto_ctx_t *ctx, const char *key, int32_t *value);
bool base_proto_get_uint(const base_proto_ctx_t *ctx, const char *key, uint32_t *value);
bool base_proto_has_field(const base_proto_ctx_t *ctx, const char *key);

// 字段计数（仅用于调试/日志，禁止在业务逻辑中依赖该值做控制流判断）
uint8_t base_proto_field_count(const base_proto_ctx_t *ctx);
```

### 4. 编译期配置与资源预算

#### 4.1 必须定义的宏

产品层须创建 `base_proto_config.h`，至少定义：

```c
#define BASE_PROTO_MAX_FRAME_LEN   512   // 512 ~ 8192
#define BASE_PROTO_MAX_FIELDS      20    // 可选，默认 20
```

#### 4.2 RAM 预算参考表

以 `BASE_PROTO_MAX_FRAME_LEN = 512` 为例：

| 缓冲区 | 大小 (字节) | 说明 |
|:---|:---|:---|
| Jigsaw RX buffer | 528 | `MAX_FRAME_LEN + 16` |
| Jigsaw TX buffer (copy) | 512 | 拷贝模式 |
| 应用层 RX 中间缓冲 | 513 | `MAX_FRAME_LEN + 1`，ISR 中拷贝帧 |
| 命令应答格式化缓冲 | 513 | `MAX_FRAME_LEN + 1` |
| 异步帧格式化缓冲 | 513 | `MAX_FRAME_LEN + 1` |
| 解析字段数组 | ~320 | `MAX_FIELDS × 16` |
| Jigsaw 上下文 | ~200 | 估算 |
| 其他状态变量 | ~100 | 估算 |
| **总计** | **~3.2 KB** | |

若 `MAX_FRAME_LEN = 8192`，总计约 **~25 KB**。请根据目标 MCU 评估可行性。

#### 4.3 Flash 预算参考

底座代码段约 **2~3 KB**（含 Jigsaw），若使用标准库 `snprintf` 需额外约 **2 KB**，总计 **4~5 KB**。对资源敏感场景可考虑轻量级字符串拼接替代 `snprintf`。

#### 4.4 双重拷贝说明

发送一帧经历两次内存拷贝：应用格式化缓冲 → Jigsaw TX 缓冲 → MIDI 输出。这简化了状态管理但消耗额外 RAM。若需优化可启用 `JIGSAW_ZERO_COPY_TX`，让 Jigsaw 直接引用应用缓冲区，但需保证传输期间缓冲区不被覆盖（异步帧覆盖保护逻辑需同步调整）。当前默认采用拷贝模式以保证安全性。

#### 4.5 MISRA C 合规性说明

`base_proto_send_response` / `base_proto_send_async` 使用了 C 变参函数（`<stdarg.h>`），违反 MISRA C:2012 Rule 17.1。若项目要求 MISRA 合规，须将变参接口替换为键值对数组传参方式（如 `kv_pair_t pairs[], size_t count`），或使用 Builder 模式逐字段添加。当前设计优先易用性，可在后续版本提供合规替代接口。

### 5. 命令分发器自动校验规则（不变）

按顺序执行：

1. 状态检查：`REQUIRE_CONNECTED` 且 IDLE → 错误码 6。
2. 必填检查：缺失 `required_keys` 中任一 key → 错误码 3。
3. 禁止字段检查：`forbidden_keys` 为 `"*"` 时除 `cmd` 外禁止任何字段；否则检查是否包含列表中 key → 错误码 3。
4. 重复 key 由解析引擎拒绝，不进入分发器。

设备端不执行基于协议版本的拒绝逻辑。

### 6. 异步命令生命周期

#### 6.1 ACK 命名硬约束
异步命令的应答帧 `cmd` 名**必须**为 `<name>_ack` 格式。底座通过拼接 `name + "_ack"` 进行匹配（例如 `factory_reset` 的应答为 `factory_reset_ack`）。产品层若需非标准命名，须修改底座内部匹配逻辑或在 `cmd_def_t` 中增加 `ack_name` 字段——当前版本不支持。

#### 6.2 生命周期流程
1. 分发器调用带有 `CMD_FLAG_ASYNC` 的处理函数。
2. 处理函数启动异步操作后返回，**不应答**。
3. 底座启动超时定时器（`timeout_ms`，0 则使用 5000ms）。
4. 等待期间，底座正常处理其他命令（串行模型不受影响）。
5. 产品层异步操作完成后，在任务上下文中调用 `base_proto_send_response` 发送对应的 `_ack` 帧。底座根据拼接的名称匹配，匹配后取消定时器。
6. 超时未收到应答，底座自动发送 `[cmd=error;code=4;msg=async_timeout]`。
7. **同一时刻最多 1 个异步命令挂起**。若已有挂起时收到新异步命令，分发器直接返回 `[cmd=error;code=3;msg=stream_active]`（不调用处理函数）。
8. 连接超时回退 IDLE 时，**取消所有挂起的异步命令定时器**，并调用 `on_state_change`。产品层应在回调中终止底层异步操作。

### 7. 传输层错误处理策略

底座内部监控 Jigsaw 状态，执行以下默认策略：

| Jigsaw 事件 | 底座行为 |
|:---|:---|
| `JIGSAW_TX_FRAME_FAILED` | 应用层重试最多 2 次（应答帧）；异步帧直接丢弃。若最终失败，记录日志（可选）。 |
| `JIGSAW_TX_ABORTED` | 依赖 Jigsaw 自动重试（若 `JIGSAW_AUTO_RETRY` 启用），否则重新提交。 |
| `JIGSAW_ERR_BUS_BUSY` | 延迟到下一个 `base_proto_task` 周期重试提交。 |
| 其他传输层错误 | 记录状态，不影响应用层状态机。 |

### 8. 内部数据流详解

#### 8.1 下行（接收）路径

```
ISR: jigsaw_rx_feed → FRAME_COMPLETE
  → jigsaw_rx_get_frame 获取原始字节指针
  → memcpy 到 ctx.app_rx_buf (大小 BASE_PROTO_MAX_FRAME_LEN+1)
  → jigsaw_rx_release_frame
  → 设置 frame_ready 标志

Task (base_proto_task):
  → 检测 frame_ready
  → 对 app_rx_buf 进行字符级解析（状态机）
  → 提取键值对到 parsed_fields[]
  → 校验通过则设置 cmd_ready
  → 校验失败则设置待发送错误标志（帧格式/溢出/重复key等）
```

**关键点**：ISR 中必须完成拷贝并释放 Jigsaw 帧，防止下一帧覆盖。应用层解析在 Task 中执行，不影响 ISR 延迟。

**安全性依赖**：解析期间 `app_rx_buf` 可能被新收到的帧覆盖，但因协议采用严格串行模型（上位机发一条命令→等待应答→发下一条），在设备发送应答前上位机不应发送新命令，因此 Task 有充足时间完成解析和应答，ISR 不会在此期间收到新帧。此窗口天然受协议层保护。若未来支持命令流水线，需引入双缓冲机制。

#### 8.2 上行（发送）路径

```
产品层 / 命令处理函数 (Task context):
  → base_proto_send_response(...) 格式化到 cmd_tx_buf
  → 置位 cmd_tx_pending

  → base_proto_send_async(...) 格式化到 async_tx_buf (覆盖旧内容)
  → 置位 async_tx_pending

base_proto_task:
  → 检查 Jigsaw 状态 (bus_is_free && !tx_has_pending)
  → 优先提交 cmd_tx_buf (若 pending)
  → 其次提交 async_tx_buf (若 pending)
  → 提交后等待 Jigsaw 发送完成 (TX_FRAME_COMPLETE / TX_FRAME_FAILED)
```

### 9. 解析引擎参考伪代码

```
parse_byte(ctx, byte):
  switch ctx.parse_state:
    case IDLE:
      if byte == '[':
        ctx.parse_state = RECEIVING
        ctx.buf_len = 0
        ctx.frame_start_ms = current_ms
    case RECEIVING:
      if byte == ']':
        // 空帧 [] 不直接丢弃，交由 validate_and_store_frame 统一处理：
        // 该函数会检测缺少 cmd 字段并标记 invalid_frame 错误
        validate_and_store_frame(ctx)
        ctx.parse_state = IDLE
      else if byte == '[':
        // 未闭合的 '['，丢弃前帧，开始新帧
        ctx.buf_len = 0
        ctx.frame_start_ms = current_ms
      else if ctx.buf_len >= BASE_PROTO_MAX_FRAME_LEN:
        ctx.parse_state = IGNORE_UNTIL_BRACKET
        ctx.error_code = FRAME_TOO_LONG
      else:
        ctx.buf[ctx.buf_len++] = byte
    case IGNORE_UNTIL_BRACKET:
      if byte == ']':
        set_pending_error(FRAME_TOO_LONG)
        ctx.parse_state = IDLE
      // else: discard byte
```

**超时检查**（在 `base_proto_task` 中）：
若状态非 IDLE 且 `now - frame_start_ms > 1000`，复位状态机并设置 `FRAME_TIMEOUT` 错误。

**超时与溢出的优先级**：若在 `IGNORE_UNTIL_BRACKET` 状态触发超时（即收到 `[` 后 1000ms 内既未收到 `]` 也未发生溢出，或溢出后 1000ms 内仍未收到 `]`），统一上报 `frame_timeout` 错误。`frame_timeout` 优先级高于 `frame_too_long`：任何非 IDLE 状态下超时均以超时为准。

### 10. 状态转换图

#### 10.1 应用层连接状态
```
IDLE ──(收到 handshake)──→ CONNECTED
CONNECTED ──(30s 无活动 or 连接超时)──→ IDLE
```

#### 10.2 解析器状态
```
IDLE ──('[')──→ RECEIVING
RECEIVING ──(']')──→ IDLE (帧完成)
RECEIVING ──(溢出)──→ IGNORE_UNTIL_BRACKET
IGNORE_UNTIL_BRACKET ──(']')──→ IDLE (frame_too_long 错误)
任意非 IDLE ──(1000ms 超时)──→ IDLE (frame_timeout 错误)
```

#### 10.3 TX 侧状态
```
IDLE ──(send_response)──→ CMD_PENDING
IDLE ──(send_async)──→ ASYNC_PENDING
CMD_PENDING + ASYNC_PENDING 同时存在时，优先发送 CMD
发送完成后回 IDLE
```

### 11. 产品层集成示例

```c
// base_proto_config.h
#define BASE_PROTO_MAX_FRAME_LEN   512

// main.c
#include "base_proto.h"

static base_proto_ctx_t base_ctx;
static volatile bool g_factory_reset_done = false;

void on_state_change(base_proto_state_t new_state) {
    if (new_state == BASE_PROTO_IDLE) {
        stop_adc_stream();
        // 如有挂起的异步操作，此处应取消
    }
}

void factory_reset_handler(void) {
    flash_erase_all_async(on_flash_done);  // 异步启动
}

void on_flash_done(void) {
    g_factory_reset_done = true;           // 仅设标志，禁止在此调用发送API
}

void read_pot_handler(base_proto_ctx_t *ctx) {
    int32_t pot;
    if (!base_proto_get_int(ctx, "pot", &pot)) {
        BASE_PROTO_SEND_ERROR(ctx, 3, "missing_parameter");
        return;
    }
    char val_str[12];
    snprintf(val_str, sizeof(val_str), "%d", pot);
    base_proto_send_response(ctx, "read_pot_ack", "pot", val_str, NULL);
}

static const cmd_def_t my_cmds[] = {
    { "read_pot", read_pot_handler, CMD_CONFIG,
      CMD_FLAG_REQUIRE_CONNECTED, "pot", NULL, 0 },
    // ...
};

void main_init() {
    base_proto_init(&base_ctx,
                    "Veloce-A1B2", "1.0", "1.3",
                    BASE_PROTO_MAX_FRAME_LEN,
                    my_cmds, ARRAY_SIZE(my_cmds),
                    my_midi_send, enter_crit, exit_crit,
                    on_state_change, factory_reset_handler);
}

void on_midi_cc(uint8_t ch, uint8_t cc, uint8_t val) {
    base_proto_on_midi_cc(&base_ctx, ch, cc, val, get_monotonic_ms());
}

void main_loop() {
    uint32_t now = get_monotonic_ms();

    base_proto_task(&base_ctx, now);

    // 处理异步完成标志
    if (g_factory_reset_done) {
        g_factory_reset_done = false;
        base_proto_send_response(&base_ctx, "factory_reset_ack", NULL);
    }

    sleep_ms(5);
}
```

### 12. factory_reset 时序约束

`factory_reset` 命令的上位机超时为 5000ms 且不重试。产品层实现必须确保 Flash 操作在 **5000ms 内完成** 并调用 `send_response`。若硬件无法保证，应改为仅擦除配置扇区而非全片擦除，或采取分段擦除策略。

### 13. 实现检查清单

- [ ] 定义 `base_proto_config.h`，配置 `BASE_PROTO_MAX_FRAME_LEN` 和 `BASE_PROTO_MAX_FIELDS`。
- [ ] 实现 `midi_send` 及临界区回调（须 ISR 安全）。
- [ ] 定义命令表，明确 `required_keys`、`forbidden_keys`、超时时间。
- [ ] 所有异步完成回调仅设标志，在主循环中调用 `base_proto_send_response`。
- [ ] 错误消息使用下划线，避免非法字符。
- [ ] 评估 RAM/Flash 预算是否满足目标平台。
- [ ] 若需 MISRA 合规，准备变参函数的替代方案。

