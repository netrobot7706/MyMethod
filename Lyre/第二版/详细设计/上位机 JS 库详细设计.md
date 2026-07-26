# 上位机 JS 库详细设计 v1.10

## 1. 概述

本文档描述基于 **Web MIDI API** 的 JavaScript 库 **LyreConfigSDK**，用于在浏览器中实现《MIDI 控制器自描述配置协议 v2.6》定义的完整上位机功能。该库可直接内联于 HTML 页面，生成单页配置工具。

**核心能力**：

- 手动选择 MIDI 端口并连接目标设备
- 发送/接收 SysEx 消息，完整实现 0x03–0x12 命令
- 解析物理描述、面板布局树、虚拟控件表、ADC 原始值
- 提供校准向导、虚拟配置编辑、写入与校验功能
- 基于面板布局树自动生成可视化控件 UI

---

## 2. 库的整体架构

```
┌─────────────────────────────────────────────┐
│              单页 HTML 宿主                  │
├─────────────────────────────────────────────┤
│                  视图层                       │
│  LayoutRenderer / CalibrationWizard / ...    │
├─────────────────────────────────────────────┤
│                  服务层                       │
│     DeviceService (命令编排、重试、状态)      │
├─────────────────────────────────────────────┤
│                  协议层                       │
│    ProtocolCodec (编解码、校验和、验证)       │
├─────────────────────────────────────────────┤
│                  MIDI 传输层                  │
│    MidiTransport (端口选择、SysEx 收发队列)   │
├─────────────────────────────────────────────┤
│              Web MIDI API                    │
└─────────────────────────────────────────────┘
```

各层职责：

- **MidiTransport**：封装 `navigator.requestMIDIAccess`，提供可用端口枚举及基于用户选择的连接，管理 SysEx 请求/响应的异步匹配与资源释放。
- **ProtocolCodec**：纯函数集合，实现所有命令的编码、解码、校验和计算及数据验证。
- **DeviceService**：面向业务的高级接口，组合 MidiTransport 与 ProtocolCodec，提供“连接并初始化”“读取全部配置”“执行校准”“写入虚拟配置”等方法，并处理重试逻辑与事件通知。
- **视图层**：包含布局树渲染器 `LayoutRenderer`、虚拟配置编辑器、校准向导等 UI 组件，用于直接操作 DOM。视图层由库提供，但宿主页面可自定义样式和布局容器。

---

## 3. 依赖与运行环境

- 浏览器支持 **Web MIDI API**（Chrome / Edge / Opera 等）。
- 无需任何第三方库，全部代码以 **ES6 模块或 IIFE** 内联方式提供，可直接嵌入 `<script>` 标签。
- 使用 `async/await` 和 `Promise`，需浏览器支持 ES2017。

---

## 4. 核心模块详细设计

### 4.1 MIDI 传输模块 `MidiTransport`

#### 4.1.1 职责
- 请求 MIDI 访问权限（**必须申请 SysEx 权限**）
- 枚举可用输入/输出端口，供用户手动选择
- 基于用户选择异步创建连接句柄（含端口打开）
- 发送 SysEx 消息，异步匹配响应（含超时、校验和检查、废弃事务处理）
- 提供干净的断开与资源释放

#### 4.1.2 主要数据结构

```typescript
interface MIDIPortInfo {
  id: string;       // MIDIPort.id
  name: string;     // MIDIPort.name
}

interface MidiDeviceHandle {
  input: MIDIInput;
  output: MIDIOutput;
  deviceId: number;        // 0x00–0x7E
}
```

#### 4.1.3 核心方法

**`requestAccess(): Promise<MIDIAccess>`**  
内部调用 `navigator.requestMIDIAccess({ sysex: true })`。  
**必须指定 `{ sysex: true }`**，否则浏览器静默丢弃所有 SysEx 消息，导致本库完全不可用。若用户拒绝或浏览器不支持，抛出 `MidiAccessDeniedError`。

**`getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] }`**  
返回当前系统中所有 MIDI 输入/输出端口的信息（`id` 和 `name`），供宿主构建下拉选择框。  
内部遍历 `access.inputs` 和 `access.outputs`，过滤掉明显无关的端口（如软件合成器，可选），但保留用户最终选择权。

**`async createHandle(access: MIDIAccess, inputId: string, outputId: string, deviceId: number): Promise<MidiDeviceHandle>`**  
1. 验证 `deviceId` 在 `0x00–0x7E` 内，否则抛出 `RangeError`。  
2. 从 `access` 中获取对应 `inputId` 和 `outputId` 的端口对象，若不存在则抛出 `Error`。  
3. **异步打开端口**：`await input.open(); await output.open();`。  
   - 若 `output.open()` 失败，需要先 `await input.close().catch(() => {})` 再重新抛出异常，保证原子性（不残留已打开端口）。  
4. 注册 `input.onmidimessage` 回调，用于响应匹配逻辑。  
5. 返回 `{ input, output, deviceId }`。

