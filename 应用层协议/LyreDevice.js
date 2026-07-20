/**
 * LyreDevice.js v2 (State Management Pattern)
 * 
 * 核心变化：
 * 1. 内部维护 this._config 作为“寄存器”。
 * 2. 暴露 getPotConfig / setPotConfig 供上层读写内存状态。
 * 3. load() 从设备拉取并更新寄存器。
 * 4. save() 将寄存器全量写入设备。
 */

class LyreError extends Error {
  constructor(message, code, originalError = null) {
    super(message);
    this.name = 'LyreError';
    this.code = code;
    this.originalError = originalError;
  }
}

class LyreDevice {
  constructor(protocol) {
    this.protocol = protocol;

    // 初始化内部状态寄存器 (默认为空或 null，需调用 load() 填充)
    // 结构: [{ midiCh: 1, cc: 70, min: 0, max: 0 }, ...]
    this._configStore = null;

    // 标记状态是否脏（是否与设备不同步）
    this._isDirty = false;

    this._registerCommands();
    
    // 绑定事件
    this.protocol.setEventHandlers({
      onDisconnected: (reason) => console.warn(`[Lyre] Disconnected: ${reason}`),
      onFatalError: (err) => console.error(`[Lyre] Fatal Error:`, err),
      onAsyncFrame: (cmd, fields) => this._handleAsyncFrame(cmd, fields)
    });
  }

  // ==========================================
  // 1. 生命周期：加载与保存
  // ==========================================

  /**
   * 从设备加载配置，更新内部寄存器
   * 页面初始化时调用此方法
   */
  async load() {
    try {
      const resp = await this.protocol.sendCommand('read_cfg', {});
      // 解析并存入寄存器
      this._configStore = this._parseConfigResponse(resp);
      this._isDirty = false;
      console.log('[Lyre] 配置已加载到寄存器', this._configStore);
      return this._configStore;
    } catch (e) {
      throw this._wrapError(e, '加载配置失败');
    }
  }

  /**
   * 将当前内部寄存器的配置全量写入设备
   * 通常在用户点击“保存”按钮时调用
   */
  async save() {
    if (!this._configStore) {
      throw new LyreError('配置未初始化，请先调用 load()', -1);
    }

    // 1. 前端校验
    this._validateConfigData(this._configStore);

    // 2. 构造参数
    const params = {};
    this._configStore.forEach((cfg, idx) => {
      params[`${idx}_midi_ch`] = String(cfg.midiCh);
      params[`${idx}_cc`] = String(cfg.cc);
      params[`${idx}_min`] = String(cfg.min);
      params[`${idx}_max`] = String(cfg.max);
    });

    // 3. 发送
    try {
      await this.protocol.sendCommand('write_cfg', params);
      this._isDirty = false; // 保存成功，标记为同步
    } catch (e) {
      throw this._wrapError(e, '保存配置失败');
    }
  }

  // ==========================================
  // 2. 状态访问接口 (上层 JS 调用)
  // ==========================================

  /**
   * 获取所有推杆的配置（用于渲染 UI 初始状态）
   */
  getAllConfigs() {
    if (!this._configStore) return null;
    // 返回深拷贝，防止上层直接修改引用导致状态混乱
    return JSON.parse(JSON.stringify(this._configStore));
  }

  /**
   * 获取单个推杆的配置
   * @param {number} index 0-3
   */
  getPotConfig(index) {
    if (!this._configStore) return null;
    return { ...this._configStore[index] }; // 返回副本
  }

  /**
   * 更新单个推杆的配置（更新寄存器，不立即写入设备）
   * 上层控件值变化时调用此方法
   * 
   * @param {number} index 
   * @param {object} partialConfig { midiCh?: number, cc?: number, min?: number, max?: number }
   */
  setPotConfig(index, partialConfig) {
    if (!this._configStore) {
      console.warn('[Lyre] 警告: 尚未加载配置，更新将被忽略');
      return;
    }
    if (index < 0 || index > 3) return;

    // 合并配置
    this._configStore[index] = {
      ...this._configStore[index],
      ...partialConfig
    };
    
    this._isDirty = true;
    
    // 可选：抛出事件通知 UI 更新（如果 UI 采用响应式数据绑定则不需要）
    // this.emit('change', this._configStore);
  }

