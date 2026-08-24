/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Database } from '@nocobase/database';
import { Application } from '@nocobase/server';
import { AttachmentAnalyzer, AttachmentAnalysisItem, AttachmentReference } from './AttachmentAnalyzer';

export interface CleanerSettings {
  autoCleanEnabled: boolean;
  retentionDays: number;
  /** 去重时优先保留的存储空间 id，不配置则按引用数/创建时间选择 */
  preferredStorageId?: number | string | null;
}

export interface AuditOperator {
  id?: string | number;
  name?: string;
}

/** 审计日志最多保留条数，超出自动裁剪最旧记录 */
const AUDIT_LOG_LIMIT = 500;

export class AttachmentCleanerService {
  private analyzer: AttachmentAnalyzer;

  constructor(private app: Application) {
    this.analyzer = new AttachmentAnalyzer(app);
  }

  private get db(): Database {
    return this.app.db;
  }

  private normalizeOperator(operator?: AuditOperator | string | number): AuditOperator | undefined {
    if (operator === undefined || operator === null) return undefined;
    if (typeof operator === 'object') {
      return { id: operator.id, name: operator.name };
    }
    return { id: operator };
  }

  /**
   * 写入一条操作审计日志（失败不影响主流程），并裁剪超过上限的最旧记录。
   */
  private async writeAuditLog(
    action: string,
    operator: AuditOperator | string | number | undefined,
    params: any,
    result: any,
    transaction?: any,
  ) {
    try {
      const repo = this.db.getRepository('attachmentCleanerAuditLogs');
      if (!repo) return;
      const op = this.normalizeOperator(operator);
      await repo.create({
        values: {
          action,
          operatorId: op?.id != null ? String(op.id) : 'system',
          operatorName: op?.name || 'system',
          params: params ?? {},
          result: result ?? {},
        },
        transaction,
      });

      const total = await repo.count({ transaction });
      if (total > AUDIT_LOG_LIMIT) {
        const keep = await repo.find({ sort: '-createdAt', limit: AUDIT_LOG_LIMIT, transaction });
        const keepIds = keep.map((r) => r.get('id'));
        await repo.destroy({
          filter: { id: { $notIn: keepIds } },
          transaction,
        });
      }
    } catch (e) {
      // 审计写入失败不应阻断清理主流程
    }
  }

  async listAuditLogs(limit = 200) {
    const repo = this.db.getRepository('attachmentCleanerAuditLogs');
    if (!repo) return { items: [], count: 0 };
    const records = await repo.find({ sort: '-createdAt', limit });
    return {
      items: records.map((r) => ({
        id: r.get('id'),
        action: r.get('action'),
        operatorId: r.get('operatorId'),
        operatorName: r.get('operatorName'),
        params: r.get('params'),
        result: r.get('result'),
        createdAt: r.get('createdAt'),
      })),
      count: records.length,
    };
  }

  async clearAuditLogs() {
    const repo = this.db.getRepository('attachmentCleanerAuditLogs');
    if (!repo) return { success: true, count: 0 };
    const count = await repo.destroy({ filter: { id: { $not: null } } });
    return { success: true, count };
  }

  async scan() {
    return this.analyzer.analyzeAll();
  }

  async recycle(
    attachmentIds: (string | number)[],
    operator?: AuditOperator | string | number,
    transaction?: any,
    skipAudit = false,
  ) {
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (!recycleRepo) {
      return { success: false, reason: 'RecycleBin collection missing' };
    }

    const now = new Date();
    const op = this.normalizeOperator(operator);
    const records: any[] = [];

    for (const id of attachmentIds) {
      const existing = await recycleRepo.findOne({ filter: { attachmentId: id }, transaction });
      if (!existing) {
        records.push({
          attachmentId: id,
          recycledAt: now,
          recycledBy: op?.id != null ? String(op.id) : 'system',
          status: 'recycled',
        });
      }
    }

    if (records.length > 0) {
      await recycleRepo.createMany({ records, transaction });
    }

    const result = { success: true, count: records.length };
    if (!skipAudit) {
      await this.writeAuditLog('recycle', op, { attachmentIds }, result, transaction);
    }
    return result;
  }

  async restore(attachmentIds: (string | number)[], operator?: AuditOperator | string | number) {
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (recycleRepo) {
      await recycleRepo.destroy({
        filter: {
          attachmentId: attachmentIds,
        },
      });
    }

    const result = { success: true, count: attachmentIds.length };
    await this.writeAuditLog('restore', operator, { attachmentIds }, result);
    return result;
  }

