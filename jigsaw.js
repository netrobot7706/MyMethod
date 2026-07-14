/**
 * Jigsaw Protocol - Web Transport Module V3.3 (Release)
 * 
 * 修复 P7-001：移除无效的防御性 catch，增加 JSDoc 说明调用者必须处理 rejection。
 */

const CONTROL = Object.freeze({
  START:        new Uint8Array([0xBD, 0x03, 0x00]),
  END:          new Uint8Array([0xBD, 0x03, 0x01]),
  CKSUM_HEADER: new Uint8Array([0xBD, 0x03, 0x02]),
  NAK:          new Uint8Array([0xBD, 0x03, 0x11]),
});

const SIGNALING = Object.freeze({
  START:        0x00,
  END:          0x01,
  CKSUM_HEADER: 0x02,
  ACK:          0x10,
  NAK:          0x11,
});

const NAK_REASON = Object.freeze({
  CHECKSUM_FAIL: 0x01,
  TIMEOUT:       0x02,
  EMPTY_FRAME:   0x03,
  BUFFER_FULL:   0x04,
});

const CHUNK_SIZE = 1024;
const MSG_INTERVAL_MS = 0.5;
const ACK_TIMEOUT_MS = 2000;
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;
const LISTEN_WINDOW_MS = 150;

function encodeDataByte(byte) {
  const ch = (byte & 0x80) ? 15 : 14;
  return [0xB0 | ch, 0x09, byte & 0x7F];
}

function decodeByte(statusByte, value) {
  const channel = statusByte & 0x0F;
  return ((channel & 0x01) << 7) | value;
}

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function delayCancellable(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve('cancelled');
    const onAbort = () => {
      clearTimeout(timer);
      resolve('cancelled');
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ──────────────── 轻量 EventEmitter ────────────────

class EventEmitter {
  constructor() {
    this._listeners = Object.create(null);
  }
  on(event, fn) {
    (this._listeners[event] ??= []).push(fn);
  }
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    wrapper._original = fn;
    this.on(event, wrapper);
  }
  off(event, fn) {
    const list = this._listeners[event];
    if (!list) return;
    const idx = list.findIndex(f => f === fn || f._original === fn);
    if (idx >= 0) list.splice(idx, 1);
  }
  emit(event, ...args) {
    const list = this._listeners[event];
    if (!list || list.length === 0) return;
    const snapshot = list.slice();
    for (const fn of snapshot) {
      try { fn(...args); } catch (e) { /* ignore */ }
    }
  }
  removeAllListeners(event) {
    if (event) delete this._listeners[event];
    else this._listeners = Object.create(null);
  }
}

// ──────────────── 双缓冲接收器 ────────────────

const BufferState = Object.freeze({
  FREE:      0,
  WRITING:   1,
  READY:     2,
  CONSUMING: 3,
});

class DoubleBuffer {
  constructor(size = 8192) {
    this._bufs = [new Uint8Array(size), new Uint8Array(size)];
    this._states = [BufferState.FREE, BufferState.FREE];
    this._active = 0;
    this.length = 0;
  }
  get active() { return this._bufs[this._active]; }
  markWriting() {
    if (this._states[this._active] === BufferState.FREE ||
        this._states[this._active] === BufferState.WRITING) {
      this._states[this._active] = BufferState.WRITING;
    }
  }
  swap() {
    this._states[this._active] = BufferState.READY;
    const done = this._bufs[this._active];
    const len = this.length;
    this._active = (this._active + 1) % 2;
    this.length = 0;

    const currentState = this._states[this._active];
    if (currentState !== BufferState.CONSUMING) {
      this._states[this._active] = BufferState.FREE;
    }
    return { buffer: done, length: len };
  }
  markConsuming() {
    const other = this._active === 0 ? 1 : 0;
    if (this._states[other] === BufferState.READY) {
      this._states[other] = BufferState.CONSUMING;
    }
  }
  releaseConsumed() {
    const other = this._active === 0 ? 1 : 0;
    if (this._states[other] === BufferState.CONSUMING) {
      this._states[other] = BufferState.FREE;
    }
  }
  canAcceptFrame() {
    const s = this._states[this._active];
    return s === BufferState.FREE || s === BufferState.WRITING;
  }
}

// ──────────────── 看门狗定时器 ────────────────

class Watchdog {
  constructor(timeoutMs, onExpire, getStateFn) {
    this._timeout = timeoutMs;
    this._onExpire = onExpire;
    this._getState = getStateFn;
    this._lastActivity = 0;
    this._timer = null;
    this._visible = true;
    this._boundCheck = this._check.bind(this);
    this._boundVisibility = this._onVisibility.bind(this);
  }
  start() {
    this.reset();
    this._timer = setInterval(this._boundCheck, 250);
    document.addEventListener('visibilitychange', this._boundVisibility);
  }
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    document.removeEventListener('visibilitychange', this._boundVisibility);
  }
  reset() { this._lastActivity = performance.now(); }
  _check() {
    if (!this._visible) return;
    if (this._getState && this._getState() === RxState.IDLE) return;
    if (performance.now() - this._lastActivity > this._timeout) {
      this._onExpire();
    }
  }
  _onVisibility() {
    this._visible = !document.hidden;
    if (this._visible) {
      setTimeout(() => this._check(), 100);
    }
  }
}

