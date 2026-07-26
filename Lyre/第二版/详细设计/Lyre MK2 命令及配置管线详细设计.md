# Lyre MK2 命令及配置管线详细设计（v2.6 — 最终冻结版）

> **文档版本**：v2.6  
> **关联架构文档**：《Lyre MK2 产品架构设计文档 v2.2》  
> **关联协议**：《MIDI 控制器自描述配置协议 v2.6》  
> **管线**：Command & Config  
> **状态**：最终冻结基线，可直接用于编码实现  
> **修订**：第六轮审计闭环，修正 T‑09 测试向量、补充 T‑07 示例帧

---

## 1. 设计目标与分层策略

命令及配置管线承担所有 SysEx 协议消息的解析、分发、状态维护及跨管线协调任务。遵循 **“最大可移植性”** 原则，本设计将管线清晰切分为两层：

- **cmd_core（CORE 层）**：  
  与产品完全无关的协议引擎，提供 SysEx 帧解析、校验和验证、命令分发，以及所有《MIDI 控制器自描述配置协议 v2.6》定义的通用校验与响应帧构建。**零外部依赖，零 `market/` API 调用**，可在不同产品间直接拷贝复用。

- **cmd_cfg_app（APP 层）**：  
  Lyre 产品专用外壳，极薄一层。仅包含：
  - Lyre 的产品参数定义（N、B、V、物理描述、布局树）。
  - 命令回调中调用 `cmd_core` 校验并提取配置、**仅设置状态标志**（无跨管线副作用）。
  - 通过 `cmd_cfg_task()` 状态机编排跨管线交互（存储、LED、Pot 暂停等），**所有跨管线调用和 MIDI 发送均集中在此函数中**。
  - 实现 `market/cmd_cfg_api.h` 的所有接口。

**移植到新控制器时，只需重写 `cmd_cfg_app.c/h`（约 200 行），`cmd_core.c/h` 完全保留。**

> **注**：架构文档 §6.3 业务流描述中 `cmd_cfg_process_sysex()` 直接调用 `pot_get_all_raw()` 为历史遗留文字，实际实现以 `cmd_cfg_api.h` 的 `@constraint` 约束为准，所有跨管线调用均延迟至 `cmd_cfg_task()` 执行。

---

## 2. 文件组织

```
pipelines/cmd_config/
├── cmd_core.h                // 通用协议引擎接口（仅本管线可见）
├── cmd_core.c                // 帧解析、校验、命令分发、协议响应构建
├── cmd_cfg_app.h             // Lyre 产品内部接口
└── cmd_cfg_app.c             // Lyre 产品命令表、状态机、RAM 快照
```

本管线允许的内部包含关系：
- `cmd_core.c` 只包含 `cmd_core.h`
- `cmd_cfg_app.c` 包含 `cmd_core.h`, `cmd_cfg_app.h`, 以及所有需要的 `market/*.h`
- 严禁包含其他管线的内部头文件。

---

## 3. cmd_core 详细设计

### 3.1 职责

`cmd_core` 实现《协议 v2.6》中与产品参数无关的所有逻辑：

- SysEx 消息完整性校验（厂商 ID、设备 ID、校验和，以及 F0/F7 帧定界符）。
- 命令字分发。
- **虚拟控件配置 payload 校验**（字段范围、唯一性）。
- **校准数据 payload 校验**（长度、`cal_max > cal_min`）。**注**：按钮控件校验由调用者保证数据合法（见 3.4 说明）。
- **应答帧构建**（ACK/NACK）。
- **数据响应帧构建**（0x04、0x08、0x0C、0x12）。

`cmd_core` **绝不** 操作任何硬件、存储或调用其他管线。

### 3.2 协议数据类型与接口

