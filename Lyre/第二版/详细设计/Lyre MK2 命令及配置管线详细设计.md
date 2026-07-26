# Lyre MK2 命令及配置管线详细设计（v2.0 — CORE/APP 分离版）

> **文档版本**：v2.0  
> **关联架构文档**：《Lyre MK2 产品架构设计文档 v2.2》  
> **关联协议**：《MIDI 控制器自描述配置协议 v2.6》  
> **管线**：Command & Config  
> **状态**：冻结基线，可直接用于编码实现

---

## 1. 设计目标与分层策略

命令及配置管线承担所有 SysEx 协议消息的解析、分发、状态维护及跨管线协调任务。遵循 **“最大可移植性”** 原则，本设计将管线清晰切分为两层：

- **cmd_core（CORE 层）**：  
  与产品完全无关的协议引擎，提供 SysEx 帧解析、校验和验证、命令分发，以及所有《MIDI 控制器自描述配置协议 v2.6》定义的通用校验与响应帧构建。**零外部依赖，零 `market/` API 调用**，可在不同产品间直接拷贝复用。

- **cmd_cfg_app（APP 层）**：  
  Lyre 产品专用外壳，极薄一层。仅包含：
  - Lyre 的产品参数定义（N、B、V、物理描述、布局树）。
  - 命令回调中调用 `cmd_core` 校验并提取配置、设置状态机标志。
  - 通过 `cmd_cfg_task()` 状态机编排跨管线交互（存储、LED、Pot 暂停等）。
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
- **校准数据 payload 校验**（长度、`cal_max > cal_min`）。
- **应答帧构建**（ACK/NACK）。
- **数据响应帧构建**（0x04、0x08、0x0C、0x12）。

`cmd_core` **绝不** 操作任何硬件、存储或调用其他管线。

### 3.2 协议数据类型定义（与产品解耦）

`cmd_core` 需要访问物理描述和虚拟控件描述的字节布局，但不应依赖产品的具体结构体。因此，我们在 `cmd_core.h` 中定义协议层通用类型：

```c
/* === cmd_core.h 片段 === */

/* 物理控件描述（严格遵循协议 0x04 的 6 字节布局） */
typedef struct {
    uint8_t  mux;          // 多路器索引
    uint8_t  channel;      // 通道号
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
```

APP 层若使用相同布局的结构体，可直接强制转换；若布局不同，则需在调用 CORE 函数前手动拷贝转换。本产品中 APP 层直接使用这些类型以简化设计。

### 3.3 新增的通用协议函数接口

在原有 `cmd_core_dispatch` 基础上，增加以下函数：

```c
/* === cmd_core.h 新增 === */

#define CMD_PROTO_VERSION       0x16   // v2.6

// ---- 校验函数 ----

/**
 * 校验虚拟控件配置 payload。
 * payload 格式：B(1) V(1) + 4V 数据
 * @return 0 成功；非 0 错误码
 */
uint8_t cmd_proto_validate_virt_config(const uint8_t *payload, uint16_t len,
                                       uint8_t B_expected, uint8_t V_expected,
                                       uint8_t N_expected);

/**
 * 校验校准数据 payload。
 * payload 格式：N(1) + 4N 校准数据
 * @return 0 成功；非 0 错误码
 */
uint8_t cmd_proto_validate_calibration(const uint8_t *payload, uint16_t len,
                                       uint8_t N_expected);

// ---- 响应构建函数（仅生成帧数据，不发送） ----

/** 构建 ACK/NACK 响应帧，固定 7 字节。 */
void cmd_proto_build_ack(uint8_t device_id, uint8_t ack_cmd, uint8_t status,
                         uint8_t *buf_out, uint8_t *len_out);

/** 构建 0x04 物理设备信息响应帧。 */
void cmd_proto_build_device_info(uint8_t device_id, uint8_t N,
                                 const cmd_phys_desc_t *phys,
                                 uint8_t *buf_out, uint16_t *len_out);

/** 构建 0x0C 虚拟配置响应帧。 */
void cmd_proto_build_virt_config(uint8_t device_id, uint8_t B, uint8_t V,
                                 const cmd_virt_ctrl_t *virt,
                                 uint8_t *buf_out, uint16_t *len_out);

/** 构建 0x12 ADC 原始值响应帧。 */
void cmd_proto_build_adc_raw(uint8_t device_id, uint8_t N,
                             const uint16_t *raw_values,
                             uint8_t *buf_out, uint16_t *len_out);

/** 构建 0x08 面板布局响应帧（布局树字节流由调用者提供）。 */
void cmd_proto_build_layout(uint8_t device_id, const uint8_t *tree_data,
                            uint16_t tree_len,
                            uint8_t *buf_out, uint16_t *len_out);
```

所有构建函数输出的缓冲区大小需要调用者根据协议上限分配（例如 770 字节）。校验和由函数内部自动计算。

### 3.4 实现要点

#### 校验函数实现

