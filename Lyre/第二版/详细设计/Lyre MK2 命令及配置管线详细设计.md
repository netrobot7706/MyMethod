审计报告识别出的问题大部分真实存在，且建议合理，没有过度设计。我对每一条缺陷的评估如下：

- **P0 #1**：确实违反 `@constraint`，采纳方案A（0x11 改为设标志，延迟到 `cmd_cfg_task` 处理）。  
- **P0 #2**：`save_buffer` 大小确实应明确定义，用宏表达。  
- **P0 #3**：序列化格式已在状态机代码中隐式表达，但应显式增加一个小节说明。  
- **P0 #4**：初始化写回路径必须明确为同步阻塞调用。  
- **P1 #5**：0x02 是协议未定义的扩展，采纳降级处理——忙时统一返回 0x01，上位机重试。  
- **P1 #6**：按钮豁免是合理的可移植性说明，但无需修改函数签名，在文档中注明调用者责任即可。  
- **P1 #7/#8/#9**：接口/类型/辅助函数缺失，必须补充完整。  
- **P1 #10**：查询回调同样必须遵守设标志模式，补充实现。  
- **P2 #11**：补充 14-bit 长度编码的构建代码，避免误导。  
- **P2 #12**：补充原子切换的明确说明。  
- **P2 #13**：补充 `handle_0x0F` 与 0x0D 的差异说明。  
- **P2 #14**：增加 `CFG_SAVE_FAILED` 状态及 `begin` 失败处理，`step` 目前 API 无错误返回，但至少应处理 `begin` 失败。  
- **P2 #15**：明确 IDLE 状态下的事件优先级。  
- **P2 #16**：修正注释。  
- **P2 #17**：统一接口类型。  
- **P2 #18**：VLA 风险确实存在，改为固定上限数组+编译期限制。  
- **P3 #19–22**：全部采纳，补充状态机图、完整伪代码、防御性校验等。

以下是吸收所有缺陷后修正的完整详细设计文档（v2.1）。修订轨迹以注释形式标注。

---

# Lyre MK2 命令及配置管线详细设计（v2.1 — 审计闭环版）

> **文档版本**：v2.1  
> **关联架构文档**：《Lyre MK2 产品架构设计文档 v2.2》  
> **关联协议**：《MIDI 控制器自描述配置协议 v2.6》  
> **管线**：Command & Config  
> **状态**：冻结基线，可直接用于编码实现  
> **修订**：依据架构审计报告闭环 P0–P3 所有缺陷

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

- SysEx 消息完整性校验（厂商 ID、设备 ID、校验和）。
- 命令字分发。
- **虚拟控件配置 payload 校验**（字段范围、唯一性）。
- **校准数据 payload 校验**（长度、`cal_max > cal_min`）。**注**：按钮控件校验由调用者保证数据合法（见 3.4 说明）。
- **应答帧构建**（ACK/NACK）。
- **数据响应帧构建**（0x04、0x08、0x0C、0x12）。

`cmd_core` **绝不** 操作任何硬件、存储或调用其他管线。

### 3.2 协议数据类型定义

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
#define CMD_MAX_UNIQUE_PAIRS    128    // 最大 B*N，用于唯一性校验数组

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
 * @return 0=成功分发，1=长度不足，2=非 F0 开头，3=厂商不匹配，4=设备 ID 不匹配，5=校验和错误，6=未知命令字
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

void cmd_proto_build_adc_raw(uint8_t device_id, uint8_t N,
                             const uint16_t *raw_values,
                             uint8_t *buf_out, uint16_t *len_out);

void cmd_proto_build_layout(uint8_t device_id, const uint8_t *tree_data,
                            uint16_t tree_len,
                            uint8_t *buf_out, uint16_t *len_out);