// ──────────────── 接收器 FrameReceiver ────────────────

const RxState = Object.freeze({
  IDLE:            0,
  DATA:            1,
  WAIT_CHECKSUM:   2,
  WAIT_CKSUM_HIGH: 3,
  WAIT_CKSUM_LOW:  4,
});

class FrameReceiver extends EventEmitter {
  constructor(input, output, options = {}) {
    super();
    this.input = input;
    this.output = output;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._db = new DoubleBuffer(8192);
    this._rxIdx = 0;
    this._rxSum = 0;
    this._rxCksum = 0;
    this._state = RxState.IDLE;
    this._nakReasonMsg = new Uint8Array(3);
    this._watchdog = new Watchdog(this._timeout, () => this._onTimeout(), () => this._state);
    this._watchdog.start();
    this._onMidi = this._onMidiMessage.bind(this);
    this.input.addEventListener('midimessage', this._onMidi);
  }

  get state() { return this._state; }

  _resetStateMachine() {
    this._rxIdx = 0;
    this._rxSum = 0;
    this._state = RxState.IDLE;
  }

  _onTimeout() {
    if (this._state !== RxState.IDLE) {
      this._resetStateMachine();
      this.emit('error', { type: 'timeout', message: 'Receive timeout' });
      this.sendNAK(NAK_REASON.TIMEOUT);
    }
  }

  sendNAK(reasonCode) {
    try {
      const now = performance.now();
      this.output.send(CONTROL.NAK, now);
      const [status, cc, val] = encodeDataByte(reasonCode);
      this._nakReasonMsg[0] = status;
      this._nakReasonMsg[1] = cc;
      this._nakReasonMsg[2] = val;
      const reasonTs = Math.max(now + 1.0, performance.now() + 0.1);
      this.output.send(this._nakReasonMsg, reasonTs);
    } catch { /* ignore */ }
  }

  _onMidiMessage(event) {
    if (!event.data || event.data.length !== 3) return;
    const [statusByte, cc, value] = event.data;
    const channel = statusByte & 0x0F;

    if (channel === 13 && cc === 0x03) {
      this._handleSignaling(value);
      return;
    }
    if ((channel === 14 || channel === 15) && cc === 0x09) {
      const byte = decodeByte(statusByte, value);
      this._handleDataByte(byte);
    }
  }

