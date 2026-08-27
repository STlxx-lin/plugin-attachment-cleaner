/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useEffect, useRef } from 'react';
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
  Input,
  Switch,
  Select,
  Space,
  Progress,
  Tooltip,
} from 'antd';
import {
  DeleteOutlined,
  UndoOutlined,
  RestOutlined,
  SyncOutlined,
  SettingOutlined,
  EyeOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileOutlined,
  LoadingOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { useAPIClient, attachmentFileTypes } from '@nocobase/client';

interface ScanProgressInfo {
  taskId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  phase: string;
  phaseText: string;
  percent: number;
  currentStep?: number;
  totalSteps?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  result?: any;
}

export const AttachmentCleanerPage: React.FC = () => {
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);

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
      missingFileCount: number;
      missingFileSize: number;
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
      missingFileCount: 0,
      missingFileSize: 0,
    },
  });

  const [scanProgress, setScanProgress] = useState<ScanProgressInfo>({
    taskId: '',
    status: 'idle',
    phase: 'init',
    phaseText: '',
    percent: 0,
  });

  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const pollTimerRef = useRef<any>(null);
  const elapsedTimerRef = useRef<any>(null);

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

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  };

  const applyAnalysisResult = (payload: any) => {
    if (!payload || typeof payload !== 'object') return;
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
        missingFileCount: 0,
        missingFileSize: 0,
        ...(payload.stats ?? {}),
      },
    });
  };

  const startScan = async () => {
    stopPolling();
    setLoading(true);
    setElapsedTime(0);

    const startTime = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 500);

    try {
      const res = await api.request({
        url: 'attachmentCleaners:startScan',
        method: 'post',
      });
      const initialProgress = unwrapBody(res);
      if (initialProgress) {
        setScanProgress(initialProgress);
      }

      // 启动轮询检查进度
      pollTimerRef.current = setInterval(async () => {
        try {
          const pRes = await api.request({
            url: 'attachmentCleaners:getScanProgress',
          });
          const progress: ScanProgressInfo = unwrapBody(pRes);
          if (!progress) return;

          setScanProgress(progress);

          if (progress.status === 'completed') {
            stopPolling();
            setLoading(false);
            if (progress.result) {
              applyAnalysisResult(progress.result);
              setLastScannedAt(new Date().toLocaleString());
            }
            message.success(
              `全盘扫描完成！耗时 ${((progress.durationMs || Date.now() - startTime) / 1000).toFixed(1)} 秒`,
            );
          } else if (progress.status === 'failed') {
            stopPolling();
            setLoading(false);
            message.error(progress.error || '扫描中断失败');
          }
        } catch (pollErr) {
          // 容忍单次轮询网络抖动
        }
      }, 400);
    } catch (e: any) {
      stopPolling();
      setLoading(false);
      message.error(e?.message || '启动全盘扫描失败');
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await api.request({
        url: 'attachmentCleaners:getSettings',
      });
      const payload = unwrapBody(res);
      if (payload && typeof payload === 'object') {
        const cron = payload.autoScanCron || '0 3 * * *';
        const isStandard = ['0 3 * * *', '0 */12 * * *', '0 3 * * 1', '0 3 1 * *'].includes(cron);
        settingsForm.setFieldsValue({
          ...payload,
          autoScanPreset: isStandard ? cron : 'custom',
        });
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

  // 页面初次加载时拉取快照（秒开），不再自动重新执行耗时扫描
  useEffect(() => {
    const initLoad = async () => {
      try {
        const res = await api.request({ url: 'attachmentCleaners:getLastScanResult' });
        const payload = unwrapBody(res);

        if (payload) {
          if (payload.lastScannedAt) {
            setLastScannedAt(new Date(payload.lastScannedAt).toLocaleString());
          }

          // 如果后台有正在运行的扫描任务，接入轮询进度条
          if (payload.taskState && payload.taskState.status === 'running') {
            setScanProgress(payload.taskState);
            setLoading(true);
            pollTimerRef.current = setInterval(async () => {
              try {
                const pRes = await api.request({ url: 'attachmentCleaners:getScanProgress' });
                const curProgress: ScanProgressInfo = unwrapBody(pRes);
                if (!curProgress) return;
                setScanProgress(curProgress);
                if (curProgress.status === 'completed') {
                  stopPolling();
                  setLoading(false);
                  if (curProgress.result) {
                    applyAnalysisResult(curProgress.result);
                    setLastScannedAt(new Date().toLocaleString());
                  }
                } else if (curProgress.status === 'failed') {
                  stopPolling();
                  setLoading(false);
                }
              } catch (err) {}
            }, 400);
            return;
          }

          // 如果有历史快照数据，直接呈现
          if (payload.hasSnapshot && payload.result) {
            applyAnalysisResult(payload.result);
            return;
          }
        }
      } catch (err) {}

      // 若系统初次安装且没有任何快照，则进行一次初始扫描
      startScan();
    };

    initLoad();
    fetchAuditLogs();

    return () => {
      stopPolling();
    };
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

      // 本地即时响应更新，不触发耗时全盘扫描
      setData((prev) => {
        const idSet = new Set(ids.map(String));
        let unusedCountDelta = 0;
        let unusedSizeDelta = 0;
        const newItems = prev.items.map((item) => {
          if (idSet.has(String(item.id))) {
            if (item.isUnused && !item.isRecycled) {
              unusedCountDelta--;
              unusedSizeDelta += item.size || 0;
            }
            return { ...item, isRecycled: true, recycledAt: new Date() };
          }
          return item;
        });
        return {
          ...prev,
          items: newItems,
          stats: {
            ...prev.stats,
            unusedCount: Math.max(0, prev.stats.unusedCount + unusedCountDelta),
            unusedSize: Math.max(0, prev.stats.unusedSize - unusedSizeDelta),
            recycledCount: prev.stats.recycledCount + idSet.size,
          },
        };
      });

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

      // 本地即时响应更新，不触发耗时全盘扫描
      setData((prev) => {
        const idSet = new Set(ids.map(String));
        let unusedCountDelta = 0;
        let unusedSizeDelta = 0;
        const newItems = prev.items.map((item) => {
          if (idSet.has(String(item.id))) {
            if (item.isUnused) {
              unusedCountDelta++;
              unusedSizeDelta += item.size || 0;
            }
            return { ...item, isRecycled: false, recycledAt: undefined };
          }
          return item;
        });
        return {
          ...prev,
          items: newItems,
          stats: {
            ...prev.stats,
            unusedCount: prev.stats.unusedCount + unusedCountDelta,
            unusedSize: prev.stats.unusedSize + unusedSizeDelta,
            recycledCount: Math.max(0, prev.stats.recycledCount - idSet.size),
          },
        };
      });

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

          // 本地即时从列表中剔除并更新统计，不触发耗时全盘扫描
          setData((prev) => {
            const idSet = new Set(ids.map(String));
            let removedTotalSize = 0;
            let removedUnusedCount = 0;
            let removedUnusedSize = 0;
            let removedMissingCount = 0;
            let removedMissingSize = 0;
            let removedRecycledCount = 0;

            const newItems = prev.items.filter((item) => {
              if (idSet.has(String(item.id))) {
                removedTotalSize += item.size || 0;
                if (item.isRecycled) removedRecycledCount++;
                if (item.isUnused) {
                  removedUnusedCount++;
                  removedUnusedSize += item.size || 0;
                }
                if (item.isMissingFile) {
                  removedMissingCount++;
                  removedMissingSize += item.size || 0;
                }
                return false;
              }
              return true;
            });

            return {
              ...prev,
              items: newItems,
              stats: {
                ...prev.stats,
                totalCount: Math.max(0, prev.stats.totalCount - idSet.size),
                totalSize: Math.max(0, prev.stats.totalSize - removedTotalSize),
                unusedCount: Math.max(0, prev.stats.unusedCount - removedUnusedCount),
                unusedSize: Math.max(0, prev.stats.unusedSize - removedUnusedSize),
                recycledCount: Math.max(0, prev.stats.recycledCount - removedRecycledCount),
                missingFileCount: Math.max(0, prev.stats.missingFileCount - removedMissingCount),
                missingFileSize: Math.max(0, prev.stats.missingFileSize - removedMissingSize),
              },
            };
          });

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
          // 去重后轻量刷新最新快照结果
          const snapshotRes = await api.request({ url: 'attachmentCleaners:getLastScanResult' });
          const snapPayload = unwrapBody(snapshotRes);
          if (snapPayload?.result) {
            applyAnalysisResult(snapPayload.result);
          }
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
      if (values.autoScanPreset && values.autoScanPreset !== 'custom') {
        values.autoScanCron = values.autoScanPreset;
      }
      delete values.autoScanPreset;

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

  const openFilePreview = (record: any) => {
    const fileObj = {
      ...record,
      name: record.title || record.filename,
      originalname: record.title || record.filename,
      title: record.title || record.filename,
    };
    setPreviewFile(fileObj);
    setPreviewOpen(true);
  };

  const items = data.items ?? [];
  const allActiveItems = items.filter((i) => !i.isRecycled);
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
        <Space wrap>
          {record.isUnused && <Tag color="warning">未被引用</Tag>}
          {record.isDuplicate && <Tag color="error">重复文件 ({record.duplicateCount})</Tag>}
          {record.isMissingFile && <Tag color="magenta">物理文件丢失</Tag>}
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
            disabled={!record.url || record.isMissingFile}
            title={record.isMissingFile ? '物理文件在磁盘中已丢失（404），无法预览' : undefined}
            onClick={() => {
              if (record.isMissingFile) {
                message.warning('该附件物理文件在磁盘中已丢失，无法预览，建议放入回收站清理。');
                return;
              }
              openFilePreview(record);
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

  const isScanning = loading || scanProgress.status === 'running';

  const tabItems = [
    {
      key: 'all',
      label: `全部附件 (${allActiveItems.length})`,
      children: (
        <div>
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
            dataSource={allActiveItems}
            loading={isScanning && items.length === 0}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys),
            }}
          />
        </div>
      ),
    },
    {
      key: 'unused',
      label: `未引用的附件 (${unusedItems.length})`,
      children: (
        <div>
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
            loading={isScanning && items.length === 0}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys),
            }}
          />
        </div>
      ),
    },
    {
      key: 'duplicate',
      label: `重复文件分析 (${duplicateItems.length})`,
      children: (
        <div>
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
            loading={isScanning && items.length === 0}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys),
            }}
          />
        </div>
      ),
    },
    {
      key: 'recycled',
      label: `回收站 (${recycledItems.length})`,
      children: (
        <div>
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
            loading={isScanning && items.length === 0}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys),
            }}
          />
        </div>
      ),
    },
    {
      key: 'audit',
      label: `操作审计 (${auditLogs.length})`,
      children: (
        <div>
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
        </div>
      ),
    },
  ];

  // 解析当前文件是否能匹配到系统级预览器（例如 KKFilePreviewer 或已注册的预览组件）
  const getSystemPreviewer = (file: any) => {
    if (!file) return null;
    const aft = attachmentFileTypes as any;
    if (aft) {
      if (typeof aft.get === 'function') {
        const matched = aft.get(file);
        if (matched?.Previewer) return matched.Previewer;
      }
      const list = aft.types || aft.items || aft.rules || (Array.isArray(aft) ? aft : []);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item.match === 'function' && item.match(file)) {
            if (item.Previewer) return item.Previewer;
          }
        }
      }
    }
    return null;
  };

  const SystemPreviewer = getSystemPreviewer(previewFile);

  return (
    <div style={{ padding: 24, background: '#f5f5f5', minHeight: '100vh' }}>
      {/* 顶部统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
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

      {/* 实时全盘扫描进度条展示 */}
      {isScanning && (
        <Card
          style={{
            marginBottom: 16,
            borderColor: '#1890ff',
            background: 'linear-gradient(135deg, #f0f7ff 0%, #ffffff 100%)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Space>
              <LoadingOutlined style={{ color: '#1890ff', fontSize: 16 }} spin />
              <span style={{ fontWeight: 600, color: '#1890ff', fontSize: 14 }}>
                全盘深度扫描进行中...
              </span>
              <Tag color="blue">{scanProgress.phaseText || '正在处理'}</Tag>
            </Space>
            <span style={{ color: '#666', fontSize: 13 }}>
              已耗时: <strong>{elapsedTime}</strong> 秒
            </span>
          </div>
          <Progress
            percent={scanProgress.percent}
            status="active"
            strokeColor={{
              '0%': '#108ee9',
              '100%': '#52c41a',
            }}
          />
        </Card>
      )}

      <Card
        title={
          <Space>
            <span>附件清理与维护面板</span>
            {lastScannedAt && (
              <Tag icon={<ClockCircleOutlined />} color="default">
                最近扫描时间: {lastScannedAt}
              </Tag>
            )}
          </Space>
        }
        extra={
          <Space>
            <Button
              icon={<SyncOutlined spin={isScanning} />}
              loading={isScanning}
              type={isScanning ? 'primary' : 'default'}
              onClick={startScan}
            >
              {isScanning ? '正在全盘扫描' : '重新全盘扫描'}
            </Button>
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                fetchSettings();
                fetchStorages();
                setSettingsModalOpen(true);
              }}
            >
              自动清理与扫描策略配置
            </Button>
          </Space>
        }
      >
        <Tabs defaultActiveKey="all" items={tabItems} />
      </Card>

      <Modal
        title="回收站与定时扫描策略配置"
        open={settingsModalOpen}
        onOk={handleSaveSettings}
        onCancel={() => setSettingsModalOpen(false)}
        width={560}
      >
        <Form form={settingsForm} layout="vertical">
          <Form.Item name="autoCleanEnabled" label="开启回收站定时自动物理擦除" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="retentionDays"
            label="回收站保留天数 (超期自动清除)"
            rules={[{ required: true, message: '请设置保留天数' }]}
          >
            <InputNumber min={1} max={365} style={{ width: '100%' }} addonAfter="天" />
          </Form.Item>

          <Form.Item name="autoScanEnabled" label="开启后台定时自动全盘扫描" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => prevValues.autoScanEnabled !== currentValues.autoScanEnabled}
          >
            {({ getFieldValue }) =>
              getFieldValue('autoScanEnabled') ? (
                <>
                  <Form.Item
                    name="autoScanPreset"
                    label="自动扫描周期"
                    extra="系统将在后台按设定周期自动执行全盘深度扫描并更新快照。"
                  >
                    <Select
                      options={[
                        { label: '每天凌晨 3:00 (推荐)', value: '0 3 * * *' },
                        { label: '每 12 小时执行一次', value: '0 */12 * * *' },
                        { label: '每周一凌晨 3:00', value: '0 3 * * 1' },
                        { label: '每月 1 日凌晨 3:00', value: '0 3 1 * *' },
                        { label: '自定义 Cron 表达式', value: 'custom' },
                      ]}
                    />
                  </Form.Item>

                  <Form.Item
                    noStyle
                    shouldUpdate={(prevValues, currentValues) =>
                      prevValues.autoScanPreset !== currentValues.autoScanPreset
                    }
                  >
                    {({ getFieldValue: getField }) =>
                      getField('autoScanPreset') === 'custom' ? (
                        <Form.Item
                          name="autoScanCron"
                          label="自定义 Cron 表达式"
                          rules={[{ required: true, message: '请输入 Cron 表达式' }]}
                          extra="标准 5 段式 Cron 表达式（分 时 日 月 周），例如：0 2 * * *"
                        >
                          <Input placeholder="0 3 * * *" />
                        </Form.Item>
                      ) : null
                    }
                  </Form.Item>
                </>
              ) : null
            }
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

      {/* 优先调用系统级专业文件预览服务（如 KKFilePreviewer 等），支持 Excel/Word/PPT/PDF/图片/代码多引擎全格式预览 */}
      {previewOpen && previewFile && (
        SystemPreviewer ? (
          <SystemPreviewer
            file={previewFile}
            list={[previewFile]}
            index={0}
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            onSwitchIndex={(idx: number | null) => {
              if (idx === null) setPreviewOpen(false);
            }}
          />
        ) : (
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
                    <div style={{ padding: '8px', textAlign: 'center' }}>
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
                    <div style={{ padding: '8px', textAlign: 'center' }}>
                      <video src={previewFile.url} controls style={{ maxWidth: '100%', maxHeight: '60vh' }} />
                    </div>
                  );
                }
                if (audioExts.includes(ext)) {
                  return (
                    <div style={{ padding: '24px', textAlign: 'center' }}>
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
                  <div style={{ padding: '40px 16px', color: '#666', textAlign: 'center' }}>
                    <FileOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
                    <p style={{ fontSize: 16, fontWeight: 500, margin: '8px 0' }}>
                      {previewFile.title || previewFile.filename}
                    </p>
                    <p style={{ color: '#999', fontSize: 13 }}>
                      当前格式（.{ext || '未知'}）暂不支持内嵌直接渲染，请点击下方按钮下载或在新窗口中打开。
                    </p>
                  </div>
                );
              })()
            ) : (
              <div style={{ padding: '32px', color: '#999', textAlign: 'center' }}>暂无有效的文件链接</div>
            )}
          </Modal>
        )
      )}
    </div>
  );
};

export default AttachmentCleanerPage;
