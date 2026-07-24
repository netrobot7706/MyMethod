# MIDI 控制器自描述配置协议 v2.2

## 基于库与虚拟控件的统一配置模型

---

## 1. 概述

本协议定义了一套基于 **MIDI 系统专用信息 (SysEx)** 的控制器自描述与配置机制。它采用 **库 (Bank) 与虚拟控件 (Virtual Control)** 的统一模型，能够同时适配从最简单的固定功能旋钮盒到带库切换的复杂推子控制器的所有产品形态。

**核心思想：** 将“纯实体电位器”视为“仅有一个库”的特例，从而使所有设备，无论是否支持库切换，都运行在同一个简单、一致的配置框架下。

---

## 2. 核心概念

| 概念 | 说明 |
|------|------|
| **物理控件** | 实际焊接在 PCB 上的旋钮、推杆、按钮。通过 `0x04` 和 `0x08` 描述其电气特性和面板布局。物理映射由设备硬件决定，固件启动时加载，**不支持上位机修改**。 |
| **库 (Bank)** | 一组虚拟控件的集合。设备可有 1~127 个库。 |
| **虚拟控件** | 在特定库中绑定到一个物理控件，并具有独立 MIDI 配置（CC 号、通道）的逻辑单元。它是用户可配置的最小单位。 |
| **单库设备** | 库数量 = 1，所有虚拟控件与物理控件一一对应。这是最简单的固定功能控制器形态。 |
| **多库设备** | 库数量 > 1，一个物理控件可在不同库中被映射为不同的 MIDI 控制。常用于少量推子配合库切换按钮实现大量虚拟控制。 |

**统一关系：**
```
物理控件 ←1对多→ 虚拟控件 ←多对1→ 库
```

用户在上位机中配置的是虚拟控件。设备根据当前活跃的库编号，将物理控件的 ADC 值映射到对应的虚拟控件发送 MIDI 消息。

**按钮的行为模型：**
按钮在布局树中以 `0x12` 类型出现，表示其在面板上的物理位置。按钮的 MIDI 行为由是否出现在虚拟控件表中决定：
- 若按钮**不在**虚拟控件表中，其行为完全由设备固件定义（如切库、发送固定 Note 等），上位机仅显示其位置，不提供 MIDI 配置选项。
- 若按钮**出现**在虚拟控件表中，则其行为遵循该表的 CC/通道配置，设备应在按钮状态变化时发送对应的 MIDI 消息。
- 一个物理按钮不应同时承担切库和发送 CC 两种角色。若产品需要两者，应使用不同的物理按钮。

---

## 3. SysEx 协议基础

### 3.1 消息结构
所有消息均封装为标准 MIDI SysEx：
```
F0 7D <设备ID> <命令字> [有效载荷] <校验和> F7
```
- **厂商 ID**：`0x7D`（非商业用途）。
- **设备 ID**：`0x00` – `0x7E`（**严禁使用 `0x7F`**，该值为 MIDI 广播地址）。
- **数据字节约束**：除 `F0` 和 `F7` 外，所有字节的 bit7 必须为 0（值域 `0x00 – 0x7F`）。

### 3.2 校验和
- **算法**：Roland 式求和补码。
  ```
  sum = (待校验字节之和) & 0x7F
  checksum = (128 - sum) & 0x7F
  ```
- **校验范围**：从 `7D` 开始，到校验和前一字节为止（含）。
- **局限性**：此算法可检测单比特翻转等常见传输错误，但无法检测相邻字节交换。在 MIDI 传输典型误码模式下足够使用。若未来对完整性有更高要求，可升级为 CRC-8。

### 3.3 消息最大长度
单条 SysEx 消息（`F0` 至 `F7` 之间）应不超过 **256 字节**。虚拟控件总数 V 应满足 `4V + 6 ≤ 256`，即 **V ≤ 62**，以保证配置响应和写入命令不超出此限制。

---

## 4. 命令字定义

| 命令字 | 方向 | 功能 |
|--------|------|------|
| `0x03` | PC → 设备 | 查询物理设备信息 |
| `0x04` | 设备 → PC | 返回物理设备信息（数量、物理映射） |
| `0x07` | PC → 设备 | 查询面板布局描述 |
| `0x08` | 设备 → PC | 返回面板布局描述 |
| `0x0B` | PC → 设备 | **查询虚拟控件与库配置** |
| `0x0C` | 设备 → PC | **返回虚拟控件与库配置** |
| `0x0D` | PC → 设备 | **设置虚拟控件与库配置（写入）** |
| `0x0E` | 设备 → PC | 写入命令应答 (ACK/NACK) |

