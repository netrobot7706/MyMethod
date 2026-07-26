# 上位机 JS 库详细设计 v1.8

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
  发送并等待匹配响应。超时逻辑同 v1.7。

- `disconnect(device: MidiDeviceHandle): void`  
  清理：reject pending 为 DisconnectedError，移除监听，调用 `input.close().catch(()=>{})` 和 `output.close().catch(()=>{})`，清空队列。

#### 4.1.4 错误类

```typescript
class TimeoutError extends Error {}
class ChecksumError extends Error {}
class DisconnectedError extends Error {}
class MidiAccessDeniedError extends Error {}
```

---

### 4.2 协议编解码器 `ProtocolCodec`

同 v1.7，无变更。

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

**数据所有权**（v1.8 新增说明）：
- `DeviceState.virtual.controls` 存储**最后一次从设备读取的值**（只读快照），连接后由 `queryVirtualConfig` 填充，写入成功后刷新。
- 用户编辑通过 `ConfigManager` 维护一份独立的**可写副本**，`getDeviceState().virtual.controls` 不反映未保存的修改。若需获取当前工作副本，使用 `ConfigManager.getCurrentControls()`。

#### 4.3.3 核心方法

- **`async connectAndInitialize(access, inputId, outputId, deviceId): Promise<DeviceState>`**  
  1. 如果 `connected === true`，先调用 `this.disconnect()` 自动断开旧连接。**注意：断开后若新连接失败，旧连接不会恢复，用户需重新选择端口**。  
  2. 创建句柄，内部 `connect()` 发送 0x03 等。  
  3. 使用 `access.addEventListener('statechange', ...)` 监听端口移除，匹配当前端口 ID 且 state 为 disconnected 时，触发断开逻辑。  
  4. 返回 `DeviceState`。

- **USB 拔出事件处理顺序**（v1.8 明确）：  
  当 `_onStateChange` 检测到设备端口移除时，按以下顺序操作：
  1. 调用 `this._emit('deviceDisconnected')`（先通知 UI，使其可标记"正在断开"）
  2. 再调用 `this.disconnect()`（内部会 reject 所有 pending 请求为 `DisconnectedError`）  
  这样 UI 层可在收到 `deviceDisconnected` 事件时设置标志，忽略随后到来的 `DisconnectedError`，避免双重提示。

- **`disconnect(): void`**  
  用户主动断开。不触发 `deviceDisconnected` 事件。

- **`async writeVirtualConfig(controls): Promise<void>`**  
  重试策略同前。

- **`async startCalibrationWizard(onPrompt): Promise<void>`**  
  **新增前置检查**：若 `!this.state.connected`，立即抛出 `NotConnectedError`，避免用户操作一半才发现。  
  其余流程同前。

- **`async readRawADC(): Promise<number[]>`**  
  连接检查同前。

- **`editVirtual(bank, physIdx, field, value): void`**  
  即时验证，修改 `ConfigManager` 的可写副本。

- **`async saveConfig(): Promise<void>`**  
  委托给 `ConfigManager.saveToDevice()`，后者检查脏标记，若无修改则跳过；否则调用 `DeviceService.writeVirtualConfig(currentControls)` 写入设备，成功后刷新 `DeviceState.virtual.controls` 快照并清除脏标记。

- **`exportConfig(): string`**  
  未连接抛 `NotConnectedError`。返回 JSON 格式见 §9。

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

- 维护虚拟控件配置的可写副本（`controlsCopy`）。
- `editVirtual` 修改该副本并标记脏。
- `saveToDevice()` 调用 `DeviceService.writeVirtualConfig(controlsCopy)`，成功则清除脏标记。
- 不再包含 `exportConfig` 方法。

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
sdk.connectAndInitialize(...) 
  → 若已连接，自动断开旧连接（注意：失败不恢复旧连接）
  → createHandle → connect → 返回 DeviceState
```

### 5.2 编辑写入
```
editVirtual → ConfigManager 修改副本
saveConfig → ConfigManager.saveToDevice() → writeVirtualConfig(副本) → 成功刷新 DeviceState
```

---

## 6. 错误处理策略

| 层级 | 异常 | 处理 |
|------|------|------|
| MidiTransport | `TimeoutError`, `ChecksumError`, `DisconnectedError` | 不重试 |
| DeviceService | `NotConnectedError` | 操作前置检查立即抛出 |
| DeviceService | 写入 NACK (status=1) | 重试一次 |
| 向导 | `CancelSignal` → `CalibrationCancelledError` | UI 处理 |
| USB 拔出 | 先 `deviceDisconnected` 事件，后 `DisconnectedError` | UI 应优先处理前者 |

---

## 7. API 参考

```typescript
class LyreConfigSDK {
  requestAccess(): Promise<MIDIAccess>;
  getAvailablePorts(access: MIDIAccess): { inputs: MIDIPortInfo[], outputs: MIDIPortInfo[] };
  async connectAndInitialize(access, inputId, outputId, deviceId): Promise<DeviceState>;
  disconnect(): void;
  getDeviceState(): DeviceState;
  editVirtual(bank, physIdx, field, value): void;
  async saveConfig(): Promise<void>;
  async startCalibrationWizard(onPrompt: (phase: 'min'|'max') => Promise<void>): Promise<void>;
  async readRawADC(): Promise<number[]>;
  exportConfig(): string;
  readonly CancelSignal: typeof CancelSignal;
  readonly CalibrationCancelledError: typeof CalibrationCancelledError;
  on(event: 'error', handler: (err: Error) => void): () => void;
  on(event: 'deviceDisconnected', handler: () => void): () => void;
}
```

---

## 8. 集成示例（重要更新）

```javascript
// 监听设备断开，设置标志避免双重提示
let isDisconnecting = false;
sdk.on('deviceDisconnected', () => {
  isDisconnecting = true;
  alert('设备已断开');
});
sdk.on('error', (err) => {
  if (isDisconnecting && err instanceof sdk.DisconnectedError) return; // 忽略
  alert('错误: ' + err.message);
});
```

其余同前。

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
| v1.7 | 修复 SysEx 权限、重连自动断开、onstatechange 事件处理、close 错误忽略、移除重复 exportConfig |
| v1.8 | 明确 USB 拔出时事件顺序（先 deviceDisconnected 后 DisconnectedError）；补充连接失败不恢复旧连接说明；明确 saveConfig 调用链；增加校准向导连接检查；定义 DeviceState 数据所有权（快照 vs 可写副本） |

---

*本文档为 LyreConfigSDK 最终详细设计，可直接作为编码实现蓝图。*
