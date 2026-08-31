import path from 'path';
import { defineConfig } from '@nocobase/build';

export default defineConfig({
  modifyTsupConfig(config) {
    const next = { ...config };
    if (Array.isArray(next.entry)) {
      // 仅在 Windows 环境下将绝对路径转换为相对于 process.cwd() 的相对路径，规避 Windows 盘符冒号 glob 问题；
      // Linux/云打包环境下保持绝对路径，避免 process.cwd() 变动导致云端打包找不到入口文件。
      if (process.platform === 'win32') {
        next.entry = next.entry.map((item) =>
          path.isAbsolute(item) ? path.relative(process.cwd(), item).replace(/\\/g, '/') : item,
        );
      }
    }
    return next;
  },
});
