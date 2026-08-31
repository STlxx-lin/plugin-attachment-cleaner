/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import path from 'path';
import { Context } from '@nocobase/actions';
import { AuditOperator } from '../services/AttachmentCleanerService';
import PluginAttachmentCleanerServer from '../plugin';

/** 直接覆盖附件内容的 base64 体积上限（100MB，base64 编码膨胀约 33% 由客户端负责） */
const MAX_REPLACE_FILE_SIZE = 100 * 1024 * 1024;

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
        const { resume } = ctx.action.params?.values || ctx.request.body || {};
        const result = await plugin.cleanerService.startScan(true, Boolean(resume));
        ctx.body = result;
        await next();
      },

      async pauseScan(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.pauseScan();
        ctx.body = result;
        await next();
      },

      async cancelScan(ctx: Context, next: () => Promise<void>) {
        const result = await plugin.cleanerService.cancelScan();
        ctx.body = result;
        await next();
      },

      async getScanProgress(ctx: Context, next: () => Promise<void>) {
        // 剥离全量扫描结果：条目统一走 getLastScanResult 分页获取，避免轮询响应过大
        const { result, ...progress } = plugin.cleanerService.getScanProgress();
        ctx.body = progress;
        await next();
      },

      async getLastScanResult(ctx: Context, next: () => Promise<void>) {
        const values = (ctx.action.params?.values || {}) as any;
        // 注意：不能使用名为 filter 的查询参数——NocoBase 会拦截 filter 参数做内建过滤解析，
        // 导致自定义 action 被绕过并返回空结果。客户端使用 tab 参数，这里兼容读取旧的 filter。
        const tab = values.tab ?? ctx.request.query?.tab;
        const filter = tab ?? values.filter ?? ctx.request.query?.filter;
        const query = {
          page: values.page ?? ctx.request.query?.page,
          pageSize: values.pageSize ?? ctx.request.query?.pageSize,
          filter,
          search: values.search ?? ctx.request.query?.search,
        };
        const result = await plugin.cleanerService.getLastScanResult(query);
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
        // 后台异步执行：立即返回任务进度，避免大库下请求超时
        const result = plugin.cleanerService.startDeduplication(getOperator(ctx));
        ctx.body = result;
        await next();
      },

      async getDedupProgress(ctx: Context, next: () => Promise<void>) {
        const result = plugin.cleanerService.getDedupProgress();
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

      async replaceFile(ctx: Context, next: () => Promise<void>) {
        const values = ctx.action.params?.values || ctx.request.body || {};
        const { attachmentId, fileBase64, originalFilename, mimetype, size } = values;

        if (!attachmentId) {
          ctx.throw(400, 'attachmentId is required');
        }

        let buffer: Buffer | undefined;
        let tempFilePath: string | undefined;

        // 1. 优先从 multipart files 中提取
        const fileObj =
          (ctx.request as any).files?.file ||
          (ctx.req as any).file ||
          (ctx.request as any).files?.upload ||
          (ctx.request as any).file;

        if (fileObj) {
          tempFilePath = fileObj.path || fileObj.filepath;
          if (!tempFilePath && fileObj.buffer) {
            buffer = fileObj.buffer;
          }
        } else if (fileBase64) {
          // 2. Base64 方式
          const base64Data = String(fileBase64).replace(/^data:.*?;base64,/, '');
          buffer = Buffer.from(base64Data, 'base64');
        }

        if (!buffer && !tempFilePath) {
          ctx.throw(400, '请选择需要上传替换的文件');
        }

        const replaceSize = buffer ? buffer.length : Number(size) || 0;
        if (replaceSize > MAX_REPLACE_FILE_SIZE) {
          ctx.throw(413, `替换文件过大（超过 ${Math.floor(MAX_REPLACE_FILE_SIZE / 1024 / 1024)}MB 限制）`);
        }

        const result = await plugin.cleanerService.replaceFile(
          attachmentId,
          {
            originalFilename: originalFilename || fileObj?.name || fileObj?.originalFilename,
            mimetype: mimetype || fileObj?.type || fileObj?.mimetype,
            size: size || (buffer ? buffer.length : fileObj?.size || 0),
            buffer,
            tempFilePath,
          },
          getOperator(ctx),
        );

        ctx.body = result;
        await next();
      },

      async replaceReference(ctx: Context, next: () => Promise<void>) {
        const { sourceAttachmentId, targetAttachmentId, recycleSource } =
          ctx.action.params?.values || ctx.request.body || {};

        if (!sourceAttachmentId || !targetAttachmentId) {
          ctx.throw(400, 'sourceAttachmentId and targetAttachmentId are required');
        }

        const result = await plugin.cleanerService.replaceReference(
          sourceAttachmentId,
          targetAttachmentId,
          recycleSource !== false,
          getOperator(ctx),
        );

        ctx.body = result;
        await next();
      },

      async replaceWithAttachment(ctx: Context, next: () => Promise<void>) {
        const { oldAttachmentId, newAttachmentId, mode } =
          ctx.action.params?.values || ctx.request.body || {};

        if (!oldAttachmentId || !newAttachmentId) {
          ctx.throw(400, 'oldAttachmentId and newAttachmentId are required');
        }

        const result = await plugin.cleanerService.replaceWithAttachment(
          oldAttachmentId,
          newAttachmentId,
          mode || 'overwrite',
          getOperator(ctx),
        );

        ctx.body = result;
        await next();
      },
    },
  });

  // 权限策略：清理工具涉及物理删除、文件覆盖、引用改写、审计清空等高危操作，
  // 一律仅允许管理员执行；普通登录用户仅保留只读查询能力。
  const readOnlyActions = [
    'getScanProgress',
    'getLastScanResult',
    'getSettings',
    'storages',
    'auditLogs',
  ];
  plugin.app.acl.allow('attachmentCleaners', readOnlyActions, 'loggedIn');
  plugin.app.acl.allow('attachmentCleaners', '*', 'admin');
}
