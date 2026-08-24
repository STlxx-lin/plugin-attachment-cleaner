/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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

export class AttachmentAnalyzer {
  constructor(private app: Application) {}

  private get db(): Database {
    return this.app.db;
  }

  async findUsedAttachmentIds(): Promise<Set<string | number>> {
    const usedIds = new Set<string | number>();
    const collections = Array.from(this.db.collections.values());

    for (const collection of collections) {
      if (collection.name === 'attachments' || collection.name === 'attachmentRecycleBin') {
        continue;
      }

      const fields = Array.from(collection.fields.values());
      for (const field of fields) {
        if (field.options?.target === 'attachments' || field.options?.interface === 'attachment') {
          try {
            const repo = this.db.getRepository(collection.name);
            if (!repo) continue;
            const records = await repo.find({
              appends: [field.name],
            });

            for (const record of records) {
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
          } catch (e) {
            // ignore exception
          }
        }
      }

      const textFields = fields.filter((f) =>
        ['string', 'text', 'longText', 'json', 'jsonb', 'markdown'].includes(f.type),
      );

      if (textFields.length > 0) {
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

              if (contentStr.includes('/files/') || contentStr.includes('attachments')) {
                const attachmentsRepo = this.db.getRepository('attachments');
                if (!attachmentsRepo) continue;
                const allAttachments = await attachmentsRepo.find({ fields: ['id', 'filename', 'url'] });
                for (const att of allAttachments) {
                  const attId = att.get('id');
                  const filename = att.get('filename');
                  const url = att.get('url');

                  if (
                    (filename && contentStr.includes(filename)) ||
                    (url && contentStr.includes(url)) ||
                    contentStr.includes(`/attachments/${attId}`) ||
                    contentStr.includes(`id=${attId}`)
                  ) {
                    usedIds.add(attId);
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore exception
        }
      }
    }

    return usedIds;
  }

  /**
   * 扫描所有业务集合中的附件字段，构建「附件 id -> 引用条目」映射。
   * 与 findUsedAttachmentIds 不同，这里保留了引用关系（哪条记录、哪个字段），
   * 供去重时把被移除附件的引用改写到保留附件上。
   */
  async findAttachmentReferences(): Promise<Map<string | number, AttachmentReference[]>> {
    const refMap = new Map<string | number, AttachmentReference[]>();
    const collections = Array.from(this.db.collections.values());

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
      if (collection.name === 'attachments' || collection.name === 'attachmentRecycleBin') {
        continue;
      }

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

  async findDuplicateGroups(attachments: any[]): Promise<Map<string, any[]>> {
    const candidateGroups = new Map<string, any[]>();

    for (const att of attachments) {
      const size = att.get('size') || att.size;
      const ext = att.get('extname') || att.extname || '';
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

    for (const [, candidates] of candidateGroups.entries()) {
      if (candidates.length < 2) continue;

      const hashSubGroups = new Map<string, any[]>();
      for (const att of candidates) {
        let fileHash = '';
        try {
          if (fileManagerPlugin) {
            const { stream } = await fileManagerPlugin.getFileStream(att);
            fileHash = await new Promise<string>((resolve, reject) => {
              const hash = crypto.createHash('sha256');
              stream.on('data', (chunk) => hash.update(chunk));
              stream.on('end', () => resolve(hash.digest('hex')));
              stream.on('error', (err) => reject(err));
            });
          } else {
            // 未加载 file-manager 时无法计算内容哈希，退化为按 size + filename 分组
            fileHash = `${att.get('size')}_${att.get('filename')}`;
          }
        } catch (e) {
          fileHash = `${att.get('size')}_${att.get('filename')}`;
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

  async analyzeAll(): Promise<{
    items: AttachmentAnalysisItem[];
    stats: {
      totalCount: number;
      totalSize: number;
      unusedCount: number;
      unusedSize: number;
      duplicateCount: number;
      duplicateWastedSize: number;
      recycledCount: number;
    };
  }> {
    const attachmentsRepo = this.db.getRepository('attachments');
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');

    const allAttachments = attachmentsRepo ? await attachmentsRepo.find({ sort: ['-createdAt'] }) : [];
    const recycledRecords = recycleRepo ? await recycleRepo.find() : [];

    // 存储空间映射：storageId -> { 名称, 类型 }
    const storageMap = new Map<string | number, { title: string; name: string; type: string }>();
    try {
      const storagesRepo = this.db.getRepository('storages');
      if (storagesRepo) {
        const storages = await storagesRepo.find();
        for (const s of storages) {
          storageMap.set(s.get('id'), {
            title: s.get('title'),
            name: s.get('name'),
            type: s.get('type'),
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

    const usedIds = await this.findUsedAttachmentIds();
    const activeAttachments = allAttachments.filter((att) => !recycledMap.has(att.get('id')));
    const duplicateMap = await this.findDuplicateGroups(activeAttachments);

    const attDuplicateGroupMap = new Map<string | number, { groupId: string; count: number }>();
    for (const [hash, items] of duplicateMap.entries()) {
      for (const item of items) {
        attDuplicateGroupMap.set(item.get('id'), {
          groupId: hash,
          count: items.length,
        });
      }
    }

    let totalSize = 0;
    let unusedCount = 0;
    let unusedSize = 0;
    let duplicateCount = 0;
    let duplicateWastedSize = 0;
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
      },
    };
  }
}
