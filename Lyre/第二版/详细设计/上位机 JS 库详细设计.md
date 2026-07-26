# 上位机 JS 库详细设计 v1.6

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

---

## 3. 依赖与运行环境

- 浏览器支持 **Web MIDI API**（Chrome / Edge / Opera 等）
- 无需第三方库，以 **IIFE** 内联方式提供
- 使用 `async/await` 和 `Promise`，需 ES2017+

---

## 4. 核心模块详细设计

### 4.1 MIDI 传输模块 `MidiTransport`

#### 4.1.1 职责
- 请求 MIDI 访问权限
- 枚举可用输入/输出端口，供用户手动选择
- 基于用户选择异步创建连接句柄（含端口打开）
- 发送 SysEx 消息，异步匹配响应
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

- `requestAccess(): Promise<MIDIAccess>`  
  请求用户授权，拒绝则抛 `MidiAccessDeniedError`。

- `getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] }`  
  返回所有可用 MIDI 端口信息。

- `async createHandle(access: MIDIAccess, inputId: string, outputId: string, deviceId: number): Promise<MidiDeviceHandle>`  
  1. 验证 `deviceId` 在 `0x00–0x7E` 内，否则抛出 `RangeError`。
  2. 获取 `input` 和 `output` 端口对象，不存在则抛出 `Error`。
  3. **异步打开端口**：`await input.open(); await output.open();`（若 output 打开失败，需关闭已打开的 input 并重新抛出异常）。
  4. 注册 `input.onmidimessage` 回调用于响应匹配。
  5. 返回 `{ input, output, deviceId }`。

- `sendSysex(device: MidiDeviceHandle, msg: Uint8Array, responseCmd?: number, timeout = 500): Promise<Uint8Array>`  
  发送 SysEx，若提供 `responseCmd`，返回匹配响应。超时或校验和错误策略同 v1.5。

- `disconnect(device: MidiDeviceHandle): void`  
  完整清理：reject 所有 pending 请求为 `DisconnectedError`，移除 `onmidimessage`，关闭 `input`/`output`（`input.close(); output.close()`），清除队列。

#### 4.1.4 错误类

```typescript
class TimeoutError extends Error {}
class ChecksumError extends Error {}
class DisconnectedError extends Error {}
class MidiAccessDeniedError extends Error {}
```

**重试策略**：本层不自动重试。

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

#### 4.3.2 状态模型 `DeviceState` 及初始值

