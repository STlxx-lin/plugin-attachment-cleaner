/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import path from 'path';
import { Plugin, Application, PluginManager } from '@nocobase/server';
import attachmentRecycleBin from './collections/attachmentRecycleBin';
import attachmentCleanerSettings from './collections/attachmentCleanerSettings';
import attachmentCleanerAuditLogs from './collections/attachmentCleanerAuditLogs';
import { AttachmentCleanerService } from './services/AttachmentCleanerService';
import { registerCleanerActions } from './actions/cleaner-actions';
import { registerCleanerCommands } from './commands/cleaner-command';

function ensurePluginEnvironment() {
  if (!process.env.NODE_MODULES_PATH) {
    process.env.NODE_MODULES_PATH = path.resolve(process.cwd(), 'node_modules');
  }
  if (PluginManager) {
    const parsedNames = (PluginManager as any).parsedNames || ((PluginManager as any).parsedNames = {});
    parsedNames['attachment-cleaner'] = {
      name: 'attachment-cleaner',
      packageName: '@nocobase/plugin-attachment-cleaner',
    };
    parsedNames['@nocobase/plugin-attachment-cleaner'] = {
      name: 'attachment-cleaner',
      packageName: '@nocobase/plugin-attachment-cleaner',
    };
  }
}

ensurePluginEnvironment();

export class PluginAttachmentCleanerServer extends Plugin {
  cleanerService: AttachmentCleanerService;

  static async staticImport() {
    ensurePluginEnvironment();
    Application.addCommand(registerCleanerCommands);
  }

  async beforeLoad() {
    if (!this.db.hasCollection('attachmentRecycleBin')) {
      this.db.collection(attachmentRecycleBin);
    }
    if (!this.db.hasCollection('attachmentCleanerSettings')) {
      this.db.collection(attachmentCleanerSettings);
    }
    if (!this.db.hasCollection('attachmentCleanerAuditLogs')) {
      this.db.collection(attachmentCleanerAuditLogs);
    }
    this.cleanerService = new AttachmentCleanerService(this.app);
  }

  async load() {
    registerCleanerActions(this);

    // 注册定时任务（回收站过期清理 + 可配置的定时全盘扫描）。
    // 服务内部使用 app.cronJobManager.addJob 实现，并在配置变化时支持热更新。
    this.cleanerService.registerCronJobs();
  }

  async install() {
    await this.cleanerService.updateSettings({
      autoCleanEnabled: true,
      retentionDays: 30,
      autoScanEnabled: false,
      autoScanCron: '0 3 * * *',
    });
  }
}

export default PluginAttachmentCleanerServer;