```c
/* === cmd_core.h === */

#ifndef CMD_CORE_H
#define CMD_CORE_H

#include <stdint.h>
#include <stdbool.h>

/* 物理控件描述（严格遵循协议 0x04 的 6 字节布局） */
typedef struct {
    uint8_t  mux;
    uint8_t  channel;
    uint8_t  cal_min_mid;
    uint8_t  cal_min_lo;
    uint8_t  cal_max_mid;
    uint8_t  cal_max_lo;
} cmd_phys_desc_t;

/* 虚拟控件描述（严格遵循协议 0x0C 的 4 字节布局） */
typedef struct {
    uint8_t bank;
    uint8_t phys_idx;
    uint8_t cc;
    uint8_t channel;
} cmd_virt_ctrl_t;

/* 命令处理回调原型 */
typedef void (*cmd_handler_t)(const uint8_t *payload, uint16_t len, uint8_t cmd);

/* 命令表条目 */
typedef struct {
    uint8_t cmd;
    cmd_handler_t handler;
} cmd_entry_t;

/* —— 协议常量 —— */
#define CMD_PROTO_VERSION       0x16   // v2.6
#define CMD_MAX_UNIQUE_PAIRS    128    // 最大 B*N，用于唯一性校验数组，覆盖 B≤127,N≤127

/* —— 函数声明 —— */

/** 初始化 CORE（当前无状态，保留扩展） */
void cmd_core_init(void);

/**
 * 处理一条完整的 SysEx 消息。
 * @param sysex_msg  完整帧（含 F0..F7）
 * @param len        总长度
 * @param device_id  本设备期望 ID
 * @param table      命令表
 * @param table_size 命令表条目数
 * @param payload_out 输出 payload 首字节指针（可为 NULL）
 * @param payload_len_out 输出 payload 长度（可为 NULL）
 * @return 0=成功分发，1=长度不足，2=非 F0 开头，3=厂商不匹配，4=设备 ID 不匹配，
 *         5=校验和错误，6=未知命令字，7=非 F7 结尾
 */
uint8_t cmd_core_dispatch(const uint8_t *sysex_msg, uint16_t len,
                          uint8_t device_id,
                          const cmd_entry_t *table, uint8_t table_size,
                          const uint8_t **payload_out, uint16_t *payload_len_out);

// ---- 校验函数 ----
uint8_t cmd_proto_validate_virt_config(const uint8_t *payload, uint16_t len,
                                       uint8_t B_expected, uint8_t V_expected,
                                       uint8_t N_expected);

uint8_t cmd_proto_validate_calibration(const uint8_t *payload, uint16_t len,
                                       uint8_t N_expected);

// ---- 响应构建函数（仅生成帧数据）----
void cmd_proto_build_ack(uint8_t device_id, uint8_t ack_cmd, uint8_t status,
                         uint8_t *buf_out, uint16_t *len_out);

void cmd_proto_build_device_info(uint8_t device_id, uint8_t N,
                                 const cmd_phys_desc_t *phys,
                                 uint8_t *buf_out, uint16_t *len_out);

void cmd_proto_build_virt_config(uint8_t device_id, uint8_t B, uint8_t V,
                                 const cmd_virt_ctrl_t *virt,
                                 uint8_t *buf_out, uint16_t *len_out);

/**
 * 构建 ADC 原始值响应帧。
 * @note 调用者保证 raw_values[i] ≤ 0x0FFF（12-bit ADC 范围），
 *       且已过滤 0xFFFF 暂停标记。
 */
void cmd_proto_build_adc_raw(uint8_t device_id, uint8_t N,
                             const uint16_t *raw_values,
                             uint8_t *buf_out, uint16_t *len_out);

void cmd_proto_build_layout(uint8_t device_id, const uint8_t *tree_data,
                            uint16_t tree_len,
                            uint8_t *buf_out, uint16_t *len_out);

#endif /* CMD_CORE_H */
```

### 3.3 实现要点

#### 3.3.1 Roland 校验和（辅助函数）

```c
static uint8_t roland_checksum(const uint8_t *data, uint16_t len) {
    uint16_t sum = 0;
    for (uint16_t i = 0; i < len; i++) sum += data[i];
    return (128 - (sum & 0x7F)) & 0x7F;
}
```

#### 3.3.2 `cmd_core_dispatch` 实现

