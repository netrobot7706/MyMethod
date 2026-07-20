/**
 * LyreDevice.js
 * 
 * Lyre 四推杆 MIDI 控制器产品协议库 (v1.4)
 * 基于 Veloce Base Command Protocol 构建
 */

/**
 * 定义错误类，用于区分产品层错误和基础协议错误
 */
class LyreError extends Error {
  constructor(message, code, originalError = null) {
    super(message);
    this.name = 'LyreError';
    this.code = code; // 产品错误码 (如 3, 5) 或基础错误码
    this.originalError = originalError;
  }
}

class LyreDevice {
  /**
   * 构造函数
   * @param {VeloceBaseProtocol} protocol - 已实例化的 VeloceBaseProtocol 对象
   */
  constructor(protocol) {
    this.protocol = protocol;

    // 注册命令超时与重试策略 (根据文档第 5 节)
    this._registerCommands();

    // 绑定基础协议的生命周期事件
    this.protocol.setEventHandlers({
      onDisconnected: (reason) => console.warn(`[Lyre] Disconnected: ${reason}`),
      onFatalError: (err) => console.error(`[Lyre] Fatal Error:`, err),
      onAsyncFrame: (cmd, fields) => this._handleAsyncFrame(cmd, fields)
    });
  }

  /**
   * 注册特定命令的超时与重试配置
   */
  _registerCommands() {
    // read_cfg: 1000ms, retry 2
    this.protocol.registerCommand('read_cfg', {
      domain: 'config',
      timeoutMs: 1000,
      retries: 2
    });

    // write_cfg: 2000ms, retry 0 (避免重复写Flash)
    this.protocol.registerCommand('write_cfg', {
      domain: 'config',
      timeoutMs: 2000,
      retries: 0
    });

    // read_adc: 500ms, retry 2
    this.protocol.registerCommand('read_adc', {
      domain: 'config',
      timeoutMs: 500,
      retries: 2
    });
  }

  // ==========================================
  // 1. 核心配置操作 (全量读写)
  // ==========================================

  /**
   * 读取设备当前配置
   * @returns {Promise<Array>} 返回包含 4 个推杆配置对象的数组
   */
  async readConfig() {
    try {
      const resp = await this.protocol.sendCommand('read_cfg', {});
      return this._parseConfigResponse(resp);
    } catch (e) {
      throw this._wrapError(e, '读取配置失败');
    }
  }

  /**
   * 写入配置（全量写入）
   * 内部会自动合并当前未修改的字段，确保发送 16 个完整字段。
   * 
   * @param {Array} newConfigs - 包含 4 个推杆配置的数组。允许只提供部分推杆的配置，未提供的将保持原值。
   * @returns {Promise<void>}
   */
  async writeConfig(newConfigs) {
    // 1. 先读取现有配置以保证数据完整性（符合文档 7.2 建议）
    let currentConfigs;
    try {
      currentConfigs = await this.readConfig();
    } catch (e) {
      // 如果读取失败（例如设备还没配置过），使用默认全空结构或抛错？
      // 文档说 read_cfg 若无配置返回出厂默认值，所以一般会成功。
      // 若读取彻底失败，无法进行部分合并，必须中止。
      throw new LyreError('无法获取当前配置以进行合并写入，写入中止', -1, e);
    }

    // 2. 合并配置
    const finalConfigs = currentConfigs.map((oldCfg, index) => {
      const newCfg = newConfigs[index] || {};
      return { ...oldCfg, ...newCfg };
    });

    // 3. 校验数据合法性 (前端预校验，减少设备端报错)
    this._validateConfigData(finalConfigs);

    // 4. 构造请求参数 (扁平化)
    const params = {};
    finalConfigs.forEach((cfg, idx) => {
      params[`${idx}_midi_ch`] = String(cfg.midiCh);
      params[`${idx}_cc`] = String(cfg.cc);
      params[`${idx}_min`] = String(cfg.min);
      params[`${idx}_max`] = String(cfg.max);
    });

    // 5. 发送命令
    try {
      await this.protocol.sendCommand('write_cfg', params);
    } catch (e) {
      throw this._wrapError(e, '写入配置失败');
    }
  }

  // ==========================================
  // 2. ADC 采集操作
  // ==========================================

