# Lyre 产品命令协议 v1.0

## 1. 概述

本文档定义 **Lyre 四推杆 MIDI 控制器**的产品特有命令协议。它继承《Veloce 基础命令协议 v1.0》的所有规定（帧格式、状态机、握手、恢复出厂、错误应答），并在此基础上定义推杆配置、ADC 采集、校准等业务命令。

### 1.1. 产品帧长
本产品最大帧数据长度继承基础协议默认值 **512 字节**。设备在握手时报告 `max_frame_len=512`。

### 1.2. 引用基础协议
以下章节直接引用《Veloce 基础命令协议 v1.0》，本文档不再重复：
- 帧格式（定界、字符集、长度限制、同步恢复、数值约定）
- 设备状态机（IDLE / CONNECTED / 连接超时）
- 通用命令（handshake、factory_reset）
- 通用错误码（code 1-4, 6）
- 通用超时规范（handshake、factory_reset）
- 通用实现注意事项

---

## 2. 产品命名规范

- `pot`：推杆索引，取值 0‑3，表示 4 个推杆之一。
- `midi_ch`：MIDI 通道，取值 1‑16。
- `cc`：MIDI CC 号，取值 0‑127。
- `min` / `max`：ADC 校准最小/最大值。
- 所有命令名遵循基础协议的 **`动词_名词`** 风格。

---

## 3. 产品命令集

### 3.1. 读取推杆配置
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| read_pot_config | 上位机→设备 | `[cmd=read_pot_config]` | 请求读取设备永久存储的当前推杆配置。 |
| read_pot_config | 设备→上位机 | `[cmd=read_pot_config;<pot>_midi_ch=...;<pot>_cc=...;...]` | 返回配置。若设备无已保存配置，返回出厂默认值。失败时返回 error 帧。 |

**配置字段格式**：
- 每个推杆使用编号前缀 `0_`、`1_`、`2_`、`3_`，后接属性名：
  - `<pot>_midi_ch`：MIDI 通道
  - `<pot>_cc`：CC 号
  - `<pot>_min`：校准最小值
  - `<pot>_max`：校准最大值
- 必须返回 4 个推杆的完整配置，每个推杆至少包含上述 4 个字段。

**超时**：1000ms，最多重试 2 次。

**示例**：
```
上位机 → 设备: [cmd=read_pot_config]
设备 → 上位机: [cmd=read_pot_config;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
```

---

### 3.2. 写入推杆配置
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| write_pot_config | 上位机→设备 | `[cmd=write_pot_config;<字段列表>]` | 保存推杆配置字段到设备永久存储。支持全量或部分字段。 |
| write_pot_config_ack | 设备→上位机 | `[cmd=write_pot_config_ack;status=ok;<回传字段>]` | 保存成功确认，回传上位机发送的字段及设备实际写入的值。 |
| error | 设备→上位机 | `[cmd=error;code=<错误码>;msg=<描述>]` | 保存失败时返回错误帧。 |

**字段合法性校验（强制）**：
设备收到 `write_pot_config` 时必须对所有字段进行校验，**严禁静默裁剪或修正非法值**。校验规则：
- `midi_ch`：必须为 1‑16，否则返回 error (code=3)。
- `cc`：必须为 0‑127，否则返回 error (code=3)。
- `min` / `max`：
  - 必须满足 `min < max`，否则返回 error (code=3)。
  - 若只更新了 `min` 或 `max` 之一，设备应与未更新的另一侧组合后校验 `min < max` 仍成立。
- 未知字段名（如 `0_curve`）：返回 error (code=3)。
- `pot` 编号越界（如 `4_cc`）：返回 error (code=5)。
- 空字段列表（除 `cmd` 外无其他字段）：返回 error (code=3, msg=`no_fields_provided`)。

**部分更新语义**：
- 可以只发送需要修改的字段。设备只更新指定字段，其他字段保持不变。
- 必须确保部分更新后整体配置合法（如上所述）。