**`sendSysex(device: MidiDeviceHandle, msg: Uint8Array, responseCmd?: number, timeout?: number): Promise<Uint8Array>`**  
发送 SysEx 消息。如果提供 `responseCmd`（期望响应命令字），则返回 Promise，在收到匹配的响应后 resolve；若超时（默认 500ms）则 reject `TimeoutError`。  
内部维护一个未完成请求队列，每个请求分配递增事务 ID。  
响应匹配条件（全部满足才算匹配）：
1. 命令字等于 `responseCmd`
2. 设备 ID 与 `device.deviceId` 一致
3. 校验和正确（校验失败视为无效响应，丢弃并记录，继续等待）
4. 事务 ID 仍为 pending 状态（超时后标记为废弃，迟到响应直接丢弃）

若提供 `responseCmd` 但发送后无匹配响应：
- 在等待期间若曾收到过校验和错误的匹配消息，则最终抛出 `ChecksumError`（有助于诊断固件 bug 或传输错误）。
- 若从未收到任何匹配消息（包括校验和错误的），则抛出 `TimeoutError`。

若未提供 `responseCmd`，则发送后立即 resolve（无返回值，或返回空数组）。

**`disconnect(device: MidiDeviceHandle): void`**  
完整清理：
1. 将 `device` 对应的所有 pending 请求 reject 为 `DisconnectedError`
2. 设置 `input.onmidimessage = null`
3. 调用 `input.close().catch(() => {})` 和 `output.close().catch(() => {})`，静默忽略关闭失败（端口可能已被系统移除）
4. 清空内部请求队列中与该句柄相关的条目

#### 4.1.4 错误类

```typescript
class TimeoutError extends Error {}
class ChecksumError extends Error {}
class DisconnectedError extends Error {}
class MidiAccessDeniedError extends Error {}
```

**重试策略**：本层不执行任何自动重试。所有重试逻辑由上层 `DeviceService` 根据协议要求实现。

---

### 4.2 协议编解码器 `ProtocolCodec`

#### 4.2.1 职责
提供所有 SysEx 命令的构建与解析函数，负责数据格式校验、14-bit 编解码、校验和计算。与固件端 `cmd_core` 保持对应。

#### 4.2.2 常量定义

```typescript
const SYSEX_START = 0xF0;
const SYSEX_END   = 0xF7;
const MANUFACTURER_ID = 0x7D;
const PROTOCOL_VERSION = 0x16;

const CMD_QUERY_PHYSICAL      = 0x03;
const CMD_PHYSICAL_RESPONSE   = 0x04;
const CMD_QUERY_LAYOUT        = 0x07;
const CMD_LAYOUT_RESPONSE     = 0x08;
const CMD_QUERY_VIRTUAL       = 0x0B;
const CMD_VIRTUAL_RESPONSE    = 0x0C;
const CMD_SET_VIRTUAL         = 0x0D;
const CMD_SET_VIRTUAL_ACK     = 0x0E;
const CMD_SET_CALIBRATION     = 0x0F;
const CMD_CALIBRATION_ACK     = 0x10;
const CMD_QUERY_ADC_RAW       = 0x11;
const CMD_ADC_RAW_RESPONSE    = 0x12;
```

#### 4.2.3 工具函数

**`rolandChecksum(data: Uint8Array | number[]): number`**  
计算 Roland 式校验和：  
`sum = data.reduce((a, b) => a + b, 0) & 0x7F; return (128 - sum) & 0x7F;`  
调用者需传入从 `0x7D` 开始到校验和前一字节的范围。

**`computeMessageChecksum(fullMsg: Uint8Array): number`**  
封装方法，自动提取 `msg.slice(1, msg.length - 2)` 计算校验和，避免调用者传错范围。

**`encode14bit(value: number): [number, number]`**  
将 14-bit 值（0–16383）编码为 `[mid, lo]` 两个 7-bit 字节（`mid = (value >> 7) & 0x7F, lo = value & 0x7F`）。  
若 `value` 超出范围则抛出 `RangeError`。

**`decode14bit(mid: number, lo: number): number`**  
将两个 7-bit 字节解码为 14-bit 值：`(mid << 7) | lo`。

**`validateSysEx(msg: Uint8Array, expectedCmd?: number, expectedDeviceId?: number): boolean`**  
校验消息完整性：
- 长度至少为 6
- 以 `F0` 开头，`F7` 结尾
- 校验和正确（使用 `rolandChecksum` 校验从 `msg[1]` 到 `msg[length - 3]` 的字节）
- 可选校验命令字（`msg[3]`）与设备 ID（`msg[2]`）

#### 4.2.4 命令构建函数（静态方法，返回 Uint8Array）

每个函数均接收必要参数，返回完整 SysEx 消息（包含 F0..F7）。

**`buildQueryPhysical(deviceId: number): Uint8Array`**  
构建 0x03 查询消息：`F0 7D <ID> 03 <CK> F7`。

**`buildQueryLayout(deviceId: number): Uint8Array`**  
构建 0x07 查询消息。

**`buildQueryVirtual(deviceId: number): Uint8Array`**  
构建 0x0B 查询消息。

