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
import {
  AttachmentAnalyzer,
  AttachmentAnalysisItem,
  AttachmentReference,
  ScanCheckpointData,
  FileFingerprintCacheEntry,
  FingerprintCacheMap,
  ScanPausedError,
  FileStreamProvider,
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
  /** 最近一次扫描完成时间 (ISO String) */
  lastScannedAt?: string;
  /** 快照条目是否因超过 MAX_SNAPSHOT_ITEMS 被截断 */
  lastScanTruncated?: boolean;
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

/** 持久化快照最多保留的附件条数：截断时优先保留被标记的附件（未引用/重复/回收站/丢失） */
const MAX_SNAPSHOT_ITEMS = 10000;

/** 单页快照查询默认与最大页大小 */
const SNAPSHOT_DEFAULT_PAGE_SIZE = 50;
const SNAPSHOT_MAX_PAGE_SIZE = 200;

export type SnapshotFilter = 'all' | 'unused' | 'duplicate' | 'recycled' | 'missing';

export interface SnapshotQuery {
  page?: number;
  pageSize?: number;
  filter?: SnapshotFilter;
  search?: string;
}

export interface DedupTaskState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  phaseText?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  result?: DeduplicateSummary;
}

export interface DeduplicateFailedReference {
  attachmentId?: string | number;
  collection: string;
  recordId: string | number;
  field: string;
  error: string;
}

export interface DeduplicateSummary {
  success: boolean;
  reason?: string;
  groups?: number;
  keptCount?: number;
  removedCount?: number;
  referencesUpdated?: number;
  recycledIds?: (string | number)[];
  skippedIds?: (string | number)[];
  failedReferences?: DeduplicateFailedReference[];
}

export class AttachmentCleanerService {
  private analyzer: AttachmentAnalyzer;
  private shouldPauseScan = false;
  /** 取消请求：与暂停区分，用于中断后彻底清除断点而不进入 paused 状态 */
  private shouldCancelScan = false;
  private cacheMap: FingerprintCacheMap = new Map();
  private cacheDirty = false;
  private autoCleanCronJob: any = null;
  private autoScanCronJob: any = null;
  private currentDedupTask: DedupTaskState = { status: 'idle' };

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