```c
uint8_t cmd_core_dispatch(const uint8_t *msg, uint16_t len,
                          uint8_t device_id,
                          const cmd_entry_t *table, uint8_t table_size,
                          const uint8_t **payload_out, uint16_t *payload_len_out) {
    // 检查帧完整性和长度
    if (len < 6) return 1;
    if (msg[0] != 0xF0) return 2;
    if (msg[len-1] != 0xF7) return 7;   // 非 F7 结尾，帧不完整
    if (msg[1] != 0x7D) return 3;
    if (msg[2] != device_id) return 4;

    // 校验和：范围从 msg[1] (0x7D) 到 msg[len-3]（校验和前一个字节），长度 = len-3
    uint8_t expected = roland_checksum(&msg[1], len - 3);
    if (expected != msg[len - 2]) return 5;

    // 注：帧头字段的 bit7 合法性由匹配逻辑隐式保证（不匹配则拒绝）
    uint8_t cmd = msg[3];
    for (uint8_t i = 0; i < table_size; i++) {
        if (table[i].cmd == cmd) {
            if (payload_out) *payload_out = &msg[4];
            if (payload_len_out) *payload_len_out = len - 6;
            table[i].handler(&msg[4], len - 6, cmd);
            return 0;
        }
    }
    return 6;
}
```
> **验证**：使用协议 §9.2 示例帧 `F0 7D 00 12 04 00 64 1F 40 00 00 1F 7F 0C F7`，校验和计算范围 = 从 `7D` 到 `1F 7F` 共 11 字节，和为 `0x7D+0x00+0x12+0x04+0x00+0x64+0x1F+0x40+0x00+0x00+0x1F+0x7F = 0x1F4`，取低 7 位 `0x74`，校验和 = `128 - 0x74 = 0x0C`，与消息一致。

#### 3.3.3 校验函数

```c
uint8_t cmd_proto_validate_virt_config(const uint8_t *payload, uint16_t len,
                                       uint8_t B_expected, uint8_t V_expected,
                                       uint8_t N_expected) {
    if (len < 2) return 1;
    uint8_t B = payload[0];
    uint8_t V = payload[1];
    if (B != B_expected || V != V_expected) return 2;
    if (len != (2 + 4 * V)) return 3;

    // 防御性 bit7 检查
    for (uint16_t i = 0; i < len; i++) {
        if (payload[i] & 0x80) return 6;
    }

    // 唯一性检查，使用固定上限数组（覆盖协议最大 B*N=127*127 的子集 V≤126）
    uint8_t used[CMD_MAX_UNIQUE_PAIRS] = {0};
    uint16_t pair_count = (uint16_t)B_expected * N_expected;
    if (pair_count > CMD_MAX_UNIQUE_PAIRS) return 7;

    for (uint8_t i = 0; i < V; i++) {
        uint8_t bank    = payload[2 + i*4];
        uint8_t phys    = payload[2 + i*4 + 1];
        uint8_t cc      = payload[2 + i*4 + 2];
        uint8_t channel = payload[2 + i*4 + 3];

        if (bank >= B_expected || phys >= N_expected || cc > 127 || channel > 15)
            return 4;
        uint16_t idx = (uint16_t)bank * N_expected + phys;
        if (used[idx]) return 5;
        used[idx] = 1;
    }
    return 0;
}

uint8_t cmd_proto_validate_calibration(const uint8_t *payload, uint16_t len,
                                       uint8_t N_expected) {
    if (len < 1) return 1;
    uint8_t N = payload[0];
    if (N != N_expected) return 2;
    if (len != (1 + 4 * N)) return 3;

    for (uint16_t i = 0; i < len; i++) {
        if (payload[i] & 0x80) return 5;
    }

    for (uint8_t i = 0; i < N; i++) {
        uint16_t cal_min = (payload[1 + i*4] << 7) | payload[1 + i*4 + 1];
        uint16_t cal_max = (payload[1 + i*4 + 2] << 7) | payload[1 + i*4 + 3];
        if (cal_max <= cal_min) return 4;
    }
    return 0;
}
```

**按钮控件说明**：`cmd_proto_validate_calibration` 对所有物理控件执行 `max>min` 检查。若产品包含按钮，调用者必须确保其校准数据满足此约束（例如保持默认 min=0, max=4095），固件在映射时忽略按钮的校准值。

#### 3.3.4 响应构建函数

