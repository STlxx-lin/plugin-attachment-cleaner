import path from 'path';
import { defineConfig } from '@nocobase/build';

export default defineConfig({
  modifyTsupConfig(config) {
    const next = { ...config };
    if (Array.isArray(next.entry)) {
      // Windows 下 tsup 内置 globby 无法匹配绝对路径（服务端构建入口），转成相对路径
      next.entry = next.entry.map((item) =>
        path.isAbsolute(item) ? path.relative(process.cwd(), item).replace(/\\/g, '/') : item,
      );
    }
    return next;
  },
});