```c
uint8_t cmd_proto_validate_virt_config(const uint8_t *payload, uint16_t len,
                                       uint8_t B_expected, uint8_t V_expected,
                                       uint8_t N_expected) {
    if (len < 2) return 1;
    uint8_t B = payload[0];
    uint8_t V = payload[1];
    if (B != B_expected || V != V_expected) return 2;
    if (len != (2 + 4 * V)) return 3;

    // 唯一性检查表：最大 B*N <= 127*127 但可动态分配或使用栈数组
    bool used[B_expected * N_expected];  // C99 VLA，或根据需要改为固定大小
    memset(used, 0, sizeof(used));

    for (uint8_t i = 0; i < V; i++) {
        uint8_t bank    = payload[2 + i*4];
        uint8_t phys    = payload[2 + i*4 + 1];
        uint8_t cc      = payload[2 + i*4 + 2];
        uint8_t channel = payload[2 + i*4 + 3];

        if (bank >= B_expected || phys >= N_expected || cc > 127 || channel > 15)
            return 4;
        uint8_t idx = bank * N_expected + phys;
        if (used[idx]) return 5;
        used[idx] = true;
    }
    return 0;
}
```

#### 响应构建函数示例（0x04）

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
    buf_out[pos++] = CMD_PROTO_VERSION;  // 0x16

    for (uint8_t i = 0; i < N; i++) {
        buf_out[pos++] = phys[i].mux;
        buf_out[pos++] = phys[i].channel;
        buf_out[pos++] = phys[i].cal_min_mid;
        buf_out[pos++] = phys[i].cal_min_lo;
        buf_out[pos++] = phys[i].cal_max_mid;
        buf_out[pos++] = phys[i].cal_max_lo;
    }

    // 校验和从索引 1 到当前末尾
    uint8_t ck = roland_checksum(&buf_out[1], pos - 1);
    buf_out[pos++] = ck;
    buf_out[pos++] = 0xF7;
    *len_out = pos;
}
```

其他构建函数类似，严格遵循协议文档的格式。布局树构建函数接收外部已组织好的树字节流，无需 CORE 理解节点语义。

### 3.5 原有 `cmd_core_dispatch` 保留不变

依然提供最底层帧解析与命令分发。校验和错误时返回错误码，不自动构建 NACK，由 APP 层决定是否回复。

---

## 4. cmd_cfg_app 详细设计（Lyre 专用）

APP 层现在极其简洁：**定义产品常量与数据 + 注册命令回调 + 维护状态机**。

### 4.1 产品常量与类型

```c
#define LYRE_PHYS_COUNT        4
#define LYRE_BANK_COUNT        1
#define LYRE_VIRT_COUNT        4
#define LYRE_DEVICE_ID         0x00  // 默认，可修改

// 物理描述数组（固化映射）
const cmd_phys_desc_t lyre_phys_default[LYRE_PHYS_COUNT] = {
    { 0x00, 0, 0x00, 0x00, 0x1F, 0x7F }, // GPIO26, ADC0
    { 0x00, 1, 0x00, 0x00, 0x1F, 0x7F }, // GPIO27, ADC1
    { 0x00, 2, 0x00, 0x00, 0x1F, 0x7F }, // GPIO28, ADC2
    { 0x00, 3, 0x00, 0x00, 0x1F, 0x7F }, // GPIO29, ADC3
};

// 布局树（上排4推杆）
const uint8_t lyre_layout_tree[] = {
    0x01, 0x04,          // HBox, 4 children
    0x11, 0x00,          // Fader, phys index 0
    0x11, 0x01,          // Fader, phys index 1
    0x11, 0x02,          // Fader, phys index 2
    0x11, 0x03           // Fader, phys index 3
};
#define LYRE_LAYOUT_TREE_LEN   (sizeof(lyre_layout_tree))
```

### 4.2 配置快照与双缓冲

```c
typedef struct {
    cmd_phys_desc_t phys[LYRE_PHYS_COUNT];
    cmd_virt_ctrl_t virt[LYRE_VIRT_COUNT];
} lyre_config_t;

static lyre_config_t cfg_buf[2];
static lyre_config_t *cfg_current = &cfg_buf[0];
static lyre_config_t *cfg_pending = &cfg_buf[1];
```

出厂默认虚拟配置（CC1–CC4, 通道0）：

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

### 4.3 命令表与回调

```c
static void handle_0x03(const uint8_t *payload, uint16_t len, uint8_t cmd);
static void handle_0x07(const uint8_t *payload, uint16_t len, uint8_t cmd);
static void handle_0x0B(const uint8_t *payload, uint16_t len, uint8_t cmd);
static void handle_0x0D(const uint8_t *payload, uint16_t len, uint8_t cmd);
static void handle_0x0F(const uint8_t *payload, uint16_t len, uint8_t cmd);
static void handle_0x11(const uint8_t *payload, uint16_t len, uint8_t cmd);