  _handleSignaling(value) {
    switch (value) {
      case SIGNALING.START:
        if (!this._db.canAcceptFrame()) {
          this.sendNAK(NAK_REASON.BUFFER_FULL);
          this._resetStateMachine();
          this.emit('stateChange', RxState.IDLE);
          return;
        }
        this._rxIdx = 0;
        this._rxSum = 0;
        this._db.length = 0;
        this._db.markWriting();
        this._state = RxState.DATA;
        this._watchdog.reset();
        this.emit('stateChange', RxState.DATA);
        break;

      case SIGNALING.END:
        if (this._state === RxState.DATA) {
          if (this._rxIdx === 0) {
            this.sendNAK(NAK_REASON.EMPTY_FRAME);
            this._resetStateMachine();
            this.emit('stateChange', RxState.IDLE);
          } else {
            this._state = RxState.WAIT_CHECKSUM;
            this._watchdog.reset();
          }
        } else {
          this._resetStateMachine();
          this.emit('stateChange', RxState.IDLE);
        }
        break;

      case SIGNALING.CKSUM_HEADER:
        if (this._state === RxState.WAIT_CHECKSUM) {
          this._state = RxState.WAIT_CKSUM_HIGH;
          this._watchdog.reset();
        } else {
          this._resetStateMachine();
          this.emit('stateChange', RxState.IDLE);
        }
        break;

      case SIGNALING.ACK:
        this.emit('ack');
        break;

      case SIGNALING.NAK:
        this.emit('nak');
        break;

      default:
        break;
    }
  }

  _handleDataByte(byte) {
    switch (this._state) {
      case RxState.DATA:
        if (this._rxIdx < 8192) {
          this._db.active[this._rxIdx++] = byte;
          this._db.length = this._rxIdx;
          this._rxSum = (this._rxSum + byte) & 0xFFFF;
          this._watchdog.reset();
        } else {
          this._resetStateMachine();
          this.emit('stateChange', RxState.IDLE);
          this.emit('error', { type: 'buffer_overflow', message: 'Rx buffer overflow' });
        }
        break;

      case RxState.WAIT_CKSUM_HIGH:
        this._rxCksum = (byte << 8) & 0xFF00;
        this._state = RxState.WAIT_CKSUM_LOW;
        this._watchdog.reset();
        break;

      case RxState.WAIT_CKSUM_LOW:
        this._rxCksum = (this._rxCksum | byte) & 0xFFFF;
        if (this._rxCksum === this._rxSum) {
          this._onFrameComplete();
        } else {
          this.emit('error', { type: 'checksum', message: 'Checksum mismatch' });
          this.sendNAK(NAK_REASON.CHECKSUM_FAIL);
        }
        this._resetStateMachine();
        this.emit('stateChange', RxState.IDLE);
        break;

      default:
        break;
    }
  }

  _onFrameComplete() {
    const { buffer: raw, length: frameLen } = this._db.swap();
    this._db.markConsuming();
    const copy = raw.slice(0, frameLen);
    try {
      this.emit('frame', copy);
    } finally {
      this._db.releaseConsumed();
    }
  }

  destroy() {
    this._watchdog.stop();
    this.input.removeEventListener('midimessage', this._onMidi);
    this.removeAllListeners();
    this._db = null;
  }
}

// ──────────────── 核心会话 JigsawSession ────────────────