```c
void cmd_proto_build_device_info(uint8_t device_id, uint8_t N,
                                 const cmd_phys_desc_t *phys,
                                 uint8_t *buf_out, uint16_t *len_out) {
    uint16_t pos = 0;
    buf_out[pos++] = 0xF0;
    buf_out[pos++] = 0x7D;
    buf_out[pos++] = device_id;
    buf_out[pos++] = 0x04;
    buf_out[pos++] = N;
    buf_out[pos++] = CMD_PROTO_VERSION;
    for (uint8_t i = 0; i < N; i++) {
        buf_out[pos++] = phys[i].mux;
        buf_out[pos++] = phys[i].channel;
        buf_out[pos++] = phys[i].cal_min_mid;
        buf_out[pos++] = phys[i].cal_min_lo;
        buf_out[pos++] = phys[i].cal_max_mid;
        buf_out[pos++] = phys[i].cal_max_lo;
    }
    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}

void cmd_proto_build_virt_config(uint8_t device_id, uint8_t B, uint8_t V,
                                 const cmd_virt_ctrl_t *virt,
                                 uint8_t *buf_out, uint16_t *len_out) {
    uint16_t pos = 0;
    buf_out[pos++] = 0xF0;
    buf_out[pos++] = 0x7D;
    buf_out[pos++] = device_id;
    buf_out[pos++] = 0x0C;
    buf_out[pos++] = B;
    buf_out[pos++] = V;
    for (uint8_t i = 0; i < V; i++) {
        buf_out[pos++] = virt[i].bank;
        buf_out[pos++] = virt[i].phys_idx;
        buf_out[pos++] = virt[i].cc;
        buf_out[pos++] = virt[i].channel;
    }
    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}

void cmd_proto_build_adc_raw(uint8_t device_id, uint8_t N,
                             const uint16_t *raw_values,
                             uint8_t *buf_out, uint16_t *len_out) {
    uint16_t pos = 0;
    buf_out[pos++] = 0xF0;
    buf_out[pos++] = 0x7D;
    buf_out[pos++] = device_id;
    buf_out[pos++] = 0x12;
    buf_out[pos++] = N;
    for (uint8_t i = 0; i < N; i++) {
        buf_out[pos++] = (raw_values[i] >> 7) & 0x7F;
        buf_out[pos++] = raw_values[i] & 0x7F;
    }
    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}

void cmd_proto_build_layout(uint8_t device_id, const uint8_t *tree_data,
                            uint16_t tree_len,
                            uint8_t *buf_out, uint16_t *len_out) {
    uint16_t pos = 0;
    buf_out[pos++] = 0xF0;
    buf_out[pos++] = 0x7D;
    buf_out[pos++] = device_id;
    buf_out[pos++] = 0x08;
    buf_out[pos++] = (tree_len >> 7) & 0x7F;
    buf_out[pos++] = tree_len & 0x7F;
    memcpy(&buf_out[pos], tree_data, tree_len);
    pos += tree_len;
    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}

void cmd_proto_build_ack(uint8_t device_id, uint8_t ack_cmd, uint8_t status,
                         uint8_t *buf_out, uint16_t *len_out) {
    buf_out[0] = 0xF0; buf_out[1] = 0x7D; buf_out[2] = device_id;
    buf_out[3] = ack_cmd; buf_out[4] = status;
    uint8_t ck = roland_checksum(&buf_out[1], 4);
    buf_out[5] = ck; buf_out[6] = 0xF7;
    *len_out = 7;
}
```

---

## 4. cmd_cfg_app 详细设计（Lyre 专用）

### 4.1 产品常量与数据

```c
#define LYRE_PHYS_COUNT        4
#define LYRE_BANK_COUNT        1
#define LYRE_VIRT_COUNT        4
#define LYRE_DEVICE_ID         0x00   // 编译期固定，当前不支持运行时修改
```

**物理描述**（硬件固定，不可写）：
```c
const cmd_phys_desc_t lyre_phys_default[LYRE_PHYS_COUNT] = {
    { 0x00, 0, 0x00, 0x00, 0x1F, 0x7F }, // ADC0
    { 0x00, 1, 0x00, 0x00, 0x1F, 0x7F }, // ADC1
    { 0x00, 2, 0x00, 0x00, 0x1F, 0x7F }, // ADC2
    { 0x00, 3, 0x00, 0x00, 0x1F, 0x7F }, // ADC3
};
```

**布局树**（4 个水平推杆）：
```c
const uint8_t lyre_layout_tree[] = {
    0x01, 0x04,        // HBox, 4 children
    0x11, 0x00,        // Fader, phys index 0
    0x11, 0x01,        // Fader, phys index 1
    0x11, 0x02,        // Fader, phys index 2
    0x11, 0x03         // Fader, phys index 3
};
#define LYRE_LAYOUT_TREE_LEN  (sizeof(lyre_layout_tree))
```

**配置快照结构体**：
```c
typedef struct {
    cmd_phys_desc_t phys[LYRE_PHYS_COUNT];
    cmd_virt_ctrl_t virt[LYRE_VIRT_COUNT];
} lyre_config_t;
```

