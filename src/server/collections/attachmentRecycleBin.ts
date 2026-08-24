/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'attachmentRecycleBin',
  shared: true,
  fields: [
    {
      type: 'bigInt',
      name: 'attachmentId',
      unique: true,
      index: true,
    },
    {
      type: 'date',
      name: 'recycledAt',
    },
    {
      type: 'string',
      name: 'recycledBy',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'recycled',
    },
  ],
} as CollectionOptions;