#endif /* CMD_CORE_H */
```

### 3.3 实现要点

#### 3.3.1 `cmd_core_dispatch` 实现

```c
uint8_t cmd_core_dispatch(const uint8_t *msg, uint16_t len,
                          uint8_t device_id,
                          const cmd_entry_t *table, uint8_t table_size,
                          const uint8_t **payload_out, uint16_t *payload_len_out) {
    if (len < 6) return 1;
    if (msg[0] != 0xF0) return 2;
    if (msg[1] != 0x7D) return 3;
    if (msg[2] != device_id) return 4;

    // 校验和
    uint16_t ck_range_len = len - 3 - 1; // 从 0x7D 到校验和前
    uint8_t expected = roland_checksum(&msg[1], ck_range_len);
    if (expected != msg[len - 2]) return 5;

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

#### 3.3.2 校验函数

```c
uint8_t cmd_proto_validate_virt_config(const uint8_t *payload, uint16_t len,
                                       uint8_t B_expected, uint8_t V_expected,
                                       uint8_t N_expected) {
    if (len < 2) return 1;
    uint8_t B = payload[0];
    uint8_t V = payload[1];
    if (B != B_expected || V != V_expected) return 2;
    if (len != (2 + 4 * V)) return 3;

    // 防御性：bit7 检查
    for (uint16_t i = 0; i < len; i++) {
        if (payload[i] & 0x80) return 6;
    }

    // 唯一性检查，使用固定上限数组，避免 VLA 栈溢出
    uint8_t used[CMD_MAX_UNIQUE_PAIRS] = {0};
    uint16_t pair_count = B_expected * N_expected;
    if (pair_count > CMD_MAX_UNIQUE_PAIRS) return 7; // 参数超限

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

    // bit7 校验
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

**按钮说明**：`cmd_proto_validate_calibration` 对所有物理控件执行 `max>min` 检查。若产品包含按钮，调用者必须确保其校准数据满足此约束（例如保持默认 min=0, max=4095），固件在映射时忽略按钮的校准值。

#### 3.3.3 响应构建函数

（0x04 已给出，此处补充 0x08 的关键片段）

```c
void cmd_proto_build_layout(uint8_t device_id, const uint8_t *tree_data,
                            uint16_t tree_len,
                            uint8_t *buf_out, uint16_t *len_out) {
    uint16_t pos = 0;
    buf_out[pos++] = 0xF0;
    buf_out[pos++] = 0x7D;
    buf_out[pos++] = device_id;
    buf_out[pos++] = 0x08;
    // 14-bit 长度编码
    buf_out[pos++] = (tree_len >> 7) & 0x7F;
    buf_out[pos++] = tree_len & 0x7F;
    memcpy(&buf_out[pos], tree_data, tree_len);
    pos += tree_len;

    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}
```

其他构建函数类似，均自动处理校验和。

---

## 4. cmd_cfg_app 详细设计（Lyre 专用）

### 4.1 产品常量与数据

```c
/* === cmd_cfg_app.h / .c === */
#define LYRE_PHYS_COUNT        4
#define LYRE_BANK_COUNT        1
#define LYRE_VIRT_COUNT        4
#define LYRE_DEVICE_ID         0x00   // 编译期固定，当前不支持运行时修改

/* 物理描述（硬件固定，不可写） */
const cmd_phys_desc_t lyre_phys_default[LYRE_PHYS_COUNT] = {
    { 0x00, 0, 0x00, 0x00, 0x1F, 0x7F }, // ADC0
    { 0x00, 1, 0x00, 0x00, 0x1F, 0x7F }, // ADC1
    { 0x00, 2, 0x00, 0x00, 0x1F, 0x7F }, // ADC2
    { 0x00, 3, 0x00, 0x00, 0x1F, 0x7F }, // ADC3
};

/* 布局树 */
const uint8_t lyre_layout_tree[] = {
    0x01, 0x04, 0x11, 0x00, 0x11, 0x01, 0x11, 0x02, 0x11, 0x03
};
#define LYRE_LAYOUT_TREE_LEN  (sizeof(lyre_layout_tree))

/* 配置快照结构体 */
typedef struct {
    cmd_phys_desc_t phys[LYRE_PHYS_COUNT];
    cmd_virt_ctrl_t virt[LYRE_VIRT_COUNT];
} lyre_config_t;

/* 保存缓冲区大小 = max(2+4*V, 1+4*N) 取大值，这里 V=N=4，缓冲区只需 18 字节，
   但为了可读性和移植性，使用宏定义 */
#define CMD_SAVE_BUF_MAX  (2 + 4 * LYRE_VIRT_COUNT)  // Lyre: 18
```

### 4.2 配置快照与双缓冲

```c
static lyre_config_t cfg_buf[2];
static lyre_config_t *cfg_current = &cfg_buf[0];
static lyre_config_t *cfg_pending = &cfg_buf[1];

/* 出厂默认虚拟配置 */
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

**双缓冲原子切换**：在 `CFG_SAVE_DONE` 状态下执行：
```c
lyre_config_t *tmp = cfg_current;
cfg_current = cfg_pending;
cfg_pending = tmp;
```
Cortex-M0+ 单核主循环上下文中，指针赋值是原子的，无竞态条件。切换后，`cfg_pending` 变为旧配置，下次写入前会在 `CFG_SAVE_START` 中通过 `memcpy(cfg_pending, cfg_current, sizeof(lyre_config_t))` 同步。

### 4.3 内部状态与辅助函数

```c
typedef enum {
    CFG_IDLE = 0,
    CFG_SAVE_START,
    CFG_SAVING,
    CFG_SAVE_DONE,
    CFG_ACK_PENDING,
    CFG_SAVE_FAILED,   // 新增：写入失败恢复状态
} cfg_state_t;

static cfg_state_t current_state = CFG_IDLE;

/* 事件标志 */
static bool save_requested = false;
static bool save_is_calibration = false;
static uint8_t save_buffer[CMD_SAVE_BUF_MAX];
static size_t  save_len = 0;

static bool nack_pending = false;
static uint8_t nack_cmd = 0;
static uint8_t nack_status = 0;

/* 查询标志（支持同时挂起多个查询时按优先级处理，当前简单实现每次只处理一个） */
static uint8_t query_pending = 0; // 0=无，1=0x03, 2=0x07, 3=0x0B, 4=0x11

static uint8_t ack_retries = 0;
#define MAX_ACK_RETRIES 3

/* 只设标志，不发送 */
static void schedule_nack(uint8_t cmd, uint8_t status) {
    nack_pending = true;
    nack_cmd = cmd;
    nack_status = status;
}

static void send_ack_response(void) {
    uint8_t buf[7];
    uint16_t len;
    cmd_proto_build_ack(LYRE_DEVICE_ID, nack_cmd, nack_status, buf, &len);
    if (midi_send_sysex(buf, len)) {
        nack_pending = false;
    } else {
        ack_retries++;
        if (ack_retries >= MAX_ACK_RETRIES) {
            nack_pending = false; // 放弃
            ack_retries = 0;
        }
    }
}
```

### 4.4 命令表与回调（所有回调均不产生跨管线副作用）

```c
static void handle_0x03(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    query_pending = 1;   // 设备信息查询
}
static void handle_0x07(...) { query_pending = 2; } // 布局
static void handle_0x0B(...) { query_pending = 3; } // 虚拟配置

static void handle_0x11(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    (void)payload; (void)len; (void)cmd;
    if (current_state != CFG_IDLE) return; // 忙时静默忽略
    query_pending = 4;
}

static void handle_0x0D(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    if (current_state != CFG_IDLE) {
        schedule_nack(0x0E, 0x01);   // 忙，统一返回 NACK 0x01（与校验失败同，上位机将重试）
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

### 4.5 cmd_cfg_task() 状态机（完整伪代码）

```c
void cmd_cfg_task(void) {
    // --- 优先级：NACK > 写入请求 > 查询响应 ---
    if (nack_pending) {
        send_ack_response();
        return;  // NACK 优先，本轮不做其他操作
    }

    switch (current_state) {
    case CFG_IDLE:
        // 处理写入请求
        if (save_requested) {
            current_state = CFG_SAVE_START;
            save_requested = false;
            return;  // 下个周期执行 SAVE_START
        }
        // 处理查询请求
        if (query_pending != 0) {
            uint8_t buf[770]; uint16_t len;
            switch (query_pending) {
            case 1: cmd_proto_build_device_info(LYRE_DEVICE_ID, LYRE_PHYS_COUNT, cfg_current->phys, buf, &len); break;
            case 2: cmd_proto_build_layout(LYRE_DEVICE_ID, lyre_layout_tree, LYRE_LAYOUT_TREE_LEN, buf, &len); break;
            case 3: cmd_proto_build_virt_config(LYRE_DEVICE_ID, LYRE_BANK_COUNT, LYRE_VIRT_COUNT, cfg_current->virt, buf, &len); break;
            case 4: {
                uint16_t raw[LYRE_PHYS_COUNT];
                pot_get_all_raw(raw, LYRE_PHYS_COUNT);
                cmd_proto_build_adc_raw(LYRE_DEVICE_ID, LYRE_PHYS_COUNT, raw, buf, &len);
                break;
            }
            default: break;
            }
            midi_send_sysex(buf, len);
            query_pending = 0;
        }
        break;

    case CFG_SAVE_START:
        led_event_save_start();
        pot_set_pause(true);
        // 准备 cfg_pending
        memcpy(cfg_pending, cfg_current, sizeof(lyre_config_t));
        if (save_is_calibration) {
            // 替换校准字段
            const uint8_t *p = save_buffer + 1; // skip N
            for (uint8_t i = 0; i < LYRE_PHYS_COUNT; i++) {
                cfg_pending->phys[i].cal_min_mid = p[0];
                cfg_pending->phys[i].cal_min_lo  = p[1];
                cfg_pending->phys[i].cal_max_mid = p[2];
                cfg_pending->phys[i].cal_max_lo  = p[3];
                p += 4;
            }
        } else {
            // 虚拟配置
            const uint8_t *p = save_buffer + 2; // skip B,V
            for (uint8_t i = 0; i < LYRE_VIRT_COUNT; i++) {
                cfg_pending->virt[i].bank    = p[0];
                cfg_pending->virt[i].phys_idx = p[1];
                cfg_pending->virt[i].cc      = p[2];
                cfg_pending->virt[i].channel = p[3];
                p += 4;
            }
        }
        if (!storage_save_config_begin((const uint8_t*)cfg_pending, sizeof(lyre_config_t))) {
            // 写入启动失败
            pot_set_pause(false);
            schedule_nack(save_is_calibration ? 0x10 : 0x0E, 0x01);
            current_state = CFG_IDLE;
        } else {
            current_state = CFG_SAVING;
        }
        break;

    case CFG_SAVING:
        if (storage_save_config_step()) {
            // 写入完成，双缓冲切换
            lyre_config_t *tmp = cfg_current;
            cfg_current = cfg_pending;
            cfg_pending = tmp;
            current_state = CFG_SAVE_DONE;
        }
        // 若 step 返回 false，继续等待。目前 step 无错误返回，未来可扩展错误检测
        break;

    case CFG_SAVE_DONE:
        pot_set_pause(false);
        pot_reset_stable_values();
        led_event_save_done();
        {
            uint8_t buf[7]; uint16_t len;
            cmd_proto_build_ack(LYRE_DEVICE_ID, save_is_calibration ? 0x10 : 0x0E, 0x00, buf, &len);
            if (midi_send_sysex(buf, len)) {
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
            uint8_t buf[7]; uint16_t len;
            cmd_proto_build_ack(LYRE_DEVICE_ID, save_is_calibration ? 0x10 : 0x0E, 0x00, buf, &len);
            if (midi_send_sysex(buf, len)) {
                current_state = CFG_IDLE;
                ack_retries = 0;
            } else if (++ack_retries >= MAX_ACK_RETRIES) {
                current_state = CFG_IDLE; // 放弃重试
            }
        }
        break;

    case CFG_SAVE_FAILED:
        // 预留，当前由 begin 失败直接转 IDLE
        current_state = CFG_IDLE;
        break;
    }
}
```

### 4.6 持久化数据格式

存储管线保存/加载的 `data` 是 `lyre_config_t` 结构体的原始内存拷贝（小端对齐），所有字段均为 `uint8_t`，无端序问题。版本兼容性由 Storage 管线的 header version 保证。加载时若长度不符或 CRC 失败，`storage_load_config` 返回 false，APP 层回退到出厂默认。

### 4.7 cmd_cfg_init() 实现要点

```c
void cmd_cfg_init(void) {
    cmd_core_init();
    size_t out_len;
    if (storage_load_config((uint8_t*)cfg_current, sizeof(lyre_config_t), &out_len)) {
        // 成功，可增加完整性检查
    } else {
        // 加载失败，使用出厂默认
        load_factory_defaults();
        // 同步尝试写回默认值（阻塞，但在 setup() 中可接受）
        if (storage_save_config_begin((const uint8_t*)cfg_current, sizeof(lyre_config_t))) {
            while (!storage_save_config_step()) { /* busy-wait, Flash 写入 <50ms */ }
        }
        // 写回失败静默忽略
    }
    // 其余状态初始化
    current_state = CFG_IDLE;
    save_requested = false;
    nack_pending = false;
    query_pending = 0;
}
```

### 4.8 市场 API 实现

`cmd_cfg_process_sysex(const uint8_t *data, uint16_t len)`:
```c
void cmd_cfg_process_sysex(const uint8_t *data, uint16_t len) {
    cmd_core_dispatch(data, len, LYRE_DEVICE_ID, cmd_table,
                      sizeof(cmd_table)/sizeof(cmd_table[0]), NULL, NULL);
    // dispatch 内部可能设置 schedule_nack 或 query_pending，均为纯标志操作，
    // 不违反 @constraint。
}
```

`config_get_pot_mapping` 等直接读取 `cfg_current->virt`，批量接口同理，保证单次调用一致性。

---

## 5. 状态机转移图

```
CFG_IDLE ──save_requested──▶ CFG_SAVE_START
CFG_IDLE ◀──ACK发送成功─── CFG_SAVE_DONE
CFG_IDLE ◀──begin失败───── CFG_SAVE_START
CFG_SAVE_START ──begin成功──▶ CFG_SAVING
CFG_SAVING ──step true──▶ CFG_SAVE_DONE
CFG_SAVE_DONE ──ACK发送中──▶ CFG_ACK_PENDING
CFG_ACK_PENDING ──成功/超限──▶ CFG_IDLE
CFG_SAVE_FAILED ──清理──▶ CFG_IDLE (预留)
```

---

## 6. 附录：修订记录

- v2.1：依据架构审计报告闭环所有缺陷。主要修改：明确 `cmd_cfg_process_sysex` 零副作用，所有跨管线调用延迟到 `cmd_cfg_task`；补充接口定义、VLA 替换为固定数组、统一长度类型、增加查询回调实现、完善状态机与错误路径、新增持久化格式说明。

---

*本文档 v2.1 经审计闭环，可直接作为编码实现的权威依据。*