  /**
   * 读取指定推杆的当前 ADC 原始值
   * @param {number} potIndex - 推杆索引 (0-3)
   * @returns {Promise<number>} ADC 值 (0-4095)
   */
  async readADC(potIndex) {
    if (potIndex < 0 || potIndex > 3) {
      throw new LyreError('推杆索引必须在 0-3 之间', 5);
    }

    try {
      // 发送 read_adc，响应为 report_adc
      const resp = await this.protocol.sendCommand('read_adc', { pot: String(potIndex) });
      
      // 文档 3.3 指出应答帧为 report_adc
      if (resp.get('cmd') === 'report_adc') {
        return parseInt(resp.get('raw'), 10);
      } else {
        throw new LyreError(`未预期的应答命令: ${resp.get('cmd')}`, -1);
      }
    } catch (e) {
      throw this._wrapError(e, `读取推杆 ${potIndex} ADC 失败`);
    }
  }

  // ==========================================
  // 3. 校准辅助功能
  // ==========================================

  /**
   * 校准辅助类，用于管理单个推杆的校准状态
   */
  createCalibrationSession() {
    return {
      // 存储校准过程中的临时值
      _values: [null, null, null, null], 

      /**
       * 记录推杆的最小值
       */
      async recordMin(potIndex) {
        this._values[potIndex] = this._values[potIndex] || { min: 0, max: 0 };
        this._values[potIndex].min = await this.readADC(potIndex);
      },

      /**
       * 记录推杆的最大值
       */
      async recordMax(potIndex) {
        this._values[potIndex] = this._values[potIndex] || { min: 0, max: 0 };
        this._values[potIndex].max = await this.readADC(potIndex);
      },

      /**
       * 提交所有校准数据并写入设备
       * @param {Array} currentFullConfig - 当前完整的配置对象数组 (由 readConfig 获取)
       */
      async commit(currentFullConfig) {
        const patch = [];
        
        for (let i = 0; i < 4; i++) {
          if (!this._values[i]) {
            // 如果该推杆未参与校准，保持原值
            patch.push(null);
          } else {
            patch.push({
              min: this._values[i].min,
              max: this._values[i].max
            });
          }
        }

        await this.writeConfig(patch);
      }
    };
  }

  // ==========================================
  // 内部辅助方法
  // ==========================================

  /**
   * 解析 read_cfg 返回的 Map 为结构化数组
   */
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

  /**
   * 前端数据校验 (避免发送非法数据导致设备报错 code=3)
   */
  _validateConfigData(configs) {
    if (configs.length !== 4) throw new Error('配置数组长度必须为 4');

    configs.forEach((cfg, idx) => {
      if (cfg.midiCh < 1 || cfg.midiCh > 16) throw new LyreError(`推杆${idx} MIDI通道越界 (1-16)`, 3);
      if (cfg.cc < 0 || cfg.cc > 127) throw new LyreError(`推杆${idx} CC号越界 (0-127)`, 3);
      if (cfg.min >= cfg.max) throw new LyreError(`推杆${idx} Min必须小于Max`, 3);
    });
  }

  /**
   * 错误包装器
   * 解析 CommandError 中的 remoteMsg，转换为 LyreError
   */
  _wrapError(error, fallbackMsg) {
    if (error.name === 'CommandError') {
      // 产品特定错误 (Code 3: Invalid Fields, Code 5: Pot Index)
      if (error.remoteMsg) {
        return new LyreError(`${fallbackMsg}: ${error.remoteMsg}`, error.code, error);
      }
    }
    // 基础协议错误 (Timeout, ConnectionLost, VersionMismatch) 直接透传
    return new LyreError(fallbackMsg, error.code || -1, error);
  }

  /**
   * 处理异步帧 (如果设备主动发送 report_adc 或 device_status)
   */
  _handleAsyncFrame(cmd, fields) {
    if (cmd === 'report_adc') {
      const pot = parseInt(fields.get('pot'), 10);
      const raw = parseInt(fields.get('raw'), 10);
      console.log(`[Lyre] Async ADC Update: Pot ${pot} = ${raw}`);
      // 可在此处触发事件通知上层 UI
    } else if (cmd === 'device_status') {
      console.log(`[Lyre] Device Status:`, fields);
    }
  }
}