```typescript
interface DeviceState {
  connected: boolean;
  deviceHandle: MidiDeviceHandle | null;
  physical: {
    N: number;
    protocolVersion: number;
    controls: PhysDesc[];
  };
  layoutTree: LayoutNode | null;
  virtual: {
    B: number;
    V: number;
    controls: VirtualCtrl[];
  };
  calibration: {
    rawMin: number[] | null;
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

#### 4.3.3 核心方法

- **`async connectAndInitialize(access, inputId, outputId, deviceId): Promise<DeviceState>`**  
  1. `const handle = await MidiTransport.createHandle(...);`
  2. 内部调用私有方法 `connect(handle)`，该方法发送 0x03、检查版本、查询布局和虚拟配置（含 `V ≤ B×N` 校验），若失败自动清理并重新抛出。
  3. 监听 `access.onstatechange`，当关联的输入/输出端口移除时，自动断开并触发 `deviceDisconnected` 事件。
  4. 返回完整 `DeviceState`。

- **`disconnect(): void`**  
  若未连接（`connected === false`），静默返回。否则：
  - 移除 `onstatechange` 监听
  - 调用 `MidiTransport.disconnect(state.deviceHandle!)`
  - 重置状态为 `INITIAL_STATE`
  - **不触发** `deviceDisconnected` 事件（用户主动操作）

- **`async writeVirtualConfig(controls): Promise<void>`**  
  构建 0x0D 消息一次，发送并等待 0x0E ACK。status=1 时重试（最多一次），重试时发送同一字节数组。

- **`async startCalibrationWizard(onPrompt): Promise<void>`**  
  使用局部变量，成功后才更新状态。若用户取消，`onPrompt` 应 reject `CancelSignal`，向导转为 `CalibrationCancelledError`。

- **`async readRawADC(): Promise<number[]>`**  
  发送 0x11，返回原始值。**调用前必须连接**，否则抛 `NotConnectedError`。

- **`getCalibrationStatus(): string`**  
  仅检查旋钮/推杆控件。

- **`editVirtual(bank, physIdx, field, value): void`**  
  即时验证：
  - `field === 'cc'` → `0 <= value <= 127`
  - `field === 'channel'` → `0 <= value <= 15`
  - `bank` 和 `physIdx` 需在已加载的有效范围内。
  非法则抛出 `ValidationError`。修改后标记脏。

- **`exportConfig(): string`**  
  若未连接，抛出 `NotConnectedError`。返回 JSON 字符串，schema 见第 9 节。

- **`on(event, handler): () => void`**  
  - `'error'`：任意模块错误，回调接收 `Error`。
  - `'deviceDisconnected'`：**仅在非用户主动断开的情况下**（如 USB 拔出）触发，回调无参数。  
  返回取消订阅函数。

#### 4.3.4 错误类

```typescript
class CancelSignal extends Error {}
class CalibrationCancelledError extends Error {}
class ProtocolViolationError extends Error {}
class NotConnectedError extends Error {}
class ValidationError extends Error {}
```

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
  rows?: number;
}

interface LeafNode {
  type: 'knob' | 'fader' | 'button' | 'unknown';
  physIndex: number;
}
```

#### 4.4.3 解析算法
- 静态方法 `parse(treeBytes: Uint8Array, declaredLength: number): LayoutNode`
- 使用游标 `pos` 在 `treeBytes` 上递归读取，**严格以 `declaredLength` 为边界**。
- 读取前检查 `pos < declaredLength`，越界则抛出 `MalformedTreeError`。
- 解析完成后检查 `pos === declaredLength`，不等则抛出 `MalformedTreeError`。
- 容器节点：读取子节点数量，递归构建子节点。Grid 额外校验 `cols * rows <= 127` 及子节点数量一致性。
- 叶子节点：读取物理索引。
- 未知容器节点（0x01–0x0F）：抛出 `UnknownContainerError`。
- 未知叶子节点（0x10–0x3F）：消耗索引字节，生成类型为 `'unknown'` 的叶子节点。

---

### 4.5 UI 渲染模块 `LayoutRenderer`

#### 4.5.1 职责
根据 `LayoutNode` 树和物理/虚拟配置，生成对应的 DOM 元素，并绑定交互事件。

#### 4.5.2 核心方法
- `render(container: HTMLElement, layout: LayoutNode, context: RenderContext): void`
  清空容器，递归遍历布局树，生成对应的 HTML 结构。

`RenderContext` 提供：
- `deviceState: DeviceState`
- `onVirtualChange(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void`
- `onCalibrate(): void`

#### 4.5.3 渲染规则
- 水平容器 → `display: flex; flex-direction: row;`
- 垂直容器 → `display: flex; flex-direction: column;`
- 网格容器 → CSS Grid，行列数由属性决定
- 旋钮/推杆/按钮：根据 `(bank, physIdx)` 查找虚拟控件绑定，渲染可编辑控件（滑块、按钮样式），显示 CC/通道等信息
- 库选择器：若 B > 1，生成下拉菜单，切换时更新显示
- 校准状态图标：每个旋钮/推杆旁显示未校准/已校准标识

所有交互通过 `context.onVirtualChange` 触发配置修改，由 `ConfigManager` 处理。

---

### 4.6 配置管理器 `ConfigManager`

#### 4.6.1 职责
管理虚拟配置的本地副本，支持编辑、撤销、批量写入。维护“脏”状态。

