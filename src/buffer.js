/**
 * 环形缓冲（S3 · 规格 §五）。拉取模式的性能地基。
 *
 * 采集回调只做两件事：打分 + 帧进这里。sheet 组装/PNG 编码延迟到 peek 按需做。
 * 消除 ffmpeg 编码背压，peek 延迟从 15-30s 降到 2-10s。
 *
 * 按字节数管理（R3）：上限 48MB 封顶（非固定帧数）——low 档 1.08MB/帧存 44 帧，
 * ultra 档 4.3MB/帧存 11 帧。静止屏 3 帧 low 只占 3.2MB，不是 48MB。
 *
 * 帧存元数据（R4）：{buf, hsv, score, via, t, level, tier}——hsv 留给 peek 组 sheet 时
 * 去重（沿用 pipeline.js dupMin 判据，不因拉取模式挪位置而丢失去重语义）。
 *
 * v1 纯内存不落盘（F4）。磁盘模式 v2 再做。
 */

const DEFAULT_MAX_BYTES = 48 * 1024 * 1024; // 48MB

export function createBuffer({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  /** @type {{buf:Buffer, hsv:Float32Array|null, score:number|null, via:string, t:number, level:number, tier:number}[]} */
  let frames = [];
  let bytes = 0;

  return {
    /**
     * 进一帧。超上限从最老端弹出（环形语义：宁可丢老画面，不给模型看十几秒前的事）。
     * @param {{buf:Buffer, hsv:Float32Array|null, score:number|null, via:string, t:number, level:number, tier:number}} frame
     */
    push(frame) {
      frames.push(frame);
      bytes += frame.buf.length;
      while (bytes > maxBytes && frames.length > 1) {
        bytes -= frames[0].buf.length;
        frames.shift();
      }
    },

    /**
     * 从缓冲尾部向前取帧（R2 三条件先到先截）：
     *   ① 帧数达 maxFrames（默认 4，对应该 quality 档 maxFrames）
     *   ② 时间跨度超 maxWaitSec（默认 15s）
     *   ③ 缓冲取空
     *
     * 静止屏 peek 拿到「最近 10 分钟仅有的 2 帧」如实反映无变化；
     * 活动屏拿到最近 15s 的 4 帧。
     *
     * **不消费帧**——peek 是只读语义，帧靠环形缓冲自然挤出。
     *
     * @returns {Array} 时间正序的帧数组（最老在前）
     */
    peek(maxFrames = 4, maxWaitSec = 15) {
      if (!frames.length) return [];
      const result = [];
      const latest = frames[frames.length - 1].t;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (result.length >= maxFrames) break;
        if (latest - frames[i].t > maxWaitSec) break;
        result.unshift(frames[i]);
      }
      return result;
    },

    /** 时间戳晚于 ts 的帧数（主动看改造：status.bufferedNew 用，模型回合里查"有没有新画面"）。 */
    countSince(ts) {
      let n = 0;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].t > ts) n += 1; else break;   // 尾部时间单调，从尾往头数到第一个不新的就停
      }
      return n;
    },

    /** 清空（off 档语义：采集停 + 缓冲清 + peek 返 102）。 */
    clear() {
      frames = [];
      bytes = 0;
    },

    get count() { return frames.length; },
    get bytes() { return bytes; },
    get maxBytes() { return maxBytes; },
    /** 弹窗成本口径（R12）：当前档约 X MB/满 */
    get mbUsed() { return +(bytes / 1048576).toFixed(1); },
    get mbMax() { return +(maxBytes / 1048576).toFixed(0); },
  };
}
