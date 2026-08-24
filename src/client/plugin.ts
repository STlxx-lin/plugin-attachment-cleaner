import { Plugin } from '@nocobase/client';
import { AttachmentCleanerPage } from './AttachmentCleanerPage';

export class PluginAttachmentCleanerClient extends Plugin {
  async load() {
    if (this.app?.pluginSettingsManager) {
      this.app.pluginSettingsManager.add('attachment-cleaner', {
        title: '附件清理管理',
        icon: 'DeleteOutlined',
        Component: AttachmentCleanerPage,
      });
    }
  }
}

export default PluginAttachmentCleanerClient;
