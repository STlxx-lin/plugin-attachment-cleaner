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

    const appWithCron = this.app as any;
    if (appWithCron.cron && typeof appWithCron.cron.add === 'function') {
      // 1. 定时清理回收站过期附件 (每天凌晨 2:00)
      appWithCron.cron.add('attachment-cleaner-auto-clean', '0 2 * * *', async () => {
        try {
          await this.cleanerService.autoCleanExpired();
        } catch (err) {
          this.app.logger.error('[attachment-cleaner] auto clean task error:', err);
        }
      });

      // 2. 定时自动全盘扫描任务 (根据配置的 Cron 执行，默认每天凌晨 3:00)
      try {
        const settings = await this.cleanerService.getSettings();
        if (settings.autoScanEnabled) {
          const cronExpr = settings.autoScanCron || '0 3 * * *';
          appWithCron.cron.add('attachment-cleaner-auto-scan', cronExpr, async () => {
            try {
              this.app.logger.info('[attachment-cleaner] starting scheduled scan...');
              await this.cleanerService.startScan(false);
              this.app.logger.info('[attachment-cleaner] scheduled scan completed.');
            } catch (err) {
              this.app.logger.error('[attachment-cleaner] scheduled scan error:', err);
            }
          });
        }
      } catch (e) {
        // ignore initial cron load error
      }
    }
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
