# 上位机 JS 库详细设计

## 1. 概述

本文档描述一个基于 **Web MIDI API** 的 JavaScript 库 **LyreConfigSDK**，用于在浏览器中实现《MIDI 控制器自描述配置协议 v2.6》定义的完整上位机功能。该库可直接内联于 HTML 页面，生成单页配置工具。

**核心能力**：
- 自动发现并连接符合条件的 MIDI 设备
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
│    MidiTransport (连接管理、SysEx 收发队列)   │
├─────────────────────────────────────────────┤
│              Web MIDI API                    │
└─────────────────────────────────────────────┘
```

- **MidiTransport**：封装 `navigator.requestMIDIAccess`，管理输入/输出端口，提供异步的 SysEx 请求/响应匹配。
- **ProtocolCodec**：纯函数集合，实现所有命令的编码、解码、校验和计算及数据验证。
- **DeviceService**：面向业务的高级接口，组合 MidiTransport 与 ProtocolCodec，提供“连接并初始化”“读取全部配置”“执行校准”“写入虚拟配置”等方法，并处理重试逻辑。
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
- 请求 MIDI 访问权限
- 枚举输入/输出设备，按名称或设备 ID（通过 SysEx 查询）筛选目标设备
- 为每个设备建立独立的 `Input` 和 `Output` 连接
- 发送 SysEx 消息，并等待匹配的响应（支持超时与重试）

#### 4.1.2 主要数据结构
```typescript
interface MidiDeviceHandle {
  input: MIDIInput;
  output: MIDIOutput;
  deviceId: number;        // SysEx 中使用的设备 ID (0x00–0x7E)
}
```

#### 4.1.3 核心方法

- `requestAccess(): Promise<MIDIAccess>`
  请求用户授权 MIDI 访问。

- `scanDevices(access: MIDIAccess, predicate?: FilterFn): Promise<MidiDeviceHandle[]>`
  枚举所有输入/输出端口，自动配对同名端口，并对每个候选设备发送 `0x03` 查询设备信息，根据响应中的设备 ID 建立句柄。可自定义过滤条件。

- `sendSysex(device: MidiDeviceHandle, msg: Uint8Array, responseCmd?: number, timeout?: number): Promise<Uint8Array>`
  发送 SysEx 消息，如果提供 `responseCmd`，则等待该命令的响应消息（超时默认 500ms）。内部维护未完成请求队列，通过命令字和消息匹配。

- `onSysex(callback: (msg: Uint8Array) => void): void`
  注册全局 SysEx 监听器，用于被动接收消息（如后续固件主动推送）。库本身内部使用该机制进行响应匹配。

#### 4.1.4 响应匹配逻辑
每个输出消息分配单调递增的事务 ID（或直接用命令字 + 时间戳）。当收到 SysEx 消息时，首先解析命令字、设备 ID，如果与某个挂起请求匹配，则 resolve 对应 Promise，否则交给 `onSysex` 回调。匹配时额外校验消息长度与校验和（校验和错误视为无效响应，触发重试）。

#### 4.1.5 错误处理
- 超时抛出 `TimeoutError`
- 校验和错误抛出 `ChecksumError`
- MIDI 访问被拒抛出 `MidiAccessDeniedError`

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
- `rolandChecksum(data: number[] | Uint8Array): number`
  计算 Roland 式校验和，范围：`sum = data.reduce(...) & 0x7F; return (128 - sum) & 0x7F`。

- `validateSysEx(msg: Uint8Array, expectedCmd?: number, expectedDeviceId?: number): boolean`
  校验消息完整性、F0/F7、校验和。

- `encode14bit(value: number): [number, number]`  
  `decode14bit(mid: number, lo: number): number`

#### 4.2.4 命令构建函数（静态方法，返回 Uint8Array）

每个函数均接收必要参数，返回完整 SysEx 消息（包含 F0..F7）。

| 方法 | 说明 |
|------|------|
| `buildQueryPhysical(deviceId)` | 构建 0x03 查询消息 |
| `buildQueryLayout(deviceId)` | 构建 0x07 查询消息 |
| `buildQueryVirtual(deviceId)` | 构建 0x0B 查询消息 |
| `buildSetVirtual(deviceId, B, V, controls)` | 构建 0x0D 写入消息，`controls` 为 `{bank, physIdx, cc, channel}[]` |
| `buildSetCalibration(deviceId, N, calibrations)` | 构建 0x0F 写入消息，`calibrations` 为 `{minMid, minLo, maxMid, maxLo}[]` 或直接提供 `Uint16` 数组后编码 |
| `buildQueryRawADC(deviceId)` | 构建 0x11 查询消息 |

#### 4.2.5 响应解析函数

| 方法 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `parsePhysicalResponse(msg)` | SysEx 字节数组 | `{N, protocolVersion, physControls: PhysDesc[]}` | `PhysDesc: {mux, channel, calMin, calMax}`，其中 calMin/calMax 已解码为 16-bit 值 |
| `parseLayoutResponse(msg)` | 同上 | `{treeBytes: Uint8Array, length: number}` | 返回原始树字节流，不在此层解析树结构 |
| `parseVirtualResponse(msg)` | 同上 | `{B, V, controls: VirtualCtrl[]}` | `VirtualCtrl: {bank, physIdx, cc, channel}` |
| `parseAck(msg, expectedCmd)` | 同上 | `{status: number}` | 0=成功, 1=失败 |
| `parseRawADCResponse(msg)` | 同上 | `{N, rawValues: number[]}` | 已解码的 14-bit 原始值数组 |

所有解析函数首先调用 `validateSysEx`，失败则抛出异常。

#### 4.2.6 数据验证函数（对应固件端 `cmd_proto_validate_*`）

- `validateVirtualConfig(controls, B, V, N): {valid: boolean, error?: string}`
  检查数组长度、字段范围、唯一性（bank*N + physIdx 不得重复）。

- `validateCalibrationData(calibrations, N): {valid: boolean, error?: string}`
  检查长度、每项 cal_max > cal_min。

---

### 4.3 设备服务层 `DeviceService`

#### 4.3.1 职责
封装设备交互流程，提供面向 UI 的业务 API。管理设备状态，处理重试策略。

#### 4.3.2 设备状态模型 `DeviceState`
```typescript
interface DeviceState {
  connected: boolean;
  deviceHandle: MidiDeviceHandle | null;
  physical: {
    N: number;
    protocolVersion: number;
    controls: PhysDesc[];
  };
  layoutTree: LayoutNode | null;   // 树结构
  virtual: {
    B: number;
    V: number;
    controls: VirtualCtrl[];
  };
  calibration: {
    rawMin: number[];   // 最近一次采集的最小 ADC 值
    rawMax: number[];   // 最近一次采集的最大 ADC 值
    status: 'uncalibrated' | 'calibrated' | 'unknown';
  };
}
```
物理描述与虚拟配置从设备读取后直接填充，校准状态通过比较当前存储的 min/max 是否为默认值 (0/4095) 判断。

#### 4.3.3 核心方法

- `connect(deviceHandle: MidiDeviceHandle): Promise<void>`
  保存设备句柄，依次调用 `queryPhysicalInfo`, `queryLayout`, `queryVirtualConfig`，填充 `DeviceState`。

- `disconnect(): void`
  关闭 MIDI 端口监听（如果必要），重置状态。

- `queryPhysicalInfo(): Promise<PhysicalInfo>`
  发送 0x03，等待 0x04，解析并存储。

- `queryLayout(): Promise<LayoutNode>`
  发送 0x07，等待 0x08，调用 `LayoutParser.parse(treeBytes)` 得到树。

- `queryVirtualConfig(): Promise<VirtualInfo>`
  发送 0x0B，等待 0x0C，解析并存储。

- `writeVirtualConfig(controls: VirtualCtrl[]): Promise<void>`
  先本地验证（`validateVirtualConfig`），然后构建 0x0D 消息发送，等待 0x0E 应答。若返回 NACK 或通信失败，按协议重试 1 次（共 2 次尝试，间隔 400ms）。

- `startCalibrationWizard(onPrompt: (phase: string) => void): Promise<void>`
  执行上位机辅助校准流程：
  1. 调用 `onPrompt('min')` 提示用户将控件调至最小值。
  2. 连续发送 5 次 0x11（间隔 50ms），取每个物理控件的中位数作为 `calMin[]`。
  3. 调用 `onPrompt('max')` 提示调至最大值。
  4. 同样采集 5 次取中位数作为 `calMax[]`。
  5. 对于布局树中类型为旋钮/推杆的控件，验证 `calMax[i] > calMin[i]`，否则抛出 `CalibrationRangeError` 并提示重试。
  6. 按钮控件保持默认值 min=0, max=4095。
  7. 构建 0x0F 消息发送，等待 ACK。
  8. 成功后更新状态。

- `readRawADC(): Promise<number[]>`
  单次发送 0x11，返回原始值数组，用于调试或手动校准。

#### 4.3.4 重试与错误恢复
- 所有命令发送均设置超时 500ms，超时后重试一次。
- 连续失败则标记设备断开，触发 `onDisconnect` 回调。

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
  type: 'knob' | 'fader' | 'button';
  physIndex: number;   // 物理控件逻辑索引
}
```

