class OutputBatcher {
  constructor(options) {
    this.chunks = [];
    this.pendingBytes = 0;
    this.timer = null;
    this.disposed = false;
    this.flushCount = 0;
    this.totalBytes = 0;
    this.windowMs = options.windowMs ?? 16;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.onFlush = options.onFlush;
  }
  /** 追加一段输出 */
  push(chunk) {
    if (this.disposed || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= this.maxBytes) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
      this.timer.unref?.();
    }
  }
  /** 立即交付缓冲内容（定时器到点、体积超限、或主动调用） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.chunks.length === 0) return;
    const payload = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join("");
    this.chunks = [];
    this.pendingBytes = 0;
    this.flushCount += 1;
    this.totalBytes += payload.length;
    this.onFlush(payload);
  }
  /** 当前待交付字符数 */
  get pending() {
    return this.pendingBytes;
  }
  /** 是否有未交付内容 */
  get hasPending() {
    return this.pendingBytes > 0;
  }
  /** 丢弃缓冲并停止工作（会话关闭时调用） */
  dispose(options = {}) {
    if (this.disposed) return;
    if (options.flushFirst) this.flush();
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chunks = [];
    this.pendingBytes = 0;
  }
}
export {
  OutputBatcher as O
};