  /**
   * 检查是否有未保存的更改
   */
  isDirty() {
    return this._isDirty;
  }

  // ==========================================
  // 3. 校准功能 (基于寄存器操作)
  // ==========================================

  /**
   * 获取校准会话
   * 流程：startCalibration() -> setMin()/setMax() -> commit()
   */
  startCalibration(potIndex) {
    const self = this;
    
    // 返回一个校准控制器对象
    return {
      potIndex: potIndex,

      async readCurrent() {
        return await self.readADC(potIndex);
      },

      /** 设置最大值到寄存器 */
      async setMax() {
        const val = await self.readADC(potIndex);
        self.setPotConfig(potIndex, { max: val });
        console.log(`[Lyre] Pot ${potIndex} Max set to ${val} (暂存)`);
      },

      /** 设置最小值到寄存器 */
      async setMin() {
        const val = await self.readADC(potIndex);
        self.setPotConfig(potIndex, { min: val });
        console.log(`[Lyre] Pot ${potIndex} Min set to ${val} (暂存)`);
      },

      /** 将校准数据写入寄存器后，调用主保存 */
      async saveToDevice() {
        return await self.save();
      }
    };
  }

  /**
   * 读取 ADC 原始值
   */
  async readADC(potIndex) {
    if (potIndex < 0 || potIndex > 3) throw new LyreError('推杆索引越界', 5);
    try {
      const resp = await this.protocol.sendCommand('read_adc', { pot: String(potIndex) });
      if (resp.get('cmd') === 'report_adc') {
        return parseInt(resp.get('raw'), 10);
      }
      throw new LyreError('响应帧格式错误', -1);
    } catch (e) {
      throw this._wrapError(e, 'ADC 读取失败');
    }
  }

  // ==========================================
  // 内部辅助
  // ==========================================

  _registerCommands() {
    this.protocol.registerCommand('read_cfg', { domain: 'config', timeoutMs: 1000, retries: 2 });
    this.protocol.registerCommand('write_cfg', { domain: 'config', timeoutMs: 2000, retries: 0 });
    this.protocol.registerCommand('read_adc',  { domain: 'config', timeoutMs: 500,  retries: 2 });
  }

  _parseConfigResponse(fields) {
    const configs = [];
    for (let i = 0; i < 4; i++) {
      configs.push({
        midiCh: parseInt(fields.get(`${i}_midi_ch`), 10),
        cc: parseInt(fields.get(`${i}_cc`), 10),
        min: parseInt(fields.get(`${i}_min`), 10),
        max: parseInt(fields.get(`${i}_max`), 10),
      });
    }
    return configs;
  }

  _validateConfigData(configs) {
    if (!configs || configs.length !== 4) throw new LyreError('配置数据结构非法', 3);
    configs.forEach((cfg, idx) => {
      if (cfg.midiCh < 1 || cfg.midiCh > 16) throw new LyreError(`推杆${idx} 通道越界`, 3);
      if (cfg.cc < 0 || cfg.cc > 127) throw new LyreError(`推杆${idx} CC 越界`, 3);
      if (cfg.min >= cfg.max) throw new LyreError(`推杆${idx} Min必须小于Max`, 3);
    });
  }

  _wrapError(error, fallbackMsg) {
    if (error.name === 'CommandError') {
      return new LyreError(`${fallbackMsg}: ${error.remoteMsg}`, error.code, error);
    }
    return new LyreError(fallbackMsg, error.code || -1, error);
  }

  _handleAsyncFrame(cmd, fields) {
    if (cmd === 'report_adc') {
      const pot = parseInt(fields.get('pot'), 10);
      const raw = parseInt(fields.get('raw'), 10);
      // 如果需要处理设备主动上报的 ADC 变化，可以在这里触发事件
      console.log(`[Lyre] Async ADC: Pot ${pot} = ${raw}`);
    }
  }
}
