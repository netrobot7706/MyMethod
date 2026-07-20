# Lyre 产品命令协议 v1.4

## 1. 概述

本文档定义 **Lyre 四推杆 MIDI 控制器**的产品特有命令协议。它继承《Veloce 基础命令协议 v1.4》的所有规定（帧格式、状态机、心跳、握手、恢复出厂、错误应答），并在此基础上定义推杆配置、ADC 采集与校准等业务命令。

### 1.1. 产品帧长
本产品最大帧数据长度继承基础协议默认值 **512 字节**。设备在握手时报告 `max_frame_len=512`。

### 1.2. 引用基础协议
以下章节直接引用《Veloce 基础命令协议 v1.4》，本文档不再重复：
- 帧格式（定界、字符集、长度限制、同步恢复、数值约定）
- 设备状态机（IDLE / CONNECTED / 连接超时、心跳保活）
- 通用命令（handshake、ping、factory_reset）
- 通用错误码（code 1-4, 6）
- 通用超时规范（handshake、ping、factory_reset）
- 通用实现注意事项

---

## 2. 产品命名规范

- `pot`：推杆索引，取值 0‑3，表示 4 个推杆之一。
- `midi_ch`：MIDI 通道，取值 1‑16。
- `cc`：MIDI CC 号，取值 0‑127。
- `min` / `max`：ADC 校准最小/最大值。
- 所有命令名遵循基础协议的 **`动词_名词`** 风格。

### 2.1. 命令域归属
本协议定义的所有命令均为**配置域命令**，受协议版本匹配限制。

---

## 3. 产品命令集

### 3.1. 读取推杆配置
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| read_cfg | 上位机→设备 | `[cmd=read_cfg]` | 请求读取设备永久存储的当前推杆配置。 |
| read_cfg | 设备→上位机 | `[cmd=read_cfg;<pot>_midi_ch=...;<pot>_cc=...;...]` | 返回配置。若设备无已保存配置，返回出厂默认值。失败时返回 error 帧。 |

> **命名说明**：此命令的请求帧无业务参数，因此应答帧命令名与请求帧相同，符合基础协议 `read` 应答规则。由于配置操作始终全量读写，命令名中不再出现 `pot`。

**配置字段格式**：
- 每个推杆使用编号前缀 `0_`、`1_`、`2_`、`3_`，后接属性名：
  - `<pot>_midi_ch`：MIDI 通道
  - `<pot>_cc`：CC 号
  - `<pot>_min`：校准最小值
  - `<pot>_max`：校准最大值
- 必须返回 4 个推杆的完整配置，每个推杆包含上述 4 个字段。

**超时**：1000ms，最多重试 2 次。

**示例**：
```
上位机 → 设备: [cmd=read_cfg]
设备 → 上位机: [cmd=read_cfg;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
```

---

### 3.2. 写入推杆配置（全量）
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| write_cfg | 上位机→设备 | `[cmd=write_cfg;<完整字段列表>]` | 将推杆配置全量写入设备永久存储。**必须包含全部 4 个推杆的全部字段**。 |
| write_cfg_ack | 设备→上位机 | `[cmd=write_cfg_ack]` | 写入成功确认。 |
| error | 设备→上位机 | `[cmd=error;code=<错误码>;msg=<描述>]` | 写入失败时返回错误帧。 |

**强制全量写入规则**：
- `write_cfg` 请求必须包含且仅包含以下 16 个字段（4 个推杆 × 4 个属性）：
  - `0_midi_ch`, `0_cc`, `0_min`, `0_max`
  - `1_midi_ch`, `1_cc`, `1_min`, `1_max`
  - `2_midi_ch`, `2_cc`, `2_min`, `2_max`
  - `3_midi_ch`, `3_cc`, `3_min`, `3_max`
- 缺少任何一个字段、或包含任何额外未知字段，设备均返回错误 `[cmd=error;code=3;msg=invalid_fields]`。