---

## 5. 物理设备信息（命令 `0x03` / `0x04`）

### 5.1 查询
```
F0 7D <ID> 03 <校验和> F7
```

### 5.2 响应
```
F0 7D <ID> 04 <物理控件数量 N> <协议版本> <物理映射数据> <校验和> F7
```
- **N** (1 字节)：物理控件总数 (1–127)。包括所有旋钮、推杆、按钮。
- **协议版本** (1 字节)：当前为 `0x12`（代表 v2.2）。版本号采用单字节线性递增：高 4 位为系列标识（v2.x = `0x1x`），低 4 位为修订号。上位机若收到的版本号高 4 位不等于自身支持的高 4 位，应提示用户更新软件。
- **物理映射数据**：每个物理控件 **2 字节**，共 2N 字节，按物理索引 0～N-1 排列。
  - 字节 1：多路器索引 (`0x00` = 直连 ADC，`0x01`–`0x7F` = 多路器芯片编号)
  - 字节 2：通道号 (直连时 ADC 通道 0–15；多路器时芯片输入通道号，上限由硬件决定)

> **注意**：物理映射由设备硬件决定，固件启动时加载，本协议不支持上位机修改物理映射。这是与 v1.x 协议的一个重要区别。

---

## 6. 面板布局描述（命令 `0x07` / `0x08`）

### 6.1 查询
```
F0 7D <ID> 07 <校验和> F7
```

### 6.2 响应
```
F0 7D <ID> 08 <长度高> <长度低> <树字节流> <校验和> F7
```
- **长度**：2 字节，14-bit MIDI 编码（高字节 = `(len >> 7) & 0x7F`，低字节 = `len & 0x7F`），表示树字节流字节数。
- **树字节流**：按前缀顺序排列的布局树。

### 6.3 节点类型编码

| 类型码 | 含义 | 后续数据 |
|--------|------|----------|
| `0x01` | 水平容器 (HBox) | 1 字节子节点数 `n`，后跟 `n` 个子节点 |
| `0x02` | 垂直容器 (VBox) | 同上 |
| `0x03` | 网格容器 (Grid) | 1 字节列数，1 字节行数，后跟 `cols × rows` 个子节点（行优先）。乘积上限 127，超出则视为无效数据 |
| `0x10` | 旋钮 (Knob) | 1 字节：物理控件逻辑索引 |
| `0x11` | 推杆 (Fader) | 1 字节：物理控件逻辑索引 |
| `0x12` | 按钮 (Button) | 1 字节：物理控件逻辑索引 |

> **类型码空间划分**：`0x01`–`0x0F` 为容器类型，`0x10`–`0x3F` 为叶子控件类型。新增类型应遵守此划分。
>
> **向前兼容策略**：
> - 遇到未知**叶子节点**（`0x10`–`0x3F` 内未识别的类型码）：消耗后续 1 字节索引（共 2 字节），UI 显示为占位符，继续解析后续节点。
> - 遇到未知**容器节点**（`0x01`–`0x0F` 内未识别的类型码）：上位机无法确定其子节点数量，**必须终止解析**并提示用户更新软件。

### 6.4 示例：上排 4 旋钮，下排 4 推杆

树字节流结构（所有数值均为十六进制）：
```
02 02                         // VBox, 2行
   01 04                      // 第1行 HBox, 4子节点
      10 00 10 01 10 02 10 03
   01 04                      // 第2行 HBox, 4子节点
      11 04 11 05 11 06 11 07
```
树字节流总长度：2 + 2 + 8 + 2 + 8 = 22 字节 = `0x16`。长度编码：`00 16`。

完整 SysEx 消息：
```
F0 7D 00 08 00 16  02 02 01 04 10 00 10 01 10 02 10 03 01 04 11 04 11 05 11 06 11 07  <校验和> F7
```

---

## 7. 虚拟控件与库配置（命令 `0x0B` / `0x0C` / `0x0D` / `0x0E`）

### 7.1 查询虚拟配置
```
F0 7D <ID> 0B <校验和> F7
```

