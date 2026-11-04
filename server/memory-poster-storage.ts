import type { PosterBinary, PosterStorage } from './poster-storage.js';
import { inspectPosterBinary } from './posters.js';

/** Development previews keep images in volatile memory; no image is written to disk. */
export class MemoryPosterStorage implements PosterStorage {
  private readonly images = new Map<string, PosterBinary>();

  async get(path: string): Promise<PosterBinary | null> {
    const image = this.images.get(path);
    return image ? { ...image, data: Buffer.from(image.data) } : null;
  }

  async put(value: PosterBinary): Promise<void> {
    if (!inspectPosterBinary(value)) throw new Error('海报内容或元数据无效');
    const existing = this.images.get(value.path);
    if (existing && (existing.sha256 !== value.sha256 || existing.mime !== value.mime || !existing.data.equals(value.data))) {
      throw new Error('海报路径已有不同内容，拒绝覆盖不可变海报');
    }
    if (!existing) this.images.set(value.path, { ...value, data: Buffer.from(value.data) });
  }
}