**字段合法性校验**：
设备必须对所有字段进行校验，非法时返回 error (code=3)：
- `midi_ch`：必须为 1‑16。
- `cc`：必须为 0‑127。
- `min` / `max`：必须满足 `min < max`。
- 任何字段值类型不合法或越界，均立即拒绝整帧写入。

**成功确认**：
- 写入成功后，设备回复不带任何业务参数的 `write_cfg_ack`，仅表示成功。
- 上位机无需逐字段核对，写入成功即代表所有值已按请求生效。

**超时**：2000ms，不重试（避免重复写入 Flash）。

**示例（唯一合法形式）**：
```
上位机 → 设备: [cmd=write_cfg;0_midi_ch=1;0_cc=70;0_min=95;0_max=4010;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
设备 → 上位机: [cmd=write_cfg_ack]
```

**非法请求示例**：
```
上位机 → 设备: [cmd=write_cfg;0_min=5000;0_max=100;...]  (min>=max)
设备 → 上位机: [cmd=error;code=3;msg=min_must_be_less_than_max]

上位机 → 设备: [cmd=write_cfg;0_cc=200;...]  (cc 越界)
设备 → 上位机: [cmd=error;code=3;msg=cc_out_of_range]

上位机 → 设备: [cmd=write_cfg]  (空字段)
设备 → 上位机: [cmd=error;code=3;msg=invalid_fields]

上位机 → 设备: [cmd=write_cfg;2_cc=72]  (字段不全)
设备 → 上位机: [cmd=error;code=3;msg=invalid_fields]
```

---

### 3.3. 读取 ADC 原始值（单次）
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| read_adc | 上位机→设备 | `[cmd=read_adc;pot=<推杆>]` | 请求指定推杆的当前 ADC 原始值。 |
| report_adc | 设备→上位机 | `[cmd=report_adc;pot=<推杆>;raw=<ADC值>]` | 返回 ADC 原始值。 |

> **命名说明**：此命令的请求帧携带业务参数 `pot`，因此应答使用独立命令名 `report_adc`，符合基础协议对带有业务参数的 `read` 命令的例外规定。

- `pot`：0‑3。
- `raw`：当前 ADC 采样值，范围 0‑4095。

**超时**：500ms，最多重试 2 次。

**示例**：
```
上位机 → 设备: [cmd=read_adc;pot=0]
设备 → 上位机: [cmd=report_adc;pot=0;raw=110]
```

---

## 4. 产品错误码扩展

除基础协议定义的通用错误码（code 1-4, 6）外，本产品新增：

| 代码 | 含义 | 示例 msg |
| :--- | :--- | :--- |
| 5 | 推杆索引越界 | `pot_must_be_0_to_3` |

---

## 5. 产品超时规范

| 命令 | 上位机超时 | 最大重试次数 | 说明 |
|:---|:---|:---|:---|
| read_cfg | 1000ms | 2 | |
| write_cfg | 2000ms | 1 | Flash 操作耗时，不重试 |
| read_adc | 500ms | 2 | |

> 通用命令超时（handshake、ping、factory_reset）见基础协议第 6 节。

---

## 6. 交互流程示例

### 6.1. 启动与配置读取
```
上位机 → 设备: [cmd=handshake]
设备 → 上位机: [cmd=handshake_ack;id=LYRE-A1B2;ver=1.0;base_proto_ver=1.4;biz_proto_ver=1.4;max_frame_len=512]
上位机 → 设备: [cmd=read_cfg]
设备 → 上位机: [cmd=read_cfg;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]

(保持连接期间，上位机每 10 秒发 ping)
上位机 → 设备: [cmd=ping]
设备 → 上位机: [cmd=pong]
```

### 6.2. 校准（上位机引导式）
校准完全由上位机通过用户引导完成，无需设备端流模式或临时校准命令。