### 7.2 响应格式
```
F0 7D <ID> 0C <库数量 B> <虚拟控件总数 V> <V个虚拟控件描述> <校验和> F7
```
- **B** (1 字节)：库总数 (1–127)。单库设备为 `0x01`。
- **V** (1 字节)：虚拟控件总数。有效范围 1–62（受消息长度限制）。必须满足 `V ≤ B × N`。
- **虚拟控件描述**：每个虚拟控件 **4 字节**，共 4V 字节，建议按库编号排序。
  - 字节 1：**库编号** (0 ~ B-1)
  - 字节 2：**物理控件逻辑索引** (0 ~ N-1)
  - 字节 3：**CC 号** (0–127)
  - 字节 4：**MIDI 通道** (0–15)

### 7.3 设置虚拟配置（写入命令 `0x0D`）
- 命令格式：`F0 7D <ID> 0D <B> <V> <4V字节数据> <校验和> F7`
- 设备收到后必须逐字段验证每条记录的合法性：
  - 库编号 < B
  - 物理控件逻辑索引 < N
  - CC ≤ 127
  - 通道 ≤ 15
  - `(库编号, 物理控件逻辑索引)` 组合在整个配置表中**不得重复**
  - 若任一记录非法，回复 `0E 01` 且**不写入 EEPROM**。
- 全部校验通过后，写入非易失性存储，并回复：
  - 成功：`F0 7D <ID> 0E 00 <校验和> F7`
  - 写入失败：`F0 7D <ID> 0E 02 <校验和> F7`
- **幂等性**：建议固件实现写前比较，相同数据跳过 EEPROM 写入。
- 上位机应在发送后等待 **500ms**，未收到应答可重试一次（间隔 400ms），共 2 次尝试。
- **设备时序**：设备在写入 EEPROM 期间宜暂停 ADC 扫描和 MIDI 数据输出，写入完成后恢复。写入期间收到的查询命令可正常应答。

### 7.4 配置示例

> **注**：以下所有数值均为十六进制。

#### 单库设备（16 个旋钮，B=1, V=16）
```
F0 7D 00 0C 01 10
   00 00 07 00   00 01 0A 01   00 02 14 00   ... (其余13个)   <校验和> F7
```
库0中，物理控件0→CC#7,ch1；物理控件1→CC#10,ch2；物理控件2→CC#20,ch1...

#### 多库设备（4 推子 + 2 按钮，4 库，B=4, V=16）
物理控件：0-3 推子，4 按钮A（切库+），5 按钮B（切库-）。
（此示例中按钮不参与虚拟控件映射，故 V = (N-2) × B = 4 × 4 = 16。）
```
F0 7D 00 0C 04 10
   00 00 07 00   00 01 08 00   00 02 09 00   00 03 0A 00   // 库0
   01 00 0B 00   01 01 0C 00   01 02 0D 00   01 03 0E 00   // 库1
   02 00 0F 00   02 01 10 00   02 02 11 00   02 03 12 00   // 库2
   03 00 13 00   03 01 14 00   03 02 15 00   03 03 16 00   // 库3
   <校验和> F7
```

---

## 8. 上位机工作流程

1. 设备连接后，依次发送 `0x03`, `0x07`, `0x0B` 获取物理信息、布局树、虚拟配置。
2. 解析布局树生成物理面板 UI。
3. 根据 `B` 和 `V` 构建虚拟控件模型：
   - 若 **B = 1**：生成静态配置界面，每个物理控件直接绑定其唯一的虚拟控件配置。
   - 若 **B > 1**：生成带库切换控件（如 Tab 页）的界面，每个库页面内显示该库下的虚拟控件。
4. 用户修改配置后，点击“写入设备”，收集所有虚拟控件的 CC/通道并构造 `0x0D` 命令发送，等待 ACK。
5. 若设备断开后重连，应重新执行步骤 1–3。

