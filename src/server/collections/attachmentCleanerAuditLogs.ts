/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions } from '@nocobase/database';

/**
 * 附件清理操作审计日志：
 * 记录 recycle / restore / purge / deduplicate / updateSettings / autoCleanExpired
 * 等变更类操作的操作人、参数与结果。
 */
export default {
  name: 'attachmentCleanerAuditLogs',
  shared: true,
  fields: [
    { type: 'string', name: 'action', index: true },
    { type: 'string', name: 'operatorId' },
    { type: 'string', name: 'operatorName' },
    { type: 'jsonb', name: 'params', defaultValue: {} },
    { type: 'jsonb', name: 'result', defaultValue: {} },
  ],
} as CollectionOptions;