**`write_pot_config_ack` 回传规则**：
- 回传字段集合 **等于** 上位机在 `write_pot_config` 中显式发送的字段集合。
- 值为设备**实际写入永久存储**的值。
- 上位机核对逻辑：遍历自己发送的每个 key，逐值与 ACK 中对应值比对。若有不一致，应视为写入异常并提示用户。

**超时**：2000ms，不重试（避免重复写入 Flash）。

**示例（全量写入）**：
```
上位机 → 设备: [cmd=write_pot_config;0_midi_ch=1;0_cc=70;0_min=95;0_max=4010;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
设备 → 上位机: [cmd=write_pot_config_ack;status=ok;0_midi_ch=1;0_cc=70;0_min=95;0_max=4010;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
```

**示例（部分写入）**：
```
上位机 → 设备: [cmd=write_pot_config;2_cc=72]
设备 → 上位机: [cmd=write_pot_config_ack;status=ok;2_cc=72]
```

**非法值示例**：
```
上位机 → 设备: [cmd=write_pot_config;0_min=5000;0_max=100]
设备 → 上位机: [cmd=error;code=3;msg=min_must_be_less_than_max]

上位机 → 设备: [cmd=write_pot_config;0_cc=200]
设备 → 上位机: [cmd=error;code=3;msg=cc_out_of_range]

上位机 → 设备: [cmd=write_pot_config]
设备 → 上位机: [cmd=error;code=3;msg=no_fields_provided]
```

---

### 3.3. 读取 ADC 原始值（单次）
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| read_adc | 上位机→设备 | `[cmd=read_adc;pot=<推杆>]` | 请求指定推杆的当前 ADC 原始值。 |
| report_adc | 设备→上位机 | `[cmd=report_adc;pot=<推杆>;raw=<ADC值>]` | 返回 ADC 原始值。 |

- `pot`：0‑3。
- `raw`：当前 ADC 采样值 0‑4095。

**超时**：500ms，最多重试 2 次。

**示例**：
```
上位机 → 设备: [cmd=read_adc;pot=0]
设备 → 上位机: [cmd=report_adc;pot=0;raw=110]
```

---

### 3.4. ADC 流式上报
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| stream_adc | 上位机→设备 | `[cmd=stream_adc;pot=<推杆>;enable=1]` | 开启指定推杆的 ADC 连续上报。 |
| stream_adc_ack | 设备→上位机 | `[cmd=stream_adc_ack;pot=<推杆>;enable=1]` | 确认流模式已开启。 |
| stream_adc | 上位机→设备 | `[cmd=stream_adc;pot=<推杆>;enable=0]` | 停止指定推杆的 ADC 连续上报。 |
| stream_adc_ack | 设备→上位机 | `[cmd=stream_adc_ack;pot=<推杆>;enable=0]` | 确认流模式已停止。 |
| report_adc | 设备→上位机 | `[cmd=report_adc;pot=<推杆>;raw=<ADC值>]` | 流式上报的 ADC 值。 |

**参数非法处理**：若 `pot` 越界，设备返回错误帧 `[cmd=error;code=5;msg=pot_must_be_0_to_3]`，不进入流模式。

**流式上报行为**：
- 设备收到开启指令且参数合法后，先发送 `stream_adc_ack;enable=1` 确认，随后以 **约 20Hz** 的频率主动向主机发送 `report_adc` 帧。
- 同一时刻仅允许一个推杆处于流模式。若开启 `pot=1` 时 `pot=0` 正在流模式，设备应先自动关闭 `pot=0` 的流，然后开启 `pot=1` 的流。

**推杆切换 ACK 时序**（重要）：
当开启新推杆的流模式导致旧推杆自动关闭时，设备应**依次发送两条 ACK**：
```
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=0]   ← 先确认旧流已关闭
设备 → 上位机: [cmd=stream_adc_ack;pot=1;enable=1]   ← 再确认新流已开启
```
这样上位机始终能准确追踪当前哪个推杆处于流模式。