#### 4.4.3 解析算法
- 使用游标 `pos` 在 `Uint8Array` 上递归读取。
- 遇到容器节点，读取子节点数量或行列数，递归构建子节点。
- 遇到叶子节点，读取物理索引。
- 遇到未知容器节点（0x01–0x0F），抛出 `UnknownContainerError` 并终止。
- 遇到未知叶子节点（0x10–0x3F），消耗索引字节，生成一个占位符叶子节点，类型标记为 `unknown`，以便 UI 提示。

解析完成后，验证叶子节点总数是否与物理控件数 N 匹配（可选警告）。

---

### 4.5 UI 渲染模块 `LayoutRenderer`

#### 4.5.1 职责
根据 `LayoutNode` 树和物理/虚拟配置，生成对应的 DOM 元素，并绑定交互事件。此模块供单页工具直接使用。

#### 4.5.2 核心方法
- `render(container: HTMLElement, layout: LayoutNode, context: RenderContext): void`
  清空容器，递归遍历布局树，生成对应的 HTML 结构。

`RenderContext` 提供：
- `deviceState: DeviceState`
- `onVirtualChange(index: number, field: string, value: number): void`  用于编辑虚拟控件参数
- `onCalibrate(): void`  触发校准向导

#### 4.5.3 渲染规则
- **水平容器 (HBox)**：生成 `display: flex; flex-direction: row;` 的 DIV。
- **垂直容器 (VBox)**：生成 `display: flex; flex-direction: column;` 的 DIV。
- **网格容器 (Grid)**：生成 CSS Grid 容器，行列数由属性决定。
- **旋钮 / 推杆**：根据 `physIndex` 查找对应的虚拟控件绑定（在当前选中的库下），显示一个滑块 (`<input type="range">`) 或旋钮样式（可用 CSS 模拟），并在旁边显示 CC 号、通道等可编辑字段。
- **按钮**：同理显示一个按钮样式，可配置其 CC / 通道（若存在虚拟控件绑定）。