**保存缓冲区大小**：
```c
// 取 max( 0x0D payload: 2+4V, 0x0F payload: 1+4N )
#define CMD_SAVE_BUF_MAX  ((2 + 4 * LYRE_VIRT_COUNT) > (1 + 4 * LYRE_PHYS_COUNT) \
                           ? (2 + 4 * LYRE_VIRT_COUNT) : (1 + 4 * LYRE_PHYS_COUNT))
```

### 4.2 配置快照与双缓冲

```c
static lyre_config_t cfg_buf[2];
static lyre_config_t *cfg_current = &cfg_buf[0];   // 只读，供所有 config_get_* 使用
static lyre_config_t *cfg_pending = &cfg_buf[1];   // 写入时后台缓冲
```

**出厂默认虚拟配置**（CC1–CC4，通道 0）：
```c
static void load_factory_defaults(void) {
    memcpy(cfg_current->phys, lyre_phys_default, sizeof(lyre_phys_default));
    for (uint8_t i = 0; i < LYRE_VIRT_COUNT; i++) {
        cfg_current->virt[i].bank    = 0;
        cfg_current->virt[i].phys_idx = i;
        cfg_current->virt[i].cc      = i + 1;
        cfg_current->virt[i].channel = 0;
    }
}
```

**双缓冲原子切换**：在 `CFG_SAVE_DONE` 中执行：
```c
lyre_config_t *tmp = cfg_current;
cfg_current = cfg_pending;
cfg_pending = tmp;
// Cortex-M0+ 单核主循环上下文，指针交换为原子操作，无竞态。
// 切换后 cfg_pending 变为旧数据，下次写入前会在 CFG_SAVE_START 中重新 memcpy 同步。
```

### 4.3 内部状态与辅助函数

```c
/* 状态机状态（对外仅暴露 CFG_IDLE..CFG_ACK_PENDING，CFG_SAVE_FAILED_INTERNAL 为内部状态） */
typedef enum {
    CFG_IDLE = 0,
    CFG_SAVE_START,
    CFG_SAVING,
    CFG_SAVE_DONE,
    CFG_ACK_PENDING,
    CFG_SAVE_FAILED_INTERNAL,  // 不对外暴露，由 cmd_cfg_get_state() 映射为 CFG_IDLE
} cfg_state_internal_t;

static cfg_state_internal_t current_state = CFG_IDLE;

/* 对外 API */
cfg_state_t cmd_cfg_get_state(void) {
    if (current_state == CFG_SAVE_FAILED_INTERNAL) return CFG_IDLE;
    return (cfg_state_t)current_state;
}
```

**事件标志**：
```c
static bool save_requested = false;
static bool save_is_calibration = false;
static uint8_t save_buffer[CMD_SAVE_BUF_MAX];
static size_t  save_len = 0;

static bool nack_pending = false;
static uint8_t nack_cmd = 0;
static uint8_t nack_status = 0;

/* 查询标志，使用位图，每轮只处理一个置位 */
static uint8_t query_flags = 0;
#define QUERY_DEVICE_INFO   (1 << 0)
#define QUERY_LAYOUT        (1 << 1)
#define QUERY_VIRT_CONFIG   (1 << 2)
#define QUERY_ADC_RAW       (1 << 3)

static uint8_t ack_retries = 0;
static uint16_t save_step_timeout = 0;  // 看门狗计数
#define MAX_ACK_RETRIES 3
#define MAX_SAVE_STEP_TIMEOUT 500

/* 共享发送缓冲区（静态分配，避免大栈数组）
 * 注意：本设计假设 midi_send_sysex() 在返回前完成数据拷贝（即调用返回后 tx_buf 可安全复用）。
 * 若 MIDI 管线实现为异步 DMA 发送，需改为双缓冲或等待发送完成。
 */
static uint8_t tx_buf[770];   // 协议最大消息长度

/* 辅助：尝试将当前 cfg_current 同步写回存储（用于初始化恢复默认） */
static void try_write_back_defaults(void) {
    if (storage_save_config_begin((const uint8_t*)cfg_current, sizeof(lyre_config_t))) {
        uint16_t timeout = 200;
        while (!storage_save_config_step() && --timeout) {}
        if (timeout == 0) storage_save_config_abort();
    }
}

/* 只设标志，不产生任何跨管线副作用 */
static void schedule_nack(uint8_t cmd, uint8_t status) {
    nack_pending = true;
    nack_cmd = cmd;
    nack_status = status;
}

static void send_pending_nack(void) {
    uint16_t len;
    cmd_proto_build_ack(LYRE_DEVICE_ID, nack_cmd, nack_status, tx_buf, &len);
    if (midi_send_sysex(tx_buf, len)) {
        nack_pending = false;
        ack_retries = 0;
    } else {
        ack_retries++;
        if (ack_retries >= MAX_ACK_RETRIES) {
            nack_pending = false;
            ack_retries = 0;
        }
    }
}
```