**流模式停止**：
- 收到 `enable=0` 指令，设备停止流并发送 `stream_adc_ack;enable=0`。
- 若流已因连接超时等原因自动停止，上位机再发 `enable=0` 时设备仍应返回 `stream_adc_ack;enable=0`。
- 设备状态回到 IDLE（连接超时）或断电时流自动停止。

**连接超时暂停**：流模式激活期间，基础协议定义的 30 秒连接超时检测**暂停**。流模式关闭后恢复超时检测。

**超时**：
| 操作 | 超时 | 最大重试 |
|:---|:---|:---|
| stream_adc (开启) | 500ms | 2 |
| stream_adc (停止) | 500ms | 2 |

**示例**：
```
上位机 → 设备: [cmd=stream_adc;pot=0;enable=1]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=1]
设备 → 上位机: [cmd=report_adc;pot=0;raw=110]
设备 → 上位机: [cmd=report_adc;pot=0;raw=115]
...
上位机 → 设备: [cmd=stream_adc;pot=0;enable=0]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=0]
```

---

### 3.5. 设置临时校准
| 命令 | 方向 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| set_calibration | 上位机→设备 | `[cmd=set_calibration;pot=<推杆>;min=<最小值>;max=<最大值>]` | 设置指定推杆的校准值，**仅写入内存，即时生效，断电丢失**。 |
| set_calibration_ack | 设备→上位机 | `[cmd=set_calibration_ack;min=<值>;max=<值>]` | 校准值成功应用，回传确认值。 |
| error | 设备→上位机 | `[cmd=error;code=<错误码>;msg=<描述>]` | 参数非法或通信错误。 |

- `pot`：0‑3。
- `min`、`max`：必须满足 `min < max`，否则设备返回 error (code=3)。
- 临时校准后，上位机应提示用户执行 `write_pot_config` 以持久化。

**超时**：500ms，最多重试 2 次。

**示例**：
```
上位机 → 设备: [cmd=set_calibration;pot=0;min=95;max=4010]
设备 → 上位机: [cmd=set_calibration_ack;min=95;max=4010]
上位机 → 设备: [cmd=write_pot_config;0_min=95;0_max=4010]
设备 → 上位机: [cmd=write_pot_config_ack;status=ok;0_min=95;0_max=4010]
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
| read_pot_config | 1000ms | 2 | |
| write_pot_config | 2000ms | 1 | Flash 操作耗时，不重试 |
| read_adc | 500ms | 2 | |
| stream_adc (开启) | 500ms | 2 | 超时后上位机应假定流未启动 |
| stream_adc (停止) | 500ms | 2 | |
| set_calibration | 500ms | 2 | |

> 通用命令超时（handshake、factory_reset）见基础协议第 6 节。

---

## 6. 交互流程示例

### 6.1. 启动与配置读取
```
上位机 → 设备: [cmd=handshake]
设备 → 上位机: [cmd=handshake_ack;id=LYRE-A1B2;ver=1.0;base_proto_ver=1.0;biz_proto_ver=1.0;max_frame_len=512]
上位机 → 设备: [cmd=read_pot_config]
设备 → 上位机: [cmd=read_pot_config;0_midi_ch=1;0_cc=70;0_min=100;0_max=4000;1_midi_ch=1;1_cc=71;1_min=100;1_max=4000;2_midi_ch=1;2_cc=72;2_min=100;2_max=4000;3_midi_ch=1;3_cc=73;3_min=100;3_max=4000]
```

### 6.2. 校准（使用流模式）
```
上位机 → 设备: [cmd=stream_adc;pot=0;enable=1]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=1]
设备 → 上位机: [cmd=report_adc;pot=0;raw=110]
设备 → 上位机: [cmd=report_adc;pot=0;raw=115]
设备 → 上位机: [cmd=report_adc;pot=0;raw=4010]
... (用户推动推杆至两端，上位机自动捕获 min=95, max=4010)
上位机 → 设备: [cmd=stream_adc;pot=0;enable=0]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=0]
上位机 → 设备: [cmd=set_calibration;pot=0;min=95;max=4010]
设备 → 上位机: [cmd=set_calibration_ack;min=95;max=4010]
上位机 → 设备: [cmd=write_pot_config;0_min=95;0_max=4010]
设备 → 上位机: [cmd=write_pot_config_ack;status=ok;0_min=95;0_max=4010]
```

### 6.3. IDLE 状态下直接发配置命令
```
上位机 → 设备: [cmd=write_pot_config;0_cc=72]
设备 → 上位机: [cmd=error;code=6;msg=not_connected]
上位机 → 设备: [cmd=handshake]                   ← 上位机自动重新握手
设备 → 上位机: [cmd=handshake_ack;id=LYRE-A1B2;ver=1.0;base_proto_ver=1.0;biz_proto_ver=1.0;max_frame_len=512]
上位机 → 设备: [cmd=write_pot_config;0_cc=72]
设备 → 上位机: [cmd=write_pot_config_ack;status=ok;0_cc=72]
```

### 6.4. 流模式切换推杆（含 ACK 时序）
```
上位机 → 设备: [cmd=stream_adc;pot=0;enable=1]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=1]
设备 → 上位机: [cmd=report_adc;pot=0;raw=110]
... (用户决定换一个推杆校准)
上位机 → 设备: [cmd=stream_adc;pot=1;enable=1]
设备 → 上位机: [cmd=stream_adc_ack;pot=0;enable=0]   ← 旧流先关
设备 → 上位机: [cmd=stream_adc_ack;pot=1;enable=1]   ← 新流后开
设备 → 上位机: [cmd=report_adc;pot=1;raw=2050]
...
```

### 6.5. 错误处理
```
上位机 → 设备: [cmd=read_adc;pot=4]
设备 → 上位机: [cmd=error;code=5;msg=pot_must_be_0_to_3]