```
(上位机弹出校准向导，提示用户推动推杆 0 至最高点)
用户点击"确认最高点"
上位机 → 设备: [cmd=read_adc;pot=0]
设备 → 上位机: [cmd=report_adc;pot=0;raw=4010]   (上位机记录 max=4010)

(向导提示用户推动推杆 0 至最低点)
用户点击"确认最低点"
上位机 → 设备: [cmd=read_adc;pot=0]
设备 → 上位机: [cmd=report_adc;pot=0;raw=95]     (上位机记录 min=95)

(以此类推完成 4 个推杆的极值采集，最后上位机将保留的其他字段与新的 min/max 组合成全量配置)
上位机 → 设备: [cmd=write_cfg;0_midi_ch=1;0_cc=70;0_min=95;0_max=4010;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
设备 → 上位机: [cmd=write_cfg_ack]

(校准完成，新校准值已永久保存)
```

> **说明**：上位机在构造 `write_cfg` 时，可以使用先前 `read_cfg` 获取的其他字段（如 `midi_ch`、`cc` 以及未校准推杆的 `min`/`max`），仅替换新采集的 `min`/`max`，确保全量合法写入。

### 6.3. IDLE 状态下直接发配置命令
```
上位机 → 设备: [cmd=write_cfg;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;...]
设备 → 上位机: [cmd=error;code=6;msg=not_connected]
上位机 → 设备: [cmd=handshake]                   ← 上位机自动重新握手
设备 → 上位机: [cmd=handshake_ack;id=LYRE-A1B2;ver=1.0;base_proto_ver=1.4;biz_proto_ver=1.4;max_frame_len=512]
上位机 → 设备: [cmd=write_cfg;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;...]
设备 → 上位机: [cmd=write_cfg_ack]
```

### 6.4. 错误处理
```
上位机 → 设备: [cmd=read_adc;pot=4]
设备 → 上位机: [cmd=error;code=5;msg=pot_must_be_0_to_3]

上位机 → 设备: [cmd=write_cfg;0_min=1000;0_max=800;...]
设备 → 上位机: [cmd=error;code=3;msg=min_must_be_less_than_max]

上位机 → 设备: [cmd=write_cfg;0_cc=200;...]
设备 → 上位机: [cmd=error;code=3;msg=cc_out_of_range]

上位机 → 设备: [cmd=write_cfg]  (字段不全)
设备 → 上位机: [cmd=error;code=3;msg=invalid_fields]
```

---

## 7. 产品实现注意事项

### 7.1. MCU 实现要点
- 帧缓冲区 512 字节，握手时报告 `max_frame_len=512`。
- 实现 `read_cfg`、`write_cfg`、`read_adc` 三个命令的处理函数，注册到基础协议的命令分发表（配置域）。
- `write_cfg` 必须进行完整字段检查：字段数量恰好 16 个，无未知字段，所有值合法。任一不满足则拒绝整体写入，返回错误码 3。不做部分更新，不静默修正。
- 上电加载配置时必须校验 `min < max`，非法则对该推杆使用出厂默认校准值（但保留 CC 和通道）。
- `read_adc` 每次执行一次 ADC 采样并返回结果，无任何流状态。

### 7.2. 上位机实现要点
- 在基础协议实现之上，增加产品命令的构造与解析。
- 握手后记录 `max_frame_len`，发送帧时确保数据部分不超过该值（本产品为 512）。
- 发送 `write_cfg` 时，**必须拼装全部 16 个字段**。建议先调用 `read_cfg` 获取当前配置，修改指定字段后再全量写入。
- 校准向导：通过一系列 `read_adc` 在用户确认下采集极值，最后调用 `write_cfg` 一次性保存。
- 上位机可基于 `read_adc` 实现定时轮询，以满足任何实时监视需求（如校准前检查推杆平滑度），无需设备端支持流模式。

---

**文档版本**：1.4
**最后更新**：2026-07-20
**适用范围**：Lyre 四推杆 MIDI 控制器（须配合《Veloce 基础命令协议 v1.4》使用）
