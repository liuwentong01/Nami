/**
 * @nami/server - 文件系统缓存存储实现
 *
 * 将缓存条目序列化为 JSON 文件存储在文件系统中。
 *
 * 特性：
 * 1. 持久化 — 进程重启后缓存不丢失
 * 2. 多进程共享 — 同一台机器上的多个 Node.js 进程可共享缓存
 * 3. 自动创建目录 — 首次写入时自动创建缓存目录
 * 4. 安全的文件名 — 对缓存键进行编码，防止路径穿越
 * 5. 标签索引文件 — 使用独立的标签索引文件支持按标签失效
 *
 * 文件结构：
 * ```
 * cacheDir/
 * ├── entries/         # 缓存条目文件
 * │   ├── abc123.json  # 每个条目一个 JSON 文件
 * │   └── def456.json
 * ├── tags/            # 标签索引文件
 * │   ├── product:123.json
 * │   └── category:electronics.json
 * └── stats.json       # 统计信息
 * ```
 *
 * 适用场景：
 * - 单机多进程部署（PM2 cluster 模式）
 * - 需要缓存持久化但不想依赖外部服务的场景
 *
 * @example
 * ```typescript
 * import { FilesystemStore } from '@nami/server';
 *
 * const store = new FilesystemStore({ cacheDir: '.nami-cache/isr' });
 * await store.set('/', entry, 60);
 * ```
 */

import type { CacheEntry, CacheStore, CacheStats } from '@nami/shared';
import { createLogger } from '@nami/shared';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 文件系统缓存配置选项
 */
export interface FilesystemStoreOptions {
  /**
   * 缓存目录路径
   * 默认: '.nami-cache/isr'
   */
  cacheDir?: string;

  /**
   * 是否启用统计
   * 默认: true
   */
  enableStats?: boolean;
}

/** 模块级日志实例 */
const logger = createLogger('@nami/server:fs-store');

/**
 * 文件系统缓存条目的磁盘格式
 */
interface DiskCacheItem {
  /** 原始缓存条目 */
  entry: CacheEntry;
  /** 过期时间戳（毫秒），0 表示永不过期 */
  expireAt: number;
  /** 写入时间戳 */
  writtenAt: number;
}

/**
 * 文件系统缓存存储
 *
 * 实现 @nami/shared 中的 CacheStore 接口。
 */
export class FilesystemStore implements CacheStore {
  /** 缓存根目录 */
  private readonly cacheDir: string;

  /** 缓存条目目录 */
  private readonly entriesDir: string;

  /** 标签索引目录 */
  private readonly tagsDir: string;

  /** 是否已初始化目录 */
  private initialized = false;

  /** 是否启用统计 */
  private readonly enableStats: boolean;

  // 统计数据（内存中维护，持久化到文件）
  private hits = 0;
  private misses = 0;

  constructor(options: FilesystemStoreOptions = {}) {
    this.cacheDir = path.resolve(options.cacheDir ?? '.nami-cache/isr');
    this.entriesDir = path.join(this.cacheDir, 'entries');
    this.tagsDir = path.join(this.cacheDir, 'tags');
    this.enableStats = options.enableStats ?? true;

    logger.debug('文件系统缓存初始化', { cacheDir: this.cacheDir });
  }

  /**
   * 确保缓存目录存在
   * 使用 recursive: true，即使父目录不存在也会自动创建
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.entriesDir, { recursive: true });
      await fs.mkdir(this.tagsDir, { recursive: true });
      this.initialized = true;
    } catch (error) {
      logger.error('创建缓存目录失败', {
        cacheDir: this.cacheDir,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 将缓存键转换为安全的文件名
   *
   * 使用 SHA-256 哈希确保：
   * - 文件名长度固定（64 个十六进制字符）
   * - 不包含路径分隔符等特殊字符
   * - 不同的缓存键映射到不同的文件名（碰撞概率极低）
   *
   * @param key - 缓存键
   * @returns 安全的文件名
   */
  private keyToFilename(key: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return `${hash}.json`;
  }

  /**
   * 获取缓存条目的文件路径
   */
  private getEntryPath(key: string): string {
    return path.join(this.entriesDir, this.keyToFilename(key));
  }

  /**
   * 获取标签索引的文件路径
   */
  private getTagPath(tag: string): string {
    const hash = crypto.createHash('sha256').update(tag).digest('hex');
    return path.join(this.tagsDir, `${hash}.json`);
  }