**数据验证**（上位机必须强制执行，任一失败则提示用户并拒绝操作）：
- 每个虚拟控件的物理索引 < N，库编号 < B。
- `(库编号, 物理索引)` 组合不得重复。
- 虚拟控件总数 V ≤ B × N 且 V ≤ 62。
- 布局树中所有叶子节点的物理索引必须 < N 且不得重复。建议（但非强制）验证索引 0 至 N-1 各出现一次；若存在有意隐藏的控件，应在产品文档中说明。
- 布局树中类型为**旋钮**（`0x10`）或**推杆**（`0x11`）的叶子节点，其物理索引必须在虚拟控件表**每个库**中恰好出现一次。按钮（`0x12`）不受此约束——未出现在虚拟控件表中的按钮，其行为由固件定义（如切库），上位机应允许此情况。
- 解析布局树后消耗字节数必须等于声明的长度。

---

## 9. 下位机实现参考（C 语言）

```c
#include <stdint.h>

#define MY_DEVICE_ID 0x00
#define N 6          // 物理控件总数（4推子+2按钮）
#define B 4          // 库数量
#define V 16         // 虚拟控件总数 (N-2)*B

// 物理映射表（固件固化，不支持上位机修改）
const uint8_t PHY_MAP[N][2] = { /* 多路器索引, 通道 */ };

// 虚拟控件配置
typedef struct {
    uint8_t bank;
    uint8_t phys_idx;
    uint8_t cc;
    uint8_t channel;
} virt_control_t;

virt_control_t virt_config[V];
uint8_t current_bank = 0;

// 校验和
uint8_t midi_checksum(const uint8_t *data, int len) {
    int sum = 0;
    for (int i = 0; i < len; i++) sum += data[i];
    return (128 - (sum & 0x7F)) & 0x7F;
}

// 预期长度计算宏
// 帧结构：F0(1) + 7D(1) + ID(1) + CMD(1) + B(1) + V(1) + 4*V(data) + CK(1) + F7(1)
#define SYSEX_LEN_0D(v) (8 + 4 * (v))

// 手动发送缓冲区，统一风格
static uint8_t tx_buf[256];
static int tx_len = 0;

void tx_begin() { tx_len = 0; }
void tx_byte(uint8_t b) { tx_buf[tx_len++] = b; }
void tx_end() {
    uint8_t ck = midi_checksum(&tx_buf[1], tx_len - 1); // 从 7D 开始到 payload 末
    tx_byte(ck);
    tx_byte(0xF7);
    uart_send(tx_buf, tx_len);
}

void handle_sysex(uint8_t *msg, uint16_t len) {
    if (len < 6) return;
    if (msg[0] != 0xF0 || msg[1] != 0x7D || msg[2] != MY_DEVICE_ID) return;

    uint8_t expected = midi_checksum(&msg[1], len - 3);
    if (expected != msg[len-2]) {
        if (msg[3] == 0x0D) send_nack();
        return;
    }

    switch (msg[3]) {
        case 0x03:
            send_device_info(); break;
        case 0x07:
            send_layout(); break;
        case 0x0B:
            send_virt_config(); break;
        case 0x0D:
            // 校验长度和头部
            if (len != SYSEX_LEN_0D(V) || msg[4] != B || msg[5] != V) {
                send_nack(); break;
            }
            // 逐字段校验
            for (int i = 0; i < V; i++) {
                uint8_t bank    = msg[6 + i*4];
                uint8_t phy_idx = msg[7 + i*4];
                uint8_t cc      = msg[8 + i*4];
                uint8_t channel = msg[9 + i*4];
                if (bank >= B || phy_idx >= N || cc > 127 || channel > 15) {
                    send_nack(); return;
                }
            }
            // (bank, phys_idx) 唯一性校验
            for (int i = 0; i < V; i++) {
                for (int j = i + 1; j < V; j++) {
                    if (msg[6 + i*4] == msg[6 + j*4] &&
                        msg[7 + i*4] == msg[7 + j*4]) {
                        send_nack(); return;
                    }
                }
            }
            // 全部通过，写入
            for (int i = 0; i < V; i++) {
                virt_config[i].bank    = msg[6 + i*4];
                virt_config[i].phys_idx= msg[7 + i*4];
                virt_config[i].cc      = msg[8 + i*4];
                virt_config[i].channel = msg[9 + i*4];
            }
            save_to_eeprom();
            send_ack(0x00);
            break;
    }
}

void send_ack(uint8_t status) {
    tx_begin();
    tx_byte(0xF0); tx_byte(0x7D); tx_byte(MY_DEVICE_ID);
    tx_byte(0x0E); tx_byte(status);
    tx_end();
}

void send_nack() { send_ack(0x01); }

void send_virt_config() {
    tx_begin();
    tx_byte(0xF0); tx_byte(0x7D); tx_byte(MY_DEVICE_ID); tx_byte(0x0C);
    tx_byte(B);
    tx_byte(V);
    for (int i = 0; i < V; i++) {
        tx_byte(virt_config[i].bank);
        tx_byte(virt_config[i].phys_idx);
        tx_byte(virt_config[i].cc);
        tx_byte(virt_config[i].channel);
    }
    tx_end();
}

// 主循环中发送 MIDI
// 注：对于 V 较大的设备，建议使用二维数组 virt_config[bank][phys_idx] 实现 O(1) 查找
void send_control_value(uint8_t phys_idx, uint16_t adc_val) {
    for (int i = 0; i < V; i++) {
        if (virt_config[i].bank == current_bank && virt_config[i].phys_idx == phys_idx) {
            uint8_t midi_val = adc_val >> 3;
            send_cc(virt_config[i].channel, virt_config[i].cc, midi_val);
            break;
        }
    }
}

// 库切换按钮（物理索引 4 和 5）
void check_bank_buttons() {
    if (button_fell(4)) current_bank = (current_bank + 1) % B;
    if (button_fell(5)) current_bank = (current_bank - 1 + B) % B;
}
```