  async purge(attachmentIds: (string | number)[], operator?: AuditOperator | string | number) {
    const attachmentsRepo = this.db.getRepository('attachments');
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');

    if (recycleRepo) {
      await recycleRepo.destroy({
        filter: {
          attachmentId: attachmentIds,
        },
      });
    }

    if (!attachmentsRepo) {
      const failed = { success: false, count: 0 };
      await this.writeAuditLog('purge', operator, { attachmentIds }, failed);
      return failed;
    }

    const destroyCount = await attachmentsRepo.destroy({
      filter: {
        id: attachmentIds,
      },
    });

    const result = { success: true, count: destroyCount };
    await this.writeAuditLog('purge', operator, { attachmentIds }, result);
    return result;
  }

  async getSettings(): Promise<CleanerSettings> {
    const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
    if (!settingsRepo) {
      return {
        autoCleanEnabled: true,
        retentionDays: 30,
        preferredStorageId: null,
      };
    }

    const record = await settingsRepo.findOne({ filter: { key: 'config' } });

    if (!record) {
      return {
        autoCleanEnabled: true,
        retentionDays: 30,
        preferredStorageId: null,
      };
    }

    return {
      autoCleanEnabled: record.get('value')?.autoCleanEnabled ?? true,
      retentionDays: record.get('value')?.retentionDays ?? 30,
      preferredStorageId: record.get('value')?.preferredStorageId ?? null,
    };
  }

  /** 列出可用存储空间（供配置端选择） */
  async listStorages() {
    const repo = this.db.getRepository('storages');
    if (!repo) return { items: [] };
    const records = await repo.find({ sort: ['title', 'name'] });
    return {
      items: records.map((r) => ({
        id: r.get('id'),
        title: r.get('title'),
        name: r.get('name'),
        type: r.get('type'),
      })),
    };
  }

  async updateSettings(settings: Partial<CleanerSettings>, operator?: AuditOperator | string | number) {
    const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
    if (!settingsRepo) {
      const fallback = {
        autoCleanEnabled: true,
        retentionDays: 30,
        ...settings,
      };
      await this.writeAuditLog('updateSettings', operator, settings, fallback);
      return fallback;
    }

    const current = await this.getSettings();
    const updated = { ...current, ...settings };

    const record = await settingsRepo.findOne({ filter: { key: 'config' } });
    if (record) {
      await settingsRepo.update({
        filter: { key: 'config' },
        values: { value: updated },
      });
    } else {
      await settingsRepo.create({
        values: {
          key: 'config',
          value: updated,
        },
      });
    }

    await this.writeAuditLog('updateSettings', operator, settings, updated);
    return updated;
  }

  async autoCleanExpired(operator?: AuditOperator | string | number) {
    const settings = await this.getSettings();
    if (!settings.autoCleanEnabled) {
      const disabled = { success: false, reason: 'Auto clean is disabled', purgedCount: 0 };
      await this.writeAuditLog('autoCleanExpired', operator, { retentionDays: settings.retentionDays }, disabled);
      return disabled;
    }

    const retentionDays = settings.retentionDays || 30;
    const thresholdDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (!recycleRepo) {
      const result = { success: true, purgedCount: 0 };
      await this.writeAuditLog('autoCleanExpired', operator, { retentionDays }, result);
      return result;
    }

    const expiredRecords = await recycleRepo.find({
      filter: {
        recycledAt: {
          $lt: thresholdDate,
        },
      },
    });

    if (expiredRecords.length === 0) {
      const result = { success: true, purgedCount: 0 };
      await this.writeAuditLog('autoCleanExpired', operator, { retentionDays }, result);
      return result;
    }

    const expiredIds = expiredRecords.map((r) => r.get('attachmentId'));
    const result = await this.purge(expiredIds, operator);

    const auditResult = { success: true, purgedCount: result.count };
    await this.writeAuditLog('autoCleanExpired', operator, { retentionDays }, auditResult);
    return auditResult;
  }

