/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Database } from '@nocobase/database';
import { Application } from '@nocobase/server';
import PluginFileManagerServer from '@nocobase/plugin-file-manager';

export interface AttachmentAnalysisItem {
  id: number | string;
  title: string;
  filename: string;
  extname: string;
  size: number;
  mimetype: string;
  url: string;
  storageId: number;
  /** 存储空间名称（title 优先，回退英文标识 name） */
  storageName?: string;
  /** 存储类型标识，如 local / ali-oss / s3 */
  storageType?: string;
  createdAt: Date;
  updatedAt: Date;
  isUnused?: boolean;
  isDuplicate?: boolean;
  duplicateGroupId?: string;
  duplicateCount?: number;
  isRecycled?: boolean;
  recycledAt?: Date;
  /** 底层物理文件在磁盘中是否缺失/丢失（无效孤立记录） */
  isMissingFile?: boolean;
}

export interface AttachmentReference {
  /** 引用该附件的业务集合名 */
  collection: string;
  /** 引用该附件的业务记录主键 */
  recordId: string | number;
  /** 业务集合中的附件字段名 */
  field: string;
  /** 该字段的原始值（对象 / 对象数组 / 裸 id），供去重时改写 */
  value: any;
}

export interface FileFingerprintCacheEntry {
  size: number;
  updatedAt?: string;
  path?: string;
  fileHash: string;
  isMissingFile: boolean;
  cachedAt: number;
}

export type FingerprintCacheMap = Map<string | number, FileFingerprintCacheEntry>;

export interface ScanCheckpointData {
  taskId: string;
  phase: 'init' | 'relations' | 'texts' | 'duplicates' | 'summary';
  phaseText: string;
  percent: number;
  relationsIndex: number;
  textsIndex: number;
  duplicatesIndex: number;
  usedIdList: (string | number)[];
  updatedAt: number;
}

export type ScanProgressCallback = (info: {
  phase: 'init' | 'relations' | 'texts' | 'duplicates' | 'summary';
  phaseText: string;
  percent: number;
  currentStep?: number;
  totalSteps?: number;
}) => void;

export interface AnalyzeOptions {
  checkpoint?: ScanCheckpointData | null;
  cacheMap?: FingerprintCacheMap;
  shouldPause?: () => boolean;
  onSaveCheckpoint?: (checkpoint: ScanCheckpointData) => Promise<void> | void;
  onUpdateCache?: (attachmentId: string | number, entry: FileFingerprintCacheEntry) => void;
  onProgress?: ScanProgressCallback;
}

export class ScanPausedError extends Error {
  constructor(message = 'Scan paused by user or system') {
    super(message);
    this.name = 'ScanPausedError';
  }
}

/** 主动让出 Node.js 主线程事件循环，防止长时间任务造成服务假死 */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 仅排除清理插件自身和系统底层迁移表（系统Logo、设置、UI Schemas、用户头像等均需正常扫描） */
const SYSTEM_EXCLUDE_COLLECTIONS = new Set([
  'attachments',
  'attachmentRecycleBin',
  'attachmentCleanerSettings',
  'attachmentCleanerAuditLogs',
  'migrations',
]);

const BATCH_SIZE = 300;

/** 内容哈希统一前缀：只有携带该前缀的指纹才可参与去重判定（防止历史元数据指纹混入） */
export const CONTENT_HASH_PREFIX = 'sha256:';

/**
 * 富文本 / 长文本中提取附件引用的正则（全局标志，使用前需重置 lastIndex）。
 * 第三分支使用 Unicode 友好的字符集（含中文文件名），并排除 URL 分隔符避免跨段误匹配。
 */