> **EEPROM 有效性检查**：启动时验证 `virt_config` 中所有 CC ≤ 127、通道 ≤ 15、库编号 < B、物理索引 < N、`(bank, phys_idx)` 无重复。无效则回退至出厂默认值。推荐使用双字节标志防止半写入。

---

## 10. 上位机解析参考（JavaScript）

```javascript
function verifyChecksum(data) {
    // data: Uint8Array of full SysEx (F0 ... F7)
    let sum = 0;
    for (let i = 1; i < data.length - 2; i++) sum += data[i];
    return ((128 - (sum & 0x7F)) & 0x7F) === data[data.length - 2];
}

function parseVirtualConfig(data, N) {
    // 调用前应先验证校验和：if (!verifyChecksum(data)) throw error;
    const B = data[4];
    const V = data[5];
    if (V > 62 || V > B * N) throw new Error('V out of valid range');
    const controls = [];
    const keys = new Set();
    for (let i = 0; i < V; i++) {
        const off = 6 + i * 4;
        const bank = data[off];
        const physIdx = data[off + 1];
        const cc = data[off + 2];
        const channel = data[off + 3];
        if (bank >= B || physIdx >= N || cc > 127 || channel > 15) {
            throw new Error('Record value out of range');
        }
        const key = `${bank}:${physIdx}`;
        if (keys.has(key)) throw new Error('Duplicate (bank, phys_idx)');
        keys.add(key);
        controls.push({ bank, physIdx, cc, channel });
    }
    return { bankCount: B, controls };
}

// 验证旋钮/推杆在每个库中均存在
function validateKnobsAndFaders(layoutLeafIndices, virtControls, B) {
    const knobFaderIndices = new Set(
        layoutLeafIndices.filter(n => n.type === 'knob' || n.type === 'fader')
                       .map(n => n.index)
    );
    for (const idx of knobFaderIndices) {
        for (let b = 0; b < B; b++) {
            const found = virtControls.some(c => c.bank === b && c.physIdx === idx);
            if (!found) throw new Error(`Physical control ${idx} missing in bank ${b}`);
        }
    }
}

function parseLayout(treeData, totalLen) {
    let offset = 0;
    const leafNodes = [];
    function parseNode() {
        if (offset > totalLen) throw new Error('Parse beyond length');
        const type = treeData[offset++];
        switch (type) {
            case 0x01: case 0x02: {
                const n = treeData[offset++];
                const children = [];
                for (let i = 0; i < n; i++) children.push(parseNode());
                return { type: type===0x01?'hbox':'vbox', children };
            }
            case 0x03: {
                const cols = treeData[offset++];
                const rows = treeData[offset++];
                const total = cols * rows;
                if (total > 127) throw new Error('Grid too large');
                const children = [];
                for (let i = 0; i < total; i++) children.push(parseNode());
                return { type: 'grid', cols, rows, children };
            }
            case 0x10: case 0x11: case 0x12: {
                const idx = treeData[offset++];
                const node = { type: type===0x10?'knob':type===0x11?'fader':'button', index: idx };
                leafNodes.push(node);
                return node;
            }
            default:
                if (type >= 0x10 && type <= 0x3F) {
                    const idx = treeData[offset++];
                    const node = { type: 'unknown_leaf', originalType: type, index: idx };
                    leafNodes.push(node);
                    return node;
                } else {
                    throw new Error(`Unknown container type: ${type}. Please update software.`);
                }
        }
    }
    const root = parseNode();
    if (offset !== totalLen) throw new Error('Layout length mismatch');
    return { root, leafNodes };
}
```