上位机 → 设备: [cmd=set_calibration;pot=0;min=1000;max=800]
设备 → 上位机: [cmd=error;code=3;msg=min_must_be_less_than_max]

上位机 → 设备: [cmd=write_pot_config;0_cc=200]
设备 → 上位机: [cmd=error;code=3;msg=cc_out_of_range]

上位机 → 设备: [cmd=write_pot_config]
设备 → 上位机: [cmd=error;code=3;msg=no_fields_provided]
```

---

## 7. 产品实现注意事项

### 7.1. MCU 实现要点
- 帧缓冲区 512 字节，握手时报告 `max_frame_len=512`。
- 实现 `read_pot_config`、`write_pot_config`、`read_adc`、`stream_adc`、`set_calibration` 五个命令的处理函数，注册到基础协议的命令分发表。
- `write_pot_config` 校验逻辑完整，所有非法值返回 error，不做静默裁剪。
- 上电加载配置时必须校验 `min < max`，非法则对该推杆使用出厂默认校准值（但保留 CC 和通道）。
- 流模式管理：维护当前流推杆编号，切换时先发送旧流关闭 ACK，再发新流开启 ACK。
- 流模式激活期间暂停基础协议的连接超时定时器。

### 7.2. 上位机实现要点
- 在基础协议实现之上，增加产品命令的构造与解析。
- 握手后记录 `max_frame_len`，发送帧时确保数据部分不超过该值（本产品为 512）。
- 发送 `write_pot_config` 后逐字段核对回传值与发送值是否一致，不一致时提示用户。
- 流模式期间正确处理 `stream_adc_ack` 和 `report_adc`，使用 ACK 跟踪流状态。
- 校准向导中使用流模式替代单次 `read_adc` 轮询，提升体验。

---

**文档版本**：1.0
**最后更新**：2026-07-15
**适用范围**：Lyre 四推杆 MIDI 控制器（须配合《Veloce 基础命令协议 v1.0》使用）