**`buildSetVirtual(deviceId: number, B: number, V: number, controls: VirtualCtrl[]): Uint8Array`**  
构建 0x0D 写入消息。  
**参数验证**：在构建前，对 `controls` 数组中每个字段进行检查：`bank`、`physIdx`、`cc`、`channel` 必须在 0–127 范围内，且 `cc ≤ 127`、`channel ≤ 15`。不满足则抛出 `ValidationError`。  
内部不做 `& 0x7F` 静默截断。

**`buildSetCalibration(deviceId: number, N: number, calibrations: {min: number, max: number}[]): Uint8Array`**  
构建 0x0F 写入消息。接收 14-bit 值的 `min`/`max` 数组，内部调用 `encode14bit` 编码为 `cal_min_mid, cal_min_lo, cal_max_mid, cal_max_lo`，并确保所有输出字节 < 128。

**`buildQueryRawADC(deviceId: number): Uint8Array`**  
构建 0x11 查询消息。

#### 4.2.5 响应解析函数

所有解析函数首先调用 `validateSysEx`，校验失败则抛出 `ChecksumError` 或 `ParseError`。

**`parsePhysicalResponse(msg: Uint8Array): {N: number, protocolVersion: number, physControls: PhysDesc[]}`**  
解析 0x04 响应。`PhysDesc` 结构：`{mux: number, channel: number, calMin: number, calMax: number}`，其中 `calMin`/`calMax` 已解码为 16-bit 值。

**0x04 响应字节偏移表**：

| 偏移 | 内容 |
|------|------|
| 0 | 0xF0 |
| 1 | 0x7D |
| 2 | 设备 ID |
| 3 | 0x04 |
| 4 | 物理控件数量 N |
| 5 | 协议版本 |
| 6+ | 物理描述数据块（6N 字节） |
| -2 | 校验和 |
| -1 | 0xF7 |

**`parseLayoutResponse(msg: Uint8Array): {declaredLength: number, treeBytes: Uint8Array}`**  
解析 0x08 响应。`declaredLength` 由两字节 14-bit 编码解码得到，`treeBytes` 为紧随其后的原始树字节流。

**`parseVirtualResponse(msg: Uint8Array): {B: number, V: number, controls: VirtualCtrl[]}`**  
解析 0x0C 响应。`controls` 为 `{bank, physIdx, cc, channel}` 数组。  
**注意**：本函数只做解析，不进行协议约束校验（如 `V ≤ B×N`）。该校验在服务层进行。

**`parseAck(msg: Uint8Array, expectedCmd: number): {status: number}`**  
解析 ACK 响应（0x0E / 0x10）。`status` 含义：
- `0`：成功
- `1`：通用 NACK（当前固件对所有失败均返回 1，包括校验和错误和字段错误）
- `2`：预留（协议定义但当前固件未使用；上位机提前兼容，若收到 2 则不重试并提示字段错误）

**`parseRawADCResponse(msg: Uint8Array): {N: number, rawValues: number[]}`**  
解析 0x12 响应，`rawValues` 为已解码的 14-bit 原始值数组。

#### 4.2.6 数据验证函数

**`validateVirtualConfig(controls: VirtualCtrl[], B: number, V: number, N: number): {valid: boolean, error?: string}`**  
检查：
- `controls` 长度等于 `V`
- 字段范围：`bank < B`、`physIdx < N`、`cc ≤ 127`、`channel ≤ 15`
- 所有字段值 bit7 为 0（`value & 0x80 === 0`）
- 唯一性约束：`(bank * N + physIdx)` 不得重复

**`validateCalibrationData(calibrations: {min: number, max: number}[], N: number): {valid: boolean, error?: string}`**  
检查：
- 数组长度等于 `N`
- 每个条目：`min >= 0`、`max <= 16383`、`max > min`
- 编码为 7-bit 字节后逐个检查 bit7 为 0

---

### 4.3 设备服务层 `DeviceService`

#### 4.3.1 职责
封装设备交互流程，提供面向 UI 的业务 API。管理设备状态，处理重试策略，触发全局事件。

#### 4.3.2 设备状态模型 `DeviceState` 及初始值

```typescript
interface PhysDesc {
  mux: number;
  channel: number;
  calMin: number;    // 14-bit 解码值
  calMax: number;
}

interface VirtualCtrl {
  bank: number;
  physIdx: number;
  cc: number;
  channel: number;
}

interface DeviceState {
  connected: boolean;
  deviceHandle: MidiDeviceHandle | null;
  physical: {
    N: number;
    protocolVersion: number;
    controls: PhysDesc[];        // 设备当前存储值（只读）
  };
  layoutTree: LayoutNode | null;
  virtual: {
    B: number;
    V: number;
    controls: VirtualCtrl[];     // 最后一次从设备读取/写入的值（只读快照）
  };
  calibration: {
    rawMin: number[] | null;     // 本会话采集的临时值
    rawMax: number[] | null;
    status: 'uncalibrated' | 'calibrated' | 'unknown';
  };
}

const INITIAL_STATE: DeviceState = {
  connected: false,
  deviceHandle: null,
  physical: { N: 0, protocolVersion: 0, controls: [] },
  layoutTree: null,
  virtual: { B: 0, V: 0, controls: [] },
  calibration: { rawMin: null, rawMax: null, status: 'unknown' }
};
```