  /**
   * 对重复文件去重：每组内容相同的附件只保留 1 个，其余移入回收站，
   * 并把业务集合中指向被移除附件的引用改写到保留附件上。整个过程在事务内完成。
   */
  async deduplicate(operator?: AuditOperator | string | number) {
    const settings = await this.getSettings();
    const preferredStorageId = settings.preferredStorageId;
    const result = await this.analyzer.analyzeAll();
    const refMap = await this.analyzer.findAttachmentReferences();

    // 按 duplicateGroupId 聚合未被回收的重复附件
    const groups = new Map<string, AttachmentAnalysisItem[]>();
    for (const item of result.items) {
      if (item.isDuplicate && item.duplicateGroupId && !item.isRecycled) {
        let list = groups.get(item.duplicateGroupId);
        if (!list) {
          list = [];
          groups.set(item.duplicateGroupId, list);
        }
        list.push(item);
      }
    }

    if (groups.size === 0) {
      return { groups: 0, keptCount: 0, removedCount: 0, referencesUpdated: 0, recordsUpdated: 0 };
    }

    // 每组挑选保留项：优先保留配置的存储空间中的文件，其次被引用最多者，平局取创建最早者
    const removedToKeeper = new Map<string | number, string | number>();
    const removedIds: (string | number)[] = [];

    const isPreferred = (storageId: any) =>
      preferredStorageId != null && storageId != null && String(storageId) === String(preferredStorageId);

    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => {
        const aPref = isPreferred(a.storageId) ? 1 : 0;
        const bPref = isPreferred(b.storageId) ? 1 : 0;
        if (aPref !== bPref) return bPref - aPref;
        const aRefs = refMap.get(a.id)?.length ?? 0;
        const bRefs = refMap.get(b.id)?.length ?? 0;
        if (aRefs !== bRefs) return bRefs - aRefs;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      const keeper = sorted[0];
      for (const item of sorted.slice(1)) {
        removedToKeeper.set(item.id, keeper.id);
        removedIds.push(item.id);
      }
    }

    if (removedIds.length === 0) {
      return { groups: groups.size, keptCount: groups.size, removedCount: 0, referencesUpdated: 0, recordsUpdated: 0 };
    }

    const transaction = await this.db.sequelize.transaction();

    try {
      // 同一 (collection, recordId, field) 只更新一次
      const uniqueRefs = new Map<string, AttachmentReference>();
      for (const [removedId, refs] of refMap.entries()) {
        if (!removedToKeeper.has(removedId)) continue;
        for (const ref of refs) {
          uniqueRefs.set(`${ref.collection}:${ref.recordId}:${ref.field}`, ref);
        }
      }

      let referencesUpdated = 0;

      for (const ref of uniqueRefs.values()) {
        const newValue = this.migrateReferenceValue(ref.value, removedToKeeper);
        const repo = this.db.getRepository(ref.collection);
        if (!repo) continue;
        await repo.update({
          filterByTk: ref.recordId,
          values: { [ref.field]: newValue },
          transaction,
        });
        referencesUpdated += this.countMigratedIds(ref.value, removedToKeeper);
      }

      // 被移除的重复附件移入回收站（不立即物理删除），内部调用不重复记录审计
      await this.recycle(removedIds, operator, transaction, true);

      const result = {
        groups: groups.size,
        keptCount: groups.size,
        removedCount: removedIds.length,
        referencesUpdated,
        recordsUpdated: uniqueRefs.size,
      };
      await this.writeAuditLog('deduplicate', operator, { duplicateGroupIds: [...groups.keys()] }, result, transaction);

      await transaction.commit();

      return result;
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  }

  /**
   * 把字段值中所有被移除附件的 id 改写为保留附件 id，并按 id 去重。
   * 值支持对象 / 对象数组 / 裸 id 三种形式。
   */
  private migrateReferenceValue(value: any, removedToKeeper: Map<string | number, string | number>): any {
    const resolve = (rawId: any) =>
      rawId !== undefined && rawId !== null && removedToKeeper.has(rawId) ? removedToKeeper.get(rawId) : rawId;

    if (Array.isArray(value)) {
      const seen = new Set<string | number>();
      const result: any[] = [];
      for (const item of value) {
        const rawId = typeof item === 'object' && item !== null ? item.id : item;
        if (rawId === undefined || rawId === null) continue;
        const id = resolve(rawId);
        if (seen.has(id)) continue;
        seen.add(id);
        if (typeof item === 'object' && item !== null) {
          // 被改写的项只保留 id，避免残留被移除附件的 url/title 等误导性信息
          result.push(rawId !== id ? { id } : { ...item, id });
        } else {
          result.push(id);
        }
      }
      return result;
    }

    if (value && typeof value === 'object') {
      const rawId = value.id;
      if (rawId !== undefined && rawId !== null && removedToKeeper.has(rawId)) {
        return { id: removedToKeeper.get(rawId) };
      }
      return value;
    }

    return resolve(value);
  }

  /** 统计字段值中被改写的引用个数 */
  private countMigratedIds(value: any, removedToKeeper: Map<string | number, string | number>): number {
    const ids = Array.isArray(value)
      ? value.map((item) => (typeof item === 'object' && item !== null ? item.id : item))
      : value && typeof value === 'object'
        ? [value.id]
        : [value];

    let count = 0;
    for (const id of ids) {
      if (id !== undefined && id !== null && removedToKeeper.has(id)) count++;
    }
    return count;
  }
}