#### 4.6.2 主要 API
- `editVirtual(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void`
  修改内存中的虚拟配置，标记脏。
- `saveToDevice(): Promise<void>`
  调用 `DeviceService.writeVirtualConfig`，成功后清除脏标记。
- `discardChanges(): void`
  重新从设备读取配置。
- `exportConfig(): string`
  将当前虚拟配置序列化为 JSON 备份。


---

## 5. 数据流示意

### 5.1 连接

```
refreshPorts() → 枚举端口 → 用户选择
→ sdk.connectAndInitialize(access, inputId, outputId, deviceId)
  → await MidiTransport.createHandle(...)   (异步打开端口)
  → 内部 connect(handle) 发送 0x03… 校验
  → 注册 onstatechange 监听
  → 返回 DeviceState
```

### 5.2 校准

```
startCalibrationWizard(onPrompt)
  → onPrompt reject CancelSignal → 抛出 CalibrationCancelledError
  → 采集、写入、刷新
```

---

## 6. 错误处理策略

| 层级 | 异常 | 处理 |
|------|------|------|
| MidiTransport | `TimeoutError`, `ChecksumError`, `DisconnectedError` | 不重试 |
| DeviceService | `NotConnectedError` | 未连接时操作立即抛出 |
| DeviceService | 写入 NACK (status=1) | 重试一次，发送相同字节 |
| 向导 | `CancelSignal` → `CalibrationCancelledError` | UI 处理 |
| 全局 | `deviceDisconnected` | USB 拔出时自动触发，清理状态 |

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
  editVirtual(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void;
  async saveConfig(): Promise<void>;
  async startCalibrationWizard(onPrompt: (phase: 'min'|'max') => Promise<void>): Promise<void>;
  async readRawADC(): Promise<number[]>;
  exportConfig(): string;

  // 信号/错误实例属性（非静态）
  readonly CancelSignal: typeof CancelSignal;
  readonly CalibrationCancelledError: typeof CalibrationCancelledError;

  // 事件订阅，返回取消订阅函数
  on(event: 'error', handler: (err: Error) => void): () => void;
  on(event: 'deviceDisconnected', handler: () => void): () => void;
}
```

---

## 8. 集成示例（完整）

```html
<script src="lyre-config-sdk.js"></script>
<script>
  const sdk = new LyreConfigSDK();
  let state, access;

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
      renderer.render(/* ... */);
    } catch (e) {
      alert('连接失败：' + e.message);
    }
  };

  document.getElementById('btn-calibrate').onclick = async () => {
    try {
      await sdk.startCalibrationWizard(async (phase) => {
        return new Promise((resolve, reject) => {
          const msg = phase === 'min' ? '请将所有推子拉到底' : '请将所有推子推到顶';
          if (confirm(msg)) resolve();
          else reject(new sdk.CancelSignal('用户取消'));
        });
      });
      alert('校准完成');
    } catch (e) {
      if (e instanceof sdk.CalibrationCancelledError) {
        // 用户取消
      } else {
        alert('校准失败：' + e.message);
      }
    }
  };

  // 设备异常断开监听
  sdk.on('deviceDisconnected', () => {
    alert('设备已断开');
  });

  refreshPorts();
</script>
```

---

## 9. 导出配置 JSON Schema

```typescript
interface ConfigExport {
  version: string;          // "2.6"
  exportedAt: string;       // ISO8601
  device: {
    deviceId: number;
    N: number;
    B: number;
    V: number;
  };
  virtualControls: VirtualCtrl[];
  calibration: {            // 长度 N，物理索引顺序
    min: number;
    max: number;
  }[];
}
```

---

## 10. 版本历史

| 版本 | 主要变更 |
|------|----------|
| v1.6 | `createHandle` 改为异步，确保端口打开；增加 `NotConnectedError` 及操作前置检查；`editVirtual` 即时校验；明确 `deviceDisconnected` 触发条件与事件系统细节；完善原子性清理。 |

---