**数据所有权说明**：
- `DeviceState.virtual.controls` 存储**最后一次从设备读取或写入的值**（只读快照）。连接时由 `queryVirtualConfig` 填充，写入成功后由 `saveConfig` 直接更新。
- 用户编辑通过 `ConfigManager` 维护独立的可写副本。`getDeviceState().virtual.controls` 不反映未保存的修改。UI 渲染应使用 `getActiveControls(bank)` 获取当前工作副本。

#### 4.3.3 核心方法

**`async connectAndInitialize(access: MIDIAccess, inputId: string, outputId: string, deviceId: number): Promise<DeviceState>`**  
完整连接流程：
1. 若当前 `connected === true`，先调用 `this.disconnect()` 自动断开旧连接。  
   **注意**：断开后若新连接失败，旧连接不会恢复，用户需重新选择端口再连接。
2. `const handle = await MidiTransport.createHandle(access, inputId, outputId, deviceId);`
3. 调用内部私有方法 `connect(handle)`：
   - 发送 0x03 获取物理信息 → 检查协议版本兼容性（低于 0x16 警告，高于当前库版本警告）
   - 发送 0x07 获取布局树
   - 发送 0x0B 获取虚拟配置，并在本层执行 `V ≤ B×N` 和 `V ≤ 126` 校验，不通过则抛 `ProtocolViolationError`
   - 若以上任何步骤失败（超时、校验和错误、版本不兼容、数据校验失败等），**必须执行完整清理**：移除可能已注册的 `statechange` 监听器，调用 `MidiTransport.disconnect(handle)` 关闭端口，重置状态为 `INITIAL_STATE`，然后重新抛出原始错误。
4. 注册 `access.addEventListener('statechange', this._onStateChange)`，监听端口断开事件。
5. 标记 `connected = true`，返回当前 `DeviceState`。

**`_onStateChange` 回调逻辑**：
```typescript
private _onStateChange = (e: MIDIConnectionEvent) => {
  if (!this.state.connected) return;
  const h = this.state.deviceHandle!;
  if ((e.port.id === h.input.id || e.port.id === h.output.id) &&
      e.port.state === 'disconnected') {
    // 先通知 UI，使其可设置"正在断开"标志
    this._emit('deviceDisconnected');
    // 再执行完整清理（内部会 reject pending 请求为 DisconnectedError）
    this.disconnect();
  }
};
```

**`disconnect(): void`**  
用户主动断开连接：
- 若 `connected === false`，静默返回（幂等）。
- 否则：
  1. 移除 `access.removeEventListener('statechange', this._onStateChange)`
  2. 调用 `MidiTransport.disconnect(state.deviceHandle!)`
  3. 重置状态为 `INITIAL_STATE`
  4. **不触发** `deviceDisconnected` 事件（用户主动操作）

**`async writeVirtualConfig(controls: VirtualCtrl[]): Promise<void>`**  
将虚拟配置写入设备。内部流程：
1. 本地验证 `validateVirtualConfig(controls, B, V, N)`。
2. 构建 0x0D 消息（仅构建一次，缓存字节数组）。
3. 发送并等待 0x0E ACK（超时 500ms）：
   - status = 0：成功，返回。
   - status = 1：等待 400ms 后重试一次（发送同一字节数组）。
   - status = 2：预留字段错误，不重试，直接抛出错误。
4. 若超时，等待 400ms 后重试一次。两次尝试均失败则抛出 `WriteConfigError`。

**`async startCalibrationWizard(onPrompt: (phase: 'min' | 'max') => Promise<void>): Promise<void>`**  
执行上位机辅助校准流程。**前置条件**：必须已连接，否则立即抛出 `NotConnectedError`。  
流程使用局部变量收集采样数据，成功后才写入状态，失败时不污染现有 `calibration` 字段。

详细步骤：
1. `await onPrompt('min')` —— 等待用户确认已将控件调至最小值。若用户取消，`onPrompt` 应 reject `CancelSignal`，向导捕获后转为 `CalibrationCancelledError` 抛出。
2. 采集最小值：串行发送 5 次 0x11 查询。
   - 每次发送后等待 0x12 响应，收到后等待 50ms 再发下一次。
   - 对每个物理控件取 5 次采样的中位数，存入局部变量 `calMin[]`。
3. `await onPrompt('max')` —— 等待用户确认已调至最大值。
4. 采集最大值：同样方式获取 `calMax[]`。
5. 对于布局树中类型为**旋钮（0x10）或推杆（0x11）**的控件，逐一验证 `calMax[i] > calMin[i]`；若不满足则抛出 `CalibrationRangeError`。
6. 对于按钮（0x12）及未知类型控件，**强制使用默认值** `min=0, max=4095`，不读取设备当前存储值（遵循协议 §8.1 建议，避免 EEPROM 损坏值导致写入失败）。
7. 构建 0x0F 消息，发送并等待 0x10 ACK，重试策略同 `writeVirtualConfig`。
8. 写入成功后，**重新查询 0x03** 刷新 `physical.controls`，然后更新 `calibration.status`。