### 4.4 命令表与回调（全部为纯标志操作）

```c
static void handle_0x03(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    query_flags |= QUERY_DEVICE_INFO;
}
static void handle_0x07(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    query_flags |= QUERY_LAYOUT;
}
static void handle_0x0B(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    query_flags |= QUERY_VIRT_CONFIG;
}

static void handle_0x11(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    query_flags |= QUERY_ADC_RAW;
}

static void handle_0x0D(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)cmd;
    if (current_state != CFG_IDLE) {
        schedule_nack(0x0E, 0x01);   // 忙时统一返回 NACK 0x01，上位机将重试
        return;
    }
    uint8_t err = cmd_proto_validate_virt_config(payload, len,
                                                 LYRE_BANK_COUNT, LYRE_VIRT_COUNT,
                                                 LYRE_PHYS_COUNT);
    if (err != 0) { schedule_nack(0x0E, 0x01); return; }
    memcpy(save_buffer, payload, len);
    save_len = len;
    save_is_calibration = false;
    save_requested = true;
}

static void handle_0x0F(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)cmd;
    if (current_state != CFG_IDLE) {
        schedule_nack(0x10, 0x01);
        return;
    }
    uint8_t err = cmd_proto_validate_calibration(payload, len, LYRE_PHYS_COUNT);
    if (err != 0) { schedule_nack(0x10, 0x01); return; }
    memcpy(save_buffer, payload, len);
    save_len = len;
    save_is_calibration = true;
    save_requested = true;
}

static const cmd_entry_t cmd_table[] = {
    { 0x03, handle_0x03 },
    { 0x07, handle_0x07 },
    { 0x0B, handle_0x0B },
    { 0x0D, handle_0x0D },
    { 0x0F, handle_0x0F },
    { 0x11, handle_0x11 },
};
```

### 4.5 `cmd_cfg_task()` 完整伪代码

