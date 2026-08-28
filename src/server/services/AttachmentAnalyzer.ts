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

export class AttachmentAnalyzer {
  constructor(private app: Application) {}

  private get db(): Database {
    return this.app.db;
  }

  /**
   * 构建附件快速检索索引 (O(1) 内存查询)
   */
  private buildAttachmentIndex(allAttachments: any[]) {
    const idSet = new Set<string | number>();
    const filenameMap = new Map<string, string | number>();
    const urlMap = new Map<string, string | number>();

    for (const att of allAttachments) {
      const id = att.get ? att.get('id') : att.id;
      const filename = att.get ? att.get('filename') : att.filename;
      const url = att.get ? att.get('url') : att.url;

      if (id !== undefined && id !== null) {
        idSet.add(id);
        idSet.add(String(id));
      }
      if (filename) {
        filenameMap.set(String(filename).trim(), id);
      }
      if (url) {
        urlMap.set(String(url).trim(), id);
      }
    }

    return { idSet, filenameMap, urlMap };
  }

  /**
   * 异步非阻塞检测物理磁盘文件是否存在（精准按需探测 + 内存缓存，彻底替代同步全盘递归）
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

    if (diskCache.has(relKey)) {
      return diskCache.get(relKey)!;
    }

    for (const root of docRoots) {
      const absRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
      const candidatePath1 = path.join(absRoot, relKey);
      const candidatePath2 = path.join(absRoot, filename);

      try {
        await fs.promises.access(candidatePath1);
        diskCache.set(relKey, true);
        return true;
      } catch {
        try {
          await fs.promises.access(candidatePath2);
          diskCache.set(relKey, true);
          return true;
        } catch {
          // 继续检查下一个 root
        }
      }
    }

    diskCache.set(relKey, false);
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
    const { idSet, filenameMap, urlMap } = this.buildAttachmentIndex(allAttachments);

    const extractFromValue = (val: any) => {
      if (val === null || val === undefined) return;
      if (typeof val === 'number' || typeof val === 'string') {
        if (idSet.has(val)) usedIds.add(val);
        const byFilename = filenameMap.get(String(val).trim());
        if (byFilename !== undefined) usedIds.add(byFilename);
        const byUrl = urlMap.get(String(val).trim());
        if (byUrl !== undefined) usedIds.add(byUrl);

        if (typeof val === 'string' && (val.includes('/') || val.includes('.'))) {
          const urlRegex = /(?:src|href)=["']([^"']+)["']|(?:\/api\/attachments\/([^\s"'<>]+))|([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)/gi;
          let match;
          while ((match = urlRegex.exec(val)) !== null) {
            if (match[1]) {
              const id = filenameMap.get(match[1]) ?? urlMap.get(match[1]);
              if (id !== undefined) usedIds.add(id);
            }
            if (match[2]) {
              const id = filenameMap.get(match[2]) ?? urlMap.get(match[2]);
              if (id !== undefined) usedIds.add(id);
            }
            if (match[3]) {
              const id = filenameMap.get(match[3]);
              if (id !== undefined) usedIds.add(id);
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (const item of val) extractFromValue(item);
      } else if (typeof val === 'object') {
        if (val.id !== undefined && idSet.has(val.id)) {
          usedIds.add(val.id);
        }
        if (val.filename && filenameMap.has(val.filename)) {
          usedIds.add(filenameMap.get(val.filename)!);
        }
        if (val.url && urlMap.has(val.url)) {
          usedIds.add(urlMap.get(val.url)!);
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
      onCheckpoint?: (index: number, usedIds: Set<string | number>) => Promise<void> | void;
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
          await options.onCheckpoint(i, usedIds);
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
        await options.onCheckpoint(i + 1, usedIds);
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
      onCheckpoint?: (index: number, usedIds: Set<string | number>) => Promise<void> | void;
      onProgress?: (info: { step: number; total: number; collectionName: string }) => void;
    },
  ): Promise<void> {
    if (!allAttachments || allAttachments.length === 0) return;

    const { filenameMap, urlMap } = this.buildAttachmentIndex(allAttachments);
    const collections = Array.from(this.db.collections.values()).filter(
      (c) => !SYSTEM_EXCLUDE_COLLECTIONS.has(c.name),
    );

    const totalCollections = collections.length || 1;
    const startIndex = options?.startIndex ?? 0;

    for (let i = startIndex; i < collections.length; i++) {
      if (options?.shouldPause && options.shouldPause()) {
        if (options.onCheckpoint) {
          await options.onCheckpoint(i, usedIds);
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

              const urlRegex = /(?:src|href)=["']([^"']+)["']|(?:\/api\/attachments\/([^\s"'<>]+))|([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)/gi;
              let match;
              while ((match = urlRegex.exec(val)) !== null) {
                const matchedFile1 = match[1];
                const matchedFile2 = match[2];
                const matchedFile3 = match[3];

                if (matchedFile1) {
                  const id = filenameMap.get(matchedFile1) ?? urlMap.get(matchedFile1);
                  if (id !== undefined) usedIds.add(id);
                }
                if (matchedFile2) {
                  const id = filenameMap.get(matchedFile2) ?? urlMap.get(matchedFile2);
                  if (id !== undefined) usedIds.add(id);
                }
                if (matchedFile3 && (matchedFile3.includes('.') || matchedFile3.length > 5)) {
                  const id = filenameMap.get(matchedFile3);
                  if (id !== undefined) usedIds.add(id);
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
        await options.onCheckpoint(i + 1, usedIds);
      }
    }
  }

  /**
   * 查找重复附件组（头尾微采样预过滤 + 256KB 分块指纹 + 全量复合智能缓存 + 事件循环调度）
   */
  async findDuplicateGroups(
    attachments: any[],
    options?: {
      startIndex?: number;
      cacheMap?: FingerprintCacheMap;
      shouldPause?: () => boolean;
      onUpdateCache?: (attachmentId: string | number, entry: FileFingerprintCacheEntry) => void;
      onCheckpoint?: (index: number) => Promise<void> | void;
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
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerServer) as PluginFileManagerServer;

    const candidateEntries = Array.from(candidateGroups.entries()).filter(([, candidates]) => candidates.length >= 2);
    const totalCandidates = candidateEntries.length || 1;
    const startIndex = options?.startIndex ?? 0;

    for (let idx = startIndex; idx < candidateEntries.length; idx++) {
      if (options?.shouldPause && options.shouldPause()) {
        if (options.onCheckpoint) {
          await options.onCheckpoint(idx);
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

        // 1. 命中全量复合智能缓存（id + size + updatedAt 匹配直接命中，0ms 跳过）
        const cached = options?.cacheMap?.get(attId);
        if (cached && cached.size === attSize && String(cached.updatedAt || '') === attUpdated && cached.fileHash) {
          fileHash = cached.fileHash;
        } else {
          // 2. 缓存未命中：使用 256KB 极速分块指纹计算
          try {
            if (fileManagerPlugin) {
              const { stream } = await fileManagerPlugin.getFileStream(att);
              fileHash = await new Promise<string>((resolve) => {
                const hash = crypto.createHash('sha256');
                let totalBytes = 0;
                let isDone = false;
                const MAX_FINGERPRINT_BYTES = 256 * 1024; // 256KB 快速分块指纹

                const complete = (val: string) => {
                  if (isDone) return;
                  isDone = true;
                  resolve(val);
                };

                stream.on('data', (chunk: Buffer) => {
                  if (isDone) return;
                  totalBytes += chunk.length;
                  hash.update(chunk);
                  if (totalBytes >= MAX_FINGERPRINT_BYTES) {
                    try {
                      const digest = hash.digest('hex');
                      if (typeof (stream as any).destroy === 'function') {
                        (stream as any).destroy();
                      }
                      complete(`${digest}_${attSize}`);
                    } catch (e) {
                      complete(`${attSize}_${att.get ? att.get('filename') : att.filename}`);
                    }
                  }
                });

                stream.on('end', () => {
                  if (!isDone) {
                    try {
                      complete(hash.digest('hex'));
                    } catch (e) {
                      complete(`${attSize}_${att.get ? att.get('filename') : att.filename}`);
                    }
                  }
                });

                stream.on('error', () => {
                  if (!isDone) {
                    isDone = true;
                    resolve(`${attSize}_${att.get ? att.get('filename') : att.filename}`);
                  }
                });

                stream.on('close', () => {
                  if (!isDone) {
                    try {
                      complete(hash.digest('hex'));
                    } catch (e) {
                      complete(`${attSize}_${att.get ? att.get('filename') : att.filename}`);
                    }
                  }
                });
              });
            } else {
              fileHash = `${attSize}_${att.get ? att.get('filename') : att.filename}`;
            }
          } catch (e) {
            fileHash = `${attSize}_${att.get ? att.get('filename') : att.filename}`;
          }

          // 回写缓存
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
        await options.onCheckpoint(idx + 1);
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
    const docRoots: string[] = ['storage/uploads'];

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
          const root = s.get('options')?.documentRoot;
          if (root && typeof root === 'string') {
            docRoots.push(root);
          }
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
      onCheckpoint: async (index, curUsedIds) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'relations',
            phaseText: `正在分析模型关联字段 (${index})`,
            percent: 10 + Math.floor((index / 100) * 30),
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
      onCheckpoint: async (index, curUsedIds) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'texts',
            phaseText: `正在检索文本内容 (${index})`,
            percent: 40 + Math.floor((index / 100) * 35),
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
      onCheckpoint: async (index) => {
        if (options?.onSaveCheckpoint) {
          await options.onSaveCheckpoint({
            taskId: checkpoint?.taskId || `scan_${Date.now()}`,
            phase: 'duplicates',
            phaseText: `正在比对重复文件指纹 (${index})`,
            percent: 75 + Math.floor((index / 100) * 20),
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

      // 物理文件检测：优先查询复合智能缓存，未命中走异步非阻塞按需探测
      let isMissingFile = false;
      const cached = cacheMap.get(id);
      if (cached && cached.size === size && String(cached.updatedAt || '') === attUpdated && typeof cached.isMissingFile === 'boolean') {
        isMissingFile = cached.isMissingFile;
      } else {
        const filename = att.get('filename');
        const recPath = att.get('path') || '';
        if (storage?.type === 'local' || !storage || (!att.get('url') && filename)) {
          if (filename) {
            const exists = await this.checkPhysicalFileExists(filename, recPath, docRoots, diskCache);
            if (!exists) {
              isMissingFile = true;
            }
          } else {
            isMissingFile = true;
          }
        }

        if (options?.onUpdateCache) {
          options.onUpdateCache(id, {
            size,
            updatedAt: attUpdated,
            path: attPath,
            fileHash: cached?.fileHash || '',
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
