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
import {
  AttachmentAnalyzer,
  AttachmentAnalysisItem,
  AttachmentReference,
  ScanCheckpointData,
  FileFingerprintCacheEntry,
  FingerprintCacheMap,
  ScanPausedError,
} from './AttachmentAnalyzer';

export interface CleanerSettings {
  autoCleanEnabled: boolean;
  retentionDays: number;
  /** 去重时优先保留的存储空间 id，不配置则按引用数/创建时间选择 */
  preferredStorageId?: number | string | null;
  /** 是否启用后台定时自动全盘扫描 */
  autoScanEnabled?: boolean;
  /** 定时扫描 Cron 表达式，默认每天凌晨 3:00 (0 3 * * *) */
  autoScanCron?: string;
  /** 最近一次扫描分析报告快照 */
  lastScanResult?: any;
  /** 最近一次扫描完成时间 (ISO String) */
  lastScannedAt?: string;
  /** 扫描中断/暂停检查点 */
  scanCheckpoint?: ScanCheckpointData | null;
}

export interface AuditOperator {
  id?: string | number;
  name?: string;
}

export interface ScanTaskState {
  taskId: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  phase: 'init' | 'relations' | 'texts' | 'duplicates' | 'summary';
  phaseText: string;
  percent: number;
  currentStep?: number;
  totalSteps?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  result?: any;
  checkpoint?: ScanCheckpointData | null;
}

/** 审计日志最多保留条数，超出自动裁剪最旧记录 */
const AUDIT_LOG_LIMIT = 500;

export class AttachmentCleanerService {
  private analyzer: AttachmentAnalyzer;
  private shouldPauseScan = false;
  private cacheMap: FingerprintCacheMap = new Map();
  private cacheDirty = false;

  private currentScanTask: ScanTaskState = {
    taskId: '',
    status: 'idle',
    phase: 'init',
    phaseText: '空闲',
    percent: 0,
    checkpoint: null,
  };

  constructor(private app: Application) {
    this.analyzer = new AttachmentAnalyzer(app);
    void this.loadFingerprintCache();
  }

  private get db(): Database {
    return this.app.db;
  }

  private normalizeOperator(operator?: AuditOperator | string | number): AuditOperator | undefined {
    if (operator === undefined || operator === null) return undefined;
    if (typeof operator === 'object') {
      return { id: operator.id, name: operator.name };
    }
    return { id: operator, name: String(operator) };
  }