export const ATTACHMENT_REF_REGEX =
  /(?:src|href)\s*=\s*["']([^"']+)["']|(?:\/api\/(?:attachments|files)\/([^\s"'<>]+))|([^\s"'<>(){}[\],;\\?#=]+\.[a-zA-Z0-9]+)/gi;

/** 安全 decodeURIComponent（最多两层，容错非法编码序列） */
export function safeDecodeVariants(value: string): string[] {
  const out = [value];
  let cur = value;
  for (let i = 0; i < 2; i++) {
    try {
      const dec = decodeURIComponent(cur);
      if (dec === cur) break;
      out.push(dec);
      cur = dec;
    } catch {
      break;
    }
  }
  return out;
}

/** 全文件 sha256 内容指纹。读取异常时返回空串（调用方应跳过该文件，不得参与去重） */
export async function hashStreamToContentHash(stream: any): Promise<string> {
  return new Promise<string>((resolve) => {
    const hash = crypto.createHash('sha256');
    let done = false;
    const finish = (val: string) => {
      if (done) return;
      done = true;
      try {
        if (typeof stream.destroy === 'function') stream.destroy();
      } catch {
        // ignore
      }
      resolve(val);
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      hash.update(chunk);
    });
    stream.on('end', () => finish(CONTENT_HASH_PREFIX + hash.digest('hex')));
    stream.on('error', () => finish(''));
    // 未正常 end 就关闭（外部中断）视为无法计算，宁可漏判不可误判
    stream.on('close', () => finish(''));
  });
}

export interface AttachmentFileStream {
  stream: any;
  contentType?: string;
}

export type FileStreamProvider = (att: any) => Promise<AttachmentFileStream | null> | AttachmentFileStream | null;

export class AttachmentAnalyzer {
  private fileStreamProvider?: FileStreamProvider;

  constructor(private app: Application) {}

  private get db(): Database {
    return this.app.db;
  }

  /**
   * 注入文件流读取器（测试或自定义存储接入用）。未注入时使用 file-manager 插件的 getFileStream。
   */
  setFileStreamProvider(provider?: FileStreamProvider) {
    this.fileStreamProvider = provider;
  }

  /** 解析附件的物理文件流；无法获取时返回 null（不参与内容指纹计算） */
  private async resolveFileStream(att: any): Promise<AttachmentFileStream | null> {
    if (this.fileStreamProvider) {
      try {
        return await this.fileStreamProvider(att);
      } catch {
        return null;
      }
    }
    let fileManagerPlugin: any = null;
    try {
      fileManagerPlugin =
        this.app.pm.get('file-manager') ||
        this.app.pm.get('@nocobase/plugin-file-manager') ||
        (this.app.pm.get(PluginFileManagerServer as any) as any);
    } catch {
      return null;
    }
    if (!fileManagerPlugin || typeof fileManagerPlugin.getFileStream !== 'function') {
      return null;
    }
    try {
      return await fileManagerPlugin.getFileStream(att);
    } catch (e) {
      this.app.logger?.warn?.(
        `[attachment-cleaner] 读取文件流失败，该文件不参与重复内容比对: ${att?.get?.('filename') || att?.filename || '未知'}`,
      );
      return null;
    }
  }

  /**
   * 构建附件快速检索索引 (O(1) 内存查询)。
   * filename/url/urlTail 均为多值映射：同名或同 URL 尾段的附件全部标记为可能被引用（宁保守勿误删）。
   */
  private buildAttachmentIndex(allAttachments: any[]) {
    const idSet = new Set<string | number>();
    const filenameMap = new Map<string, Set<string | number>>();
    const urlMap = new Map<string, Set<string | number>>();
    const urlTailMap = new Map<string, Set<string | number>>();

    const addKey = (map: Map<string, Set<string | number>>, rawKey: any, id: string | number) => {
      if (rawKey === undefined || rawKey === null) return;
      const key = String(rawKey).trim();
      if (!key) return;
      let set = map.get(key);
      if (!set) {
        set = new Set<string | number>();
        map.set(key, set);
      }
      set.add(id);
    };

    for (const att of allAttachments) {
      const id = att.get ? att.get('id') : att.id;
      const filename = att.get ? att.get('filename') : att.filename;
      const url = att.get ? att.get('url') : att.url;

      if (id !== undefined && id !== null) {
        idSet.add(id);
        idSet.add(String(id));
      }
      addKey(filenameMap, filename, id);
      if (url) {
        const urlStr = String(url).trim();
        addKey(urlMap, urlStr, id);
        for (const dec of safeDecodeVariants(urlStr)) {
          addKey(urlMap, dec, id);
        }
        // URL 尾段（去查询参数后最后一段路径）用于富文本中域名/路径不同但文件名一致的引用
        const tail = urlStr.split(/[?#]/)[0].split('/').filter(Boolean).pop();
        if (tail) {
          addKey(urlTailMap, tail, id);
          for (const dec of safeDecodeVariants(tail)) {
            addKey(urlTailMap, dec, id);
          }
        }
      }
    }

    return { idSet, filenameMap, urlMap, urlTailMap };
  }

  /** 将一段文本片段按 原文 / 解码 / 去查询参数 / 尾段 四种变体与附件索引比对，命中即标记为已引用 */
  private markUsedCandidates(
    candidate: string,
    index: ReturnType<AttachmentAnalyzer['buildAttachmentIndex']>,
    usedIds: Set<string | number>,
  ) {
    if (!candidate) return;
    const variants = new Set<string>();
    for (const dec of safeDecodeVariants(String(candidate).trim())) {
      variants.add(dec);
      const noQuery = dec.split(/[?#]/)[0];
      if (noQuery) {
        variants.add(noQuery);
        const seg = noQuery.split('/').filter(Boolean).pop();
        if (seg) variants.add(seg);
      }
    }
    for (const v of variants) {
      index.filenameMap.get(v)?.forEach((id) => usedIds.add(id));
      index.urlMap.get(v)?.forEach((id) => usedIds.add(id));
      index.urlTailMap.get(v)?.forEach((id) => usedIds.add(id));
    }
  }

  /**
   * 异步非阻塞检测物理磁盘文件是否存在（按需探测 + 按存储根缓存的内存缓存）。
   * 缓存键包含存储根目录：不同 root 下的同名文件互不混淆，避免跨存储误判为存在。
   */
  private async checkPhysicalFileExists(
    filename: string,
    recPath: string,
    docRoots: string[],
    diskCache: Map<string, boolean>,
  ): Promise<boolean> {
    if (!filename) return false;
    const normalizedRec = (recPath || '').replace(/\\/g, '/').replace(/^\//, '');
    const relKey = normalizedRec ? `${normalizedRec}/${filename}` : filename;

    for (const root of docRoots) {
      const absRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
      const cacheKey = `${absRoot}|${relKey}`;
      if (diskCache.has(cacheKey)) {
        return diskCache.get(cacheKey)!;
      }

      let exists = false;
      try {
        await fs.promises.access(path.join(absRoot, relKey));
        exists = true;
      } catch {
        try {
          await fs.promises.access(path.join(absRoot, filename));
          exists = true;
        } catch {
          // 继续检查下一个 root
        }
      }
      diskCache.set(cacheKey, exists);
      if (exists) return true;
    }

    return false;
  }

  /**
   * 扫描系统级设置、Logo、UI Schemas 与用户头像等系统全局引用（流式分批 + 事件循环让渡）
   */
  async scanSystemSettingsAndUiSchemas(
    allAttachments: any[],
    usedIds: Set<string | number>,
  ): Promise<void> {
    if (!allAttachments || allAttachments.length === 0) return;
    const index = this.buildAttachmentIndex(allAttachments);
    const { idSet, filenameMap, urlMap } = index;

    const extractFromValue = (val: any) => {
      if (val === null || val === undefined) return;
      if (typeof val === 'number' || typeof val === 'string') {
        if (idSet.has(val)) usedIds.add(val);
        filenameMap.get(String(val).trim())?.forEach((id) => usedIds.add(id));
        urlMap.get(String(val).trim())?.forEach((id) => usedIds.add(id));

        if (typeof val === 'string' && (val.includes('/') || val.includes('.'))) {
          ATTACHMENT_REF_REGEX.lastIndex = 0;
          let match;
          while ((match = ATTACHMENT_REF_REGEX.exec(val)) !== null) {
            for (let i = 1; i <= 3; i++) {
              if (match[i]) {
                this.markUsedCandidates(match[i], index, usedIds);
              }
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (const item of val) extractFromValue(item);
      } else if (typeof val === 'object') {
        if (val.id !== undefined && idSet.has(val.id)) {
          usedIds.add(val.id);
        }
        if (val.filename && filenameMap.has(String(val.filename).trim())) {
          filenameMap.get(String(val.filename).trim())?.forEach((id) => usedIds.add(id));
        }
        if (val.url && urlMap.has(String(val.url).trim())) {
          urlMap.get(String(val.url).trim())?.forEach((id) => usedIds.add(id));
        }
        for (const k of Object.keys(val)) {
          extractFromValue(val[k]);
        }
      }
    };

    // 1. 扫描 systemSettings (系统 Logo、网站图标、品牌等)
    try {
      const systemSettingsRepo = this.db.getRepository('systemSettings');
      if (systemSettingsRepo) {
        const records = await systemSettingsRepo.find();
        for (const record of records) {
          extractFromValue(record.toJSON ? record.toJSON() : record);
        }
      }
    } catch (e) {}

    await yieldToEventLoop();

    // 2. 扫描 uiSchemas (分批拉取，防止一次性拉取上万条 schema 爆内存)
    try {
      const uiSchemasRepo = this.db.getRepository('uiSchemas');
      if (uiSchemasRepo) {
        let page = 0;
        while (true) {
          const records = await uiSchemasRepo.find({
            fields: ['schema'],
            limit: BATCH_SIZE,
            offset: page * BATCH_SIZE,
          });

          if (!records || records.length === 0) break;

          for (const record of records) {
            extractFromValue(record.get('schema'));
          }

          if (records.length < BATCH_SIZE) break;
          page++;
          await yieldToEventLoop();
        }
      }
    } catch (e) {}

    await yieldToEventLoop();

    // 3. 扫描 users (用户头像等，分批查询)
    try {
      const usersRepo = this.db.getRepository('users');
      if (usersRepo) {
        let page = 0;
        while (true) {
          const records = await usersRepo.find({
            limit: BATCH_SIZE,
            offset: page * BATCH_SIZE,
          });
          if (!records || records.length === 0) break;

          for (const record of records) {
            extractFromValue(record.toJSON ? record.toJSON() : record);
          }

          if (records.length < BATCH_SIZE) break;
          page++;
          await yieldToEventLoop();
        }
      }
    } catch (e) {}
  }

  /**
   * 扫描所有集合中通过关联字段引用的附件 ID（分批查询 + 字段投影瘦身 + 事件循环让渡）
   */
  async findUsedAttachmentIds(
    allAttachments?: any[],
    options?: {
      startIndex?: number;
      initialUsedIds?: Set<string | number>;
      shouldPause?: () => boolean;
      onCheckpoint?: (index: number, usedIds: Set<string | number>, total: number) => Promise<void> | void;
      onProgress?: (info: { step: number; total: number; collectionName: string }) => void;
    },
  ): Promise<Set<string | number>> {
    const usedIds = options?.initialUsedIds || new Set<string | number>();
    const collections = Array.from(this.db.collections.values()).filter(
      (c) => !SYSTEM_EXCLUDE_COLLECTIONS.has(c.name),
    );

    const totalCollections = collections.length || 1;
    const startIndex = options?.startIndex ?? 0;

    for (let i = startIndex; i < collections.length; i++) {
      if (options?.shouldPause && options.shouldPause()) {
        if (options.onCheckpoint) {
          await options.onCheckpoint(i, usedIds, totalCollections);
        }
        throw new ScanPausedError();
      }

      const collection = collections[i];
      if (options?.onProgress) {
        options.onProgress({ step: i + 1, total: totalCollections, collectionName: collection.name });
      }

      const fields = Array.from(collection.fields.values());
      const attachmentFields = fields.filter(
        (f) =>
          f.options?.target === 'attachments' ||
          f.options?.interface === 'attachment' ||
          f.name.toLowerCase().includes('logo') ||
          f.name.toLowerCase().includes('avatar'),
      );

      if (attachmentFields.length > 0) {
        try {
          const repo = this.db.getRepository(collection.name);
          if (repo) {
            let page = 0;
            while (true) {
              const records = await repo.find({
                fields: ['id', ...attachmentFields.map((f) => f.name)],
                appends: attachmentFields.map((f) => f.name),
                limit: BATCH_SIZE,
                offset: page * BATCH_SIZE,
              });

              if (!records || records.length === 0) break;

              for (const record of records) {
                for (const field of attachmentFields) {
                  const val = record.get(field.name);
                  if (!val) continue;

                  if (Array.isArray(val)) {
                    for (const item of val) {
                      if (typeof item === 'object' && item?.id) {
                        usedIds.add(item.id);
                      } else if (typeof item === 'number' || typeof item === 'string') {
                        usedIds.add(item);
                      }
                    }
                  } else if (typeof val === 'object' && val?.id) {
                    usedIds.add(val.id);
                  } else if (typeof val === 'number' || typeof val === 'string') {
                    usedIds.add(val);
                  }
                }
              }

              if (records.length < BATCH_SIZE) break;
              page++;
              await yieldToEventLoop();
            }
          }
        } catch (e) {}
      }

      await yieldToEventLoop();

      if (options?.onCheckpoint && (i % 5 === 0 || i === collections.length - 1)) {
        await options.onCheckpoint(i + 1, usedIds, totalCollections);
      }
    }

    return usedIds;
  }

  /**
   * 扫描富文本 / 长文本字段中可能嵌入的附件（分批查询 + 字段投影 + 事件循环让渡）
   */
  async scanTextReferences(
    allAttachments: any[],
    usedIds: Set<string | number>,
    options?: {
      startIndex?: number;
      shouldPause?: () => boolean;
      onCheckpoint?: (index: number, usedIds: Set<string | number>, total: number) => Promise<void> | void;
      onProgress?: (info: { step: number; total: number; collectionName: string }) => void;
    },
  ): Promise<void> {
    if (!allAttachments || allAttachments.length === 0) return;

    const index = this.buildAttachmentIndex(allAttachments);
    const collections = Array.from(this.db.collections.values()).filter(
      (c) => !SYSTEM_EXCLUDE_COLLECTIONS.has(c.name),
    );

    const totalCollections = collections.length || 1;
    const startIndex = options?.startIndex ?? 0;

    for (let i = startIndex; i < collections.length; i++) {
      if (options?.shouldPause && options.shouldPause()) {
        if (options.onCheckpoint) {
          await options.onCheckpoint(i, usedIds, totalCollections);
        }
        throw new ScanPausedError();
      }

      const collection = collections[i];
      if (options?.onProgress) {
        options.onProgress({ step: i + 1, total: totalCollections, collectionName: collection.name });
      }

      const fields = Array.from(collection.fields.values());
      const textFields = fields.filter((f) => {
        const type = f.options?.type || f.type;
        const uiInterface = f.options?.interface;
        return (
          type === 'text' ||
          type === 'longText' ||
          type === 'json' ||
          uiInterface === 'richText' ||
          uiInterface === 'markdown' ||
          uiInterface === 'textarea'
        );
      });

      if (textFields.length === 0) continue;

      try {
        const repo = this.db.getRepository(collection.name);
        if (!repo) continue;

        const orConditions: any[] = [];
        for (const f of textFields) {
          orConditions.push({ [f.name]: { $like: '%/api/attachments/%' } });
          orConditions.push({ [f.name]: { $like: '%.%' } });
        }

        let page = 0;
        while (true) {
          let records: any[] = [];
          try {
            records = await repo.find({
              fields: ['id', ...textFields.map((f) => f.name)],
              filter: {
                $or: orConditions,
              },
              limit: BATCH_SIZE,
              offset: page * BATCH_SIZE,
            });
          } catch (filterErr) {
            records = await repo.find({
              fields: ['id', ...textFields.map((f) => f.name)],
              limit: BATCH_SIZE,
              offset: page * BATCH_SIZE,
            });
          }

          if (!records || records.length === 0) break;

          for (const record of records) {
            for (const field of textFields) {
              let val = record.get(field.name);
              if (!val) continue;

              if (typeof val === 'object') {
                val = JSON.stringify(val);
              }
              if (typeof val !== 'string') continue;

              if (!val.includes('/') && !val.includes('.')) continue;

              ATTACHMENT_REF_REGEX.lastIndex = 0;
              for (const match of val.matchAll(ATTACHMENT_REF_REGEX)) {
                for (let i = 1; i <= 3; i++) {
                  if (match[i]) {
                    this.markUsedCandidates(match[i], index, usedIds);
                  }
                }
              }
            }
          }

          if (records.length < BATCH_SIZE) break;
          page++;
          await yieldToEventLoop();
        }
      } catch (e) {}

      await yieldToEventLoop();

      if (options?.onCheckpoint && (i % 5 === 0 || i === collections.length - 1)) {
        await options.onCheckpoint(i + 1, usedIds, totalCollections);
      }
    }
  }

  /**
   * 查找重复附件组（size+extname 预过滤 + 全文件 sha256 内容指纹 + 复合缓存 + 事件循环调度）。
   * 只有能读取到文件内容并计算出指纹的附件才会参与分组；指纹无法计算的文件一律跳过，宁可漏报不可误判。
   */
  async findDuplicateGroups(
    attachments: any[],
    options?: {
      startIndex?: number;
      cacheMap?: FingerprintCacheMap;
      shouldPause?: () => boolean;
      onUpdateCache?: (attachmentId: string | number, entry: FileFingerprintCacheEntry) => void;
      onCheckpoint?: (index: number, total: number) => Promise<void> | void;
      onProgress?: (info: { step: number; total: number }) => void;
    },
  ): Promise<Map<string, any[]>> {
    // 1. 一级过滤：按 size + extname 聚类
    const candidateGroups = new Map<string, any[]>();

    for (const att of attachments) {
      const size = Number(att.get ? att.get('size') : att.size) || 0;
      const ext = String(att.get ? att.get('extname') : att.extname || '').toLowerCase();
      if (!size) continue;

      const key = `${size}_${ext}`;
      let list = candidateGroups.get(key);
      if (!list) {
        list = [];
        candidateGroups.set(key, list);
      }
      list.push(att);
    }

    const duplicateGroups = new Map<string, any[]>();

    const candidateEntries = Array.from(candidateGroups.entries()).filter(([, candidates]) => candidates.length >= 2);
    const totalCandidates = candidateEntries.length || 1;
    const startIndex = options?.startIndex ?? 0;

    for (let idx = startIndex; idx < candidateEntries.length; idx++) {
      if (options?.shouldPause && options.shouldPause()) {
        if (options.onCheckpoint) {
          await options.onCheckpoint(idx, totalCandidates);
        }
        throw new ScanPausedError();
      }

      const [, candidates] = candidateEntries[idx];
      if (options?.onProgress) {
        options.onProgress({ step: idx + 1, total: totalCandidates });
      }

      const hashSubGroups = new Map<string, any[]>();

      for (const att of candidates) {
        const attId = att.get ? att.get('id') : att.id;
        const attSize = Number(att.get ? att.get('size') : att.size) || 0;
        const attUpdated = String(att.get ? att.get('updatedAt') : att.updatedAt || '');
        const attPath = String(att.get ? att.get('path') : att.path || '');

        let fileHash = '';

        // 1. 命中全量复合智能缓存（id + size + updatedAt 匹配且为内容指纹格式时直接命中，0ms 跳过）
        const cached = options?.cacheMap?.get(attId);
        if (
          cached &&
          cached.size === attSize &&
          String(cached.updatedAt || '') === attUpdated &&
          typeof cached.fileHash === 'string' &&
          cached.fileHash.startsWith(CONTENT_HASH_PREFIX)
        ) {
          fileHash = cached.fileHash;
        } else {
          // 2. 缓存未命中：计算全文件 sha256 内容指纹。
          //    去重结果会驱动回收/删除操作，指纹必须基于文件内容；
          //    无法读取文件流（无 file-manager、读取失败）时保持空串，该文件不参与分组，
          //    绝不允许退化为 size+filename 之类的元数据指纹，否则会把不同内容的文件误判为重复。
          try {
            const source = await this.resolveFileStream(att);
            if (source?.stream) {
              fileHash = await hashStreamToContentHash(source.stream);
            }
          } catch (e) {
            fileHash = '';
          }

          // 回写缓存（仅记录真实内容指纹）
          if (fileHash && options?.onUpdateCache) {
            options.onUpdateCache(attId, {
              size: attSize,
              updatedAt: attUpdated,
              path: attPath,
              fileHash,
              isMissingFile: false,
              cachedAt: Date.now(),
            });
          }
        }

        if (fileHash) {
          let subList = hashSubGroups.get(fileHash);
          if (!subList) {
            subList = [];
            hashSubGroups.set(fileHash, subList);
          }
          subList.push(att);
        }

        await yieldToEventLoop();
      }

      for (const [hash, items] of hashSubGroups.entries()) {
        if (items.length >= 2) {
          duplicateGroups.set(hash, items);
        }
      }

      if (options?.onCheckpoint && (idx % 10 === 0 || idx === candidateEntries.length - 1)) {
        await options.onCheckpoint(idx + 1, totalCandidates);
      }
    }

    return duplicateGroups;
  }

  /**
   * 扫描所有业务集合中的附件字段，构建「附件 id -> 引用条目」映射（分批流式查询）。
   */
  async findAttachmentReferences(): Promise<Map<string | number, AttachmentReference[]>> {
    const refMap = new Map<string | number, AttachmentReference[]>();
    const collections = Array.from(this.db.collections.values()).filter((c) => !SYSTEM_EXCLUDE_COLLECTIONS.has(c.name));

    const addRef = (attachmentId: string | number, ref: AttachmentReference) => {
      if (attachmentId === undefined || attachmentId === null) return;
      let list = refMap.get(attachmentId);
      if (!list) {
        list = [];
        refMap.set(attachmentId, list);
      }
      list.push(ref);
    };

    for (const collection of collections) {
      const fields = Array.from(collection.fields.values()).filter(
        (f) =>
          f.options?.target === 'attachments' ||
          f.options?.interface === 'attachment' ||
          f.name.toLowerCase().includes('logo') ||
          f.name.toLowerCase().includes('avatar'),
      );
      if (fields.length === 0) continue;

      try {
        const repo = this.db.getRepository(collection.name);
        if (!repo) continue;

        let page = 0;
        while (true) {
          const records = await repo.find({
            fields: ['id', ...fields.map((f) => f.name)],
            appends: fields.map((f) => f.name),
            limit: BATCH_SIZE,
            offset: page * BATCH_SIZE,
          });

          if (!records || records.length === 0) break;

          for (const record of records) {
            const recordId = record.get('id');
            for (const field of fields) {
              const val = record.get(field.name);
              if (!val) continue;

              const ref: AttachmentReference = {
                collection: collection.name,
                recordId,
                field: field.name,
                value: val,
              };

              if (Array.isArray(val)) {
                for (const item of val) {
                  if (typeof item === 'object' && item?.id) {
                    addRef(item.id, ref);
                  } else if (typeof item === 'number' || typeof item === 'string') {
                    addRef(item, ref);
                  }
                }
              } else if (typeof val === 'object' && val?.id) {
                addRef(val.id, ref);
              } else if (typeof val === 'number' || typeof val === 'string') {
                addRef(val, ref);
              }
            }
          }

          if (records.length < BATCH_SIZE) break;
          page++;
          await yieldToEventLoop();
        }
      } catch (e) {}
      await yieldToEventLoop();
    }

    return refMap;
  }

  /**
   * 全盘深度分析与扫描入口（异步非阻塞 + 分批事件循环让渡）
   */
  async analyzeAll(options?: AnalyzeOptions): Promise<{
    items: AttachmentAnalysisItem[];
    stats: {
      totalCount: number;
      totalSize: number;
      unusedCount: number;
      unusedSize: number;
      duplicateCount: number;
      duplicateWastedSize: number;
      recycledCount: number;
      missingFileCount: number;
      missingFileSize: number;
    };
  }> {
    const onProgress = options?.onProgress;
    const checkpoint = options?.checkpoint;
    const cacheMap = options?.cacheMap || new Map();
    const shouldPause = options?.shouldPause;

    if (onProgress) {
      onProgress({
        phase: 'init',
        phaseText: '正在快速预载磁盘与附件索引...',
        percent: 5,
      });
    }

    const attachmentsRepo = this.db.getRepository('attachments');
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');

    // 分批拉取全部附件记录，避免单次查询爆内存
    const allAttachments: any[] = [];
    if (attachmentsRepo) {
      let page = 0;
      while (true) {
        const batch = await attachmentsRepo.find({
          sort: ['-createdAt'],
          limit: BATCH_SIZE,
          offset: page * BATCH_SIZE,
        });
        if (!batch || batch.length === 0) break;
        allAttachments.push(...batch);
        if (batch.length < BATCH_SIZE) break;
        page++;
        await yieldToEventLoop();
      }
    }

    const recycledRecords = recycleRepo ? await recycleRepo.find() : [];

    const storageMap = new Map<string | number, { title: string; name: string; type: string; options?: any }>();

    try {
      const storagesRepo = this.db.getRepository('storages');
      if (storagesRepo) {
        const storages = await storagesRepo.find();
        for (const s of storages) {
          storageMap.set(s.get('id'), {
            title: s.get('title'),
            name: s.get('name'),
            type: s.get('type'),
            options: s.get('options'),
          });
        }
      }
    } catch (e) {}

    const diskCache = new Map<string, boolean>();

    const recycledMap = new Map<string | number, Date>();
    for (const rec of recycledRecords) {
      recycledMap.set(rec.get('attachmentId'), rec.get('recycledAt'));
    }

    const usedIds = new Set<string | number>(checkpoint?.usedIdList || []);

    // 阶段 0：优先扫描系统全局配置、系统 Logo、UI Schemas 与用户头像等系统级重要资产
    if (onProgress) {
      onProgress({
        phase: 'init',
        phaseText: '正在扫描系统配置、系统Logo与页面设计引用...',
        percent: 8,
      });
    }
    await this.scanSystemSettingsAndUiSchemas(allAttachments, usedIds);

    // 阶段 1：扫描业务集合关系字段 (10% ~ 40%)
    const relationsStartIndex =
      checkpoint?.phase === 'relations' ? checkpoint.relationsIndex : checkpoint?.phase ? 999999 : 0;

    if (onProgress) {
      onProgress({
        phase: 'relations',
        phaseText: '正在分析业务数据与系统模型关联字段...',
        percent: 10,
      });
    }

    await this.findUsedAttachmentIds(allAttachments, {
      startIndex: relationsStartIndex,
      initialUsedIds: usedIds,
      shouldPause,
      onCheckpoint: async (index, curUsedIds, total) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'relations',
            phaseText: `正在分析模型关联字段 (${index})`,
            percent: 10 + Math.floor((index / (total || 1)) * 30),
            relationsIndex: index,
            textsIndex: 0,
            duplicatesIndex: 0,
            usedIdList: Array.from(curUsedIds),
            updatedAt: Date.now(),
          });
        }
      },
      onProgress: (info) => {
        if (onProgress) {
          const progressPercent = 10 + Math.floor((info.step / info.total) * 30);
          onProgress({
            phase: 'relations',
            phaseText: `正在分析模型关联: ${info.collectionName} (${info.step}/${info.total})`,
            percent: progressPercent,
            currentStep: info.step,
            totalSteps: info.total,
          });
        }
      },
    });

    // 阶段 2：扫描富文本与长文本引用 (40% ~ 75%)
    const textsStartIndex =
      checkpoint?.phase === 'texts' ? checkpoint.textsIndex : checkpoint?.phase === 'duplicates' ? 999999 : 0;

    if (onProgress) {
      onProgress({
        phase: 'texts',
        phaseText: '正在快速检索文本与富文本中的附件引用...',
        percent: 40,
      });
    }

    await this.scanTextReferences(allAttachments, usedIds, {
      startIndex: textsStartIndex,
      shouldPause,
      onCheckpoint: async (index, curUsedIds, total) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'texts',
            phaseText: `正在检索文本内容 (${index})`,
            percent: 40 + Math.floor((index / (total || 1)) * 35),
            relationsIndex: 999999,
            textsIndex: index,
            duplicatesIndex: 0,
            usedIdList: Array.from(curUsedIds),
            updatedAt: Date.now(),
          });
        }
      },
      onProgress: (info) => {
        if (onProgress) {
          const progressPercent = 40 + Math.floor((info.step / info.total) * 35);
          onProgress({
            phase: 'texts',
            phaseText: `正在检索文本内容: ${info.collectionName} (${info.step}/${info.total})`,
            percent: progressPercent,
            currentStep: info.step,
            totalSteps: info.total,
          });
        }
      },
    });

    // 阶段 3：重复文件分析 (75% ~ 95%)
    const duplicatesStartIndex = checkpoint?.phase === 'duplicates' ? checkpoint.duplicatesIndex : 0;

    if (onProgress) {
      onProgress({
        phase: 'duplicates',
        phaseText: '正在快速比对重复文件与内容指纹...',
        percent: 75,
      });
    }

    const activeAttachments = allAttachments.filter((att) => !recycledMap.has(att.get('id')));
    const duplicateMap = await this.findDuplicateGroups(activeAttachments, {
      startIndex: duplicatesStartIndex,
      cacheMap,
      shouldPause,
      onUpdateCache: options?.onUpdateCache,
      onCheckpoint: async (index, total) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'duplicates',
            phaseText: `正在比对重复文件指纹 (${index})`,
            percent: 75 + Math.floor((index / (total || 1)) * 20),
            relationsIndex: 999999,
            textsIndex: 999999,
            duplicatesIndex: index,
            usedIdList: Array.from(usedIds),
            updatedAt: Date.now(),
          });
        }
      },
      onProgress: (info) => {
        if (onProgress) {
          const progressPercent = 75 + Math.floor((info.step / info.total) * 20);
          onProgress({
            phase: 'duplicates',
            phaseText: `正在比对重复指纹 (${info.step}/${info.total})`,
            percent: progressPercent,
            currentStep: info.step,
            totalSteps: info.total,
          });
        }
      },
    });

    const attDuplicateGroupMap = new Map<string | number, { groupId: string; count: number }>();
    for (const [hash, items] of duplicateMap.entries()) {
      for (const item of items) {
        attDuplicateGroupMap.set(item.get('id'), {
          groupId: hash,
          count: items.length,
        });
      }
    }

    // 阶段 4：汇总与构建结果 (95% ~ 100%)
    if (onProgress) {
      onProgress({
        phase: 'summary',
        phaseText: '正在汇总统计数据并生成报告...',
        percent: 95,
      });
    }

    let totalSize = 0;
    let unusedCount = 0;
    let unusedSize = 0;
    let duplicateCount = 0;
    let duplicateWastedSize = 0;
    let missingFileCount = 0;
    let missingFileSize = 0;
    const recycledCount = recycledRecords.length;

    const items: AttachmentAnalysisItem[] = [];

    // 分批处理附件汇总与物理文件检测
    for (let i = 0; i < allAttachments.length; i++) {
      const att = allAttachments[i];
      const id = att.get('id');
      const size = Number(att.get('size') || 0);
      const attUpdated = String(att.get('updatedAt') || '');
      const attPath = String(att.get('path') || '');
      totalSize += size;

      const isRecycled = recycledMap.has(id);
      const isUnused = !isRecycled && !usedIds.has(id);
      const dupInfo = attDuplicateGroupMap.get(id);

      if (isUnused) {
        unusedCount++;
        unusedSize += size;
      }

      if (dupInfo) {
        duplicateCount++;
        duplicateWastedSize += size;
      }

      const storageId = att.get('storageId');
      const storage = storageId !== undefined && storageId !== null ? storageMap.get(storageId) : undefined;

      // 物理文件检测：只探测该附件所属存储的 documentRoot 与默认根目录，避免跨存储误判为存在
      let isMissingFile = false;
      const cached = cacheMap.get(id);
      if (cached && cached.size === size && String(cached.updatedAt || '') === attUpdated && typeof cached.isMissingFile === 'boolean') {
        isMissingFile = cached.isMissingFile;
      } else {
        const filename = att.get('filename');
        const recPath = att.get('path') || '';
        const needsLocalCheck = storage?.type === 'local' || !storage || (!att.get('url') && filename);
        if (needsLocalCheck && filename) {
          const attRoots: string[] = [];
          const root = storage?.options?.documentRoot;
          if (typeof root === 'string' && root) {
            attRoots.push(root);
          }
          attRoots.push('storage/uploads');
          const exists = await this.checkPhysicalFileExists(filename, recPath, attRoots, diskCache);
          if (!exists) {
            isMissingFile = true;
          }
        } else if (needsLocalCheck && !filename) {
          isMissingFile = true;
        }

        if (options?.onUpdateCache) {
          const cachedHash =
            typeof cached?.fileHash === 'string' && cached.fileHash.startsWith(CONTENT_HASH_PREFIX)
              ? cached.fileHash
              : '';
          options.onUpdateCache(id, {
            size,
            updatedAt: attUpdated,
            path: attPath,
            fileHash: cachedHash,
            isMissingFile,
            cachedAt: Date.now(),
          });
        }
      }

      if (isMissingFile) {
        missingFileCount++;
        missingFileSize += size;
      }

      items.push({
        id,
        title: att.get('title'),
        filename: att.get('filename'),
        extname: att.get('extname'),
        size,
        mimetype: att.get('mimetype'),
        url: att.get('url'),
        storageId,
        storageName: storage?.title || storage?.name,
        storageType: storage?.type,
        createdAt: att.get('createdAt'),
        updatedAt: att.get('updatedAt'),
        isUnused,
        isDuplicate: Boolean(dupInfo),
        duplicateGroupId: dupInfo?.groupId,
        duplicateCount: dupInfo?.count,
        isRecycled,
        recycledAt: recycledMap.get(id),
        isMissingFile,
      });

      if (i % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    if (onProgress) {
      onProgress({
        phase: 'summary',
        phaseText: '扫描完成',
        percent: 100,
      });
    }

    return {
      items,
      stats: {
        totalCount: allAttachments.length,
        totalSize,
        unusedCount,
        unusedSize,
        duplicateCount,
        duplicateWastedSize,
        recycledCount,
        missingFileCount,
        missingFileSize,
      },
    };
  }
}
