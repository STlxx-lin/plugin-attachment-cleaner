/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { AuditOperator } from '../services/AttachmentCleanerService';
import PluginAttachmentCleanerServer from '../plugin';

function getOperator(ctx: Context): AuditOperator | undefined {
  const user = ctx.state?.currentUser;
  if (!user) return undefined;
  return { id: user.id, name: user.nickname || user.username };
}

export function registerCleanerActions(plugin: PluginAttachmentCleanerServer) {
  plugin.app.resourcer.define({
    name: 'attachmentCleaners',
    actions: {
      async scan(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.scan();
        ctx.body = result;
        await next();
      },

      async startScan(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.startScan(true);
        ctx.body = result;
        await next();
      },

      async getScanProgress(ctx: Context, next: () => Promise<void>) {
        const result = plugin.cleanerService.getScanProgress();
        ctx.body = result;
        await next();
      },

      async getLastScanResult(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.getLastScanResult();
        ctx.body = result;
        await next();
      },

      async recycle(ctx: Context, next: () => Promise<void>) {
        const { attachmentIds } = ctx.action.params?.values || ctx.request.body || {};
        if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
          ctx.throw(400, 'attachmentIds must be a non-empty array');
        }
        const result = await plugin.cleanerService.recycle(attachmentIds, getOperator(ctx));
        ctx.body = result;
        await next();
      },

      async restore(ctx: Context, next: () => Promise<void>) {
        const { attachmentIds } = ctx.action.params?.values || ctx.request.body || {};
        if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
          ctx.throw(400, 'attachmentIds must be a non-empty array');
        }
        const result = await plugin.cleanerService.restore(attachmentIds, getOperator(ctx));
        ctx.body = result;
        await next();
      },

      async purge(ctx: Context, next: () => Promise<void>) {
        const { attachmentIds } = ctx.action.params?.values || ctx.request.body || {};
        if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
          ctx.throw(400, 'attachmentIds must be a non-empty array');
        }
        const result = await plugin.cleanerService.purge(attachmentIds, getOperator(ctx));
        ctx.body = result;
        await next();
      },

      async deduplicate(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.deduplicate(getOperator(ctx));
        ctx.body = result;
        await next();
      },

      async getSettings(ctx: Context, next: () => Promise<void>) {
        const settings = await plugin.cleanerService.getSettings();
        ctx.body = settings;
        await next();
      },

      async storages(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.listStorages();
        ctx.body = result;
        await next();
      },

      async updateSettings(ctx: Context, next: () => Promise<void>) {
        const settings = ctx.action.params?.values || ctx.request.body || {};
        const updated = await plugin.cleanerService.updateSettings(settings, getOperator(ctx));
        ctx.body = updated;
        await next();
      },

      async auditLogs(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.listAuditLogs();
        ctx.body = result;
        await next();
      },

      async clearAuditLogs(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.clearAuditLogs();
        ctx.body = result;
        await next();
      },
    },
  });

  plugin.app.acl.allow('attachmentCleaners', '*', 'loggedIn');
}