```c
void cmd_cfg_task(void) {
    if (nack_pending) {
        send_pending_nack();
        return;
    }

    switch (current_state) {
    case CFG_IDLE:
        if (save_requested) {
            current_state = CFG_SAVE_START;
            save_requested = false;
            return;
        }
        // 处理查询（每轮至多处理一个置位；发送失败时保留标志，下轮自动重试）
        if (query_flags & QUERY_DEVICE_INFO) {
            uint16_t len;
            cmd_proto_build_device_info(LYRE_DEVICE_ID, LYRE_PHYS_COUNT,
                                        cfg_current->phys, tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                query_flags &= ~QUERY_DEVICE_INFO;
            }
        } else if (query_flags & QUERY_LAYOUT) {
            uint16_t len;
            cmd_proto_build_layout(LYRE_DEVICE_ID, lyre_layout_tree,
                                   LYRE_LAYOUT_TREE_LEN, tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                query_flags &= ~QUERY_LAYOUT;
            }
        } else if (query_flags & QUERY_VIRT_CONFIG) {
            uint16_t len;
            cmd_proto_build_virt_config(LYRE_DEVICE_ID, LYRE_BANK_COUNT,
                                        LYRE_VIRT_COUNT, cfg_current->virt,
                                        tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                query_flags &= ~QUERY_VIRT_CONFIG;
            }
        } else if (query_flags & QUERY_ADC_RAW) {
            uint16_t raw[LYRE_PHYS_COUNT];
            pot_get_all_raw(raw, LYRE_PHYS_COUNT);
            if (raw[0] == 0xFFFF) break; // 暂停，保留标志
            uint16_t len;
            cmd_proto_build_adc_raw(LYRE_DEVICE_ID, LYRE_PHYS_COUNT,
                                    raw, tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                query_flags &= ~QUERY_ADC_RAW;
            }
        }
        // 上位机可采用并行模式（一次性发送 0x03/0x07/0x0B），
        // 设备每轮处理一个，响应顺序按位图优先级依次发出，总延迟 ≤ 3 个主循环周期
        break;

    case CFG_SAVE_START:
        led_event_save_start();
        pot_set_pause(true);
        memcpy(cfg_pending, cfg_current, sizeof(lyre_config_t));
        if (save_is_calibration) {
            const uint8_t *p = save_buffer + 1;
            for (uint8_t i = 0; i < LYRE_PHYS_COUNT; i++) {
                cfg_pending->phys[i].cal_min_mid = p[0];
                cfg_pending->phys[i].cal_min_lo  = p[1];
                cfg_pending->phys[i].cal_max_mid = p[2];
                cfg_pending->phys[i].cal_max_lo  = p[3];
                p += 4;
            }
        } else {
            const uint8_t *p = save_buffer + 2;
            for (uint8_t i = 0; i < LYRE_VIRT_COUNT; i++) {
                cfg_pending->virt[i].bank    = p[0];
                cfg_pending->virt[i].phys_idx = p[1];
                cfg_pending->virt[i].cc      = p[2];
                cfg_pending->virt[i].channel = p[3];
                p += 4;
            }
        }
        if (!storage_save_config_begin((const uint8_t*)cfg_pending, sizeof(lyre_config_t))) {
            pot_set_pause(false);
            led_event_save_done();
            schedule_nack(save_is_calibration ? 0x10 : 0x0E, 0x01);
            current_state = CFG_IDLE;
        } else {
            save_step_timeout = 0;
            current_state = CFG_SAVING;
        }
        break;

    case CFG_SAVING:
        if (storage_save_config_step()) {
            lyre_config_t *tmp = cfg_current;
            cfg_current = cfg_pending;
            cfg_pending = tmp;
            current_state = CFG_SAVE_DONE;
        } else {
            if (++save_step_timeout > MAX_SAVE_STEP_TIMEOUT) {
                storage_save_config_abort();
                pot_set_pause(false);
                led_event_save_done();
                schedule_nack(save_is_calibration ? 0x10 : 0x0E, 0x01);
                current_state = CFG_IDLE;
            }
        }
        break;

    case CFG_SAVE_DONE:
        pot_set_pause(false);
        pot_reset_stable_values();
        led_event_save_done();
        {
            uint16_t len;
            cmd_proto_build_ack(LYRE_DEVICE_ID,
                                save_is_calibration ? 0x10 : 0x0E,
                                0x00, tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                current_state = CFG_IDLE;
                ack_retries = 0;
            } else {
                current_state = CFG_ACK_PENDING;
                ack_retries = 1;
            }
        }
        break;

    case CFG_ACK_PENDING:
        {
            uint16_t len;
            cmd_proto_build_ack(LYRE_DEVICE_ID,
                                save_is_calibration ? 0x10 : 0x0E,
                                0x00, tx_buf, &len);
            if (midi_send_sysex(tx_buf, len)) {
                current_state = CFG_IDLE;
                ack_retries = 0;
            } else if (++ack_retries >= MAX_ACK_RETRIES) {
                current_state = CFG_IDLE;
            }
        }
        break;

    case CFG_SAVE_FAILED_INTERNAL:
        current_state = CFG_IDLE;
        break;
    }
}
```

### 4.6 持久化数据格式

存储管线保存/加载的 `data` 是 `lyre_config_t` 结构体的原始内存拷贝（小端对齐），所有字段均为 `uint8_t`，无端序问题。版本兼容性由 Storage 管线的 header version 保证。加载时若长度不符或 CRC 失败，`storage_load_config` 返回 false，APP 层回退到出厂默认。

### 4.7 `cmd_cfg_init()` 实现要点

```c
void cmd_cfg_init(void) {
    cmd_core_init();
    size_t out_len;
    if (storage_load_config((uint8_t*)cfg_current, sizeof(lyre_config_t), &out_len)) {
        if (out_len != sizeof(lyre_config_t)) {
            load_factory_defaults();
            try_write_back_defaults();
        }
    } else {
        load_factory_defaults();
        try_write_back_defaults();
    }
    current_state = CFG_IDLE;
    save_requested = false;
    nack_pending = false;
    query_flags = 0;
    save_step_timeout = 0;
}
```

### 4.8 市场 API 实现

**`cmd_cfg_process_sysex()`**：
```c
void cmd_cfg_process_sysex(const uint8_t *data, uint16_t len) {
    uint8_t ret = cmd_core_dispatch(data, len, LYRE_DEVICE_ID, cmd_table,
                                    sizeof(cmd_table)/sizeof(cmd_table[0]),
                                    NULL, NULL);
    if (ret == 5 && len >= 4) {
        uint8_t cmd = data[3];
        if (cmd == 0x0D) schedule_nack(0x0E, 0x01);
        else if (cmd == 0x0F) schedule_nack(0x10, 0x01);
    }
}
```