**`async readRawADC(): Promise<number[]>`**  
发送 0x11 查询，返回解码后的原始 ADC 值数组。调用前必须已连接，否则抛 `NotConnectedError`。

**`getCalibrationStatus(): 'uncalibrated' | 'calibrated' | 'unknown'`**  
判断逻辑：仅检查布局树中类型为**旋钮或推杆**的控件。若其 `calMin === 0 && (calMax === 4095 || calMax === 16383)`，视为未校准；全部非默认则已校准；否则未知。按钮不参与判断。

**`editVirtual(bank: number, physIdx: number, field: 'cc' | 'channel', value: number): void`**  
编辑当前虚拟控件配置。立即执行范围验证：
- `field === 'cc'` 时：`0 <= value <= 127`
- `field === 'channel'` 时：`0 <= value <= 15`
- `bank` 必须在 `0 ~ B-1` 内，`physIdx` 必须在 `0 ~ N-1` 内
非法则抛出 `ValidationError`。验证通过后修改 `ConfigManager` 中的可写副本，并标记为“脏”。

**`async saveConfig(): Promise<void>`**  
保存虚拟配置到设备。委托给 `ConfigManager.saveToDevice()`：
- `ConfigManager` 检查脏标记，若无修改则直接 resolve。
- 若有修改，调用 `DeviceService.writeVirtualConfig(currentControls)`。
- 写入成功后，**将写入的副本直接赋值给 `DeviceState.virtual.controls`**（无需重新查询设备，因为设备端无额外处理），并清除脏标记。

**`getActiveControls(bank: number): VirtualCtrl[]`**  
返回指定库的当前虚拟控件配置（含未保存的编辑），供 UI 渲染使用。  
若未连接，返回空数组 `[]`（不抛出异常）。  
内部委托给 `ConfigManager.getControlsCopy(bank)`。

**`exportConfig(): string`**  
导出当前配置为 JSON 字符串。若未连接，抛出 `NotConnectedError`。  
**导出数据来源**：`ConfigManager` 中的可写副本（含未保存的编辑），代表用户当前工作状态。格式见第 9 节。

#### 4.3.4 错误类及事件系统

```typescript
class CancelSignal extends Error {}           // 用户取消校准的信号
class CalibrationCancelledError extends Error {} // 校准被取消
class ProtocolViolationError extends Error {}    // 协议约束违反（如 V > B×N）
class NotConnectedError extends Error {}        // 未连接时调用需要通信的方法
class ValidationError extends Error {}          // 输入数据非法
```

**事件订阅**：
- `on(event: 'error', handler: (err: Error) => void): () => void`  
  监听全局错误。**触发范围**：仅在**非用户主动发起的后台操作**失败时触发（例如 USB 拔出导致 pending 请求 reject 为 `DisconnectedError`）。用户主动调用的方法（`saveConfig`、`startCalibrationWizard` 等）错误通过 Promise reject 传播，**不触发** `error` 事件。返回取消订阅函数。
- `on(event: 'deviceDisconnected', handler: () => void): () => void`  
  监听设备物理断开（USB 拔出）。仅在 `_onStateChange` 检测到关联端口移除时触发（非用户主动断开）。返回取消订阅函数。

---

### 4.4 布局树解析器 `LayoutParser`

#### 4.4.1 职责
将协议 §6.2 定义的二进制树字节流解析为嵌套的 `LayoutNode` 对象树。

#### 4.4.2 节点类型定义

```typescript
type LayoutNode = ContainerNode | LeafNode;

interface ContainerNode {
  type: 'hbox' | 'vbox' | 'grid';
  children: LayoutNode[];
  cols?: number;   // 仅 grid
  rows?: number;   // 仅 grid
}

interface LeafNode {
  type: 'knob' | 'fader' | 'button' | 'unknown';
  physIndex: number;
}
```

#### 4.4.3 解析算法
- 静态方法 `parse(treeBytes: Uint8Array, declaredLength: number): LayoutNode`
- 使用内部游标 `pos`，初始为 0。
- **严格以 `declaredLength` 为边界**：
  - 每次读取节点前检查 `pos < declaredLength`，若 `pos >= declaredLength` 则抛出 `MalformedTreeError`（数据不足）。
  - 解析完成后检查 `pos === declaredLength`，若不相等则抛出 `MalformedTreeError`（多余字节或声明长度不匹配）。
- 读取一个字节作为节点类型码：
  - `0x01`：水平容器 (HBox)。读取 1 字节子节点数 `n`，递归读取 `n` 个子节点。
  - `0x02`：垂直容器 (VBox)。同上。
  - `0x03`：网格容器 (Grid)。读取 1 字节列数 `cols`、1 字节行数 `rows`。验证 `cols * rows <= 127` 且 `cols * rows > 0`，否则抛 `MalformedTreeError`。递归读取 `cols * rows` 个子节点（行优先）。
  - `0x10`：旋钮 (Knob)。读取 1 字节物理索引，生成 `LeafNode { type: 'knob', physIndex }`。
  - `0x11`：推杆 (Fader)。生成 `LeafNode { type: 'fader', physIndex }`。
  - `0x12`：按钮 (Button)。生成 `LeafNode { type: 'button', physIndex }`。
  - 其他 `0x10–0x3F`：未知叶子节点。消耗 1 字节索引，生成 `LeafNode { type: 'unknown', physIndex }`。
  - 其他 `0x01–0x0F`：未知容器节点。直接抛出 `UnknownContainerError`，终止解析。