static const cmd_entry_t cmd_table[] = {
    { 0x03, handle_0x03 },
    { 0x07, handle_0x07 },
    { 0x0B, handle_0x0B },
    { 0x0D, handle_0x0D },
    { 0x0F, handle_0x0F },
    { 0x11, handle_0x11 },
};
```

**回调示例（0x0D）**：极度精简

```c
static void handle_0x0D(const uint8_t *payload, uint16_t len, uint8_t cmd) {
    if (cmd_cfg_get_state() != CFG_IDLE) {
        schedule_nack(0x0E, 0x02);  // busy
        return;
    }

    uint8_t err = cmd_proto_validate_virt_config(payload, len,
                                                 LYRE_BANK_COUNT, LYRE_VIRT_COUNT,
                                                 LYRE_PHYS_COUNT);
    if (err != 0) {
        schedule_nack(0x0E, 0x01);
        return;
    }

    // 保存原始 payload 以备稍后写入 cfg_pending
    memcpy(save_buffer, payload, len);
    save_len = len;
    save_is_calibration = false;
    save_requested = true;
}
```

### 4.4 状态机（cmd_cfg_task）

状态机逻辑与之前基本一致，但所有数据帧的构造均使用 `cmd_core` 提供的构建函数。

**CFG_IDLE 状态下的响应发送：**

- 查询 0x03：调用 `cmd_proto_build_device_info(LYRE_DEVICE_ID, LYRE_PHYS_COUNT, cfg_current->phys, buf, &len)` 然后 `midi_send_sysex(buf, len)`。
- 查询 0x07：调用 `cmd_proto_build_layout(LYRE_DEVICE_ID, lyre_layout_tree, LYRE_LAYOUT_TREE_LEN, buf, &len)`。
- 查询 0x0B：调用 `cmd_proto_build_virt_config(LYRE_DEVICE_ID, LYRE_BANK_COUNT, LYRE_VIRT_COUNT, cfg_current->virt, buf, &len)`。
- 查询 0x11：调用 `pot_get_all_raw()` 后调用 `cmd_proto_build_adc_raw(LYRE_DEVICE_ID, LYRE_PHYS_COUNT, raw, buf, &len)`。

**CFG_SAVE_START 中的配置填充：**

- 0x0D：复制 `cfg_current` 到 `cfg_pending`，用 `payload` 中的数据覆写 `cfg_pending->virt`。
- 0x0F：复制 `cfg_current` 到 `cfg_pending`，用 `payload` 中的校准数据覆写 `cfg_pending->phys` 中的校准字段（mux, channel 保持不变）。

**保存完毕后双缓冲切换**。

### 4.5 市场 API 实现一览

`cmd_cfg_init()`：尝试从存储加载，失败则使用出厂默认并尝试写回。  
`cmd_cfg_process_sysex()`：调用 `cmd_core_dispatch`，根据返回状态决定是否 schedule nack。  
`config_get_*` 系列：直接读取 `cfg_current`。  
`cmd_cfg_get_state()`：返回 `current_state`。  
`cmd_cfg_task()`：运行状态机。

---

## 5. 与其他管线的交互

交互点与之前完全相同，但由于 APP 层不再内置响应构建逻辑，所有 SysEx 帧的生成均通过 `cmd_core` 的构建函数完成，调用时机由 `cmd_cfg_task` 控制。

---

## 6. 移植性总结

当需要为另一个使用《协议 v2.6》的 MIDI 控制器开发固件时：

1. **保留** `cmd_core.c/h`（直接拷贝）。
2. **重写** `cmd_cfg_app.c/h`，仅需：
   - 修改物理控件数 N、库数 B、虚拟控件数 V。
   - 提供物理描述数组（引脚映射）和布局树。
   - 调整出厂默认虚拟映射。
   - 其他状态机逻辑保持高度相似，基本只需复制粘贴并调整常量。
3. 上层 `market/cmd_cfg_api.h` 接口形状不变，新产品只需提供一致的 `config_get_pot_mapping` 等实现。

整条管线从“与产品耦合”转变为“协议引擎 + 产品薄壳”，符合架构设计中 CORE 层“免检拷贝”的最高复用原则。

---

## 附录 A：cmd_core API 完整清单

| 函数 | 类别 | 依赖 |
|------|------|------|
| `cmd_core_init()` | 初始化 | 无 |
| `cmd_core_dispatch()` | 命令分发 | 无 |
| `cmd_proto_validate_virt_config()` | 校验 | 无 |
| `cmd_proto_validate_calibration()` | 校验 | 无 |
| `cmd_proto_build_ack()` | 响应构建 | 无 |
| `cmd_proto_build_device_info()` | 响应构建 | 无 |
| `cmd_proto_build_virt_config()` | 响应构建 | 无 |
| `cmd_proto_build_adc_raw()` | 响应构建 | 无 |
| `cmd_proto_build_layout()` | 响应构建 | 无 |

所有函数均为纯计算，可在任何平台上编译运行。

---

*本文档 v2.0 彻底贯彻“最大可移植性”，将通用协议逻辑完全收束至 cmd_core 层，cmd_cfg_app 仅保留 Lyre 强相关定义。后续任何基于协议 v2.6 的产品均可复用 cmd_core 而不必重写协议处理。*