---

## 11. 协议版本与兼容性

| 项目 | 说明 |
|------|------|
| 当前版本 | **v2.2**，协议版本号 `0x12` |
| 版本号规则 | 单字节线性递增。高 4 位为系列标识（v2.x = `0x1x`），低 4 位为修订号。若修订号超过 15，应递增系列标识（如 v2.16 使用 `0x20`），或升级为 2 字节版本号 |
| 主版本不兼容 | 上位机若收到版本号高 4 位不等于自身支持的高 4 位，应提示用户更新软件，并可回退为安全模式（只读配置） |
| 向前兼容 | 遵循 §6.3 中的叶子/容器兼容策略 |

---

## 12. 已知设计与未来方向

本章节记录了在协议评审中考虑但**有意未采纳**的若干设计建议，以及可能在协议未来版本中引入的功能。这些决策是基于当前产品定位和复杂度权衡的结果。

### 12.1 全量写入而非部分更新

**现状**：`0x0D` 命令要求每次发送全部虚拟控件配置（最多 4V 字节），不支持仅更新单个控件。

**决策理由**：配置修改是低频操作。V ≤ 62 的约束使单次全量写入的最大载荷仅为 248 字节，传输和 EEPROM 写入均在毫秒级完成。全量写入简化了协议状态管理和错误恢复逻辑。

**未来可能引入**：当需要支持超大规模配置或自动化实时配置同步时，可增加部分更新命令字。

### 12.2 当前库编号不持久化

**现状**：`current_bank` 是设备 RAM 中的变量，上电默认从库 0 开始。协议不强制要求设备记住上次使用的库编号。

**决策理由**：属于产品行为定义，而非通信协议范畴。上位机查询配置时获取的是全量数据，不依赖设备当前所处的库。产品可根据自身需求决定是否将 `current_bank` 写入 EEPROM。

### 12.3 虚拟控件查找采用线性遍历

**现状**：参考代码中 `send_control_value()` 使用线性遍历查找当前活跃库下某物理控件对应的虚拟控件。

**决策理由**：对于典型设备（V ≤ 62），线性遍历的性能影响可忽略不计。参考代码旨在表达逻辑，生产固件可自行优化为二维数组 `virt_config[bank][phys_idx]` 实现 O(1) 查找。

### 12.4 校验和算法沿用 Roland 式求和

**现状**：使用 Roland 式 7-bit 求和校验和，而非 CRC-8 等更强校验算法。

**决策理由**：Roland 校验和在 MIDI 行业中广泛使用，实现极简，足以应对 USB-MIDI 和 DIN-5 传输中的典型误码模式。

### 12.5 物理映射只读

**现状**：v2.x 协议不支持上位机在线修改物理映射表，该表由设备固件在编译时或工厂校准阶段固化。

**决策理由**：物理映射是硬件接线层面的属性，应由制造者而非最终用户管理。移除动态修改功能降低了误操作风险和固件复杂度。

---

## 13. 版本历史

| 版本 | 协议版本号 | 主要特性 |
|------|------------|----------|
| v1.x | `0x01`–`0x03` | 静态配置，无库概念。v2.x 完全不兼容 |
| v2.0 | `0x10` | 引入库与虚拟控件统一模型，全新设计 |
| v2.1 | `0x11` | V 上限约束；0x0D 逐字段校验；按钮行为明确化；物理映射只读说明；版本号编码规则；向前兼容精确描述；增加“已知设计”章节 |
| v2.2 | `0x12` | 增加 (bank, phys_idx) 唯一性校验；明确旋钮/推杆必须在每个库中存在（按钮除外）；统一参考代码风格；示例补充完整消息格式；EEPROM 写入期间设备行为说明；版本号扩展性说明 |

---
