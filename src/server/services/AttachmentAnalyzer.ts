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

export type ScanProgressCallback = (info: {
  phase: 'init' | 'relations' | 'texts' | 'duplicates' | 'summary';
  phaseText: string;
  percent: number;
  currentStep?: number;
  totalSteps?: number;
}) => void;

/** 系统表或内置数据表（无需扫描附件引用） */
const SYSTEM_COLLECTIONS = new Set([
  'attachments',
  'attachmentRecycleBin',
  'attachmentCleanerSettings',
  'attachmentCleanerAuditLogs',
  'migrations',
  'uiSchemas',
  'roles',
  'permissions',
  'usersAuthenticators',
  'authenticators',
  'systemSettings',
  'applicationPlugins',
]);

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
   * 扫描所有业务集合中通过字段（interface: attachment 或 target: attachments）引用的附件 ID
   */
  async findUsedAttachmentIds(
    allAttachments?: any[],
    onProgress?: (info: { step: number; total: number; collectionName: string }) => void,
  ): Promise<Set<string | number>> {
    const usedIds = new Set<string | number>();
    const collections = Array.from(this.db.collections.values()).filter(
      (c) => !SYSTEM_COLLECTIONS.has(c.name) && !c.name.startsWith('system'),
    );

    const totalCollections = collections.length || 1;

    // 1. 扫描关联字段
    for (let i = 0; i < collections.length; i++) {
      const collection = collections[i];
      if (onProgress) {
        onProgress({ step: i + 1, total: totalCollections, collectionName: collection.name });
      }

      const fields = Array.from(collection.fields.values());
      const attachmentFields = fields.filter(
        (f) => f.options?.target === 'attachments' || f.options?.interface === 'attachment',
      );

      if (attachmentFields.length > 0) {
        try {
          const repo = this.db.getRepository(collection.name);
          if (repo) {
            const records = await repo.find({
              appends: attachmentFields.map((f) => f.name),
            });

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
          }
        } catch (e) {
          // ignore exception for individual collection
        }
      }
    }

    return usedIds;
  }

  /**
   * 从富文本与长文本字段中扫描可能引用的附件 (使用正则快速提取 + O(1) 内存比对)
   */
  async scanTextReferences(
    allAttachments: any[],
    usedIds: Set<string | number>,
    onProgress?: (info: { step: number; total: number; collectionName: string }) => void,
  ): Promise<void> {
    const { idSet, filenameMap, urlMap } = this.buildAttachmentIndex(allAttachments);

    const collections = Array.from(this.db.collections.values()).filter(
      (c) => !SYSTEM_COLLECTIONS.has(c.name) && !c.name.startsWith('system'),
    );

    const totalCollections = collections.length || 1;

    // 匹配常见的附件 ID 模式与文件名/URL 模式
    const filePatternRegex = /(?:id[=:]\s*["']?(\d+)["']?|\/attachments\/(\d+)|\/files\/([^"'\s?#<>\\]+)|\/uploads\/([^"'\s?#<>\\]+)|([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+))/gi;

    for (let i = 0; i < collections.length; i++) {
      const collection = collections[i];
      if (onProgress) {
        onProgress({ step: i + 1, total: totalCollections, collectionName: collection.name });
      }

      const textFields = Array.from(collection.fields.values()).filter((f) =>
        ['string', 'text', 'longText', 'json', 'jsonb', 'markdown'].includes(f.type),
      );

      if (textFields.length === 0) continue;

      try {
        const repo = this.db.getRepository(collection.name);
        if (!repo) continue;

        const records = await repo.find({
          fields: textFields.map((f) => f.name),
        });

        for (const record of records) {
          for (const field of textFields) {
            const content = record.get(field.name);
            if (!content) continue;

            const contentStr = typeof content === 'object' ? JSON.stringify(content) : String(content);

            // 快速粗筛：只有包含关键字或常见路径才进行深度正则提取
            if (
              !contentStr.includes('/files/') &&
              !contentStr.includes('/uploads/') &&
              !contentStr.includes('attachments') &&
              !contentStr.includes('/api/')
            ) {
              continue;
            }

            // 重置正则表达式状态
            filePatternRegex.lastIndex = 0;
            let match: RegExpExecArray | null;

            while ((match = filePatternRegex.exec(contentStr)) !== null) {
              const matchedId1 = match[1];
              const matchedId2 = match[2];
              const matchedFile1 = match[3];
              const matchedFile2 = match[4];
              const matchedFile3 = match[5];

              if (matchedId1 && idSet.has(matchedId1)) {
                usedIds.add(isNaN(Number(matchedId1)) ? matchedId1 : Number(matchedId1));
              }
              if (matchedId2 && idSet.has(matchedId2)) {
                usedIds.add(isNaN(Number(matchedId2)) ? matchedId2 : Number(matchedId2));
              }
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
      } catch (e) {
        // ignore exception for individual collection
      }
    }
  }

  /**
   * 扫描所有业务集合中的附件字段，构建「附件 id -> 引用条目」映射。
   */
  async findAttachmentReferences(): Promise<Map<string | number, AttachmentReference[]>> {
    const refMap = new Map<string | number, AttachmentReference[]>();
    const collections = Array.from(this.db.collections.values()).filter((c) => !SYSTEM_COLLECTIONS.has(c.name));

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
        (f) => f.options?.target === 'attachments' || f.options?.interface === 'attachment',
      );
      if (fields.length === 0) continue;

      try {
        const repo = this.db.getRepository(collection.name);
        if (!repo) continue;
        const records = await repo.find({
          appends: fields.map((f) => f.name),
        });

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
      } catch (e) {
        // ignore exception
      }
    }

    return refMap;
  }

  /**
   * 查找重复附件组（带快速指纹优化与防超时机制）
   */
  async findDuplicateGroups(
    attachments: any[],
    onProgress?: (info: { step: number; total: number }) => void,
  ): Promise<Map<string, any[]>> {
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

    for (let idx = 0; idx < candidateEntries.length; idx++) {
      const [, candidates] = candidateEntries[idx];
      if (onProgress) {
        onProgress({ step: idx + 1, total: totalCandidates });
      }

      const hashSubGroups = new Map<string, any[]>();

      for (const att of candidates) {
        let fileHash = '';
        try {
          if (fileManagerPlugin) {
            // 读取流并使用分块快速 SHA-256
            const { stream } = await fileManagerPlugin.getFileStream(att);
            fileHash = await new Promise<string>((resolve) => {
              const hash = crypto.createHash('sha256');
              let totalBytes = 0;
              let isDone = false;
              const MAX_FINGERPRINT_BYTES = 1024 * 1024;

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
                    complete(`${digest}_${att.get ? att.get('size') : att.size}`);
                  } catch (e) {
                    complete(`${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`);
                  }
                }
              });

              stream.on('end', () => {
                if (!isDone) {
                  try {
                    complete(hash.digest('hex'));
                  } catch (e) {
                    complete(`${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`);
                  }
                }
              });

              stream.on('error', () => {
                if (!isDone) {
                  isDone = true;
                  resolve(`${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`);
                }
              });

              stream.on('close', () => {
                if (!isDone) {
                  try {
                    complete(hash.digest('hex'));
                  } catch (e) {
                    complete(`${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`);
                  }
                }
              });
            });
          } else {
            fileHash = `${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`;
          }
        } catch (e) {
          fileHash = `${att.get ? att.get('size') : att.size}_${att.get ? att.get('filename') : att.filename}`;
        }

        if (fileHash) {
          let subList = hashSubGroups.get(fileHash);
          if (!subList) {
            subList = [];
            hashSubGroups.set(fileHash, subList);
          }
          subList.push(att);
        }
      }

      for (const [hash, items] of hashSubGroups.entries()) {
        if (items.length >= 2) {
          duplicateGroups.set(hash, items);
        }
      }
    }

    return duplicateGroups;
  }

  async analyzeAll(onProgress?: ScanProgressCallback): Promise<{
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
    if (onProgress) {
      onProgress({
        phase: 'init',
        phaseText: '正在初始化扫描环境与加载附件列表...',
        percent: 5,
      });
    }

    const attachmentsRepo = this.db.getRepository('attachments');
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');

    const allAttachments = attachmentsRepo ? await attachmentsRepo.find({ sort: ['-createdAt'] }) : [];
    const recycledRecords = recycleRepo ? await recycleRepo.find() : [];

    // 存储空间映射：storageId -> { 名称, 类型, 配置 }
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
    } catch (e) {
      // storages 集合不存在或不可读时忽略
    }

    const recycledMap = new Map<string | number, Date>();
    for (const rec of recycledRecords) {
      recycledMap.set(rec.get('attachmentId'), rec.get('recycledAt'));
    }

    // 阶段 1：扫描业务集合关系字段 (10% ~ 40%)
    if (onProgress) {
      onProgress({
        phase: 'relations',
        phaseText: '正在分析业务数据关联字段...',
        percent: 10,
      });
    }

    const usedIds = await this.findUsedAttachmentIds(allAttachments, (info) => {
      if (onProgress) {
        const progressPercent = 10 + Math.floor((info.step / info.total) * 30);
        onProgress({
          phase: 'relations',
          phaseText: `正在分析模型关联字段: ${info.collectionName} (${info.step}/${info.total})`,
          percent: progressPercent,
          currentStep: info.step,
          totalSteps: info.total,
        });
      }
    });

    // 阶段 2：扫描富文本与长文本引用 (40% ~ 75%)
    if (onProgress) {
      onProgress({
        phase: 'texts',
        phaseText: '正在扫描文本与富文本中的附件引用...',
        percent: 40,
      });
    }

    await this.scanTextReferences(allAttachments, usedIds, (info) => {
      if (onProgress) {
        const progressPercent = 40 + Math.floor((info.step / info.total) * 35);
        onProgress({
          phase: 'texts',
          phaseText: `正在扫描文本内容: ${info.collectionName} (${info.step}/${info.total})`,
          percent: progressPercent,
          currentStep: info.step,
          totalSteps: info.total,
        });
      }
    });

    // 阶段 3：重复文件分析 (75% ~ 95%)
    if (onProgress) {
      onProgress({
        phase: 'duplicates',
        phaseText: '正在分析重复文件与内容指纹...',
        percent: 75,
      });
    }

    const activeAttachments = allAttachments.filter((att) => !recycledMap.has(att.get('id')));
    const duplicateMap = await this.findDuplicateGroups(activeAttachments, (info) => {
      if (onProgress) {
        const progressPercent = 75 + Math.floor((info.step / info.total) * 20);
        onProgress({
          phase: 'duplicates',
          phaseText: `正在比对重复文件指纹 (${info.step}/${info.total})`,
          percent: progressPercent,
          currentStep: info.step,
          totalSteps: info.total,
        });
      }
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

    for (const att of allAttachments) {
      const id = att.get('id');
      const size = Number(att.get('size') || 0);
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

      // 检测物理文件是否存在（主要是本地存储及托管附件）
      let isMissingFile = false;
      const filename = att.get('filename');
      const recPath = att.get('path');
      if (storage?.type === 'local' || !storage || (!att.get('url') && filename)) {
        if (filename) {
          const docRoot = storage?.options?.documentRoot || process.env.LOCAL_STORAGE_DEST || 'storage/uploads';
          const candidatePaths = [
            path.resolve(process.cwd(), docRoot, recPath || '', filename),
            path.resolve(process.cwd(), docRoot, filename),
            path.resolve(docRoot, recPath || '', filename),
            path.resolve(docRoot, filename),
            path.resolve(process.cwd(), 'storage/uploads', recPath || '', filename),
            path.resolve(process.cwd(), 'storage/uploads', filename),
          ];
          const exists = candidatePaths.some((p) => {
            try {
              return fs.existsSync(p);
            } catch {
              return false;
            }
          });
          if (!exists) {
            isMissingFile = true;
          }
        } else {
          isMissingFile = true;
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