- 容器子节点解析失败时，异常直接向上传播。

#### 4.4.4 错误类型
```typescript
class MalformedTreeError extends Error {}
class UnknownContainerError extends Error {}
```

---

### 4.5 UI 渲染模块 `LayoutRenderer`

#### 4.5.1 职责
根据布局树和设备/虚拟配置生成 DOM 元素，并绑定交互事件。本模块为库的一部分，但宿主可自定义样式和容器。

#### 4.5.2 核心方法

**`render(container: HTMLElement, layout: LayoutNode, context: RenderContext): void`**  
清空 `container`，递归遍历布局树，生成对应的 HTML 结构。  
此方法为一次性渲染。状态变化后（如校准完成、库切换、配置保存后），UI 层需**重新调用 `render()`** 刷新界面。`LayoutRenderer` 内部不持有响应式绑定或自动重渲染逻辑。

**`RenderContext` 接口**：
```typescript
interface RenderContext {
  deviceState: DeviceState;
  getActiveControls(bank: number): VirtualCtrl[];  // 获取含未保存编辑的配置
  onVirtualChange(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void;
  onCalibrate(): void;
}
```

#### 4.5.3 渲染规则

**容器节点**：
- **HBox**：生成 `div`，设置 `style.display = 'flex'; flex-direction: row;`，可配间距。
- **VBox**：生成 `div`，设置 `style.display = 'flex'; flex-direction: column;`。
- **Grid**：生成 `div`，设置 CSS Grid：`display: grid; grid-template-columns: repeat(cols, auto); grid-template-rows: repeat(rows, auto);`。子节点按行优先顺序放入单元格。

**叶子节点**：
- 对于每个叶子节点，根据 `physIndex` 在当前选中的库（由宿主维护的 `currentBank` 决定）中查找对应的虚拟控件配置。数据来源：`context.getActiveControls(currentBank)`。
- **旋钮/推杆**：渲染为一个带标签的滑块控件（`input[type=range]`，或自定义旋钮 CSS）。旁显示可编辑的 CC 号（`input[type=number]`，范围 0–127）和 MIDI 通道（`select`，0–15）。所有编辑操作触发 `context.onVirtualChange(bank, physIdx, field, value)`。
- **按钮**：若虚拟控件表中存在该物理索引的条目，则渲染为可配置的 MIDI 控件（同上，显示 CC 和通道编辑）。若不存在，渲染为普通按钮样式（不可编辑，视觉上与可配置按钮区分）。
- **未知类型**：渲染占位符，显示 "Unknown" 文本及物理索引，不可编辑。
- 每个控件旁显示校准状态图标（仅旋钮/推杆）：根据 `deviceState.physical.controls[physIdx]` 的 `calMin`/`calMax` 判断是否已校准。

**库选择器**：
- 若 `deviceState.virtual.B > 1`，在容器外部渲染一个 `<select>` 下拉菜单，选项为库编号 0 ~ B-1。切换时宿主需重新调用 `render()` 并传入新 `currentBank`。

#### 4.5.4 交互流程
- 所有编辑操作通过 `context.onVirtualChange` 回调传递到上层，由 `LyreConfigSDK.editVirtual` 处理。
- “校准”按钮触发 `context.onCalibrate`。

---

### 4.6 配置管理器 `ConfigManager`

#### 4.6.1 职责
维护虚拟控件配置的本地可写副本，管理脏状态，提供编辑、保存与丢弃修改的功能。

#### 4.6.2 内部状态
- `controlsCopy: VirtualCtrl[]`：当前可编辑的副本。初始由 `DeviceService` 在连接成功后从 `DeviceState.virtual.controls` 深拷贝得到。
- `dirty: boolean`：标记自上次保存后是否有修改。

#### 4.6.3 主要 API

**`editVirtual(bank: number, physIdx: number, field: 'cc' | 'channel', value: number): void`**  
在 `controlsCopy` 中找到 `bank` 和 `physIdx` 匹配的条目，修改对应字段，设置 `dirty = true`。  
注意：此方法不进行范围验证（验证已在 `DeviceService.editVirtual` 中完成），但内部可做断言。

**`saveToDevice(): Promise<void>`**  
- 若 `dirty === false`，直接 `resolve()`，跳过写入。
- 否则，调用 `DeviceService.writeVirtualConfig(controlsCopy)`。
- 成功后设置 `dirty = false`。

**`discardChanges(): void`**  
丢弃本地修改：将 `controlsCopy` 重置为 `DeviceState.virtual.controls` 的深拷贝（即上次从设备读取或写入的快照）。**无需设备通信**。设置 `dirty = false`。

**`getControlsCopy(bank: number): VirtualCtrl[]`**  
返回 `controlsCopy` 中指定库的所有条目。供 `DeviceService.getActiveControls` 调用。