所有可编辑字段监听变化，调用 `context.onVirtualChange`，由上层决定是立即写入设备还是缓存后批量写入。

#### 4.5.4 库选择器
如果 B > 1，自动生成库切换下拉菜单，切换时更新各控件的显示值（CC、通道）。

#### 4.5.5 校准状态标识
每个旋钮/推杆控件旁显示校准状态图标（未校准、已校准），点击可触发针对单个控件或全局的校准流程。

---

### 4.6 配置管理器 `ConfigManager`

#### 4.6.1 职责
管理虚拟配置的本地副本，支持编辑、撤销、批量写入。维护“脏”状态，避免不必要的设备写入。

#### 4.6.2 主要 API
- `editVirtual(bank: number, physIdx: number, field: 'cc'|'channel', value: number): void`
  修改内存中的虚拟配置，标记脏。
- `saveToDevice(): Promise<void>`
  调用 `DeviceService.writeVirtualConfig`，成功后清除脏标记。
- `discardChanges(): void`
  重新从设备读取配置，丢弃本地修改。
- `exportConfig(): string`
  将当前虚拟配置序列化为 JSON 或可打印格式，用于备份。

---

## 5. 数据流示意

### 5.1 启动与连接
```
用户点击“连接” → MidiTransport.requestAccess()
→ scanDevices() 发送 0x03 到每个 MIDI 输出端口
→ 收到匹配的 0x04 响应 → 建立 MidiDeviceHandle
→ DeviceService.connect(handle)
   → queryPhysicalInfo() → state.physical
   → queryLayout() → state.layoutTree
   → queryVirtualConfig() → state.virtual
→ UI 更新：LayoutRenderer.render(container, tree, context)
```

### 5.2 编辑虚拟配置并写入
```
用户在 UI 修改 CC 值 → ConfigManager.editVirtual(bank, phys, 'cc', 42)
→ UI 显示脏标记 → 用户点击“写入设备”
→ ConfigManager.saveToDevice()
   → DeviceService.writeVirtualConfig(state.virtual.controls)
     → ProtocolCodec.buildSetVirtual(...) → 发送 0x0D
     → 等待 0x0E ACK → 若失败重试 → 成功
→ 清除脏标记，提示成功
```

### 5.3 校准流程
```
用户点击“校准” → DeviceService.startCalibrationWizard(onPrompt)
  onPrompt('min') → UI 显示“请将控件调至最小值”模态
  用户确认 → 发送 5 次 0x11（间隔 50ms）→ 取中位数 calMin
  onPrompt('max') → UI 提示调至最大值
  用户确认 → 采集 calMax
  验证范围 → 构建 0x0F 并发送 → 等待 0x10 ACK
  → 更新状态，UI 刷新校准图标
```

---

## 6. 错误处理策略

库内部分层处理错误：