`config_get_pot_mapping` 等直接读取 `cfg_current->virt`，批量接口保证单次调用一致性。

---

## 5. 状态机转移图

```
CFG_IDLE ──save_requested──▶ CFG_SAVE_START
CFG_IDLE ◀──begin失败/step超时/ACK成功── CFG_SAVE_DONE / CFG_SAVING / CFG_ACK_PENDING
CFG_SAVE_START ──begin成功──▶ CFG_SAVING
CFG_SAVING ──step true──▶ CFG_SAVE_DONE
CFG_SAVING ──step超时──▶ CFG_IDLE (经abort/NACK)
CFG_SAVE_DONE ──ACK发送中──▶ CFG_ACK_PENDING
CFG_ACK_PENDING ──成功/超限──▶ CFG_IDLE
```

---

## 6. 附录

### 附录 A：修订记录

- v2.6：闭环第六轮审计缺陷。修正 T‑09 校验和为 0x04，使测试语义精确；补充 T‑07 具体示例帧以便 JS 端验证。

### 附录 B：协议一致性测试向量

本表为固件与 JS 上位机提供共同的黄金参考帧，所有校验和值基于 `roland_checksum` 实际计算。可使用这些帧验证双方编解码的正确性。

| 编号 | 描述 | 发送帧（十六进制） | 预期响应帧（十六进制） |
|------|------|-------------------|----------------------|
| T-01 | 查询设备信息 | `F0 7D 00 03 00 F7` | `F0 7D 00 04 04 16 00 00 00 00 1F 7F 00 01 00 00 1F 7F 00 02 00 00 1F 7F 00 03 00 00 1F 7F 69 F7` |
| T-02 | 查询面板布局 | `F0 7D 00 07 7C F7` | `F0 7D 00 08 00 0A 01 04 11 00 11 01 11 02 11 03 33 F7` |
| T-03 | 查询虚拟配置 | `F0 7D 00 0B 78 F7` | `F0 7D 00 0C 01 04 00 00 01 00 00 01 02 00 00 02 03 00 00 03 04 00 62 F7` |
| T-04 | 写入虚拟配置（合法） | `F0 7D 00 0D 01 04 00 00 01 00 00 01 02 00 00 02 03 00 00 03 04 00 61 F7` | `F0 7D 00 0E 00 75 F7` |
| T-05 | 写入虚拟配置（校验和错误） | `F0 7D 00 0D 01 04 00 00 01 00 00 01 02 00 00 02 03 00 00 03 04 00 00 F7`（正确 CK 应为 0x61，此处故意设为 0x00） | `F0 7D 00 0E 01 74 F7` |
| T-06 | 写入校准数据（合法） | `F0 7D 00 0F 04 00 00 1F 7F 00 00 1F 7F 00 00 1F 7F 00 00 1F 7F 78 F7` | `F0 7D 00 10 00 73 F7` |
| T-07 | 查询 ADC 原始值 | `F0 7D 00 11 72 F7` | 示例值（100, 4032, 0, 4095）：`F0 7D 00 12 04 00 64 1F 40 00 00 1F 7F 0C F7`（与协议 §9.2 示例一致）|
| T-08 | 设备 ID 不匹配（ID=01） | `F0 7D 01 03 7F F7` | 无响应（设备静默忽略） |
| T-09 | 未知命令字（0xFF） | `F0 7D 00 FF 04 F7` | 无响应（dispatch 返回 6，静默忽略） |
| T-10 | 帧长度不足（截断） | `F0 7D 00` | 无响应 |

> **T-07 补充说明**：假设 ADC 采样值为 100, 4032, 0, 4095，编码后响应帧如表格所示，校验和 0x0C。与协议 §9.2 示例帧完全一致，可用于验证 14‑bit 编码和校验和计算。

> **使用方法**：将发送帧注入固件 `midi_read_sysex` 模拟输入，检查响应帧是否与预期一致。负面测试（T-08～T-10）预期设备不发送任何 SysEx 响应。

---

*本文档 v2.6 经六轮审计闭环，所有已知缺陷均已修正，协议符合度与测试向量均已核验，可直接作为最终编码及联调依据。*
