/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
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

  /**
   * 按附件 title 注入文件内容，模拟 file-manager 的文件流读取。
   * 去重必须基于真实内容指纹（sha256），无法提供内容的附件不参与重复分组。
   */
  const mockFileContents = (plugin: PluginAttachmentCleanerServer, contents: Record<string, string>) => {
    plugin.cleanerService.setFileStreamProvider(async (att: any) => {
      const content = contents[String(att.get('title'))];
      if (content === undefined) return null;
      return { stream: Readable.from([content]) };
    });
  };

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

    // 3. 彻底删除（物理文件由 file-manager 的 afterDestroy 钩子处理，mock 环境无 file-manager 仅删记录）
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

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    // 两个内容完全相同的附件（通过注入 provider 提供真实内容）
    mockFileContents(plugin, {
      'dup 1': 'same content bytes',
      'dup 2': 'same content bytes',
    });

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

    const result = await plugin.cleanerService.deduplicate();

    expect(result.groups).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.referencesUpdated).toBe(1);
    expect(result.failedReferences).toHaveLength(0);

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

    // 审计：上方共调用两次 deduplicate（第二次验证幂等），每次各产生 1 条记录（内部 recycle 不重复记录）
    const auditLogs = await plugin.cleanerService.listAuditLogs();
    expect(auditLogs.items.filter((l) => l.action === 'deduplicate')).toHaveLength(2);
    expect(auditLogs.items.filter((l) => l.action === 'recycle')).toHaveLength(0);
  });

  test('should not group files with same size/filename but different content', async () => {
    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    // 回归用例：同大小同文件名但内容不同，绝不允许判为重复（旧版 256KB 截断/元数据指纹会误判）
    mockFileContents(plugin, {
      'case a': 'content A'.repeat(10),
      'case b': 'content B'.repeat(10),
    });

    const attachmentsRepo = app.db.getRepository('attachments');
    await attachmentsRepo.create({
      values: { title: 'case a', filename: 'same.txt', extname: '.txt', size: 100, mimetype: 'text/plain' },
    });
    await attachmentsRepo.create({
      values: { title: 'case b', filename: 'same.txt', extname: '.txt', size: 100, mimetype: 'text/plain' },
    });

    const result = await plugin.cleanerService.deduplicate();
    expect(result.groups).toBe(0);
    expect(result.removedCount).toBe(0);

    const recycleRepo = app.db.getRepository('attachmentRecycleBin');
    expect(await recycleRepo.find()).toHaveLength(0);
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

    // 未传操作人时 operatorName 记为 null（前端展示层兜底显示 system）
    await plugin.cleanerService.updateSettings({ retentionDays: 60 });
    logs = await plugin.cleanerService.listAuditLogs();
    expect(logs.items[0].action).toBe('updateSettings');
    expect(logs.items[0].operatorName).toBeNull();

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

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    mockFileContents(plugin, {
      'in local': 'identical binary content',
      'in s3': 'identical binary content',
    });

    const attachmentsRepo = app.db.getRepository('attachments');
    const attLocal = await attachmentsRepo.create({
      values: { title: 'in local', filename: 'dup.bin', extname: '.bin', size: 100, storageId: 1 },
    });
    const attS3 = await attachmentsRepo.create({
      values: { title: 'in s3', filename: 'dup.bin', extname: '.bin', size: 100, storageId: 2 },
    });

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

  test('should detect references with URL-encoded Chinese filenames in rich text', async () => {
    app.db.collection({
      name: 'articles',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'text', name: 'content' },
      ],
    });
    await app.db.sync();

    const attachmentsRepo = app.db.getRepository('attachments');
    const att = await attachmentsRepo.create({
      values: {
        title: '产品手册 中文.png',
        filename: '产品手册 中文.png',
        extname: '.png',
        size: 2048,
        mimetype: 'image/png',
      },
    });

    // 富文本中以 URL 编码形式引用中文文件名（旧版正则既匹配不到中文，也不做解码，会误判为未引用）
    const articlesRepo = app.db.getRepository('articles');
    await articlesRepo.create({
      values: {
        title: 'doc',
        content:
          '<p>产品介绍</p><img src="/storage/uploads/2024/%E4%BA%A7%E5%93%81%E6%89%8B%E5%86%8C%20%E4%B8%AD%E6%96%87.png" />',
      },
    });

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    const result = await plugin.cleanerService.scan();

    const item = result.items.find((i) => String(i.id) === String(att.id));
    expect(item).toBeTruthy();
    expect(item!.isUnused).toBe(false);
  });

  test('should return paginated snapshot with live stats via getLastScanResult', async () => {
    const attachmentsRepo = app.db.getRepository('attachments');
    for (let i = 1; i <= 3; i++) {
      await attachmentsRepo.create({
        values: {
          title: `snap file ${i}`,
          filename: `snap${i}.txt`,
          extname: '.txt',
          size: 10 * i,
          mimetype: 'text/plain',
        },
      });
    }

    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;
    await plugin.cleanerService.scan();

    // 分页
    const page1 = await plugin.cleanerService.getLastScanResult({ page: 1, pageSize: 2, filter: 'all' });
    expect(page1.result.total).toBe(3);
    expect(page1.result.items).toHaveLength(2);
    expect(page1.result.stats.totalCount).toBe(3);
    expect(page1.result.stats.unusedCount).toBe(3);

    const page2 = await plugin.cleanerService.getLastScanResult({ page: 2, pageSize: 2, filter: 'all' });
    expect(page2.result.items).toHaveLength(1);

    // 按文件名搜索
    const searched = await plugin.cleanerService.getLastScanResult({
      page: 1,
      pageSize: 10,
      filter: 'all',
      search: 'snap2',
    });
    expect(searched.result.total).toBe(1);

    // 回收后过滤与统计实时更新（快照条目随操作同步）
    const all = await plugin.cleanerService.getLastScanResult({ page: 1, pageSize: 10, filter: 'all' });
    const firstId = all.result.items[0].id;
    await plugin.cleanerService.recycle([firstId]);

    const recycled = await plugin.cleanerService.getLastScanResult({ page: 1, pageSize: 10, filter: 'recycled' });
    expect(recycled.result.total).toBe(1);
    expect(recycled.result.stats.recycledCount).toBe(1);

    const unused = await plugin.cleanerService.getLastScanResult({ page: 1, pageSize: 10, filter: 'unused' });
    expect(unused.result.total).toBe(2);
    expect(unused.result.stats.unusedCount).toBe(2);
  });

  test('should run deduplicate as a background task', async () => {
    const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;

    const progress = plugin.cleanerService.startDeduplication();
    expect(progress.status).toBe('running');

    // 轮询直到后台任务结束
    let final: any = null;
    for (let i = 0; i < 100; i++) {
      final = plugin.cleanerService.getDedupProgress();
      if (final.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(final?.status).toBe('completed');
    expect(final?.result?.success).toBe(true);
    expect(final?.result?.removedCount).toBe(0);
  });
});
