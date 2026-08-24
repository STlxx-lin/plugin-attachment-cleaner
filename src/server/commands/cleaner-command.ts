/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application } from '@nocobase/server';
import PluginAttachmentCleanerServer from '../plugin';

export function registerCleanerCommands(app: Application) {
  app
    .command('attachment-cleaner:scan')
    .description('扫描并分析未被使用及重复的附件')
    .action(async (options, k) => {
      const command = k.cli;
      const app = command.app as Application;
      const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;

      if (!plugin) {
        console.error('Plugin @nocobase/plugin-attachment-cleaner is not loaded.');
        return;
      }

      console.log('开始扫描未使用的附件与重复文件...');
      const result = await plugin.cleanerService.scan();

      console.log('\n===== 附件分析报告 =====');
      console.log(`总附件数量: ${result.stats.totalCount}`);
      console.log(`总存储空间: ${(result.stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(
        `未被使用附件: ${result.stats.unusedCount} 个 (${(result.stats.unusedSize / 1024 / 1024).toFixed(2)} MB)`,
      );
      console.log(
        `重复文件: ${result.stats.duplicateCount} 个 (潜在可节省: ${(
          result.stats.duplicateWastedSize /
          1024 /
          1024
        ).toFixed(2)} MB)`,
      );
      console.log(`回收站保留: ${result.stats.recycledCount} 个`);
      console.log('==========================\n');
    });

  app
    .command('attachment-cleaner:clean')
    .description('自动物理擦除回收站中超期的附件文件')
    .option('--days <days>', '回收站天数阈值')
    .action(async (options, k) => {
      const command = k.cli;
      const app = command.app as Application;
      const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;

      if (!plugin) {
        console.error('Plugin @nocobase/plugin-attachment-cleaner is not loaded.');
        return;
      }

      if (options.days) {
        await plugin.cleanerService.updateSettings({ retentionDays: Number(options.days) });
      }

      console.log('执行回收站过期附件自动物理清理...');
      const result = await plugin.cleanerService.autoCleanExpired();
      console.log(`自动清理完成。共擦除物理附件: ${result.purgedCount || 0} 个`);
    });

  app
    .command('attachment-cleaner:dedup')
    .description('对重复文件去重：每组只保留一个，其余移入回收站并重定向引用')
    .action(async (options, k) => {
      const command = k.cli;
      const app = command.app as Application;
      const plugin = app.pm.get(PluginAttachmentCleanerServer) as PluginAttachmentCleanerServer;

      if (!plugin) {
        console.error('Plugin @nocobase/plugin-attachment-cleaner is not loaded.');
        return;
      }

      console.log('开始对重复文件去重...');
      const result = await plugin.cleanerService.deduplicate();
      console.log(`去重完成：处理 ${result.groups} 组，保留 ${result.keptCount} 个，`);
      console.log(`移除 ${result.removedCount} 个附件，更新 ${result.referencesUpdated} 处引用（${result.recordsUpdated} 条记录）。`);
    });
}
