/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Button,
  Tabs,
  Tag,
  Modal,
  message,
  Form,
  InputNumber,
  Switch,
  Select,
  Space,
} from 'antd';
import { DeleteOutlined, UndoOutlined, RestOutlined, SyncOutlined, SettingOutlined, EyeOutlined, DownloadOutlined, ExportOutlined, FileOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

export const AttachmentCleanerPage: React.FC = () => {
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    items: any[];
    stats: {
      totalCount: number;
      totalSize: number;
      unusedCount: number;
      unusedSize: number;
      duplicateCount: number;
      duplicateWastedSize: number;
      recycledCount: number;
    };
  }>({
    items: [],
    stats: {
      totalCount: 0,
      totalSize: 0,
      unusedCount: 0,
      unusedSize: 0,
      duplicateCount: 0,
      duplicateWastedSize: 0,
      recycledCount: 0,
    },
  });

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsForm] = Form.useForm();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [storages, setStorages] = useState<{ id: string | number; title?: string; name?: string; type?: string }[]>([]);

  // NocoBase 会把 action 响应包为 { data: <body> }，这里取里面的真实载荷
  const unwrapBody = (res: any) => res?.data?.data ?? res?.data;

  const fetchAnalysis = async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'attachmentCleaners:scan',
      });
      const payload = unwrapBody(res);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        message.error('扫描接口返回了无法识别的数据');
        return;
      }
      setData({
        items: Array.isArray(payload.items) ? payload.items : [],
        stats: {
          totalCount: 0,
          totalSize: 0,
          unusedCount: 0,
          unusedSize: 0,
          duplicateCount: 0,
          duplicateWastedSize: 0,
          recycledCount: 0,
          ...(payload.stats ?? {}),
        },
      });
    } catch (e: any) {
      message.error(e?.message || '获取分析报告失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await api.request({
        url: 'attachmentCleaners:getSettings',
      });
      const payload = unwrapBody(res);
      if (payload && typeof payload === 'object') {
        settingsForm.setFieldsValue(payload);
      }
    } catch (e) {
      // ignore settings fetch error
    }
  };

  const fetchAuditLogs = async () => {
    setAuditLoading(true);
    try {
      const res = await api.request({
        url: 'attachmentCleaners:auditLogs',
      });
      const payload = unwrapBody(res);
      setAuditLogs(Array.isArray(payload?.items) ? payload.items : []);
    } catch (e) {
      // ignore audit fetch error
    } finally {
      setAuditLoading(false);
    }
  };

  const fetchStorages = async () => {
    try {
      const res = await api.request({
        url: 'attachmentCleaners:storages',
      });
      const payload = unwrapBody(res);
      setStorages(Array.isArray(payload?.items) ? payload.items : []);
    } catch (e) {
      // ignore storages fetch error
    }
  };

  useEffect(() => {
    fetchAnalysis();
    fetchAuditLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRecycle = async (ids: React.Key[]) => {
    try {
      await api.request({
        url: 'attachmentCleaners:recycle',
        method: 'post',
        data: { attachmentIds: ids },
      });
      message.success('已放入回收站');
      setSelectedRowKeys([]);
      fetchAnalysis();
      fetchAuditLogs();
    } catch (e: any) {
      message.error(e?.message || '移入回收站失败');
    }
  };

  const handleRestore = async (ids: React.Key[]) => {
    try {
      await api.request({
        url: 'attachmentCleaners:restore',
        method: 'post',
        data: { attachmentIds: ids },
      });
      message.success('已还原');
      setSelectedRowKeys([]);
      fetchAnalysis();
      fetchAuditLogs();
    } catch (e: any) {
      message.error(e?.message || '还原失败');
    }
  };

  const handlePurge = async (ids: React.Key[]) => {
    Modal.confirm({
      title: '确认彻底物理擦除附件？',
      content: '此操作将直接删除数据库记录及物理存储文件，无法撤销！',
      okText: '彻底删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.request({
            url: 'attachmentCleaners:purge',
            method: 'post',
            data: { attachmentIds: ids },
          });
          message.success('已物理擦除');
          setSelectedRowKeys([]);
          fetchAnalysis();
          fetchAuditLogs();
        } catch (e: any) {
          message.error(e?.message || '物理删除失败');
        }
      },
    });
  };

  const [dedupLoading, setDedupLoading] = useState(false);

  const handleDeduplicate = () => {
    const groupIds = new Set(
      duplicateItems.map((i) => i.duplicateGroupId).filter((id): id is string => Boolean(id)),
    );
    Modal.confirm({
      title: '确认对重复文件去重？',
      content: `将处理 ${groupIds.size} 组重复文件（共 ${duplicateItems.length} 个附件），每组仅保留 1 个文件，其余移入回收站，业务数据中的附件引用将自动改指向保留文件。移入回收站的文件可还原，超期后才会被自动物理擦除。`,
      okText: '开始去重',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDedupLoading(true);
        try {
          const res = await api.request({
            url: 'attachmentCleaners:deduplicate',
            method: 'post',
          });
          const payload = unwrapBody(res);
          message.success(
            `去重完成：处理 ${payload?.groups ?? 0} 组，保留 ${payload?.keptCount ?? 0} 个，移除 ${payload?.removedCount ?? 0} 个附件，更新 ${payload?.referencesUpdated ?? 0} 处引用`,
          );
          setSelectedRowKeys([]);
          fetchAnalysis();
          fetchAuditLogs();
        } catch (e: any) {
          message.error(e?.message || '去重失败');
        } finally {
          setDedupLoading(false);
        }
      },
    });
  };

  const handleSaveSettings = async () => {
    try {
      const values = await settingsForm.validateFields();
      await api.request({
        url: 'attachmentCleaners:updateSettings',
        method: 'post',
        data: values,
      });
      message.success('配置已保存');
      setSettingsModalOpen(false);
      fetchAuditLogs();
    } catch (e: any) {
      message.error(e?.message || '保存设置失败');
    }
  };

  const handleClearAuditLogs = () => {
    Modal.confirm({
      title: '确认清空全部审计日志？',
      content: '将删除所有操作审计记录，此操作不可撤销。',
      okText: '清空',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.request({
            url: 'attachmentCleaners:clearAuditLogs',
            method: 'post',
          });
          message.success('审计日志已清空');
          fetchAuditLogs();
        } catch (e: any) {
          message.error(e?.message || '清空日志失败');
        }
      },
    });
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
  };

  const items = data.items ?? [];
  const unusedItems = items.filter((i) => i.isUnused && !i.isRecycled);
  const duplicateItems = items.filter((i) => i.isDuplicate && !i.isRecycled);
  const recycledItems = items.filter((i) => i.isRecycled);

  const columns = [
    {
      title: '文件名',
      dataIndex: 'filename',
      key: 'filename',
      render: (text: string, record: any) => record.title || record.filename,
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      render: (size: number) => formatSize(size),
    },
    {
      title: '扩展名',
      dataIndex: 'extname',
      key: 'extname',
      render: (ext: string) => <Tag color="blue">{ext || '未知'}</Tag>,
    },
    {
      title: '存储空间',
      dataIndex: 'storageName',
      key: 'storageName',
      render: (_: string, record: any) =>
        record.storageName ? (
          <Space>
            <span>{record.storageName}</span>
            {record.storageType && <Tag>{record.storageType}</Tag>}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>未知</span>
        ),
    },
    {
      title: '状态标记',
      key: 'tags',
      render: (_: any, record: any) => (
        <Space>
          {record.isUnused && <Tag color="warning">未被引用</Tag>}
          {record.isDuplicate && <Tag color="error">重复文件 ({record.duplicateCount})</Tag>}
          {record.isRecycled && <Tag color="default">在回收站中</Tag>}
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            icon={<EyeOutlined />}
            disabled={!record.url}
            onClick={() => {
              setPreviewFile(record);
              setPreviewOpen(true);
            }}
          >
            预览
          </Button>
          {!record.isRecycled ? (
            <Button size="small" icon={<DeleteOutlined />} onClick={() => handleRecycle([record.id])}>
              放入回收站
            </Button>
          ) : (
            <>
              <Button size="small" icon={<UndoOutlined />} onClick={() => handleRestore([record.id])}>
                还原
              </Button>
              <Button size="small" danger icon={<RestOutlined />} onClick={() => handlePurge([record.id])}>
                彻底物理删除
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  const auditActionMeta: Record<string, { label: string; color: string }> = {
    recycle: { label: '移入回收站', color: 'orange' },
    restore: { label: '还原', color: 'blue' },
    purge: { label: '物理擦除', color: 'red' },
    deduplicate: { label: '去重', color: 'magenta' },
    updateSettings: { label: '修改配置', color: 'geekblue' },
    autoCleanExpired: { label: '自动清理', color: 'default' },
  };

  const summarize = (v: any) => {
    if (v === null || v === undefined) return '-';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  };

  const auditColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: '操作人',
      dataIndex: 'operatorName',
      key: 'operatorName',
      width: 140,
      render: (_: string, record: any) => record.operatorName || record.operatorId || 'system',
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 120,
      render: (action: string) => {
        const meta = auditActionMeta[action];
        return <Tag color={meta?.color}>{meta?.label || action}</Tag>;
      },
    },
    {
      title: '参数',
      dataIndex: 'params',
      key: 'params',
      render: (v: any) => <span style={{ wordBreak: 'break-all' }}>{summarize(v)}</span>,
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      render: (v: any) => <span style={{ wordBreak: 'break-all' }}>{summarize(v)}</span>,
    },
  ];

  return (
    <div style={{ padding: 24, background: '#f5f5f5', minHeight: '100vh' }}>
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic title="总附件数量" value={data.stats.totalCount} suffix="个" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="总存储占用" value={formatSize(data.stats.totalSize)} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="未引用附件"
              value={data.stats.unusedCount}
              suffix={`个 (${formatSize(data.stats.unusedSize)})`}
              valueStyle={{ color: '#faad14' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="重复文件组"
              value={data.stats.duplicateCount}
              suffix={`个 (浪费 ${formatSize(data.stats.duplicateWastedSize)})`}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="附件清理与维护面板"
        extra={
          <Space>
            <Button icon={<SyncOutlined />} loading={loading} onClick={fetchAnalysis}>
              重新全盘扫描
            </Button>
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                fetchSettings();
                fetchStorages();
                setSettingsModalOpen(true);
              }}
            >
              自动清理策略配置
            </Button>
          </Space>
        }
      >
        <Tabs defaultActiveKey="unused">
          <Tabs.TabPane tab={`未引用的附件 (${unusedItems.length})`} key="unused">
            <div style={{ marginBottom: 16 }}>
              <Button
                type="primary"
                danger
                disabled={selectedRowKeys.length === 0}
                onClick={() => handleRecycle(selectedRowKeys)}
              >
                批量移入回收站
              </Button>
            </div>
            <Table
              rowKey="id"
              columns={columns}
              dataSource={unusedItems}
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
            />
          </Tabs.TabPane>

          <Tabs.TabPane tab={`重复文件分析 (${duplicateItems.length})`} key="duplicate">
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Button
                  type="primary"
                  danger
                  loading={dedupLoading}
                  disabled={duplicateItems.length === 0}
                  onClick={handleDeduplicate}
                >
                  一键去重（每组保留一个）
                </Button>
                <Button
                  type="primary"
                  danger
                  disabled={selectedRowKeys.length === 0}
                  onClick={() => handleRecycle(selectedRowKeys)}
                >
                  批量移入回收站
                </Button>
              </Space>
            </div>
            <Table
              rowKey="id"
              columns={columns}
              dataSource={duplicateItems}
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
            />
          </Tabs.TabPane>

          <Tabs.TabPane tab={`回收站 (${recycledItems.length})`} key="recycled">
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Button
                  type="primary"
                  disabled={selectedRowKeys.length === 0}
                  onClick={() => handleRestore(selectedRowKeys)}
                >
                  批量还原
                </Button>
                <Button danger disabled={selectedRowKeys.length === 0} onClick={() => handlePurge(selectedRowKeys)}>
                  批量物理擦除
                </Button>
              </Space>
            </div>
            <Table
              rowKey="id"
              columns={columns}
              dataSource={recycledItems}
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
            />
          </Tabs.TabPane>

          <Tabs.TabPane tab={`操作审计 (${auditLogs.length})`} key="audit">
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Button icon={<SyncOutlined />} loading={auditLoading} onClick={fetchAuditLogs}>
                  刷新
                </Button>
                <Button danger disabled={auditLogs.length === 0} onClick={handleClearAuditLogs}>
                  清空日志
                </Button>
              </Space>
            </div>
            <Table
              rowKey="id"
              columns={auditColumns}
              dataSource={auditLogs}
              pagination={{ pageSize: 20 }}
              locale={{ emptyText: '暂无审计记录' }}
            />
          </Tabs.TabPane>
        </Tabs>
      </Card>

      <Modal
        title="回收站与清理规则配置"
        open={settingsModalOpen}
        onOk={handleSaveSettings}
        onCancel={() => setSettingsModalOpen(false)}
      >
        <Form form={settingsForm} layout="vertical">
          <Form.Item name="autoCleanEnabled" label="开启定时自动物理擦除" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="retentionDays"
            label="回收站保留天数 (超期自动清除)"
            rules={[{ required: true, message: '请设置保留天数' }]}
          >
            <InputNumber min={1} max={365} style={{ width: '100%' }} addonAfter="天" />
          </Form.Item>
          <Form.Item
            name="preferredStorageId"
            label="去重优先保留的存储空间"
            extra="一键去重时，若重复组内存在该存储空间的文件，则优先保留其一；不选择则按引用数/创建时间决定。"
          >
            <Select
              allowClear
              placeholder="不限制"
              options={storages.map((s) => ({
                label: s.title || s.name || String(s.id),
                value: s.id,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={previewFile?.title || previewFile?.filename || '附件预览'}
        open={previewOpen}
        footer={[
          previewFile?.url && (
            <Button
              key="download"
              icon={<DownloadOutlined />}
              onClick={() => {
                const a = document.createElement('a');
                a.href = previewFile.url;
                a.download = previewFile.title || previewFile.filename || 'download';
                a.target = '_blank';
                a.rel = 'noreferrer';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
            >
              下载文件
            </Button>
          ),
          previewFile?.url && (
            <Button
              key="open"
              type="primary"
              icon={<ExportOutlined />}
              onClick={() => window.open(previewFile.url, '_blank')}
            >
              新窗口打开
            </Button>
          ),
          <Button key="close" onClick={() => setPreviewOpen(false)}>
            关闭
          </Button>,
        ]}
        onCancel={() => setPreviewOpen(false)}
        width={750}
        styles={{ body: { maxHeight: '75vh', overflow: 'auto', textAlign: 'center', padding: '16px 0' } }}
      >
        {previewFile?.url ? (
          (() => {
            const ext = (previewFile.extname || '').toLowerCase().replace(/^\./, '');
            const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];
            const videoExts = ['mp4', 'webm', 'ogg', 'mov'];
            const audioExts = ['mp3', 'wav', 'aac', 'flac'];
            const isPdf = ext === 'pdf';

            if (imgExts.includes(ext)) {
              return (
                <div style={{ padding: '8px' }}>
                  <img
                    src={previewFile.url}
                    alt={previewFile.title || previewFile.filename}
                    style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: '4px' }}
                  />
                </div>
              );
            }
            if (videoExts.includes(ext)) {
              return (
                <div style={{ padding: '8px' }}>
                  <video src={previewFile.url} controls style={{ maxWidth: '100%', maxHeight: '60vh' }} />
                </div>
              );
            }
            if (audioExts.includes(ext)) {
              return (
                <div style={{ padding: '24px' }}>
                  <audio src={previewFile.url} controls style={{ width: '100%' }} />
                </div>
              );
            }
            if (isPdf) {
              return (
                <iframe
                  src={previewFile.url}
                  title="PDF Preview"
                  style={{ width: '100%', height: '60vh', border: '1px solid #eee', borderRadius: '4px' }}
                />
              );
            }
            return (
              <div style={{ padding: '40px 16px', color: '#666' }}>
                <FileOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
                <p style={{ fontSize: 16, fontWeight: 500, margin: '8px 0' }}>{previewFile.title || previewFile.filename}</p>
                <p style={{ color: '#999', fontSize: 13 }}>当前格式（.{ext || '未知'}）暂不支持内嵌直接渲染，请点击下方按钮下载或在新窗口中打开。</p>
              </div>
            );
          })()
        ) : (
          <div style={{ padding: '32px', color: '#999' }}>暂无有效的文件链接</div>
        )}
      </Modal>
    </div>
  );
};

export default AttachmentCleanerPage;