  /** 注入文件流读取器（测试或自定义存储接入用），透传给分析器 */
  setFileStreamProvider(provider?: FileStreamProvider) {
    this.analyzer.setFileStreamProvider(provider);
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
   * settings 集合按 key 拆分为多行，避免单一 config 行膨胀：
   * - config：小体积运行配置 + 扫描统计摘要
   * - lastScanItems：快照条目（上限 MAX_SNAPSHOT_ITEMS，截断时优先保留被标记附件）
   * - scanCheckpoint：扫描断点（usedIdList 可能很大，独立存放）
   * - fingerprintCache：文件指纹缓存（上限 3000）
   */
  private async getSettingRow<T = any>(key: string): Promise<T | null> {
    try {
      const repo = this.db.getRepository('attachmentCleanerSettings');
      if (!repo) return null;
      const record = await repo.findOne({ filter: { key } });
      return record ? (record.get('value') as T) : null;
    } catch {
      return null;
    }
  }

  private async saveSettingRow(key: string, value: any) {
    const repo = this.db.getRepository('attachmentCleanerSettings');
    if (!repo) return;
    const record = await repo.findOne({ filter: { key } });
    if (record) {
      await repo.update({ filter: { key }, values: { value } });
    } else {
      await repo.create({ values: { key, value } });
    }
  }

  /** 快照条目瘦身映射 */
  private leanSnapshotItem(item: any) {
    return {
      id: item.id,
      title: item.title,
      filename: item.filename,
      extname: item.extname,
      size: item.size,
      mimetype: item.mimetype,
      url: item.url,
      storageId: item.storageId,
      storageName: item.storageName,
      storageType: item.storageType,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isUnused: item.isUnused,
      isDuplicate: item.isDuplicate,
      duplicateGroupId: item.duplicateGroupId,
      duplicateCount: item.duplicateCount,
      isRecycled: item.isRecycled,
      recycledAt: item.recycledAt,
      isMissingFile: item.isMissingFile,
    };
  }

  private isFlaggedItem(item: any): boolean {
    return Boolean(item?.isUnused || item?.isDuplicate || item?.isRecycled || item?.isMissingFile);
  }

  /**
   * 从数据库加载文件指纹缓存
   */
  private async loadFingerprintCache() {
    const val = await this.getSettingRow<any[]>('fingerprintCache');
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

  /**
   * 持久化文件指纹缓存到数据库（最多保留最新 3000 条，防止单行 JSON 爆炸）
   */
  private async persistFingerprintCache() {
    if (!this.cacheDirty) return;
    try {
      const cacheList: any[] = [];
      for (const [id, entry] of this.cacheMap.entries()) {
        cacheList.push({
          id,
          size: entry.size,
          updatedAt: entry.updatedAt,
          path: entry.path,
          fileHash: entry.fileHash,
          isMissingFile: entry.isMissingFile,
          cachedAt: entry.cachedAt,
        });
      }

      // 截取最新 3000 条
      await this.saveSettingRow('fingerprintCache', cacheList.slice(-3000));
      this.cacheDirty = false;
    } catch (e) {}
  }

  /**
   * 保存最近一次全盘扫描快照。
   * 条目与配置拆分存储：config 行只保留统计摘要等小字段；
   * 条目行超过 MAX_SNAPSHOT_ITEMS 时截断，优先保留被标记的附件（未引用/重复/回收站/丢失）。
   */
  async saveScanSnapshot(result: any, completedAt: number) {
    try {
      const leanItems: any[] = Array.isArray(result?.items) ? result.items.map((item: any) => this.leanSnapshotItem(item)) : [];

      let truncated = false;
      let stored = leanItems;
      if (leanItems.length > MAX_SNAPSHOT_ITEMS) {
        truncated = true;
        const flagged = leanItems.filter((it) => this.isFlaggedItem(it));
        const rest = leanItems.filter((it) => !this.isFlaggedItem(it));
        stored = [...flagged, ...rest].slice(0, MAX_SNAPSHOT_ITEMS);
      }

      await this.saveSettingRow('lastScanItems', { completedAt, items: stored });

      const current = await this.getSettings();
      await this.saveSettingRow('config', {
        ...current,
        lastScannedAt: new Date(completedAt).toISOString(),
        lastScanTruncated: truncated,
      });
      await this.saveSettingRow('scanCheckpoint', null);
    } catch (e) {}
  }

  /**
   * 保存断点检查点到数据库（独立行，避免拖累 config）
   */
  async saveCheckpoint(checkpoint: ScanCheckpointData | null) {
    try {
      await this.saveSettingRow('scanCheckpoint', checkpoint);
    } catch (e) {}
  }

  /** 快照条目按过滤条件与关键词筛选 */
  private filterSnapshotItems(items: any[], filter: SnapshotFilter, search: string): any[] {
    let list = items;
    if (filter === 'unused') list = list.filter((it) => it.isUnused && !it.isRecycled);
    else if (filter === 'duplicate') list = list.filter((it) => it.isDuplicate && !it.isRecycled);
    else if (filter === 'recycled') list = list.filter((it) => it.isRecycled);
    else if (filter === 'missing') list = list.filter((it) => it.isMissingFile);
    else list = list.filter((it) => !it.isRecycled);

    const q = (search || '').trim().toLowerCase();
    if (q) {
      list = list.filter(
        (it) =>
          String(it.title || '').toLowerCase().includes(q) ||
          String(it.filename || '').toLowerCase().includes(q) ||
          String(it.id) === q,
      );
    }
    return list;
  }

  /**
   * 获取最近一次扫描结果快照（分页）与断点状态。
   * 条目支持 page/pageSize/filter/search 服务端筛选，避免全量下发。
   */
  async getLastScanResult(query: SnapshotQuery = {}): Promise<{
    hasSnapshot: boolean;
    lastScannedAt?: string;
    result: {
      stats: any;
      truncated: boolean;
      items: any[];
      total: number;
      page: number;
      pageSize: number;
      filter: SnapshotFilter;
      search: string;
    };
    taskState: ScanTaskState;
    checkpoint?: ScanCheckpointData | null;
    settings: CleanerSettings;
  }> {
    const settings = await this.getSettings();
    const taskState = this.getScanProgress();
    const checkpoint = taskState.checkpoint || (await this.getSettingRow<ScanCheckpointData | null>('scanCheckpoint')) || null;

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(SNAPSHOT_MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || SNAPSHOT_DEFAULT_PAGE_SIZE));
    const filter: SnapshotFilter = (['all', 'unused', 'duplicate', 'recycled', 'missing'] as const).includes(
      query.filter as SnapshotFilter,
    )
      ? (query.filter as SnapshotFilter)
      : 'all';
    const search = String(query.search || '');

    let items: any[] = [];
    if (taskState.result && Array.isArray(taskState.result.items)) {
      items = taskState.result.items;
    } else {
      const row = await this.getSettingRow<{ items: any[] }>('lastScanItems');
      items = row && Array.isArray(row.items) ? row.items : [];
    }

    const filtered = this.filterSnapshotItems(items, filter, search);
    const total = filtered.length;
    const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

    // 统计直接由快照条目实时计算：回收/还原/替换后的条目状态已同步更新，统计随之保持一致
    const stats = {
      totalCount: items.length,
      totalSize: 0,
      unusedCount: 0,
      unusedSize: 0,
      duplicateCount: 0,
      duplicateWastedSize: 0,
      recycledCount: 0,
      missingFileCount: 0,
      missingFileSize: 0,
    };
    for (const it of items) {
      const sz = Number(it.size) || 0;
      stats.totalSize += sz;
      if (it.isRecycled) stats.recycledCount += 1;
      if (it.isMissingFile) {
        stats.missingFileCount += 1;
        stats.missingFileSize += sz;
      }
      if (it.isDuplicate && !it.isRecycled) {
        stats.duplicateCount += 1;
        stats.duplicateWastedSize += sz;
      }
      if (it.isUnused && !it.isRecycled) {
        stats.unusedCount += 1;
        stats.unusedSize += sz;
      }
    }

    return {
      hasSnapshot: Boolean(taskState.result || items.length > 0 || settings.lastScannedAt),
      lastScannedAt: settings.lastScannedAt,
      result: {
        stats,
        truncated: Boolean(settings.lastScanTruncated),
        items: paged,
        total,
        page,
        pageSize,
        filter,
        search,
      },
      taskState: {
        ...taskState,
        checkpoint,
      },
      checkpoint,
      settings,
    };
  }

  /**
   * 写入一条操作审计日志。
   * 未显式传入事务时自建事务包裹：NocoBase 仓库的写方法会自动开事务，
   * 而 sqlite 单连接下嵌套自动事务会互相冲突，必须显式管理。
   */
  private async writeAuditLog(
    action: string,
    operator: AuditOperator | string | number | undefined,
    params: any,
    result: any,
    transaction?: any,
  ) {
    const run = async (t: any) => {
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
        transaction: t,
      });

      const total = await repo.count({ transaction: t });
      if (total > AUDIT_LOG_LIMIT) {
        const keep = await repo.find({ sort: '-createdAt', limit: AUDIT_LOG_LIMIT, transaction: t });
        const keepIds = keep.map((r) => r.get('id')).filter(Boolean);
        if (keepIds.length > 0) {
          await repo.destroy({
            filter: {
              id: { $notIn: keepIds },
            },
            transaction: t,
          });
        }
      }
    };