  /**
   * 从数据库加载文件指纹缓存
   */
  private async loadFingerprintCache() {
    try {
      const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
      if (!settingsRepo) return;
      const record = await settingsRepo.findOne({ filter: { key: 'fingerprintCache' } });
      if (record) {
        const val = record.get('value');
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && item.id !== undefined) {
              this.cacheMap.set(item.id, {
                size: item.size,
                updatedAt: item.updatedAt,
                path: item.path,
                fileHash: item.fileHash,
                isMissingFile: item.isMissingFile,
                cachedAt: item.cachedAt || Date.now(),
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  /**
   * 持久化文件指纹缓存到数据库
   */
  private async persistFingerprintCache() {
    if (!this.cacheDirty) return;
    try {
      const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
      if (!settingsRepo) return;

      const cacheList: any[] = [];
      for (const [id, entry] of this.cacheMap.entries()) {
        cacheList.push({ id, ...entry });
      }

      const record = await settingsRepo.findOne({ filter: { key: 'fingerprintCache' } });
      if (record) {
        await settingsRepo.update({
          filter: { key: 'fingerprintCache' },
          values: { value: cacheList },
        });
      } else {
        await settingsRepo.create({
          values: {
            key: 'fingerprintCache',
            value: cacheList,
          },
        });
      }
      this.cacheDirty = false;
    } catch (e) {}
  }

  /**
   * 保存最近一次全盘扫描快照到设置集合中
   */
  async saveScanSnapshot(result: any, completedAt: number) {
    try {
      const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
      if (settingsRepo) {
        const current = await this.getSettings();
        const updated = {
          ...current,
          lastScanResult: result,
          lastScannedAt: new Date(completedAt).toISOString(),
          scanCheckpoint: null, // 完成后清空断点
        };
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
      }
    } catch (e) {}
  }

  /**
   * 保存断点检查点到数据库
   */
  async saveCheckpoint(checkpoint: ScanCheckpointData | null) {
    try {
      const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
      if (settingsRepo) {
        const current = await this.getSettings();
        const updated = {
          ...current,
          scanCheckpoint: checkpoint,
        };
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
      }
    } catch (e) {}
  }

  /**
   * 获取最近一次扫描结果快照与断点状态
   */
  async getLastScanResult(): Promise<{
    hasSnapshot: boolean;
    lastScannedAt?: string;
    result?: any;
    taskState: ScanTaskState;
    checkpoint?: ScanCheckpointData | null;
    settings: CleanerSettings;
  }> {
    const settings = await this.getSettings();
    const taskState = this.getScanProgress();
    const hasSnapshot = Boolean(taskState.result || settings.lastScanResult);
    const checkpoint = taskState.checkpoint || settings.scanCheckpoint || null;

    return {
      hasSnapshot,
      lastScannedAt: settings.lastScannedAt,
      result: taskState.result || settings.lastScanResult,
      taskState: {
        ...taskState,
        checkpoint,
      },
      checkpoint,
      settings,
    };
  }

  /**
   * 写入一条操作审计日志
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
          operatorId: op?.id != null ? String(op.id) : null,
          operatorName: op?.name || null,
          params: params ?? {},
          result: result ?? {},
        },
        transaction,
      });

      const total = await repo.count({ transaction });
      if (total > AUDIT_LOG_LIMIT) {
        const keep = await repo.find({ sort: '-createdAt', limit: AUDIT_LOG_LIMIT, transaction });
        const keepIds = keep.map((r) => r.get('id')).filter(Boolean);
        if (keepIds.length > 0) {
          await repo.destroy({
            filter: {
              id: { $notIn: keepIds },
            },
            transaction,
          });
        }
      }
    } catch (e) {}
  }

  async listAuditLogs(limit = 100) {
    const repo = this.db.getRepository('attachmentCleanerAuditLogs');
    if (!repo) return { items: [], count: 0 };
    const records = await repo.find({
      sort: ['-createdAt'],
      limit,
    });
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

  getScanProgress(): ScanTaskState {
    return { ...this.currentScanTask };
  }

  /**
   * 手动暂停当前扫描任务
   */
  async pauseScan(): Promise<{ success: boolean; message: string }> {
    if (this.currentScanTask.status !== 'running') {
      return { success: false, message: '当前没有正在执行的扫描任务' };
    }
    this.shouldPauseScan = true;
    return { success: true, message: '已发出暂停请求' };
  }

  /**
   * 取消当前扫描任务并清空断点
   */
  async cancelScan(): Promise<{ success: boolean; message: string }> {
    this.shouldPauseScan = true;
    this.currentScanTask = {
      taskId: '',
      status: 'idle',
      phase: 'init',
      phaseText: '扫描已取消',
      percent: 0,
      checkpoint: null,
    };
    await this.saveCheckpoint(null);
    return { success: true, message: '扫描任务已取消' };
  }

  /**
   * 启动扫描（支持 resume 断点续扫与全量复合缓存智能跳过）
   */
  async startScan(isAsync = false, resume = false): Promise<ScanTaskState | any> {
    if (this.currentScanTask.status === 'running') {
      return this.getScanProgress();
    }

    this.shouldPauseScan = false;
    let checkpointToUse: ScanCheckpointData | null = null;

    if (resume) {
      const settings = await this.getSettings();
      checkpointToUse = this.currentScanTask.checkpoint || settings.scanCheckpoint || null;
    } else {
      // 全新扫描时清空历史断点
      await this.saveCheckpoint(null);
    }

    const taskId = checkpointToUse?.taskId || `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    this.currentScanTask = {
      taskId,
      status: 'running',
      phase: checkpointToUse?.phase || 'init',
      phaseText: checkpointToUse ? `正在从断点恢复 (${checkpointToUse.phaseText})...` : '正在准备扫描...',
      percent: checkpointToUse?.percent || 0,
      startedAt,
      result: undefined,
      error: undefined,
      checkpoint: checkpointToUse,
    };

    const runPromise = (async () => {
      try {
        const result = await this.analyzer.analyzeAll({
          checkpoint: checkpointToUse,
          cacheMap: this.cacheMap,
          shouldPause: () => this.shouldPauseScan,
          onUpdateCache: (id, entry) => {
            this.cacheMap.set(id, entry);
            this.cacheDirty = true;
          },
          onSaveCheckpoint: async (cp) => {
            this.currentScanTask.checkpoint = cp;
            await this.saveCheckpoint(cp);
          },
          onProgress: (progress) => {
            this.currentScanTask = {
              ...this.currentScanTask,
              phase: progress.phase,
              phaseText: progress.phaseText,
              percent: progress.percent,
              currentStep: progress.currentStep,
              totalSteps: progress.totalSteps,
            };
          },
        });

        const completedAt = Date.now();
        this.currentScanTask = {
          ...this.currentScanTask,
          status: 'completed',
          phase: 'summary',
          phaseText: '扫描已完成',
          percent: 100,
          completedAt,
          durationMs: completedAt - startedAt,
          result,
          checkpoint: null,
        };

        // 自动持久化保存最新快照并持久化缓存
        await this.saveScanSnapshot(result, completedAt);
        await this.persistFingerprintCache();

        return result;
      } catch (err: any) {
        const completedAt = Date.now();
        if (err instanceof ScanPausedError || err?.name === 'ScanPausedError') {
          this.currentScanTask = {
            ...this.currentScanTask,
            status: 'paused',
            phaseText: '扫描已暂停',
            completedAt,
          };
          await this.persistFingerprintCache();
          return this.getScanProgress();
        }

        this.currentScanTask = {
          ...this.currentScanTask,
          status: 'failed',
          phaseText: `扫描异常中断: ${err?.message || '未知错误'}`,
          completedAt,
          durationMs: completedAt - startedAt,
          error: err?.message || String(err),
        };
        await this.persistFingerprintCache();
        throw err;
      }
    })();

    if (isAsync) {
      return this.getScanProgress();
    }

    return runPromise;
  }

  async scan() {
    return this.startScan(false);
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
      records.push({
        attachmentId: id,
        recycledAt: now,
        recycledBy: op?.id != null ? String(op.id) : null,
      });
    }

    if (records.length > 0) {
      await recycleRepo.destroy({
        filter: {
          attachmentId: attachmentIds,
        },
        transaction,
      });

      await recycleRepo.create({
        values: records,
        transaction,
      });
    }

    const result = { success: true, count: attachmentIds.length };
    if (!skipAudit) {
      await this.writeAuditLog('recycle', operator, { attachmentIds }, result, transaction);
    }
    return result;
  }

  async restore(
    attachmentIds: (string | number)[],
    operator?: AuditOperator | string | number,
    transaction?: any,
    skipAudit = false,
  ) {
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (!recycleRepo) {
      return { success: false, reason: 'RecycleBin collection missing' };
    }

    const destroyCount = await recycleRepo.destroy({
      filter: {
        attachmentId: attachmentIds,
      },
      transaction,
    });

    const result = { success: true, count: destroyCount };
    if (!skipAudit) {
      await this.writeAuditLog('restore', operator, { attachmentIds }, result, transaction);
    }
    return result;
  }

  async deduplicate(operator?: AuditOperator | string | number) {
    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) {
      return { success: false, reason: 'attachments repository not found' };
    }

    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    const recycledRecords = recycleRepo ? await recycleRepo.find() : [];
    const recycledSet = new Set(recycledRecords.map((r) => r.get('attachmentId')));

    const allAttachments = await attachmentsRepo.find({ sort: ['-createdAt'] });
    const activeAttachments = allAttachments.filter((att) => !recycledSet.has(att.get('id')));

    const duplicateGroups = await this.analyzer.findDuplicateGroups(activeAttachments, {
      cacheMap: this.cacheMap,
      onUpdateCache: (id, entry) => {
        this.cacheMap.set(id, entry);
        this.cacheDirty = true;
      },
    });

    const settings = await this.getSettings();
    const preferredStorageId = settings.preferredStorageId;
    const refMap = await this.analyzer.findAttachmentReferences();

    let processedGroups = 0;
    let keptCount = 0;
    let removedCount = 0;
    let referencesUpdated = 0;
    const recycledIds: (string | number)[] = [];

    await this.db.sequelize.transaction(async (t: any) => {
      for (const [, items] of duplicateGroups.entries()) {
        if (items.length < 2) continue;
        processedGroups++;

        const scored = items.map((att) => {
          const id = att.get('id');
          const storageId = att.get('storageId');
          const isPreferred =
            preferredStorageId !== undefined &&
            preferredStorageId !== null &&
            String(storageId) === String(preferredStorageId);
          const refCount = refMap.get(id)?.length || 0;
          const createdAt = new Date(att.get('createdAt') || 0).getTime();
          return { att, id, isPreferred, refCount, createdAt };
        });

        scored.sort((a, b) => {
          if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
          if (a.refCount !== b.refCount) return b.refCount - a.refCount;
          return a.createdAt - b.createdAt;
        });

        const canonical = scored[0];
        keptCount++;

        const duplicatesToRemove = scored.slice(1);
        for (const dup of duplicatesToRemove) {
          recycledIds.push(dup.id);
          removedCount++;

          const refs = refMap.get(dup.id) || [];
          for (const ref of refs) {
            try {
              const repo = this.db.getRepository(ref.collection);
              if (!repo) continue;
              const record = await repo.findOne({ filterByTk: ref.recordId, transaction: t });
              if (!record) continue;

              const curVal = record.get(ref.field);
              let nextVal: any;

              if (Array.isArray(curVal)) {
                nextVal = curVal.map((item) => {
                  if (typeof item === 'object' && item?.id && String(item.id) === String(dup.id)) {
                    return { ...item, id: canonical.id };
                  }
                  if (String(item) === String(dup.id)) return canonical.id;
                  return item;
                });
              } else if (typeof curVal === 'object' && curVal?.id) {
                nextVal = { ...curVal, id: canonical.id };
              } else {
                nextVal = canonical.id;
              }

              await repo.update({
                filterByTk: ref.recordId,
                values: { [ref.field]: nextVal },
                transaction: t,
              });
              referencesUpdated++;
            } catch (e) {}
          }
        }
      }

      if (recycledIds.length > 0) {
        await this.recycle(recycledIds, operator, t, true);
      }
    });

    await this.persistFingerprintCache();

    const summary = {
      success: true,
      groups: processedGroups,
      keptCount,
      removedCount,
      referencesUpdated,
      recycledIds,
    };

    await this.writeAuditLog('deduplicate', operator, { preferredStorageId }, summary);
    return summary;
  }

  async purge(attachmentIds: (string | number)[], operator?: AuditOperator | string | number) {
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (recycleRepo) {
      await recycleRepo.destroy({
        filter: {
          attachmentId: attachmentIds,
        },
      });
    }

    const attachmentsRepo = this.db.getRepository('attachments');
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

    for (const id of attachmentIds) {
      this.cacheMap.delete(id);
    }
    this.cacheDirty = true;
    void this.persistFingerprintCache();

    const result = { success: true, count: destroyCount };
    await this.writeAuditLog('purge', operator, { attachmentIds }, result);
    return result;
  }

  /**
   * 原地文件替换：上传新文件覆盖已有附件记录（保持 ID 及所有外部引用关系不变）
   */
  async replaceFile(
    attachmentId: string | number,
    fileInfo: {
      originalFilename?: string;
      filename?: string;
      extname?: string;
      mimetype?: string;
      size: number;
      path?: string;
      buffer?: Buffer;
      tempFilePath?: string;
    },
    operator?: AuditOperator | string | number,
  ) {
    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) throw new Error('attachments collection missing');

    const attachment = await attachmentsRepo.findOne({ filterByTk: attachmentId });
    if (!attachment) throw new Error('目标附件不存在');

    const storageId = attachment.get('storageId');
    const storagesRepo = this.db.getRepository('storages');
    const storage = storageId ? await storagesRepo?.findOne({ filterByTk: storageId }) : null;

    // 确定存储根目录与相对目录
    const docRoot = storage?.get('options')?.documentRoot || process.env.LOCAL_STORAGE_DEST || 'storage/uploads';
    const recPath = attachment.get('path') || '';
    const oldFilename = attachment.get('filename') || '';
    const oldTitle = attachment.get('title') || oldFilename;

    const extname =
      fileInfo.extname ||
      path.extname(fileInfo.originalFilename || fileInfo.filename || '').toLowerCase() ||
      attachment.get('extname') ||
      '';
    const newFilename = oldFilename || `${crypto.randomBytes(16).toString('hex')}${extname}`;
    const targetDir = path.resolve(process.cwd(), docRoot, recPath);
    const targetPath = path.join(targetDir, newFilename);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 写入新物理文件
    if (fileInfo.buffer) {
      fs.writeFileSync(targetPath, fileInfo.buffer);
    } else if (fileInfo.tempFilePath && fs.existsSync(fileInfo.tempFilePath)) {
      fs.copyFileSync(fileInfo.tempFilePath, targetPath);
    }

    const actualSize = fileInfo.size || (fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0);
    const mimetype = fileInfo.mimetype || attachment.get('mimetype') || 'application/octet-stream';
    const title = fileInfo.originalFilename || attachment.get('title') || newFilename;

    // 更新 attachments 表中的物理与元数据
    await attachment.update({
      title,
      filename: newFilename,
      extname,
      mimetype,
      size: actualSize,
      updatedAt: new Date(),
    });

    // 刷新指纹缓存
    const fileHash = `${actualSize}_${newFilename}`;
    this.cacheMap.set(attachmentId, {
      size: actualSize,
      updatedAt: String(attachment.get('updatedAt')),
      path: recPath,
      fileHash,
      isMissingFile: false,
      cachedAt: Date.now(),
    });
    this.cacheDirty = true;
    void this.persistFingerprintCache();

    // 如果该附件之前在回收站中，自动移出回收站
    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (recycleRepo) {
      await recycleRepo.destroy({ filter: { attachmentId } });
    }

    const result = {
      success: true,
      attachmentId,
      oldTitle,
      newTitle: title,
      newSize: actualSize,
      newFilename,
      extname,
      mimetype,
      updatedAt: attachment.get('updatedAt'),
    };

    await this.writeAuditLog('replaceFile', operator, { attachmentId, newFilename, actualSize }, result);
    return result;
  }

  /**
   * 引用迁移替换：将引用 sourceAttachmentId 的所有业务记录改指向 targetAttachmentId
   */
  async replaceReference(
    sourceAttachmentId: string | number,
    targetAttachmentId: string | number,
    recycleSource = true,
    operator?: AuditOperator | string | number,
  ) {
    if (String(sourceAttachmentId) === String(targetAttachmentId)) {
      throw new Error('源附件与目标附件不能相同');
    }

    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) throw new Error('attachments collection missing');

    const sourceAtt = await attachmentsRepo.findOne({ filterByTk: sourceAttachmentId });
    if (!sourceAtt) throw new Error('源附件不存在');

    const targetAtt = await attachmentsRepo.findOne({ filterByTk: targetAttachmentId });
    if (!targetAtt) throw new Error('目标附件不存在');

    const targetId = targetAtt.get('id');
    const refMap = await this.analyzer.findAttachmentReferences();
    const refs = refMap.get(sourceAttachmentId) || [];
    let updatedCount = 0;

    await this.db.sequelize.transaction(async (t: any) => {
      for (const ref of refs) {
        try {
          const repo = this.db.getRepository(ref.collection);
          if (!repo) continue;
          const record = await repo.findOne({ filterByTk: ref.recordId, transaction: t });
          if (!record) continue;

          const currentVal = record.get(ref.field);
          let newVal: any = currentVal;

          if (Array.isArray(currentVal)) {
            newVal = currentVal.map((item) => {
              if (typeof item === 'object' && item !== null && String(item.id) === String(sourceAttachmentId)) {
                return { ...item, id: targetId };
              }
              if (String(item) === String(sourceAttachmentId)) {
                return targetId;
              }
              return item;
            });
          } else if (typeof currentVal === 'object' && currentVal !== null) {
            newVal = { ...currentVal, id: targetId };
          } else if (String(currentVal) === String(sourceAttachmentId)) {
            newVal = targetId;
          }

          await record.update({ [ref.field]: newVal }, { transaction: t });
          updatedCount++;
        } catch (e) {}
      }

      if (recycleSource) {
        await this.recycle([sourceAttachmentId], operator, t, true);
      }
    });

    const result = {
      success: true,
      sourceAttachmentId,
      targetAttachmentId,
      referencesUpdated: updatedCount,
      recycledSource: recycleSource,
    };

    await this.writeAuditLog(
      'replaceReference',
      operator,
      { sourceAttachmentId, targetAttachmentId, recycleSource },
      result,
    );

    return result;
  }

  /**
   * 动态更新或追加持久化快照中的单个附件项，确保刷新页面后替换结果依然生效
   */
  async updateSnapshotItem(item: any) {
    try {
      const settings = await this.getSettings();
      const currentResult = this.currentScanTask.result || settings.lastScanResult;
      if (!currentResult || !Array.isArray(currentResult.items)) return;

      const items: any[] = currentResult.items;
      let found = false;
      const newItems = items.map((it) => {
        if (String(it.id) === String(item.id)) {
          found = true;
          return {
            ...it,
            ...item,
          };
        }
        return it;
      });

      if (!found && item.id) {
        newItems.unshift(item);
      }

      const updatedResult = {
        ...currentResult,
        items: newItems,
      };

      this.currentScanTask.result = updatedResult;
      await this.saveScanSnapshot(updatedResult, Date.now());
    } catch (e) {}
  }

  /**
   * 使用系统已上传的附件记录来替换现有附件（支持原地覆盖或引用迁移）
   */
  async replaceWithAttachment(
    oldAttachmentId: string | number,
    newAttachmentId: string | number,
    mode: 'overwrite' | 'migrate' = 'overwrite',
    operator?: AuditOperator | string | number,
  ) {
    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) throw new Error('attachments collection missing');

    const oldAtt = await attachmentsRepo.findOne({ filterByTk: oldAttachmentId });
    if (!oldAtt) throw new Error('待替换的原始附件不存在');

    const newAtt = await attachmentsRepo.findOne({ filterByTk: newAttachmentId });
    if (!newAtt) throw new Error('新上传的附件记录不存在');

    let finalItem: any = null;

    if (mode === 'overwrite') {
      const oldTitle = oldAtt.get('title') || oldAtt.get('filename');
      const newTitle = newAtt.get('title') || newAtt.get('filename');
      const newFilename = newAtt.get('filename');
      const newExtname = newAtt.get('extname');
      const newMimetype = newAtt.get('mimetype');
      const newSize = Number(newAtt.get('size')) || 0;
      const newPath = newAtt.get('path');
      const newUrl = newAtt.get('url');
      const newStorageId = newAtt.get('storageId');

      await oldAtt.update({
        title: newTitle,
        filename: newFilename,
        extname: newExtname,
        mimetype: newMimetype,
        size: newSize,
        path: newPath,
        url: newUrl,
        storageId: newStorageId,
        updatedAt: new Date(),
      });

      // 删除临时的新附件记录（物理文件保留由 oldAtt 引用）
      await attachmentsRepo.destroy({ filterByTk: newAttachmentId });

      // 如果在回收站中，自动移出回收站
      const recycleRepo = this.db.getRepository('attachmentRecycleBin');
      if (recycleRepo) {
        await recycleRepo.destroy({ filter: { attachmentId: oldAttachmentId } });
      }

      // 刷新缓存
      this.cacheMap.set(oldAttachmentId, {
        size: newSize,
        updatedAt: String(oldAtt.get('updatedAt')),
        path: newPath,
        fileHash: `${newSize}_${newFilename}`,
        isMissingFile: false,
        cachedAt: Date.now(),
      });
      this.cacheDirty = true;
      void this.persistFingerprintCache();

      finalItem = {
        id: oldAttachmentId,
        title: newTitle,
        filename: newFilename,
        extname: newExtname,
        mimetype: newMimetype,
        size: newSize,
        url: newUrl,
        storageId: newStorageId,
        isMissingFile: false,
        isRecycled: false,
        updatedAt: oldAtt.get('updatedAt'),
      };

      await this.updateSnapshotItem(finalItem);

      await this.writeAuditLog(
        'replaceFile',
        operator,
        { oldAttachmentId, newAttachmentId, oldTitle, newTitle, newSize, mode: 'overwrite' },
        { success: true, item: finalItem },
      );
    } else {
      await this.replaceReference(oldAttachmentId, newAttachmentId, true, operator);

      finalItem = {
        id: newAttachmentId,
        title: newAtt.get('title') || newAtt.get('filename'),
        filename: newAtt.get('filename'),
        extname: newAtt.get('extname'),
        mimetype: newAtt.get('mimetype'),
        size: Number(newAtt.get('size')) || 0,
        url: newAtt.get('url'),
        storageId: newAtt.get('storageId'),
        isMissingFile: false,
        isRecycled: false,
        updatedAt: newAtt.get('updatedAt'),
      };

      await this.updateSnapshotItem(finalItem);
    }

    return {
      success: true,
      mode,
      item: finalItem,
    };
  }

  async getSettings(): Promise<CleanerSettings> {
    const settingsRepo = this.db.getRepository('attachmentCleanerSettings');
    const defaults: CleanerSettings = {
      autoCleanEnabled: true,
      retentionDays: 30,
      preferredStorageId: null,
      autoScanEnabled: true,
      autoScanCron: '0 3 * * *',
      lastScanResult: null,
      lastScannedAt: undefined,
      scanCheckpoint: null,
    };

    if (!settingsRepo) {
      return defaults;
    }

    const record = await settingsRepo.findOne({ filter: { key: 'config' } });
    if (!record) {
      return defaults;
    }

    const val = record.get('value') || {};
    return {
      autoCleanEnabled: val.autoCleanEnabled ?? defaults.autoCleanEnabled,
      retentionDays: val.retentionDays ?? defaults.retentionDays,
      preferredStorageId: val.preferredStorageId ?? defaults.preferredStorageId,
      autoScanEnabled: val.autoScanEnabled ?? defaults.autoScanEnabled,
      autoScanCron: val.autoScanCron || defaults.autoScanCron,
      lastScanResult: val.lastScanResult ?? null,
      lastScannedAt: val.lastScannedAt ?? undefined,
      scanCheckpoint: val.scanCheckpoint ?? null,
    };
  }

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

  async autoCleanExpired() {
    const settings = await this.getSettings();
    if (!settings.autoCleanEnabled) {
      return { success: true, count: 0, reason: 'auto clean disabled' };
    }

    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    if (!recycleRepo) return { success: false, reason: 'RecycleBin missing' };

    const retentionDays = Number(settings.retentionDays) || 30;
    const thresholdDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const expiredRecords = await recycleRepo.find({
      filter: {
        recycledAt: {
          $lt: thresholdDate,
        },
      },
    });

    if (expiredRecords.length === 0) {
      return { success: true, count: 0 };
    }

    const expiredAttachmentIds = expiredRecords.map((r) => r.get('attachmentId'));
    const result = await this.purge(expiredAttachmentIds, { id: 'cron', name: '定时清理任务' });
    await this.writeAuditLog(
      'autoCleanExpired',
      { id: 'cron', name: '定时清理任务' },
      { retentionDays, thresholdDate },
      result,
    );
    return result;
  }
}
