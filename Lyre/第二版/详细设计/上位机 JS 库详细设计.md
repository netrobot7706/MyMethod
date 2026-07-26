# 上位机 JS 库详细设计 v1.9

## 1. 概述

本文档描述基于 **Web MIDI API** 的 JavaScript 库 **LyreConfigSDK**，用于在浏览器中实现《MIDI 控制器自描述配置协议 v2.6》定义的完整上位机功能。该库可直接内联于 HTML 页面，生成单页配置工具。

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

---

## 3. 依赖与运行环境

- 浏览器支持 **Web MIDI API**（Chrome / Edge / Opera 等）
- 无需第三方库，以 **ES6 模块或 IIFE** 内联方式提供
- 使用 `async/await` 和 `Promise`，需 ES2017+

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
  id: string;
  name: string;
}

interface MidiDeviceHandle {
  input: MIDIInput;
  output: MIDIOutput;
  deviceId: number;        // 0x00–0x7E
}
```

#### 4.1.3 核心方法

- `requestAccess(): Promise<MIDIAccess>`  
  内部调用 `navigator.requestMIDIAccess({ sysex: true })`。SysEx 权限是必要条件。

- `getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] }`

- `async createHandle(access, inputId, outputId, deviceId): Promise<MidiDeviceHandle>`  
  验证 deviceId 范围、打开端口（原子性：output 打开失败时关闭 input），注册 onmidimessage。

- `sendSysex(device, msg, responseCmd?, timeout?): Promise<Uint8Array>`  
  发送并等待匹配响应。超时逻辑同 v1.8。

- `disconnect(device: MidiDeviceHandle): void`  
  清理：reject pending 为 `DisconnectedError`，移除监听，调用 `input.close().catch(()=>{})` 和 `output.close().catch(()=>{})`，清空队列。

#### 4.1.4 错误类

```typescript
class TimeoutError extends Error {}
class ChecksumError extends Error {}
class DisconnectedError extends Error {}
class MidiAccessDeniedError extends Error {}
```

---

### 4.2 协议编解码器 `ProtocolCodec`

**职责**：提供所有 SysEx 命令的构建、解析、验证函数。

#### 4.2.1 常量

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

#### 4.2.2 工具函数

- `rolandChecksum(data: Uint8Array | number[]): number`
- `computeMessageChecksum(fullMsg: Uint8Array): number`  
  自动提取 `msg.slice(1, msg.length - 2)`。
- `encode14bit(value: number): [number, number]` 输入 0–16383。
- `decode14bit(mid: number, lo: number): number`
- `validateSysEx(msg: Uint8Array, expectedCmd?, expectedDeviceId?): boolean`

#### 4.2.3 命令构建

| 方法 | 说明 |
|------|------|
| `buildQueryPhysical(deviceId)` | 0x03 |
| `buildQueryLayout(deviceId)` | 0x07 |
| `buildQueryVirtual(deviceId)` | 0x0B |
| `buildSetVirtual(deviceId, B, V, controls)` | 0x0D，字段非法抛 `ValidationError` |
| `buildSetCalibration(deviceId, N, calibrations)` | 0x0F，接收 `{min,max}[]` |
| `buildQueryRawADC(deviceId)` | 0x11 |

#### 4.2.4 响应解析

| 方法 | 输出 | 说明 |
|------|------|------|
| `parsePhysicalResponse(msg)` | `{N, protocolVersion, physControls}` | 校验和错误抛 `ChecksumError` |
| `parseLayoutResponse(msg)` | `{declaredLength, treeBytes}` | 校验和错误同上 |
| `parseVirtualResponse(msg)` | `{B, V, controls}` | 只解析，不做约束校验 |
| `parseAck(msg, expectedCmd)` | `{status: number}` | status=0/1/2 |
| `parseRawADCResponse(msg)` | `{N, rawValues}` | 14‑bit 解码 |

**0x04 响应字节偏移表**（同 v1.2）。

#### 4.2.5 数据验证

- `validateVirtualConfig(controls, B, V, N)`：检查长度、字段范围、bit7、唯一性。
- `validateCalibrationData(calibrations, N)`：检查范围、max>min、编码后 bit7。

---

### 4.3 设备服务层 `DeviceService`

#### 4.3.1 职责
面向 UI 的高级 API，管理设备状态、重试、校准、事件。

#### 4.3.2 状态模型 `DeviceState`

```typescript
interface DeviceState {
  connected: boolean;
  deviceHandle: MidiDeviceHandle | null;
  physical: { N: number; protocolVersion: number; controls: PhysDesc[] };
  layoutTree: LayoutNode | null;
  virtual: { B: number; V: number; controls: VirtualCtrl[] };
  calibration: { rawMin: number[] | null; rawMax: number[] | null; status: 'uncalibrated'|'calibrated'|'unknown' };
}
```

**数据所有权**：
- `DeviceState.virtual.controls` 存储**最后一次从设备读取/写入的值**（只读快照）。
- 用户编辑通过 `ConfigManager` 维护独立的可写副本，通过 `getActiveControls(bank)` 获取当前编辑状态。
- `getDeviceState().virtual.controls` 不反映未保存的修改。

#### 4.3.3 核心方法

- **`async connectAndInitialize(access, inputId, outputId, deviceId): Promise<DeviceState>`**  
  1. 如果已连接，先调用 `this.disconnect()`（自动断开旧连接）。**注意：断开后若新连接失败，旧连接不会恢复**。
  2. 创建句柄，内部 `connect()` 发送 0x03 等。
  3. 使用 `access.addEventListener('statechange', ...)` 监听端口移除，匹配当前端口 ID 且状态为 disconnected 时：
     - 先发出 `deviceDisconnected` 事件（UI 可设置断开标志）
     - 再执行 `disconnect()` 清理资源。
  4. 返回 `DeviceState`。

- **`disconnect(): void`**  
  用户主动断开。不触发 `deviceDisconnected` 事件。内部调用 `MidiTransport.disconnect(state.deviceHandle!)` 并重置状态。

- **`async writeVirtualConfig(controls): Promise<void>`**  
  重试策略同前（status=1 重试一次）。

- **`async startCalibrationWizard(onPrompt): Promise<void>`**  
  前置检查：未连接直接抛 `NotConnectedError`。其余流程同前。

- **`async readRawADC(): Promise<number[]>`**  
  前置检查连接。

- **`editVirtual(bank, physIdx, field, value): void`**  
  即时验证，修改 ConfigManager 的可写副本。

- **`async saveConfig(): Promise<void>`**  
  委托给 `ConfigManager.saveToDevice()`，后者检查脏标记，若无修改则跳过；否则调用 `writeVirtualConfig(currentControls)` 写入设备，成功后**将写入的副本直接赋值给 `DeviceState.virtual.controls`**（无需重新查询，设备无额外处理），并清除脏标记。

- **`exportConfig(): string`**  
  未连接抛 `NotConnectedError`。返回 JSON 格式见 §9。

- **`getActiveControls(bank: number): VirtualCtrl[]`**  
  返回指定库的当前虚拟控件配置（含未保存的编辑），供 UI 渲染使用。内部委托给 ConfigManager。

#### 4.3.4 错误类及事件

```typescript
class CancelSignal extends Error {}
class CalibrationCancelledError extends Error {}
class ProtocolViolationError extends Error {}
class NotConnectedError extends Error {}
class ValidationError extends Error {}
```

**事件**：
- `error` 事件：仅在**非用户主动发起的后台操作**失败时触发（如 USB 拔出导致的 pending 请求 reject 为 `DisconnectedError`）。用户主动调用（`saveConfig`、`startCalibrationWizard` 等）的错误通过 Promise reject 传播，**不触发** `error` 事件。
- `deviceDisconnected` 事件：仅在物理断开时触发。

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
  cols?: number;
  rows?: number;
}

interface LeafNode {
  type: 'knob' | 'fader' | 'button' | 'unknown';
  physIndex: number;
}
```

