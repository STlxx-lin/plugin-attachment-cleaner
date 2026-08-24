/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginAttachmentCleanerServer from '../plugin';

describe('PluginAttachmentCleanerServer', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: [PluginAttachmentCleanerServer],
    });

    await app.load();
    await app.install({ clean: true });

    if (!app.db.hasCollection('attachments')) {
      app.db.collection({
        name: 'attachments',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'string', name: 'filename' },
          { type: 'string', name: 'extname' },
          { type: 'integer', name: 'size' },
          { type: 'string', name: 'mimetype' },
          { type: 'text', name: 'url' },
          { type: 'bigInt', name: 'storageId' },
        ],
      });
    }

    await app.db.sync();
    await app.start();
  });

  afterEach(async () => {
    if (app) {
      try {
        if (app.db) {
          await app.db.clean({ drop: true });
        }
        await app.destroy();
      } catch (e) {
        // ignore cleanup error
      }
    }
  });

  test('should analyze unused attachments and duplicate attachments', async () => {
    const attachmentsRepo = app.db.getRepository('attachments');

    // 1. 创建测试附件记录
    await attachmentsRepo.create({
      values: {
        title: 'File 1',
        filename: 'file1.txt',
        extname: '.txt',
        size: 100,
        mimetype: 'text/plain',
      },
    });

    await attachmentsRepo.create({
      values: {
        title: 'File 2 (Duplicate of File 1)',
        filename: 'file2.txt',
        extname: '.txt',
        size: 100,
        mimetype: 'text/plain',
      },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    const result = await plugin.cleanerService.scan();

    expect(result.stats.totalCount).toBe(2);
    expect(result.stats.unusedCount).toBe(2);
    expect(result.items.length).toBe(2);
  });

  test('should handle recycle, restore and purge workflow', async () => {
    const attachmentsRepo = app.db.getRepository('attachments');

    const att = await attachmentsRepo.create({
      values: {
        title: 'Test Attachment',
        filename: 'test.txt',
        extname: '.txt',
        size: 50,
      },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;

    // 1. 移入回收站
    await plugin.cleanerService.recycle([att.id]);
    let scanResult = await plugin.cleanerService.scan();
    expect(scanResult.stats.recycledCount).toBe(1);

    // 2. 恢复
    await plugin.cleanerService.restore([att.id]);
    scanResult = await plugin.cleanerService.scan();
    expect(scanResult.stats.recycledCount).toBe(0);

    // 3. 彻底物理擦除
    await plugin.cleanerService.recycle([att.id]);
    await plugin.cleanerService.purge([att.id]);

    const count = await attachmentsRepo.count({ filter: { id: att.id } });
    expect(count).toBe(0);
  });

  test('should deduplicate: keep one per duplicate group and redirect references', async () => {
    // 业务集合，带附件字段
    app.db.collection({
      name: 'posts',
      fields: [
        { type: 'string', name: 'title' },
        {
          type: 'belongsToMany',
          name: 'attachments',
          interface: 'attachment',
          target: 'attachments',
          foreignKey: 'postId',
          otherKey: 'attachmentId',
        },
      ],
    });
    await app.db.sync();

    // 两个内容相同的附件（mock 环境无 file-manager，哈希 fallback 为 size_filename，二者同组）
    const attachmentsRepo = app.db.getRepository('attachments');
    const att1 = await attachmentsRepo.create({
      values: { title: 'dup 1', filename: 'dup.txt', extname: '.txt', size: 100, mimetype: 'text/plain' },
    });
    const att2 = await attachmentsRepo.create({
      values: { title: 'dup 2', filename: 'dup.txt', extname: '.txt', size: 100, mimetype: 'text/plain' },
    });

    const postsRepo = app.db.getRepository('posts');
    const post = await postsRepo.create({
      values: { title: 'post', attachments: [{ id: att1.id }, { id: att2.id }] },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    const result = await plugin.cleanerService.deduplicate();

    expect(result.groups).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.referencesUpdated).toBe(1);
    expect(result.recordsUpdated).toBe(1);

    // 引用已收敛到保留文件（每组仅 1 个）
    const updated = await postsRepo.findOne({ filterByTk: post.id, appends: ['attachments'] });
    const refIds = updated.get('attachments').map((a: any) => a.id);
    expect(refIds).toHaveLength(1);
    expect(refIds[0] === att1.id || refIds[0] === att2.id).toBe(true);

    // 被移除的附件进入回收站，且与保留文件不同
    const recycleRepo = app.db.getRepository('attachmentRecycleBin');
    const recycleRecords = await recycleRepo.find();
    expect(recycleRecords).toHaveLength(1);
    const recycledId = recycleRecords[0].get('attachmentId');
    expect(recycledId === att1.id || recycledId === att2.id).toBe(true);
    expect(recycledId).not.toBe(refIds[0]);

    // 再次去重不应再产生移除
    const result2 = await plugin.cleanerService.deduplicate();
    expect(result2.groups).toBe(0);
    expect(result2.removedCount).toBe(0);

    // 审计：去重只产生 1 条 deduplicate 记录（内部 recycle 不重复记录）
    const auditLogs = await plugin.cleanerService.listAuditLogs();
    expect(auditLogs.items.filter((l) => l.action === 'deduplicate')).toHaveLength(1);
    expect(auditLogs.items.filter((l) => l.action === 'recycle')).toHaveLength(0);
  });

  test('should write audit logs for mutations and support clear', async () => {
    const attachmentsRepo = app.db.getRepository('attachments');
    const att = await attachmentsRepo.create({
      values: { title: 'audit', filename: 'audit.txt', extname: '.txt', size: 10, mimetype: 'text/plain' },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    // 安装时 updateSettings 会产生一条审计，先清空以便按计数断言
    await plugin.cleanerService.clearAuditLogs();
    const operator = { id: 'u1', name: 'tester' };

    await plugin.cleanerService.recycle([att.id], operator);
    let logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.count).toBe(1);
    expect(logs.items[0].action).toBe('recycle');
    expect(logs.items[0].operatorId).toBe('u1');
    expect(logs.items[0].operatorName).toBe('tester');

    await plugin.cleanerService.restore([att.id], operator);
    logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.items[0].action).toBe('restore');

    await plugin.cleanerService.purge([att.id], operator);
    logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.items[0].action).toBe('purge');

    // 未传操作人时记为 system
    await plugin.cleanerService.updateSettings({ retentionDays: 60 });
    logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.items[0].action).toBe('updateSettings');
    expect(logs.items[0].operatorName).toBe('system');

    const cleared = await plugin.cleanerService.clearAuditLogs();
    expect(cleared.success).toBe(true);
    logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.count).toBe(0);
  });

  test('should keep file from preferred storage when deduplicating', async () => {
    if (!app.db.hasCollection('storages')) {
      app.db.collection({
        name: 'storages',
        fields: [
          { type: 'integer', name: 'id', primaryKey: true },
          { type: 'string', name: 'title' },
          { type: 'string', name: 'name' },
          { type: 'string', name: 'type' },
        ],
      });
    }
    await app.db.sync();

    const storagesRepo = app.db.getRepository('storages');
    await storagesRepo.create({ values: { id: 1, title: '本地磁盘', name: 'local', type: 'local' } });
    await storagesRepo.create({ values: { id: 2, title: 'S3 存储', name: 's3', type: 's3' } });

    const attachmentsRepo = app.db.getRepository('attachments');
    const attLocal = await attachmentsRepo.create({
      values: { title: 'in local', filename: 'dup.bin', extname: '.bin', size: 100, storageId: 1 },
    });
    const attS3 = await attachmentsRepo.create({
      values: { title: 'in s3', filename: 'dup.bin', extname: '.bin', size: 100, storageId: 2 },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    // 配置优先保留 S3 存储（id=2）
    await plugin.cleanerService.updateSettings({ preferredStorageId: 2 });

    const result = await plugin.cleanerService.deduplicate();
    expect(result.groups).toBe(1);
    expect(result.removedCount).toBe(1);

    // 保留的是 S3 存储中的文件
    const scan = await plugin.cleanerService.scan();
    const kept = scan.items.find((i) => !i.isRecycled)!;
    expect(String(kept.storageId)).toBe('2');

    // 回收站里是本地存储的文件
    const recycleRepo = app.db.getRepository('attachmentRecycleBin');
    const recycled = await recycleRepo.findOne({ filter: { attachmentId: attLocal.id } });
    expect(recycled).toBeTruthy();
    expect(await recycleRepo.findOne({ filter: { attachmentId: attS3.id } })).toBeFalsy();
  });
});