| 层级 | 异常类型 | 处理方式 |
|------|----------|----------|
| MidiTransport | `TimeoutError`, `ChecksumError` | 自动重试一次，仍失败则向上层抛出 |
| ProtocolCodec | `ValidationError`, `ParseError` | 立即抛出，包含详细错误码 |
| DeviceService | 组合上述异常 | 转换为用户友好的错误信息，通过事件通知 UI |
| UI | - | 捕获异常，显示 toast 提示，并允许用户重试 |

全局错误事件：
```typescript
library.on('error', (err) => { console.error(err); });
library.on('deviceDisconnected', () => { alert('设备断开'); });
```

---

## 7. 单页工具集成示例

```html
<!DOCTYPE html>
<html>
<head><title>Lyre 配置工具</title></head>
<body>
<div id="app">
  <button id="btn-connect">连接设备</button>
  <select id="bank-selector" style="display:none"></select>
  <div id="layout-container"></div>
  <button id="btn-write" disabled>写入配置</button>
  <button id="btn-calibrate">校准</button>
</div>

<script src="lyre-config-sdk.js"></script>
<script>
  const sdk = new LyreConfigSDK();
  let state, renderer;

  document.getElementById('btn-connect').onclick = async () => {
    const access = await sdk.requestAccess();
    const devices = await sdk.scanDevices(access);
    if (devices.length === 0) { alert('未发现 Lyre 设备'); return; }
    state = await sdk.connect(devices[0]);
    renderer = new sdk.LayoutRenderer();
    renderer.render(document.getElementById('layout-container'), state.layoutTree, {
      deviceState: state,
      onVirtualChange: (idx, field, val) => {
        sdk.editVirtual(state.currentBank, idx, field, val);
        document.getElementById('btn-write').disabled = false;
      }
    });
    if (state.virtual.B > 1) {
      // 初始化库选择器...
    }
  };

  document.getElementById('btn-write').onclick = async () => {
    await sdk.saveConfig();
    document.getElementById('btn-write').disabled = true;
    alert('配置已写入');
  };

  document.getElementById('btn-calibrate').onclick = async () => {
    await sdk.startCalibrationWizard((phase) => {
      alert(phase === 'min' ? '请将推子拉到底' : '请将推子推到顶');
    });
    alert('校准完成');
  };
</script>
</body>
</html>
```

---

## 8. API 参考（简要清单）

**LyreConfigSDK 类**

| 方法 | 说明 |
|------|------|
| `requestAccess()` | 获取 MIDIAccess |
| `scanDevices(access, filter?)` | 扫描并识别设备 |
| `connect(deviceHandle)` | 连接并读取全部配置 |
| `disconnect()` | 断开连接 |
| `getDeviceState()` | 返回当前 DeviceState |
| `editVirtual(bank, physIdx, field, value)` | 编辑虚拟控件 |
| `saveConfig()` | 写入虚拟配置到设备 |
| `startCalibrationWizard(onPrompt)` | 执行校准向导 |
| `readRawADC()` | 查询 ADC 原始值（调试） |
| `exportConfig()` | 导出配置 JSON |

**事件**

| 事件 | 参数 |
|------|------|
| `'connected'` | `deviceHandle` |
| `'disconnected'` | - |
| `'configChanged'` | `virtualControls` |
| `'error'` | `{code, message}` |

---

## 9. 实现注意事项

1. **缓冲与同步**：MidiTransport 内部维护一个请求队列，确保同一时刻只有一个命令在等待响应（避免响应混淆）。在收到匹配响应之前，后续请求排队。
2. **SysEx 长度**：按照协议最大值（770 字节）分配缓冲区。
3. **数据位约束**：所有构建的 SysEx 消息必须保证数据字节 bit7=0，构建函数内部自动处理。
4. **按钮虚拟控件**：UI 渲染时检查按钮是否出现在虚拟控件表中，以此决定显示为可配置的 MIDI 控件还是固件功能按钮（不可编辑）。
5. **错误恢复**：写入虚拟配置时，如果设备返回 NACK，尝试重新读取虚拟配置，检查是否因设备端状态不一致导致，并提示用户。
6. **版本兼容**：检查 `protocolVersion` 是否 ≥ 0x16，低于则提示升级固件。

---

## 10. 附录：关键数据结构 TypeScript 定义

```typescript
interface PhysDesc {
  mux: number;         // 0x00 = 直连
  channel: number;     // ADC 通道
  calMin: number;      // 解码后的 14-bit
  calMax: number;
}

interface VirtualCtrl {
  bank: number;
  physIdx: number;
  cc: number;
  channel: number;
}

interface DeviceState {
  physical: {
    N: number;
    protocolVersion: number;
    controls: PhysDesc[];
  };
  layoutTree: LayoutNode;
  virtual: {
    B: number;
    V: number;
    controls: VirtualCtrl[];
  };
}
```

此设计完整覆盖协议要求，分层清晰，能直接作为开发单页配置工具的蓝图。