#### 4.4.3 解析算法
- 静态方法 `parse(treeBytes: Uint8Array, declaredLength: number): LayoutNode`
- 严格以 `declaredLength` 为边界：读取前检查 `pos < declaredLength`，完成后检查 `pos === declaredLength`，否则抛出 `MalformedTreeError`。
- 容器节点：读取子节点数/行列数，递归构建子节点；Grid 校验 `cols * rows <= 127`。
- 未知容器节点抛出 `UnknownContainerError`；未知叶子节点生成 `'unknown'` 类型节点。

---

### 4.5 UI 渲染模块 `LayoutRenderer`

#### 4.5.1 职责
根据布局树和设备/虚拟配置生成 DOM 元素，并绑定交互。

#### 4.5.2 核心方法
- `render(container: HTMLElement, layout: LayoutNode, context: RenderContext): void`

**`RenderContext`** 接口：
```typescript
interface RenderContext {
  deviceState: DeviceState;
  getActiveControls(bank: number): VirtualCtrl[];  // 返回指定库的当前配置（含未保存编辑）
  onVirtualChange(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void;
  onCalibrate(): void;
}
```

渲染时使用 `context.getActiveControls(currentBank)` 获取显示数据，而非 `DeviceState.virtual.controls`。

#### 4.5.3 渲染规则
- 容器：HBox/VBox 使用 flex 布局，Grid 使用 CSS Grid。
- 叶子控件：根据 `(bank, physIdx)` 查找对应的虚拟控件，显示滑块/按钮样式及可编辑的 CC/通道。
- 库选择器：若 B > 1，生成下拉菜单，切换时重新渲染控件区。
- 校准状态图标：对旋钮/推杆显示，依据 `DeviceState.calibration.status` 和具体控件的数据。

所有编辑操作通过 `context.onVirtualChange` 通知上层。

---