class JigsawSession {
  constructor(midiInput, midiOutput, options = {}) {
    this.input = midiInput;
    this.output = midiOutput;

    this._chunkSize = options.chunkSize ?? CHUNK_SIZE;
    this._msgInterval = options.messageIntervalMs ?? MSG_INTERVAL_MS;
    this._maxRetries = options.maxRetries ?? MAX_RETRIES;
    this._ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this._listenWindowMs = options.listenWindowMs ?? LISTEN_WINDOW_MS;

    this._sending = false;
    this._destroyed = false;
    this._abortController = null;

    this._receiver = new FrameReceiver(midiInput, midiOutput, {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });
    this._receiver.on('frame', (data) => this._onFrameCb?.(data));
    this._receiver.on('error', (err) => this._onErrorCb?.(err));

    this._msgPool = [];

    this._onVisibility = this._onVisibility.bind(this);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  onFrame(cb) { this._onFrameCb = cb; }
  onProgress(cb) { this._onProgressCb = cb; }
  onError(cb) { this._onErrorCb = cb; }

  /**
   * 发送一帧数据。
   * [FIX v3.3 - P7-001] 移除无效的 promise.catch(() => {})，调用者必须处理 rejection。
   * 
   * @param {Uint8Array} data 待发送数据（≤8192 字节）
   * @returns {Promise<void>} 成功 resolve，失败 reject。
   *         调用者必须使用 .catch() 或 try/catch 处理错误，否则可能触发 unhandled rejection。
   */
  send(data) {
    if (this._destroyed) return Promise.reject(new Error('Session destroyed'));
    if (this._sending) return Promise.reject(new Error('Transmission in progress'));
    if (document.hidden) return Promise.reject(new Error('Page hidden, cannot start transmission'));
    if (data.length === 0) return Promise.reject(new Error('Empty frame not allowed'));
    if (data.length > 8192) return Promise.reject(new Error('Frame exceeds 8KB limit'));

    this._sending = true;
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    return this._doSend(data, signal)
      .finally(() => {
        this._sending = false;
        // 仅清理仍属于自己的 controller，防止 destroy() 后覆盖新 controller
        if (this._abortController?.signal === signal) {
          this._abortController = null;
        }
      });
  }

  cancel() {
    this._abortController?.abort();
    try { this.output.clear?.(); } catch {}
  }

  destroy() {
    this._destroyed = true;
    this._sending = false;
    this._abortController?.abort();
    this._abortController = null;

    try { this.output.clear?.(); } catch {}
    this._receiver.destroy();
    document.removeEventListener('visibilitychange', this._onVisibility);

    this._msgPool.length = 0;
    this._msgPool = null;

    this._onFrameCb = null;
    this._onProgressCb = null;
    this._onErrorCb = null;
  }

  // ──────── 内部方法 ────────

  async _doSend(data, signal) {
    await this._arbitrateListen(signal);
    if (this._destroyed) throw new Error('Session destroyed');

    let retries = 0;

    try {
      while (retries <= this._maxRetries) {
        if (this._destroyed) throw new Error('Session destroyed');
        if (signal.aborted) throw new Error('Session destroyed');
        if (document.hidden) {
          throw new Error('Transmission interrupted: page entered background');
        }

        const nakTriggered = { aborted: false };
        const { promise: ackPromise, cleanup: ackCleanup } = this._waitForAckOrNak(nakTriggered);
        const delayController = new AbortController();

        try {
          const physicalEndTime = await this._sendFrame(
            data, signal, nakTriggered,
          );
          const timeoutGate = Math.max(
            this._ackTimeoutMs,
            (physicalEndTime - performance.now()) + this._ackTimeoutMs,
          );
          const result = await Promise.race([
            ackPromise,
            delayCancellable(timeoutGate, delayController.signal),
          ]);

          if (result === 'ACK') return;
          if (result === 'NAK') throw new Error('NAK received');
          if (result === 'timeout') throw new Error('Timeout waiting ACK');
        } catch (err) {
          retries++;
          if (retries > this._maxRetries) throw err;
          const backoffMs = Math.min(50 * (2 ** (retries - 1)), 200);
          const backoffResult = await delayCancellable(backoffMs, signal);
          if (backoffResult === 'cancelled') {
            throw signal.aborted ? new Error('Session destroyed') : new Error('Transmission cancelled');
          }
        } finally {
          delayController.abort();
          ackCleanup();
        }
      }
    } finally {
      // noop
    }
  }

  async _arbitrateListen(signal) {
    const receiver = this._receiver;
    if (signal.aborted) return;

    if (receiver.state === RxState.DATA) {
      await new Promise((resolve, reject) => {
        let onAbort;
        const cleanup = () => {
          receiver.off('frame', onFrame);
          receiver.off('error', onError);
          signal.removeEventListener('abort', onAbort);
        };
        const onFrame = () => { cleanup(); resolve(); };
        const onError = (err) => {
          cleanup();
          reject(new Error(`Device frame failed: ${err?.message ?? err}`));
        };
        onAbort = () => {
          cleanup();
          reject(new Error('Session destroyed during arbitration'));
        };
        receiver.once('frame', onFrame);
        receiver.once('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      let timerId;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timerId);
          cleanup();
          resolve();
        }
      };
      const onFrameAfter = () => done();
      const onErrorAfter = () => done();
      const onIdleReset = (s) => {
        if (s === RxState.IDLE) done();
      };
      const onStateChange = (newState) => {
        if (newState === RxState.DATA) {
          receiver.off('stateChange', onStateChange);
          receiver.once('frame', onFrameAfter);
          receiver.once('error', onErrorAfter);
          receiver.on('stateChange', onIdleReset);
        }
      };
      const onVisChange = () => {
        if (document.hidden) done();
      };
      const onAbort = () => {
        done();
      };
      const cleanup = () => {
        receiver.off('stateChange', onStateChange);
        receiver.off('frame', onFrameAfter);
        receiver.off('error', onErrorAfter);
        receiver.off('stateChange', onIdleReset);
        document.removeEventListener('visibilitychange', onVisChange);
        signal.removeEventListener('abort', onAbort);
      };

      receiver.on('stateChange', onStateChange);
      document.addEventListener('visibilitychange', onVisChange, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      timerId = setTimeout(done, this._listenWindowMs);
    });
  }

  async _sendFrame(data, signal, nakTriggered) {
    const now = performance.now();
    let ts = now + 10;
    const CHUNK = this._chunkSize;
    this._ensurePool(CHUNK + 2);

    this.output.send(CONTROL.START, ts);
    ts += 7.0;

    let sum = 0;

    for (let offset = 0; offset < data.length; offset += CHUNK) {
      if (signal.aborted) {
        try { this.output.clear?.(); } catch {}
        throw new Error('Transmission cancelled');
      }
      if (nakTriggered.aborted) {
        try { this.output.clear?.(); } catch {}
        throw new Error('Transmission aborted by remote NAK');
      }

      const end = Math.min(offset + CHUNK, data.length);
      for (let i = offset; i < end; i++) {
        const b = data[i];
        const msg = this._msgPool[i - offset];
        const ch = (b & 0x80) ? 15 : 14;
        msg[0] = 0xB0 | ch;
        msg[1] = 0x09;
        msg[2] = b & 0x7F;
        this.output.send(msg, ts);
        sum = (sum + b) & 0xFFFF;
        ts += this._msgInterval;
      }

      if (end < data.length) {
        const beforeYield = performance.now();
        await yieldToMain();
        const afterYield = performance.now();
        if (afterYield - beforeYield > 100) {
          ts = Math.max(ts, afterYield + 50);
        } else {
          ts = Math.max(ts, afterYield + 10);
        }
      }
    }

    ts = Math.max(ts, performance.now() + 2);
    ts += 2.0; this.output.send(CONTROL.END, ts);
    ts += 1.0; this.output.send(CONTROL.CKSUM_HEADER, ts);

    const hiByte = (sum >> 8) & 0xFF;
    const hiMsg = this._msgPool[CHUNK];
    hiMsg[0] = 0xB0 | ((hiByte & 0x80) ? 15 : 14);
    hiMsg[1] = 0x09;
    hiMsg[2] = hiByte & 0x7F;
    ts += 1.0; this.output.send(hiMsg, ts);

    const loByte = sum & 0xFF;
    const loMsg = this._msgPool[CHUNK + 1];
    loMsg[0] = 0xB0 | ((loByte & 0x80) ? 15 : 14);
    loMsg[1] = 0x09;
    loMsg[2] = loByte & 0x7F;
    ts += 1.0; this.output.send(loMsg, ts);

    return ts;
  }

  _waitForAckOrNak(nakTriggered) {
    const receiver = this._receiver;
    let onAck, onNak;

    const promise = new Promise((resolve) => {
      onAck = () => resolve('ACK');
      onNak = () => {
        if (nakTriggered) nakTriggered.aborted = true;
        resolve('NAK');
      };
      receiver.once('ack', onAck);
      receiver.once('nak', onNak);
    });

    const cleanup = () => {
      receiver.off('ack', onAck);
      receiver.off('nak', onNak);
    };

    return { promise, cleanup };
  }

  _ensurePool(size) {
    while (this._msgPool.length < size) {
      this._msgPool.push(new Uint8Array(3));
    }
  }

  _onVisibility() {
    if (document.hidden) {
      console.debug('[Jigsaw] Page hidden, ongoing transmission continues in kernel');
    }
  }
}

export { JigsawSession, CONTROL, SIGNALING, NAK_REASON, RxState };