    try {
      if (transaction) {
        await run(transaction);
      } else {
        await this.db.sequelize.transaction(run);
      }
    } catch (e: any) {
      // 审计写入失败不应阻断业务操作，但必须留下排查线索
      this.app.logger?.warn?.(`[attachment-cleaner] 写入审计日志失败: ${e?.message || e}`);
    }
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
    // filter 类 destroy 必须显式事务（见 writeAuditLog 中说明）
    const count = await this.db.sequelize.transaction((t: any) =>
      repo.destroy({ filter: { id: { $not: null } }, transaction: t }),
    );
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
   * 取消当前扫描任务并清空断点。
   * 通过 shouldCancelScan 标记与运行中的扫描协同：后续的断点保存被跳过，
   * ScanPausedError 到达时任务进入 idle 而非 paused，避免取消后状态/断点被写回。
   */
  async cancelScan(): Promise<{ success: boolean; message: string }> {
    this.shouldPauseScan = true;
    this.shouldCancelScan = true;
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
    this.shouldCancelScan = false;
    let checkpointToUse: ScanCheckpointData | null = null;

    if (resume) {
      checkpointToUse =
        this.currentScanTask.checkpoint || (await this.getSettingRow<ScanCheckpointData | null>('scanCheckpoint')) || null;
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
            if (this.shouldCancelScan) {
              // 已请求取消：不再写回断点
              return;
            }
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
          if (this.shouldCancelScan) {
            // 取消：彻底进入空闲态并清空断点（cancelScan 中已清理过，这里兜底收尾）
            this.shouldCancelScan = false;
            this.shouldPauseScan = false;
            this.currentScanTask = {
              taskId: '',
              status: 'idle',
              phase: 'init',
              phaseText: '扫描已取消',
              percent: 0,
              checkpoint: null,
            };
            await this.saveCheckpoint(null);
            await this.persistFingerprintCache();
            return this.getScanProgress();
          }
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

  /**
   * 后台异步执行去重（HTTP 场景使用）：立即返回进度，完成后可通过 getDedupProgress 查询结果。
   * CLI 场景仍直接使用同步的 deduplicate()。
   */
  startDeduplication(operator?: AuditOperator | string | number): DedupTaskState {
    if (this.currentDedupTask.status === 'running') {
      return this.getDedupProgress();
    }

    const startedAt = Date.now();
    this.currentDedupTask = { status: 'running', phaseText: '正在分析重复文件与引用关系...', startedAt };

    void (async () => {
      try {
        const result = await this.deduplicate(operator);
        const completedAt = Date.now();
        this.currentDedupTask = {
          status: 'completed',
          phaseText: '去重完成',
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          result,
        };
      } catch (err: any) {
        const completedAt = Date.now();
        this.currentDedupTask = {
          status: 'failed',
          phaseText: `去重失败: ${err?.message || '未知错误'}`,
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          error: err?.message || String(err),
        };
      }
    })();

    return this.getDedupProgress();
  }

  getDedupProgress(): DedupTaskState {
    return { ...this.currentDedupTask };
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

    const perform = async (t: any) => {
      if (records.length > 0) {
        // destroy + create 组成 upsert 语义（防止重复回收），必须同事务保证原子性
        await recycleRepo.destroy({
          filter: {
            attachmentId: attachmentIds,
          },
          transaction: t,
        });

        await recycleRepo.create({
          values: records,
          transaction: t,
        });
      }

      const result = { success: true, count: attachmentIds.length };
      if (!skipAudit) {
        await this.writeAuditLog('recycle', operator, { attachmentIds }, result, t);
      }
      return result;
    };

    // 注意：sqlite 单连接下，已开启的事务内再执行未显式传 transaction 的写操作会自启 BEGIN 而冲突，
    // 因此快照同步必须在事务完全结束后进行（快照为尽力而为的缓存，不参与事务）。
    let result: { success: boolean; count: number };
    if (transaction) {
      result = await perform(transaction);
    } else {
      result = await this.db.sequelize.transaction(perform);
      if (records.length > 0) {
        await this.markSnapshotItemsRecycled(attachmentIds, true, now);
      }
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

    // 未显式传入事务时自建事务：避免仓库内部对 filter 类 destroy 嵌套自动事务（sqlite 单连接冲突）
    const destroyCount = transaction
      ? await recycleRepo.destroy({
          filter: {
            attachmentId: attachmentIds,
          },
          transaction,
        })
      : await this.db.sequelize.transaction((t: any) =>
          recycleRepo.destroy({
            filter: {
              attachmentId: attachmentIds,
            },
            transaction: t,
          }),
        );

    // 快照同步仅在没有外部事务时进行（见 recycle 中的说明）
    if (!transaction) {
      await this.markSnapshotItemsRecycled(attachmentIds, false);
    }

    const result = { success: true, count: destroyCount };
    if (!skipAudit) {
      await this.writeAuditLog('restore', operator, { attachmentIds }, result, transaction);
    }
    return result;
  }

  async deduplicate(operator?: AuditOperator | string | number): Promise<DeduplicateSummary> {
    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) {
      return { success: false, reason: 'attachments repository not found' };
    }

    const recycleRepo = this.db.getRepository('attachmentRecycleBin');
    const recycledRecords = recycleRepo ? await recycleRepo.find() : [];
    const recycledSet = new Set(recycledRecords.map((r) => r.get('attachmentId')));

    const allAttachments: any[] = [];
    let page = 0;
    while (true) {
      const batch = await attachmentsRepo.find({
        sort: ['-createdAt'],
        limit: 300,
        offset: page * 300,
      });
      if (!batch || batch.length === 0) break;
      allAttachments.push(...batch);
      if (batch.length < 300) break;
      page++;
    }
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
    const skippedIds: (string | number)[] = [];
    const failedReferences: Array<{
      attachmentId: string | number;
      collection: string;
      recordId: string | number;
      field: string;
      error: string;
    }> = [];

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
          const refs = refMap.get(dup.id) || [];
          let hasFailure = false;

          for (const ref of refs) {
            try {
              const repo = this.db.getRepository(ref.collection);
              if (!repo) {
                hasFailure = true;
                failedReferences.push({
                  attachmentId: dup.id,
                  collection: ref.collection,
                  recordId: ref.recordId,
                  field: ref.field,
                  error: 'repository not found',
                });
                continue;
              }
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
            } catch (e: any) {
              // 引用更新失败必须显式上报：失败的重复项不进入回收站，避免业务数据指向已被回收的附件
              hasFailure = true;
              failedReferences.push({
                attachmentId: dup.id,
                collection: ref.collection,
                recordId: ref.recordId,
                field: ref.field,
                error: e?.message || String(e),
              });
              this.app.logger?.warn?.(
                `[attachment-cleaner] 去重引用更新失败: 附件 ${dup.id} @ ${ref.collection}.${ref.field}(#${ref.recordId}): ${e?.message || e}`,
              );
            }
          }

          if (hasFailure) {
            skippedIds.push(dup.id);
          } else {
            recycledIds.push(dup.id);
            removedCount++;
          }
        }
      }

      if (recycledIds.length > 0) {
        await this.recycle(recycledIds, operator, t, true);
      }
    });

    // 事务结束后同步快照条目（recycle 在外部事务内运行时不会自行同步，见 recycle 中说明）
    if (recycledIds.length > 0) {
      await this.markSnapshotItemsRecycled(recycledIds, true, new Date());
    }

    await this.persistFingerprintCache();

    const summary = {
      success: true,
      groups: processedGroups,
      keptCount,
      removedCount,
      referencesUpdated,
      recycledIds,
      skippedIds,
      failedReferences,
    };

    await this.writeAuditLog('deduplicate', operator, { preferredStorageId }, summary);
    return summary;
  }

  async purge(attachmentIds: (string | number)[], operator?: AuditOperator | string | number) {
    const attachmentsRepo = this.db.getRepository('attachments');
    if (!attachmentsRepo) {
      const failed = { success: false, count: 0 };
      await this.writeAuditLog('purge', operator, { attachmentIds }, failed);
      return failed;
    }

    // 物理文件由 file-manager 的全局 afterDestroy 钩子负责删除（local: unlink，OSS/S3/COS: 对应 client），
    // paranoid 存储会保留文件（平台语义）。显式事务包裹两步删除：
    // sqlite 单连接下，不带显式事务的 filter 类 destroy 会在仓库内部嵌套自动事务并相互冲突。
    // 先删附件记录再清回收站：若第二步失败，残留的回收站记录会在下轮 autoCleanExpired 中自愈重试。
    let destroyCount = 0;
    await this.db.sequelize.transaction(async (t: any) => {
      destroyCount = await attachmentsRepo.destroy({
        filter: {
          id: attachmentIds,
        },
        transaction: t,
      });

      const recycleRepo = this.db.getRepository('attachmentRecycleBin');
      if (recycleRepo) {
        await recycleRepo.destroy({
          filter: {
            attachmentId: attachmentIds,
          },
          transaction: t,
        });
      }
    });

    for (const id of attachmentIds) {
      this.cacheMap.delete(id);
    }
    this.cacheDirty = true;
    await this.persistFingerprintCache();

    // 同步快照：移除已彻底删除的条目（尽力而为，下次扫描会全量校正）
    await this.removeSnapshotItems(attachmentIds);

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

    // 仅支持本地存储：云存储（OSS/S3/COS）无法通过本地写文件完成内容覆盖
    const storageType = storage?.get('type');
    if (storageType && storageType !== 'local') {
      throw new Error('非本地存储的附件不支持直接覆盖文件内容，请使用「上传新附件后覆盖替换」模式');
    }

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

    // 路径防逃逸：recPath/filename 来自数据，必须确保最终写入位置不会越出存储根目录
    const resolvedRoot = path.resolve(process.cwd(), docRoot);
    if (targetPath !== resolvedRoot && !targetPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error('非法的附件存储路径，已阻止写入');
    }

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

    // 刷新指纹缓存：内容已变化，内容指纹清空待下次扫描重算
    this.cacheMap.set(attachmentId, {
      size: actualSize,
      updatedAt: String(attachment.get('updatedAt')),
      path: recPath,
      fileHash: '',
      isMissingFile: false,
      cachedAt: Date.now(),
    });
    this.cacheDirty = true;
    await this.persistFingerprintCache();

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
    const failedReferences: Array<{
      collection: string;
      recordId: string | number;
      field: string;
      error: string;
    }> = [];

    await this.db.sequelize.transaction(async (t: any) => {
      for (const ref of refs) {
        try {
          const repo = this.db.getRepository(ref.collection);
          if (!repo) {
            failedReferences.push({
              collection: ref.collection,
              recordId: ref.recordId,
              field: ref.field,
              error: 'repository not found',
            });
            continue;
          }
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
        } catch (e: any) {
          failedReferences.push({
            collection: ref.collection,
            recordId: ref.recordId,
            field: ref.field,
            error: e?.message || String(e),
          });
          this.app.logger?.warn?.(
            `[attachment-cleaner] 引用迁移更新失败: ${ref.collection}.${ref.field}(#${ref.recordId}): ${e?.message || e}`,
          );
        }
      }

      // 存在更新失败的引用时不能回收源附件，否则失败的业务记录将指向已被回收的附件
      if (recycleSource && failedReferences.length === 0) {
        await this.recycle([sourceAttachmentId], operator, t, true);
      }
    });

    const recycledSource = recycleSource && failedReferences.length === 0;
    const result = {
      success: true,
      sourceAttachmentId,
      targetAttachmentId,
      referencesUpdated: updatedCount,
      recycledSource,
      failedReferences,
    };

    await this.writeAuditLog(
      'replaceReference',
      operator,
      { sourceAttachmentId, targetAttachmentId, recycleSource },
      result,
    );

    return result;
  }

  /** 将单个附件项合并进快照（内存与持久化行），确保刷新页面后替换结果依然生效 */
  async updateSnapshotItem(item: any) {
    try {
      if (!item || item.id === undefined) return;

      // 1) 内存中的扫描结果
      if (this.currentScanTask.result && Array.isArray(this.currentScanTask.result.items)) {
        this.currentScanTask.result = this.mergeSnapshotItem(this.currentScanTask.result, item);
      }

      // 2) 持久化的 lastScanItems 行（只改对应条目，不重建整份扫描结果）
      const row = await this.getSettingRow<{ completedAt: number; items: any[] }>('lastScanItems');
      if (row && Array.isArray(row.items)) {
        await this.saveSettingRow('lastScanItems', this.mergeSnapshotItem(row, item));
      }
    } catch (e) {}
  }

  private mergeSnapshotItem<T extends { items: any[] }>(snapshot: T, item: any): T {
    let found = false;
    const items = snapshot.items.map((it) => {
      if (String(it.id) === String(item.id)) {
        found = true;
        return { ...it, ...item };
      }
      return it;
    });
    if (!found && item.id !== undefined) {
      items.unshift(this.leanSnapshotItem(item));
    }
    return { ...snapshot, items };
  }

  /** 批量更新快照条目的回收状态（内存与持久化行），保证回收/还原后刷新页面数据依然一致 */
  async markSnapshotItemsRecycled(ids: (string | number)[], recycled: boolean, recycledAt?: Date) {
    try {
      if (!ids || ids.length === 0) return;
      const idSet = new Set(ids.map(String));
      const apply = (snapshot: { items: any[] } | null | undefined) => {
        if (!snapshot || !Array.isArray(snapshot.items)) return snapshot;
        const items = snapshot.items.map((it) =>
          idSet.has(String(it.id))
            ? { ...it, isRecycled: recycled, recycledAt: recycled ? recycledAt || new Date() : undefined }
            : it,
        );
        return { ...snapshot, items };
      };

      if (this.currentScanTask.result && Array.isArray(this.currentScanTask.result.items)) {
        this.currentScanTask.result = apply(this.currentScanTask.result) as any;
      }
      const row = await this.getSettingRow<{ completedAt: number; items: any[] }>('lastScanItems');
      if (row && Array.isArray(row.items)) {
        await this.saveSettingRow('lastScanItems', apply(row));
      }
    } catch (e) {}
  }

  /** 从快照中移除条目（彻底删除后调用，保持分页 total 与统计一致） */
  async removeSnapshotItems(ids: (string | number)[]) {
    try {
      if (!ids || ids.length === 0) return;
      const idSet = new Set(ids.map(String));

      if (this.currentScanTask.result && Array.isArray(this.currentScanTask.result.items)) {
        this.currentScanTask.result = {
          ...this.currentScanTask.result,
          items: this.currentScanTask.result.items.filter((it) => !idSet.has(String(it.id))),
        };
      }
      const row = await this.getSettingRow<{ completedAt: number; items: any[] }>('lastScanItems');
      if (row && Array.isArray(row.items)) {
        await this.saveSettingRow('lastScanItems', {
          ...row,
          items: row.items.filter((it) => !idSet.has(String(it.id))),
        });
      }
    } catch (e) {}
  }

  /**
   * 使用系统已上传的附件记录来替换现有附件（支持原地覆盖或引用迁移）
   *
   * overwrite 语义：保持原附件 ID / URL / 存储路径不变，仅替换其物理文件内容与基础元数据。
   * 注意：NocoBase file-manager 会在附件记录 destroy 时通过全局 afterDestroy 钩子删除物理文件，
   * 因此必须先把新文件内容复制到旧文件的存储 key 上，再销毁新附件记录，顺序不可颠倒。
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
      const oldStorageId = oldAtt.get('storageId');
      const newStorageId = newAtt.get('storageId');
      const oldFilename = oldAtt.get('filename');
      const oldPath = oldAtt.get('path') || '';
      const newTitle = newAtt.get('title') || newAtt.get('filename');
      const newExtname = newAtt.get('extname');
      const newMimetype = newAtt.get('mimetype');
      const newSize = Number(newAtt.get('size')) || 0;

      const sameStorage =
        oldStorageId !== undefined &&
        oldStorageId !== null &&
        String(oldStorageId) === String(newStorageId);

      if (!oldFilename) {
        // 旧记录本就缺文件/文件名（坏记录）：改指向新文件即可。
        // 销毁新记录必须跳过物理删除钩子，否则会删掉旧记录将要引用的文件。
        await oldAtt.update({
          title: newTitle,
          filename: newAtt.get('filename'),
          extname: newExtname,
          mimetype: newMimetype,
          size: newSize,
          path: newAtt.get('path'),
          url: newAtt.get('url'),
          storageId: newStorageId,
          updatedAt: new Date(),
        });
        await attachmentsRepo.destroy({ filterByTk: newAttachmentId, individualHooks: false });
      } else if (!sameStorage) {
        throw new Error(
          '新旧附件位于不同存储空间，无法安全地原地覆盖物理文件；请改用「全局改指向（引用迁移）」模式',
        );
      } else {
        // 同存储原地覆盖：先把新文件内容复制到旧文件 key（URL/文件名保持不变，外部引用不断链），
        // 再销毁新附件记录。任何一步失败都直接中止，保证原附件不被破坏。
        const storagesRepo = this.db.getRepository('storages');
        const storage = storagesRepo ? await storagesRepo.findOne({ filterByTk: oldStorageId }) : null;
        if (!storage) {
          throw new Error('无法定位原附件所属存储空间，已中止替换（原附件未被修改）');
        }
        let copied = false;
        try {
          const fileManagerPlugin = (this.app.pm.get('file-manager') ||
            this.app.pm.get('@nocobase/plugin-file-manager') ||
            this.app.pm.get(PluginFileManagerServer as any)) as any;
          const StorageClass = fileManagerPlugin?.storageTypes?.get?.(storage.get('type'));
          if (StorageClass) {
            const storageInstance = new StorageClass(storage.get({ plain: true }));
            await storageInstance.copy(newAtt.get({ plain: true }), oldAtt.get({ plain: true }));
            copied = true;
          }
        } catch (e: any) {
          throw new Error(`物理文件覆盖失败，已中止替换（原附件未被修改）: ${e?.message || e}`);
        }
        if (!copied) {
          throw new Error('无法初始化存储引擎以执行物理文件覆盖，已中止替换（原附件未被修改）');
        }

        await oldAtt.update({
          title: newTitle,
          extname: newExtname,
          mimetype: newMimetype,
          size: newSize,
          updatedAt: new Date(),
          // filename/path/url/storageId 有意保持不变：文件在原 key 上被新内容覆盖
        });

        // 销毁新附件记录；若其物理 key 与旧 key 恰好相同，必须跳过 afterDestroy 钩子，
        // 防止把刚覆盖生效的物理文件一并删除。
        const sameKey =
          String(newAtt.get('path') || '') === String(oldPath) && newAtt.get('filename') === oldFilename;
        await attachmentsRepo.destroy({
          filterByTk: newAttachmentId,
          individualHooks: !sameKey,
        });
      }

      // 如果在回收站中，自动移出回收站
      const recycleRepo = this.db.getRepository('attachmentRecycleBin');
      if (recycleRepo) {
        await recycleRepo.destroy({ filter: { attachmentId: oldAttachmentId } });
      }

      // 刷新缓存：内容已变化，内容指纹清空待下次扫描重算
      this.cacheMap.set(oldAttachmentId, {
        size: Number(oldAtt.get('size')) || 0,
        updatedAt: String(oldAtt.get('updatedAt')),
        path: String(oldAtt.get('path') || ''),
        fileHash: '',
        isMissingFile: false,
        cachedAt: Date.now(),
      });
      this.cacheDirty = true;
      await this.persistFingerprintCache();

      finalItem = {
        id: oldAttachmentId,
        title: oldAtt.get('title'),
        filename: oldAtt.get('filename'),
        extname: oldAtt.get('extname'),
        mimetype: oldAtt.get('mimetype'),
        size: Number(oldAtt.get('size')) || 0,
        url: oldAtt.get('url'),
        storageId: oldAtt.get('storageId'),
        isMissingFile: false,
        isRecycled: false,
        updatedAt: oldAtt.get('updatedAt'),
      };

      await this.updateSnapshotItem(finalItem);

      await this.writeAuditLog(
        'replaceFile',
        operator,
        {
          oldAttachmentId,
          newAttachmentId,
          oldTitle: oldAtt.get('title'),
          newTitle,
          newSize,
          mode: 'overwrite',
        },
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
    const defaults: CleanerSettings = {
      autoCleanEnabled: true,
      retentionDays: 30,
      preferredStorageId: null,
      // 默认关闭定时扫描：避免升级安装场景下未经配置就自动开始全盘扫描
      autoScanEnabled: false,
      autoScanCron: '0 3 * * *',
      lastScannedAt: undefined,
      lastScanTruncated: false,
    };

    const val = (await this.getSettingRow<any>('config')) || {};
    return {
      autoCleanEnabled: val.autoCleanEnabled ?? defaults.autoCleanEnabled,
      retentionDays: val.retentionDays ?? defaults.retentionDays,
      preferredStorageId: val.preferredStorageId ?? defaults.preferredStorageId,
      autoScanEnabled: val.autoScanEnabled ?? defaults.autoScanEnabled,
      autoScanCron: val.autoScanCron || defaults.autoScanCron,
      lastScannedAt: val.lastScannedAt ?? defaults.lastScannedAt,
      lastScanTruncated: val.lastScanTruncated ?? defaults.lastScanTruncated,
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

    // 扫描策略变化时热更新定时任务（无需重启服务）
    if (settings.autoScanEnabled !== undefined || settings.autoScanCron !== undefined) {
      await this.registerAutoScanCron();
    }

    await this.writeAuditLog('updateSettings', operator, settings, updated);
    return updated;
  }

  /**
   * 注册定时任务。
   * 兼容说明：NocoBase 2.x 的 Application 只暴露 cronJobManager.addJob({ cronTime, onTick })，
   * 不存在 app.cron.add(name, spec, fn)，必须使用本方法注册，否则定时任务会静默失效。
   */
  registerCronJobs() {
    const manager = (this.app as any).cronJobManager;
    if (!manager || typeof manager.addJob !== 'function') {
      this.app.logger?.warn?.('[attachment-cleaner] 当前环境未提供 cronJobManager，定时清理/定时扫描任务未启用');
      return;
    }

    // 1. 定时清理回收站过期附件（每天凌晨 2:00）
    if (!this.autoCleanCronJob) {
      this.autoCleanCronJob = manager.addJob({
        cronTime: '0 2 * * *',
        onTick: async () => {
          try {
            await this.autoCleanExpired();
          } catch (err) {
            this.app.logger.error('[attachment-cleaner] auto clean task error:', err);
          }
        },
      });
    }

    // 2. 定时自动全盘扫描（按配置的 Cron 执行，默认每天凌晨 3:00）
    void this.registerAutoScanCron();
  }

  /** 注册（或按最新配置重建）定时自动全盘扫描任务 */
  async registerAutoScanCron() {
    const manager = (this.app as any).cronJobManager;
    if (!manager || typeof manager.addJob !== 'function') return;

    if (this.autoScanCronJob) {
      try {
        manager.removeJob(this.autoScanCronJob);
      } catch {
        // ignore
      }
      this.autoScanCronJob = null;
    }

    try {
      const settings = await this.getSettings();
      if (!settings.autoScanEnabled) return;

      const cronExpr = settings.autoScanCron || '0 3 * * *';
      const job = manager.addJob({
        cronTime: cronExpr,
        onTick: async () => {
          try {
            this.app.logger.info('[attachment-cleaner] starting scheduled scan...');
            await this.startScan(false);
            this.app.logger.info('[attachment-cleaner] scheduled scan completed.');
          } catch (err) {
            this.app.logger.error('[attachment-cleaner] scheduled scan error:', err);
          }
        },
      });

      // 服务已启动后（如配置热更新）新任务需手动启动；应用启动流程中由 manager.start() 统一启动
      if (manager.started && job && !job.running) {
        try {
          job.start();
        } catch {
          // ignore
        }
      }
      this.autoScanCronJob = job;
    } catch (e: any) {
      this.app.logger?.warn?.(`[attachment-cleaner] 自动扫描任务注册失败: ${e?.message || e}`);
    }
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