### 4.6 配置管理器 `ConfigManager`

#### 4.6.1 职责
维护虚拟控件配置的可写副本，管理脏状态，提供编辑与批量保存。

#### 4.6.2 主要 API
- `editVirtual(bank, physIdx, field, value): void`  
  修改可写副本，标记脏。

- `saveToDevice(): Promise<void>`  
  调用 `DeviceService.writeVirtualConfig(controlsCopy)`，成功后清除脏标记。

- `discardChanges(): void`  
  丢弃本地修改，重新从设备加载当前值（调用 0x0B 刷新 `DeviceState.virtual.controls` 并重置副本）。

- `getControlsCopy(bank: number): VirtualCtrl[]`  
  返回指定库的当前可写副本（内部使用，供 `getActiveControls` 调用）。

本模块**不包含** `exportConfig` 方法，导出功能由 `DeviceService` 统一提供。

---

## 5. 数据流示意

### 5.1 连接与端口监听
```
sdk.connectAndInitialize(...) 
  → 若已连接则断开旧连接（注意：失败不恢复）
  → createHandle → connect → 注册 onstatechange
  → 返回 DeviceState
```

### 5.2 编辑虚拟配置
```
UI 修改 → sdk.editVirtual(...) → ConfigManager 副本更新
UI 从 context.getActiveControls(bank) 获取最新值显示

用户保存 → sdk.saveConfig() → ConfigManager.saveToDevice()
  → writeVirtualConfig(副本) → 成功：副本赋给 DeviceState.virtual.controls，清脏
```

---

## 6. 错误处理策略

| 场景 | 处理方式 |
|------|----------|
| 用户主动调用失败 | Promise reject 相应错误，不触发全局 `error` 事件 |
| USB 拔出 | 触发 `deviceDisconnected` 事件 → 内部清理，pending 请求 reject `DisconnectedError`（触发全局 `error` 事件，UI 可忽略） |
| 写入 NACK (status=1) | 自动重试一次 |
| 未连接时操作 | 立即抛 `NotConnectedError` |
| 校准取消 | 抛 `CalibrationCancelledError` |

---

## 7. API 参考（公开接口）

```typescript
class LyreConfigSDK {
  // 传输层
  requestAccess(): Promise<MIDIAccess>;
  getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] };

  // 服务层
  async connectAndInitialize(access: MIDIAccess, inputId: string, outputId: string, deviceId: number): Promise<DeviceState>;
  disconnect(): void;

  getDeviceState(): DeviceState;
  getActiveControls(bank: number): VirtualCtrl[];               // 含未保存编辑
  editVirtual(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void;
  async saveConfig(): Promise<void>;
  async startCalibrationWizard(onPrompt: (phase: 'min'|'max') => Promise<void>): Promise<void>;
  async readRawADC(): Promise<number[]>;
  exportConfig(): string;

  // 信号/错误实例属性
  readonly CancelSignal: typeof CancelSignal;
  readonly CalibrationCancelledError: typeof CalibrationCancelledError;
  readonly DisconnectedError: typeof DisconnectedError;         // v1.9 新增

  // 事件订阅，返回取消订阅函数
  on(event: 'error', handler: (err: Error) => void): () => void;
  on(event: 'deviceDisconnected', handler: () => void): () => void;
}
```

---

## 8. 集成示例（关键部分）

```javascript
const sdk = new LyreConfigSDK();
let isDisconnecting = false;

// 监听设备物理断开
sdk.on('deviceDisconnected', () => {
  isDisconnecting = true;
  alert('设备已断开');
});

// 全局错误处理（忽略断开后的 DisconnectedError）
sdk.on('error', (err) => {
  if (isDisconnecting && err instanceof sdk.DisconnectedError) return;
  console.error(err);
});

// 连接
async function connect() {
  const access = await sdk.requestAccess();
  const ports = sdk.getAvailablePorts(access);
  // ... 用户选择端口和ID ...
  const state = await sdk.connectAndInitialize(access, inputId, outputId, deviceId);
  // 渲染界面时使用 getActiveControls(currentBank) 获取控件数据
  isDisconnecting = false;
}
```

---

## 9. 导出配置 JSON Schema

```typescript
interface ConfigExport {
  version: string;
  exportedAt: string;
  device: { deviceId: number; N: number; B: number; V: number; };
  virtualControls: VirtualCtrl[];
  calibration: { min: number; max: number }[]; // 长度 N，物理索引顺序
}
```

---

## 10. 版本历史

| 版本 | 主要变更 |
|------|----------|
| v1.8 | 完善事件顺序、数据所有权、调用链 |
| v1.9 | 暴露 `DisconnectedError`；明确快照刷新方式；定义 `error` 事件触发范围；为 `LayoutRenderer` 增加 `getActiveControls` 上下文，明确渲染数据源；修正 `ConfigManager` 过时方法。 |

---

*本文档为 LyreConfigSDK 最终详细设计，可直接作为编码实现蓝图。*