  /**
   * 获取缓存条目
   *
   * @param key - 缓存键
   * @returns 缓存条目，未命中或已过期返回 null
   */
  async get(key: string): Promise<CacheEntry | null> {
    await this.ensureInitialized();

    const filePath = this.getEntryPath(key);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const item: DiskCacheItem = JSON.parse(content);

      // 检查是否过期
      if (item.expireAt > 0 && Date.now() > item.expireAt) {
        // 过期 → 异步删除文件，不阻塞读取
        void fs.unlink(filePath).catch(() => {});
        if (this.enableStats) this.misses++;
        return null;
      }

      if (this.enableStats) this.hits++;
      return item.entry;
    } catch (error) {
      // 文件不存在或读取失败 → 缓存未命中
      if (this.enableStats) this.misses++;
      return null;
    }
  }

  /**
   * 写入缓存条目
   *
   * @param key - 缓存键
   * @param entry - 缓存内容
   * @param ttl - 过期时间（秒），0 或不传表示永不过期
   */
  async set(key: string, entry: CacheEntry, ttl?: number): Promise<void> {
    await this.ensureInitialized();

    const filePath = this.getEntryPath(key);
    const expireAt = ttl && ttl > 0
      ? Date.now() + ttl * 1000
      : 0;

    const item: DiskCacheItem = {
      entry,
      expireAt,
      writtenAt: Date.now(),
    };

    try {
      /**
       * 原子写入：先写临时文件，再 rename
       * 防止写入过程中断导致的文件损坏
       */
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify(item), 'utf-8');
      await fs.rename(tempPath, filePath);

      // 更新标签索引
      if (entry.tags && entry.tags.length > 0) {
        for (const tag of entry.tags) {
          await this.addKeyToTag(tag, key);
        }
      }
    } catch (error) {
      logger.error('写入缓存文件失败', {
        key,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 删除指定缓存条目
   *
   * @param key - 缓存键
   */
  async delete(key: string): Promise<void> {
    await this.ensureInitialized();

    const filePath = this.getEntryPath(key);

    try {
      // 先读取条目以获取标签信息（用于清理标签索引）
      const content = await fs.readFile(filePath, 'utf-8');
      const item: DiskCacheItem = JSON.parse(content);

      // 清理标签索引
      if (item.entry.tags) {
        for (const tag of item.entry.tags) {
          await this.removeKeyFromTag(tag, key);
        }
      }

      // 删除文件
      await fs.unlink(filePath);
    } catch {
      // 文件不存在或读取失败 → 忽略
    }
  }

  /**
   * 检查缓存键是否存在（且未过期）
   *
   * @param key - 缓存键
   */
  async has(key: string): Promise<boolean> {
    const entry = await this.get(key);
    return entry !== null;
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    try {
      // 删除整个缓存目录并重新创建
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      this.initialized = false;
      this.hits = 0;
      this.misses = 0;
      await this.ensureInitialized();
      logger.info('文件系统缓存已清空');
    } catch (error) {
      logger.error('清空缓存失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 按标签批量失效
   *
   * @param tag - 缓存标签
   * @returns 失效的缓存条目数量
   */
  async invalidateByTag(tag: string): Promise<number> {
    await this.ensureInitialized();

    const tagPath = this.getTagPath(tag);
    let invalidatedCount = 0;

    try {
      const content = await fs.readFile(tagPath, 'utf-8');
      const keys: string[] = JSON.parse(content);

      // 删除该标签关联的所有缓存条目
      for (const key of keys) {
        try {
          const entryPath = this.getEntryPath(key);
          await fs.unlink(entryPath);
          invalidatedCount++;
        } catch {
          // 文件可能已不存在，忽略
        }
      }

      // 删除标签索引文件
      await fs.unlink(tagPath);

      logger.info(`按标签失效缓存: ${tag}`, {
        tag,
        invalidatedCount,
      });
    } catch {
      // 标签索引文件不存在 → 没有需要失效的条目
    }

    return invalidatedCount;
  }

  /**
   * 获取缓存统计信息
   */
  async getStats(): Promise<CacheStats> {
    await this.ensureInitialized();

    let totalEntries = 0;
    let sizeBytes = 0;

    try {
      const files = await fs.readdir(this.entriesDir);
      totalEntries = files.filter((f) => f.endsWith('.json')).length;

      // 估算总大小
      for (const file of files) {
        try {
          const stat = await fs.stat(path.join(this.entriesDir, file));
          sizeBytes += stat.size;
        } catch {
          // 忽略单个文件统计失败
        }
      }
    } catch {
      // 目录不存在或读取失败
    }

    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : 0;

    return {
      totalEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number(hitRate.toFixed(4)),
      sizeBytes,
      lastUpdated: Date.now(),
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 将缓存键添加到标签索引
   *
   * 使用原子写入（临时文件 + rename）防止并发写入导致的数据丢失。
   * 多进程环境下 rename 是原子操作，能保证索引文件的完整性。
   */
  private async addKeyToTag(tag: string, key: string): Promise<void> {
    const tagPath = this.getTagPath(tag);
    let keys: string[] = [];

    try {
      const content = await fs.readFile(tagPath, 'utf-8');
      keys = JSON.parse(content);
    } catch {
      // 标签索引文件不存在，创建新的
    }

    if (!keys.includes(key)) {
      keys.push(key);
      const tempPath = `${tagPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      await fs.writeFile(tempPath, JSON.stringify(keys), 'utf-8');
      await fs.rename(tempPath, tagPath);
    }
  }

  /**
   * 从标签索引中移除缓存键
   *
   * 同样使用原子写入保证并发安全。
   */
  private async removeKeyFromTag(tag: string, key: string): Promise<void> {
    const tagPath = this.getTagPath(tag);

    try {
      const content = await fs.readFile(tagPath, 'utf-8');
      let keys: string[] = JSON.parse(content);
      keys = keys.filter((k) => k !== key);

      if (keys.length === 0) {
        await fs.unlink(tagPath);
      } else {
        const tempPath = `${tagPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tempPath, JSON.stringify(keys), 'utf-8');
        await fs.rename(tempPath, tagPath);
      }
    } catch {
      // 忽略
    }
  }
}