**`initFromSnapshot(snapshot: VirtualCtrl[]): void`**  
用给定的虚拟控件快照初始化/重置 `controlsCopy`（深拷贝），清除脏标记。

本模块**不包含** `exportConfig` 方法，导出功能由 `DeviceService` 统一处理。

---

## 5. 数据流示意

### 5.1 连接与端口监听

```
用户点击“连接”按钮
→ sdk.connectAndInitialize(access, inputId, outputId, deviceId)
  → 若已连接则内部调用 disconnect()
  → await MidiTransport.createHandle(...)   // 异步打开端口
  → 内部 connect(handle)
      → 发送 0x03 查询物理信息（超时/校验失败则清理并抛异常）
      → 检查协议版本
      → 发送 0x07 查询布局树
      → 发送 0x0B 查询虚拟配置 → V ≤ B×N 校验
      → 若任一步骤失败，执行完整清理（关闭端口、移除监听、重置状态）
  → 注册 addEventListener('statechange', ...)
  → 返回完整 DeviceState
```

### 5.2 编辑虚拟配置

```
UI 控件修改 → context.onVirtualChange(bank, physIdx, field, value)
→ sdk.editVirtual(...) → 即时验证 → ConfigManager.editVirtual(...) 修改副本
UI 从 context.getActiveControls(bank) 获取最新值显示（不依赖 DeviceState 快照）

用户点击“保存”
→ sdk.saveConfig() → ConfigManager.saveToDevice()
  → 检查脏标记 → 若无修改直接返回
  → 有修改：writeVirtualConfig(controlsCopy)
    → 本地验证 → 构建 0x0D → 发送 → 等待 ACK
    → 失败按策略重试（status=1 重试，status=2 不重试）
  → 成功后：DeviceState.virtual.controls = controlsCopy（浅拷贝/替换），清脏标记
```

### 5.3 校准流程

```
用户点击“校准”
→ sdk.startCalibrationWizard(onPrompt)
  → 检查连接（否则抛 NotConnectedError）
  → await onPrompt('min') → 用户确认或取消（CancelSignal）
  → 采集 min (5次，取中位数)
  → await onPrompt('max')
  → 采集 max
  → 仅对旋钮/推杆验证范围；按钮强制填入 min=0, max=4095
  → 构建 0x0F 发送 → 等待 0x10 ACK（重试策略）
  → 成功后重新查询 0x03 刷新 physical.controls
```

### 5.4 USB 拔出

```
MIDIAccess 触发 statechange 事件
→ _onStateChange 检测关联端口断开
→ 先 _emit('deviceDisconnected')（UI 可设置断开标志）
→ 再调用 disconnect() 清理资源（pending 请求 reject DisconnectedError → 触发全局 error 事件，UI 可忽略）
```

---

## 6. 错误处理策略

| 场景 | 处理方式 |
|------|----------|
| 用户主动调用失败（如 `saveConfig`、`startCalibrationWizard`） | 通过 Promise reject 相应错误，不触发全局 `error` 事件 |
| USB 拔出导致的后台错误 | 触发 `deviceDisconnected` 事件，随后 pending 请求 reject `DisconnectedError`（触发全局 `error` 事件，UI 可据此显示或忽略） |
| 写入虚拟配置 NACK (status=1) | 自动重试一次（共 2 次发送） |
| 写入虚拟配置 NACK (status=2)（预留） | 不重试，直接抛异常 |
| 未连接时调用需通信的方法 | 立即抛出 `NotConnectedError` |
| 校准中用户取消 | 抛出 `CalibrationCancelledError`（由 `CancelSignal` 转换） |
| 协议数据校验失败（如 `validateVirtualConfig`） | 抛出 `ValidationError`，附带描述信息 |
| 协议约束违反（如 `V > B×N`） | 抛出 `ProtocolViolationError` |

---

## 7. API 参考（公开接口）

```typescript
class LyreConfigSDK {
  // —— 传输层 ——
  /** 请求 MIDI 访问权限（含 SysEx）。拒绝则抛 MidiAccessDeniedError */
  requestAccess(): Promise<MIDIAccess>;

  /** 获取可用 MIDI 输入/输出端口列表 */
  getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] };

  // —— 服务层 ——
  /**
   * 连接到指定设备并初始化状态。
   * 若已连接，会先断开旧连接（失败不恢复）。
   * 返回完整 DeviceState。
   */
  async connectAndInitialize(
    access: MIDIAccess,
    inputId: string,
    outputId: string,
    deviceId: number
  ): Promise<DeviceState>;

  /** 主动断开连接。未连接时幂等。不触发 deviceDisconnected 事件 */
  disconnect(): void;

  /** 获取当前设备状态快照 */
  getDeviceState(): DeviceState;

  /**
   * 获取指定库的当前虚拟控件配置（含未保存编辑）。
   * 未连接时返回空数组。
   */
  getActiveControls(bank: number): VirtualCtrl[];

  /** 编辑指定物理控件在当前库下的 CC 或通道。即时验证并标记脏 */
  editVirtual(bank: number, physIdx: number, field: 'cc' | 'channel', value: number): void;

  /** 保存虚拟控件配置到设备（若无脏修改则跳过） */
  async saveConfig(): Promise<void>;

  /** 启动校准向导，onPrompt 应在用户确认后 resolve，取消时 reject CancelSignal */
  async startCalibrationWizard(
    onPrompt: (phase: 'min' | 'max') => Promise<void>
  ): Promise<void>;

  /** 查询 ADC 原始值（须已连接） */
  async readRawADC(): Promise<number[]>;

  /** 导出当前配置为 JSON 字符串（含未保存编辑）。未连接抛 NotConnectedError */
  exportConfig(): string;

  // —— 信号/错误实例属性 ——
  readonly CancelSignal: typeof CancelSignal;
  readonly CalibrationCancelledError: typeof CalibrationCancelledError;
  readonly DisconnectedError: typeof DisconnectedError;

  // —— 事件订阅（返回取消订阅函数） ——
  /** 后台错误（如 USB 拔出导致的 DisconnectedError） */
  on(event: 'error', handler: (err: Error) => void): () => void;
  /** 设备物理断开（非用户主动断开） */
  on(event: 'deviceDisconnected', handler: () => void): () => void;
}
```

---

## 8. 集成示例（关键部分）

```html
<script src="lyre-config-sdk.js"></script>
<script>
  const sdk = new LyreConfigSDK();
  let state, access, currentBank = 0;
  let isDisconnecting = false;

  // 监听设备物理断开
  sdk.on('deviceDisconnected', () => {
    isDisconnecting = true;
    alert('设备已断开');
  });

  // 全局错误处理：忽略断开后的 DisconnectedError
  sdk.on('error', (err) => {
    if (isDisconnecting && err instanceof sdk.DisconnectedError) return;
    console.error(err);
  });

  async function refreshPorts() {
    access = await sdk.requestAccess();
    const ports = sdk.getAvailablePorts(access);
    fillSelect(document.getElementById('input-port'), ports.inputs);
    fillSelect(document.getElementById('output-port'), ports.outputs);
  }

  document.getElementById('btn-refresh').onclick = refreshPorts;

  document.getElementById('btn-connect').onclick = async () => {
    const inputId = document.getElementById('input-port').value;
    const outputId = document.getElementById('output-port').value;
    const rawId = parseInt(document.getElementById('device-id').value);
    const deviceId = isNaN(rawId) ? 0 : Math.max(0, Math.min(126, rawId));

    try {
      state = await sdk.connectAndInitialize(access, inputId, outputId, deviceId);
      currentBank = 0;
      isDisconnecting = false;
      renderUI();
    } catch (e) {
      alert('连接失败：' + e.message);
    }
  };

  function renderUI() {
    const container = document.getElementById('layout-container');
    const context = {
      deviceState: state,
      getActiveControls: (bank) => sdk.getActiveControls(bank),
      onVirtualChange: (bank, physIdx, field, value) => {
        sdk.editVirtual(bank, physIdx, field, value);
        // 可立即重新渲染或只标记脏
      },
      onCalibrate: () => startCalibration()
    };
    // 清空并重新渲染（一次性渲染）
    container.innerHTML = '';
    new sdk.LayoutRenderer().render(container, state.layoutTree, context);
  }

  async function startCalibration() {
    try {
      await sdk.startCalibrationWizard(async (phase) => {
        return new Promise((resolve, reject) => {
          const msg = phase === 'min' ? '请将所有推子拉到底' : '请将所有推子推到顶';
          if (confirm(msg)) resolve();
          else reject(new sdk.CancelSignal('用户取消'));
        });
      });
      alert('校准完成');
      state = sdk.getDeviceState(); // 刷新状态
      renderUI(); // 重新渲染
    } catch (e) {
      if (e instanceof sdk.CalibrationCancelledError) {
        // 用户取消
      } else {
        alert('校准失败：' + e.message);
      }
    }
  }

  // 初始化
  refreshPorts();
</script>
```

---

## 9. 导出配置 JSON Schema

```typescript
interface ConfigExport {
  version: string;          // 协议版本，如 "2.6"
  exportedAt: string;       // ISO 8601 时间戳
  device: {
    deviceId: number;
    N: number;              // 物理控件数
    B: number;              // 库数量
    V: number;              // 虚拟控件总数
  };
  virtualControls: VirtualCtrl[];   // 来源：ConfigManager 可写副本（含未保存编辑）
  calibration: {
    min: number;            // 14-bit 校准最小值
    max: number;            // 14-bit 校准最大值
  }[];                      // 长度 N，按物理索引顺序排列
}
```

---

## 10. 版本历史

| 版本 | 主要变更 |
|------|----------|
| v1.9 | 暴露 DisconnectedError；明确快照刷新方式；定义 error 事件触发范围；增加 getActiveControls；修正 ConfigManager |
| v1.10 | 补全所有省略的详细描述；discardChanges 改为纯本地恢复快照；明确 getActiveControls 未连接时返回空数组；exportConfig 数据来源明确为可写副本；补充 connect 失败清理路径；明确一次性渲染策略 |

---

