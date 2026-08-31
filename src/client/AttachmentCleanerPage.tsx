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
  Drawer,
  Descriptions,
  Typography,
  message,
  Form,
  InputNumber,
  Input,
  Switch,
  Select,
  Space,
  Progress,
  Alert,
  Tooltip,
  Badge,
  Upload,
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
  PauseCircleOutlined,
  PlayCircleOutlined,
  CloseCircleOutlined,
  ThunderboltOutlined,
  UpOutlined,
  DownOutlined,
  SwapOutlined,
  InboxOutlined,
  UploadOutlined,
  CopyOutlined,
  SearchOutlined,
  FilterOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useAPIClient, attachmentFileTypes } from '@nocobase/client';

interface ScanProgressInfo {
  taskId: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
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
  checkpoint?: any;
}

export const AttachmentCleanerPage: React.FC = () => {
  const api = useAPIClient();
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<any>(null);
  const [minimizedProgress, setMinimizedProgress] = useState(false);

  // 文件替换弹窗状态
  const [replaceModalOpen, setReplaceModalOpen] = useState(false);
  const [currentReplaceRecord, setCurrentReplaceRecord] = useState<any>(null);
  const [replaceMode, setReplaceMode] = useState<'upload' | 'reference'>('upload');
  const [replaceUploadFile, setReplaceUploadFile] = useState<File | null>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | number | undefined>(undefined);
  const [recycleSourceAtt, setRecycleSourceAtt] = useState(true);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);

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
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  const [currentAuditLog, setCurrentAuditLog] = useState<any>(null);
  const [auditFilterAction, setAuditFilterAction] = useState<string>('all');
  const [auditSearchText, setAuditSearchText] = useState<string>('');
  const [storages, setStorages] = useState<{ id: string | number; title?: string; name?: string; type?: string }[]>([]);

  // 服务端分页快照状态
  const [activeTabKey, setActiveTabKey] = useState<string>('all');
  const [snapshotPage, setSnapshotPage] = useState(1);
  const [snapshotPageSize, setSnapshotPageSize] = useState(50);
  const [snapshotTotal, setSnapshotTotal] = useState(0);
  const [snapshotTruncated, setSnapshotTruncated] = useState(false);
  const [snapshotSearch, setSnapshotSearch] = useState('');
  const [replaceTargetOptions, setReplaceTargetOptions] = useState<{ value: any; label: string }[]>([]);
  const dedupTimerRef = useRef<any>(null);

  // NocoBase 会把 action 响应包为 { data: <body> }，这里取里面的真实载荷
  const unwrapBody = (res: any) => res?.data?.data ?? res?.data;

  // Tab key -> 服务端过滤条件
  const TAB_FILTER_MAP: Record<string, string> = {
    all: 'all',
    unused: 'unused',
    duplicate: 'duplicate',
    recycled: 'recycled',
    audit: 'all',
  };

  // 服务端分页获取快照条目（tab 由当前 Tab 决定，条目不整包下发）。
  // 注意：参数名用 tab 而非 filter——NocoBase 会拦截名为 filter 的查询参数做内建过滤解析，
  // 导致自定义 action 被绕过并返回空结果。
  const fetchSnapshotPage = async (overrides?: {
    page?: number;
    pageSize?: number;
    filter?: string;
    search?: string;
  }) => {
    try {
      const params = {
        page: overrides?.page ?? snapshotPage,
        pageSize: overrides?.pageSize ?? snapshotPageSize,
        tab: overrides?.filter ?? TAB_FILTER_MAP[activeTabKey] ?? 'all',
        search: overrides?.search ?? snapshotSearch,
      };
      const res = await api.request({ url: 'attachmentCleaners:getLastScanResult', params });
      const payload = unwrapBody(res);
      if (!payload) return null;

      if (payload.lastScannedAt) {
        setLastScannedAt(new Date(payload.lastScannedAt).toLocaleString());
      }
      if (payload.checkpoint) {
        setCheckpoint(payload.checkpoint);
      }
      const result = payload.result || {};
      setData({
        items: Array.isArray(result.items) ? result.items : [],
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
          ...(result.stats ?? {}),
        },
      });
      setSnapshotTotal(result.total || 0);
      setSnapshotTruncated(Boolean(result.truncated));
      return payload;
    } catch (err) {
      return null;
    }
  };

  // 轮询回调中需要调用最新闭包的 fetchSnapshotPage（避免过期 state）
  const fetchSnapshotPageRef = useRef<(overrides?: any) => Promise<any>>(async () => null);
  useEffect(() => {
    fetchSnapshotPageRef.current = fetchSnapshotPage;
  });

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

  // 轻量轮询后台扫描进度（仅刷新进度条，不阻塞页面交互）；完成/暂停/失败时收尾
  const startProgressPolling = (startTime: number) => {
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
          setCheckpoint(null);
          // 条目统一从分页快照接口获取
          await fetchSnapshotPageRef.current({ page: 1 });
          message.success(
            `后台全盘扫描已完成！耗时 ${((progress.durationMs || Date.now() - startTime) / 1000).toFixed(1)} 秒`,
          );
        } else if (progress.status === 'paused') {
          stopPolling();
          if (progress.checkpoint) {
            setCheckpoint(progress.checkpoint);
          }
          message.info('后台扫描任务已暂停，断点已安全保存');
        } else if (progress.status === 'failed') {
          stopPolling();
          message.error(progress.error || '后台扫描中断失败');
        }
      } catch (pollErr) {
        // 容忍单次轮询网络抖动
      }
    }, 1500);
  };

  // 纯后台异步扫描：立即返回，不锁死前台 UI
  const startScan = async (resume = false) => {
    stopPolling();
    setElapsedTime(0);

    const startTime = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 500);

    try {
      const res = await api.request({
        url: 'attachmentCleaners:startScan',
        method: 'post',
        data: { resume },
      });
      const initialProgress = unwrapBody(res);
      if (initialProgress) {
        setScanProgress(initialProgress);
      }

      message.info({
        content: resume
          ? '已在后台恢复断点续扫，您可以随时进行其他操作...'
          : '全盘扫描任务已在后台独立运行，您可以随时离开或进行其他操作...',
        key: 'scanNotice',
      });

      startProgressPolling(startTime);
    } catch (e: any) {
      stopPolling();
      message.error(e?.message || '启动全盘扫描失败');
    }
  };

  const handlePauseScan = async () => {
    try {
      await api.request({
        url: 'attachmentCleaners:pauseScan',
        method: 'post',
      });
      message.loading({ content: '正在暂停后台扫描并保存检查点...', key: 'pauseScan' });
    } catch (e: any) {
      message.error(e?.message || '暂停扫描失败');
    }
  };

  const handleCancelScan = async () => {
    Modal.confirm({
      title: '确认取消后台扫描任务？',
      content: '取消后将清空当前已记录的扫描断点进度。',
      okText: '确认取消',
      okType: 'danger',
      cancelText: '关闭',
      onOk: async () => {
        try {
          stopPolling();
          await api.request({
            url: 'attachmentCleaners:cancelScan',
            method: 'post',
          });
          setCheckpoint(null);
          setScanProgress({
            taskId: '',
            status: 'idle',
            phase: 'init',
            phaseText: '空闲',
            percent: 0,
          });
          message.success('后台扫描任务已取消');
        } catch (e: any) {
          message.error(e?.message || '取消扫描失败');
        }
      },
    });
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
    } catch (e) {}
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
    } catch (e) {}
  };

  // 替换目标远程搜索（快照已服务端分页，不能依赖当前页数据做候选列表）
  const fetchReplaceTargets = async (search = '') => {
    try {
      const res = await api.request({
        url: 'attachmentCleaners:getLastScanResult',
        params: { page: 1, pageSize: 50, tab: 'all', search },
      });
      const payload = unwrapBody(res);
      const list = Array.isArray(payload?.result?.items) ? payload.result.items : [];
      setReplaceTargetOptions(
        list
          .filter((item: any) => String(item.id) !== String(currentReplaceRecord?.id))
          .map((item: any) => ({
            value: item.id,
            label: `${item.title || item.filename} (ID: ${item.id}, ${formatSize(item.size)})`,
          })),
      );
    } catch (e) {}
  };

  // 页面加载时拉取快照分页与断点检查点（秒开，无缝重连后台任务，绝不重复触发扫描）
  useEffect(() => {
    const initLoad = async () => {
      const payload = await fetchSnapshotPage();

      // 如果后台有正在运行的异步任务，无缝接入轮询与计时器，绝对不重复启动扫描！
      const taskState = payload?.taskState;
      if (taskState && taskState.status === 'running') {
        setScanProgress(taskState);
        const startedAt = taskState.startedAt || Date.now();
        setElapsedTime(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        elapsedTimerRef.current = setInterval(() => {
          setElapsedTime(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        }, 1000);
        startProgressPolling(startedAt);
      }
    };

    initLoad();
    fetchAuditLogs();

    return () => {
      stopPolling();
      if (dedupTimerRef.current) {
        clearInterval(dedupTimerRef.current);
        dedupTimerRef.current = null;
      }
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
      // 服务端已同步快照条目状态，重取当前页保证列表与统计一致
      await fetchSnapshotPageRef.current();
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
      await fetchSnapshotPageRef.current();
      fetchAuditLogs();
    } catch (e: any) {
      message.error(e?.message || '还原失败');
    }
  };

  const handlePurge = async (ids: React.Key[]) => {
    Modal.confirm({
      title: '确认彻底删除附件？',
      content: '此操作将删除数据库记录并触发物理存储文件删除（file-manager afterDestroy），无法撤销！',
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
          message.success('已彻底删除');
          setSelectedRowKeys([]);
          await fetchSnapshotPageRef.current();
          fetchAuditLogs();
        } catch (e: any) {
          message.error(e?.message || '删除失败');
        }
      },
    });
  };

  const [dedupLoading, setDedupLoading] = useState(false);

  const handleDeduplicate = () => {
    Modal.confirm({
      title: '确认对重复文件去重？',
      content: `将在后台处理当前扫描发现的全部重复文件组（共 ${data.stats.duplicateCount} 个重复附件），每组仅保留 1 个文件，其余移入回收站，业务数据中的附件引用将自动改指向保留文件。移入回收站的文件可还原，超期后才会被自动删除。`,
      okText: '开始去重',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDedupLoading(true);
        try {
          // 后台异步执行：立即返回，轮询进度直到完成/失败
          await api.request({
            url: 'attachmentCleaners:deduplicate',
            method: 'post',
          });
          message.info({ content: '去重任务已在后台运行...', key: 'dedupNotice' });

          if (dedupTimerRef.current) {
            clearInterval(dedupTimerRef.current);
          }
          dedupTimerRef.current = setInterval(async () => {
            try {
              const res = await api.request({ url: 'attachmentCleaners:getDedupProgress' });
              const progress = unwrapBody(res);
              if (!progress) return;

              if (progress.status === 'completed') {
                clearInterval(dedupTimerRef.current);
                dedupTimerRef.current = null;
                setDedupLoading(false);
                const r = progress.result || {};
                const failedCount = Array.isArray(r.failedReferences) ? r.failedReferences.length : 0;
                message.success(
                  `去重完成：处理 ${r.groups ?? 0} 组，保留 ${r.keptCount ?? 0} 个，移除 ${r.removedCount ?? 0} 个附件，更新 ${r.referencesUpdated ?? 0} 处引用${
                    failedCount > 0 ? `，${failedCount} 处引用更新失败（详见审计日志）` : ''
                  }`,
                );
                await fetchSnapshotPageRef.current();
                fetchAuditLogs();
              } else if (progress.status === 'failed') {
                clearInterval(dedupTimerRef.current);
                dedupTimerRef.current = null;
                setDedupLoading(false);
                message.error(progress.error || '去重失败');
              }
            } catch (err) {
              // 容忍单次轮询网络抖动
            }
          }, 1200);
        } catch (e: any) {
          setDedupLoading(false);
          message.error(e?.message || '启动去重失败');
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

  // 打开文件替换弹窗
  const openReplaceModal = (record: any) => {
    setCurrentReplaceRecord(record);
    setReplaceMode('upload');
    setReplaceUploadFile(null);
    setReplaceTargetId(undefined);
    setRecycleSourceAtt(true);
    setReplaceTargetOptions([]);
    setReplaceModalOpen(true);
    fetchReplaceTargets('');
  };

  // 执行文件替换（优先通过系统标准 attachments:create 接口上传，然后原地覆盖或迁移）
  const handleExecuteReplace = async () => {
    if (!currentReplaceRecord) return;
    setReplaceSubmitting(true);

    try {
      if (replaceMode === 'upload') {
        if (!replaceUploadFile) {
          message.warning('请选择需要上传的文件');
          setReplaceSubmitting(false);
          return;
        }

        message.loading({ content: '正在通过系统接口上传新文件...', key: 'replaceUpload' });

        let createdAtt: any = null;

        // 1. 优先使用系统标准 attachments:create / FormData 接口上传
        try {
          const formData = new FormData();
          formData.append('file', replaceUploadFile);
          const uploadRes = await api.request({
            url: 'attachments:create',
            method: 'post',
            data: formData,
            headers: {
              'Content-Type': 'multipart/form-data',
            },
          });
          createdAtt = unwrapBody(uploadRes);
        } catch (uploadErr) {
          // 容错降级：若直接调用 attachments:create 报错，回退到 Base64 方式直接上传覆盖
        }

        let payload: any = null;

        if (createdAtt && createdAtt.id) {
          // 2. 通过系统生成的新附件记录，将物理文件与属性原地合并覆盖到当前附件上
          const res = await api.request({
            url: 'attachmentCleaners:replaceWithAttachment',
            method: 'post',
            data: {
              oldAttachmentId: currentReplaceRecord.id,
              newAttachmentId: createdAtt.id,
              mode: 'overwrite',
            },
          });
          payload = unwrapBody(res);
        } else {
          // 3. 降级 Base64 方式
          const reader = new FileReader();
          const base64Promise = new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
          });
          reader.readAsDataURL(replaceUploadFile);
          const base64Data = await base64Promise;

          const res = await api.request({
            url: 'attachmentCleaners:replaceFile',
            method: 'post',
            data: {
              attachmentId: currentReplaceRecord.id,
              originalFilename: replaceUploadFile.name,
              mimetype: replaceUploadFile.type,
              size: replaceUploadFile.size,
              fileBase64: base64Data,
            },
          });
          payload = unwrapBody(res);
        }

        message.success({ content: '文件覆盖替换成功！全部列表与业务引用已即时更新。', key: 'replaceUpload' });

        // 服务端已完成原地覆盖并更新快照条目，重取当前页保持数据一致
        await fetchSnapshotPageRef.current();
      } else {
        if (!replaceTargetId) {
          message.warning('请选择目标附件');
          setReplaceSubmitting(false);
          return;
        }

        const res = await api.request({
          url: 'attachmentCleaners:replaceReference',
          method: 'post',
          data: {
            sourceAttachmentId: currentReplaceRecord.id,
            targetAttachmentId: replaceTargetId,
            recycleSource: recycleSourceAtt,
          },
        });

        const payload = unwrapBody(res);
        message.success(
          `引用迁移成功！已更新 ${payload?.referencesUpdated || 0} 处业务引用。${
            payload?.recycledSource === false ? '（因存在引用更新失败，源附件未移入回收站）' : ''
          }`,
        );

        // 服务端已完成回收与快照同步，重取当前页
        await fetchSnapshotPageRef.current();
      }

      setReplaceModalOpen(false);
      setReplaceUploadFile(null);
      setReplaceTargetId(undefined);
      fetchAuditLogs();
    } catch (e: any) {
      message.error({ content: e?.message || '文件替换失败', key: 'replaceUpload' });
    } finally {
      setReplaceSubmitting(false);
    }
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

  // 数据由服务端按当前 Tab 过滤并分页返回（见 fetchSnapshotPage），前端不再全量持有条目
  const items = data.items ?? [];

  const columns = [
    {
      title: '文件名',
      dataIndex: 'filename',
      key: 'filename',
      ellipsis: true,
      render: (text: string, record: any) => (
        <Tooltip title={record.title || record.filename}>
          <span style={{ fontWeight: 500 }}>{record.title || record.filename}</span>
        </Tooltip>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 110,
      render: (size: number) => formatSize(size),
    },
    {
      title: '扩展名',
      dataIndex: 'extname',
      key: 'extname',
      width: 90,
      render: (ext: string) => <Tag color="blue">{ext || '未知'}</Tag>,
    },
    {
      title: '存储空间',
      dataIndex: 'storageName',
      key: 'storageName',
      width: 160,
      render: (_: string, record: any) =>
        record.storageName ? (
          <Space>
            <span>{record.storageName}</span>
            {record.storageType && <Tag>{record.storageType}</Tag>}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>默认存储</span>
        ),
    },
    {
      title: '状态标记',
      key: 'tags',
      width: 150,
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
      width: 170,
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space size={6} wrap={false}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            disabled={!record.url || record.isMissingFile}
            title={record.isMissingFile ? '物理文件在磁盘中已丢失（404），无法预览' : undefined}
            onClick={() => {
              if (record.isMissingFile) {
                message.warning('该附件物理文件在磁盘中已丢失，无法预览，可点击【替换】重新上传修复。');
                return;
              }
              openFilePreview(record);
            }}
          >
            预览
          </Button>

          {/* 核心文件替换按钮 */}
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => openReplaceModal(record)}
            title="替换附件物理文件或迁移引用"
          >
            替换
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
                彻底删除
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
    purge: { label: '彻底物理删除', color: 'red' },
    deduplicate: { label: '重复文件去重', color: 'magenta' },
    replaceFile: { label: '文件覆盖替换', color: 'cyan' },
    replaceReference: { label: '引用迁移替换', color: 'purple' },
    updateSettings: { label: '修改配置', color: 'geekblue' },
    autoCleanExpired: { label: '自动定时清理', color: 'default' },
  };

  const renderAuditParams = (action: string, params: any) => {
    if (!params) return <span style={{ color: '#999' }}>-</span>;
    const ids = params.attachmentIds || (params.attachmentId !== undefined ? [params.attachmentId] : []);

    switch (action) {
      case 'recycle':
      case 'restore':
      case 'purge':
        return (
          <Space size={6} wrap>
            <Tag color={action === 'purge' ? 'red' : action === 'restore' ? 'blue' : 'orange'}>
              共 {ids.length} 项
            </Tag>
            <span style={{ color: '#555', fontSize: 12 }}>
              IDs: {ids.slice(0, 6).join(', ')}{ids.length > 6 ? '…' : ''}
            </span>
          </Space>
        );
      case 'deduplicate':
        return (
          <Space size={6} wrap>
            <Tag color="magenta">去重分析</Tag>
            {params.preferredStorageId && (
              <span style={{ color: '#555', fontSize: 12 }}>首选存储 ID: #{params.preferredStorageId}</span>
            )}
            {params.duplicateGroupIds && (
              <span style={{ color: '#555', fontSize: 12 }}>指定组: {params.duplicateGroupIds.length} 组</span>
            )}
          </Space>
        );
      case 'replaceFile':
        return (
          <Space size={6} wrap>
            <Tag color="cyan">目标 #{params.attachmentId}</Tag>
            <span style={{ fontSize: 12 }}>
              新文件: <strong>{params.newFilename || params.originalFilename || '新文件'}</strong>
              {params.actualSize ? ` (${formatSize(params.actualSize)})` : ''}
            </span>
          </Space>
        );
      case 'replaceReference':
        return (
          <Space size={6} wrap>
            <Tag color="purple">#{params.sourceAttachmentId} ➔ #{params.targetAttachmentId}</Tag>
            {params.recycleSource && <Tag color="default">回收源文件</Tag>}
          </Space>
        );
      case 'updateSettings':
        return (
          <Space size={6} wrap>
            {params.autoCleanEnabled !== undefined && (
              <Tag color={params.autoCleanEnabled ? 'green' : 'default'}>
                {params.autoCleanEnabled ? `自动清理开启 (${params.retentionDays || 30}天)` : '自动清理关闭'}
              </Tag>
            )}
            {params.preferredStorageId && <Tag>首选存储 #{params.preferredStorageId}</Tag>}
          </Space>
        );
      default: {
        const str = typeof params === 'string' ? params : JSON.stringify(params);
        return (
          <Tooltip title={str}>
            <span style={{ color: '#555', fontSize: 12, wordBreak: 'break-all' }}>
              {str.length > 50 ? str.slice(0, 50) + '…' : str}
            </span>
          </Tooltip>
        );
      }
    }
  };

  const renderAuditResult = (action: string, result: any) => {
    if (!result) return <span style={{ color: '#999' }}>-</span>;

    switch (action) {
      case 'recycle':
        return <Tag color="success">成功移入 {result.count ?? 0} 项</Tag>;
      case 'restore':
        return <Tag color="success">成功还原 {result.count ?? 0} 项</Tag>;
      case 'purge':
        return <Tag color="success">成功物理删除 {result.count ?? 0} 项</Tag>;
      case 'deduplicate':
        return (
          <Space size={6} wrap>
            <Badge status="success" />
            <span style={{ fontWeight: 500 }}>处理 {result.groups ?? 0} 组</span>
            <Tag color="cyan">保留 {result.keptCount ?? 0}</Tag>
            <Tag color="volcano">清理 {result.removedCount ?? 0}</Tag>
            <Tag color="purple">更新 {result.referencesUpdated ?? 0} 处引用</Tag>
          </Space>
        );
      case 'replaceFile':
        return (
          <Space size={6} wrap>
            <Badge status="success" />
            <span style={{ fontWeight: 500 }}>覆盖成功</span>
            {result.oldTitle && result.newTitle && (
              <span style={{ color: '#666', fontSize: 12 }}>
                ({result.oldTitle} ➔ {result.newTitle})
              </span>
            )}
          </Space>
        );
      case 'replaceReference':
        return (
          <Space size={6} wrap>
            <Badge status="success" />
            <span style={{ fontWeight: 500 }}>迁移成功</span>
            <Tag color="purple">更新 {result.referencesUpdated ?? 0} 处引用</Tag>
          </Space>
        );
      case 'updateSettings':
        return <Tag color="success">配置已更新生效</Tag>;
      default:
        return (
          <Tag color={result.success !== false ? 'success' : 'error'}>
            {result.success !== false ? '操作成功' : (result.message || '操作失败')}
          </Tag>
        );
    }
  };

  const openAuditDetail = (record: any) => {
    setCurrentAuditLog(record);
    setAuditDrawerOpen(true);
  };

  const auditColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: '操作人',
      dataIndex: 'operatorName',
      key: 'operatorName',
      width: 130,
      render: (_: string, record: any) => record.operatorName || record.operatorId || 'system',
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 130,
      render: (action: string) => {
        const meta = auditActionMeta[action];
        return <Tag color={meta?.color}>{meta?.label || action}</Tag>;
      },
    },
    {
      title: '参数',
      dataIndex: 'params',
      key: 'params',
      render: (v: any, record: any) => renderAuditParams(record.action, v),
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      render: (v: any, record: any) => renderAuditResult(record.action, v),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Button size="small" icon={<InfoCircleOutlined />} onClick={() => openAuditDetail(record)}>
          详情
        </Button>
      ),
    },
  ];

  // 审计日志多维筛选
  const filteredAuditLogs = auditLogs.filter((log) => {
    if (auditFilterAction !== 'all' && log.action !== auditFilterAction) {
      return false;
    }
    if (auditSearchText.trim()) {
      const q = auditSearchText.trim().toLowerCase();
      const op = String(log.operatorName || log.operatorId || '').toLowerCase();
      const p = JSON.stringify(log.params || {}).toLowerCase();
      const r = JSON.stringify(log.result || {}).toLowerCase();
      if (!op.includes(q) && !p.includes(q) && !r.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const isScanning = scanProgress.status === 'running';

  // 快照表格：数据源为服务端按当前 Tab 过滤后的分页数据
  const renderSnapshotTable = (toolbar: React.ReactNode) => (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <Space wrap>{toolbar}</Space>
        <Input
          placeholder="搜索文件名或附件 ID（回车确认）"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          value={snapshotSearch}
          onChange={(e) => {
            const v = e.target.value;
            setSnapshotSearch(v);
            if (!v) {
              fetchSnapshotPageRef.current({ page: 1, search: '' });
            }
          }}
          onPressEnter={() => fetchSnapshotPageRef.current({ page: 1, search: snapshotSearch })}
          allowClear
          style={{ width: 240 }}
        />
      </div>
      {snapshotTruncated && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="附件数量超出快照上限，仅优先保留被标记的附件（未引用/重复/回收站/丢失），可重新扫描获取完整数据。"
        />
      )}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={items}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
        pagination={{
          current: snapshotPage,
          pageSize: snapshotPageSize,
          total: snapshotTotal,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100', '200'],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setSnapshotPage(p);
            setSnapshotPageSize(ps);
            fetchSnapshotPageRef.current({ page: p, pageSize: ps });
          },
        }}
      />
    </div>
  );

  const recycleToolbar = (
    <Button
      type="primary"
      danger
      disabled={selectedRowKeys.length === 0}
      onClick={() => handleRecycle(selectedRowKeys)}
    >
      批量移入回收站
    </Button>
  );

  const tabItems = [
    {
      key: 'all',
      label: `全部附件 (${Math.max(0, data.stats.totalCount - data.stats.recycledCount)})`,
      children: renderSnapshotTable(recycleToolbar),
    },
    {
      key: 'unused',
      label: `未引用的附件 (${data.stats.unusedCount})`,
      children: renderSnapshotTable(recycleToolbar),
    },
    {
      key: 'duplicate',
      label: `重复文件分析 (${data.stats.duplicateCount})`,
      children: renderSnapshotTable(
        <>
          <Button
            type="primary"
            danger
            loading={dedupLoading}
            disabled={data.stats.duplicateCount === 0}
            onClick={handleDeduplicate}
          >
            一键去重（每组保留一个）
          </Button>
          {recycleToolbar}
        </>,
      ),
    },
    {
      key: 'recycled',
      label: `回收站 (${data.stats.recycledCount})`,
      children: renderSnapshotTable(
        <>
          <Button
            type="primary"
            disabled={selectedRowKeys.length === 0}
            onClick={() => handleRestore(selectedRowKeys)}
          >
            批量还原
          </Button>
          <Button danger disabled={selectedRowKeys.length === 0} onClick={() => handlePurge(selectedRowKeys)}>
            批量彻底删除
          </Button>
        </>,
      ),
    },
    {
      key: 'audit',
      label: `操作审计 (${auditLogs.length})`,
      children: (
        <div>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <Space wrap>
              <Button icon={<SyncOutlined />} loading={auditLoading} onClick={fetchAuditLogs}>
                刷新
              </Button>
              <Select
                value={auditFilterAction}
                onChange={(val) => setAuditFilterAction(val)}
                style={{ width: 160 }}
                options={[
                  { label: '全部操作动作', value: 'all' },
                  { label: '移入回收站', value: 'recycle' },
                  { label: '还原', value: 'restore' },
                  { label: '彻底物理删除', value: 'purge' },
                  { label: '重复文件去重', value: 'deduplicate' },
                  { label: '文件覆盖替换', value: 'replaceFile' },
                  { label: '引用迁移替换', value: 'replaceReference' },
                  { label: '修改配置', value: 'updateSettings' },
                  { label: '自动定时清理', value: 'autoCleanExpired' },
                ]}
              />
              <Input
                placeholder="搜索操作人、文件名或关键词"
                prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                value={auditSearchText}
                onChange={(e) => setAuditSearchText(e.target.value)}
                allowClear
                style={{ width: 240 }}
              />
              <span style={{ color: '#888', fontSize: 13 }}>
                已显示 <strong>{filteredAuditLogs.length}</strong> / {auditLogs.length} 条记录
              </span>
            </Space>

            <Button danger disabled={auditLogs.length === 0} onClick={handleClearAuditLogs}>
              清空日志
            </Button>
          </div>
          <Table
            rowKey="id"
            columns={auditColumns}
            dataSource={filteredAuditLogs}
            pagination={{ pageSize: 15, showSizeChanger: true, pageSizeOptions: ['15', '30', '50', '100'] }}
            locale={{ emptyText: '暂无符合条件的审计记录' }}
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

      {/* 扫描断点恢复警示条 */}
      {!isScanning && checkpoint && (
        <Alert
          style={{ marginBottom: 16 }}
          message="检测到未完成的扫描断点"
          description={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <span>
                系统记录到上次扫描在 <strong>[{checkpoint.phaseText || '处理中'}]</strong> 暂停或中断，已完成进度 <strong>{checkpoint.percent || 0}%</strong>。
                您可以直接从断点继续，未修改的附件将自动命中缓存秒级跳过。
              </span>
              <Space>
                <Button
                  type="primary"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  style={{ background: '#52c41a', borderColor: '#52c41a' }}
                  onClick={() => startScan(true)}
                >
                  继续后台续扫
                </Button>
                <Button size="small" danger onClick={handleCancelScan}>
                  放弃断点
                </Button>
              </Space>
            </div>
          }
          type="warning"
          showIcon
        />
      )}

      {/* 后台异步扫描状态卡片（完全非阻塞，支持最小化折叠） */}
      {(isScanning || scanProgress.status === 'paused') && (
        <Card
          size="small"
          style={{
            marginBottom: 16,
            borderColor: scanProgress.status === 'paused' ? '#faad14' : '#52c41a',
            background:
              scanProgress.status === 'paused'
                ? 'linear-gradient(135deg, #fffbe6 0%, #ffffff 100%)'
                : 'linear-gradient(135deg, #f6ffed 0%, #ffffff 100%)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              {isScanning ? (
                <Badge status="processing" color="#52c41a" text={<strong style={{ color: '#389e0d' }}>后台静默扫描运行中</strong>} />
              ) : (
                <Badge status="warning" text={<strong style={{ color: '#d46b08' }}>后台扫描已暂停</strong>} />
              )}
              <Tag color={scanProgress.status === 'paused' ? 'orange' : 'green'}>
                {scanProgress.phaseText || '正在后台处理'}
              </Tag>
              <Tag icon={<ThunderboltOutlined />} color="cyan">
                复合智能缓存加速
              </Tag>
              {isScanning && (
                <span style={{ color: '#888', fontSize: 12 }}>
                  已在后台运行: <strong>{elapsedTime}</strong> 秒（不影响前台任何操作）
                </span>
              )}
            </Space>

            <Space>
              {isScanning ? (
                <>
                  <Button size="small" icon={<PauseCircleOutlined />} onClick={handlePauseScan}>
                    暂停后台任务
                  </Button>
                  <Button size="small" danger icon={<CloseCircleOutlined />} onClick={handleCancelScan}>
                    终止任务
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    style={{ background: '#52c41a', borderColor: '#52c41a' }}
                    onClick={() => startScan(true)}
                  >
                    继续后台任务
                  </Button>
                  <Button size="small" danger icon={<CloseCircleOutlined />} onClick={handleCancelScan}>
                    终止任务
                  </Button>
                </>
              )}
              <Button
                size="small"
                type="text"
                icon={minimizedProgress ? <DownOutlined /> : <UpOutlined />}
                onClick={() => setMinimizedProgress(!minimizedProgress)}
              >
                {minimizedProgress ? '展开进度' : '收起'}
              </Button>
            </Space>
          </div>

          {!minimizedProgress && (
            <div style={{ marginTop: 8 }}>
              <Progress
                percent={scanProgress.percent}
                size="small"
                status={scanProgress.status === 'paused' ? 'normal' : 'active'}
                strokeColor={
                  scanProgress.status === 'paused'
                    ? '#faad14'
                    : {
                        '0%': '#108ee9',
                        '100%': '#52c41a',
                      }
                }
              />
            </div>
          )}
        </Card>
      )}

      <Card
        title={
          <Space>
            <span>附件清理与维护面板</span>
            {lastScannedAt && (
              <Tag icon={<ClockCircleOutlined />} color="default">
                最近扫描快照: {lastScannedAt}
              </Tag>
            )}
          </Space>
        }
        extra={
          <Space>
            <Button
              icon={<SyncOutlined spin={isScanning} />}
              type={isScanning ? 'dashed' : 'default'}
              onClick={() => startScan(false)}
            >
              {isScanning ? '后台扫描运行中...' : '启动后台全盘扫描'}
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
        <Tabs
          defaultActiveKey="all"
          items={tabItems}
          onChange={(k) => {
            setActiveTabKey(k);
            setSelectedRowKeys([]);
            fetchSnapshotPageRef.current({ page: 1, filter: TAB_FILTER_MAP[k] ?? 'all' });
          }}
        />
      </Card>

      {/* 文件替换弹窗 */}
      <Modal
        title={
          <Space>
            <SwapOutlined style={{ color: '#1890ff' }} />
            <span>附件文件替换与版本更新</span>
          </Space>
        }
        open={replaceModalOpen}
        onCancel={() => {
          setReplaceModalOpen(false);
          setReplaceUploadFile(null);
          setReplaceTargetId(undefined);
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setReplaceModalOpen(false);
              setReplaceUploadFile(null);
              setReplaceTargetId(undefined);
            }}
          >
            取消
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={replaceSubmitting}
            disabled={replaceMode === 'upload' ? !replaceUploadFile : !replaceTargetId}
            onClick={handleExecuteReplace}
          >
            {replaceMode === 'upload' ? '确认覆盖替换' : '确认迁移引用'}
          </Button>,
        ]}
        width={640}
      >
        {currentReplaceRecord && (
          <div>
            <Alert
              style={{ marginBottom: 16 }}
              message="当前待替换的目标附件"
              description={
                <div style={{ marginTop: 4 }}>
                  <p style={{ margin: '2px 0' }}>
                    <strong>原文件名:</strong> {currentReplaceRecord.title || currentReplaceRecord.filename}
                  </p>
                  <p style={{ margin: '2px 0', color: '#666' }}>
                    <strong>附件 ID:</strong> {currentReplaceRecord.id} | <strong>原大小:</strong>{' '}
                    {formatSize(currentReplaceRecord.size)} | <strong>存储空间:</strong>{' '}
                    {currentReplaceRecord.storageName || '默认存储'}
                  </p>
                  {currentReplaceRecord.isMissingFile && (
                    <Tag color="magenta" style={{ marginTop: 4 }}>
                      物理磁盘文件已丢失（可通过上传新文件原地修复）
                    </Tag>
                  )}
                </div>
              }
              type="info"
              showIcon
            />

            <Tabs
              activeKey={replaceMode}
              onChange={(k) => setReplaceMode(k as any)}
              items={[
                {
                  key: 'upload',
                  label: '上传新文件覆盖（推荐：保持原 ID 与引用不变）',
                  children: (
                    <div style={{ padding: '8px 0' }}>
                      <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
                        上传新的物理文件覆盖当前附件记录，<strong>保持原有附件 ID 和所有数据表引用关系不变</strong>。适用于升级合同/图片/文档模板版本，或修复 404 缺失附件。
                      </p>
                      <Upload.Dragger
                        maxCount={1}
                        beforeUpload={(file) => {
                          setReplaceUploadFile(file);
                          return false;
                        }}
                        onRemove={() => setReplaceUploadFile(null)}
                        fileList={replaceUploadFile ? [replaceUploadFile as any] : []}
                      >
                        <p className="ant-upload-drag-icon">
                          <InboxOutlined style={{ fontSize: 36, color: '#1890ff' }} />
                        </p>
                        <p className="ant-upload-text">点击或将新文件拖拽到此区域</p>
                        <p className="ant-upload-hint">支持任意格式文件，覆盖后所有业务引用即时生效</p>
                      </Upload.Dragger>
                    </div>
                  ),
                },
                {
                  key: 'reference',
                  label: '全局改指向已有附件',
                  children: (
                    <div style={{ padding: '8px 0' }}>
                      <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
                        将所有引用当前附件的业务数据表记录，<strong>全局批量改指向选中的目标附件</strong>。
                      </p>
                      <Form layout="vertical">
                        <Form.Item label="选择目标替换附件" required>
                          <Select
                            showSearch
                            placeholder="输入文件名或 ID 搜索目标附件..."
                            filterOption={false}
                            value={replaceTargetId}
                            onChange={(val) => setReplaceTargetId(val)}
                            onSearch={(input) => fetchReplaceTargets(input)}
                            onDropdownVisibleChange={(open) => {
                              if (open) {
                                fetchReplaceTargets('');
                              }
                            }}
                            options={replaceTargetOptions}
                            notFoundContent={replaceSubmitting ? '搜索中...' : '未找到匹配的附件'}
                          />
                        </Form.Item>
                        <Form.Item>
                          <Switch
                            checked={recycleSourceAtt}
                            onChange={(checked) => setRecycleSourceAtt(checked)}
                          />
                          <span style={{ marginLeft: 8 }}>替换完成后将当前原附件移入回收站</span>
                        </Form.Item>
                      </Form>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Modal>

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

      {/* 审计日志详情抽屉 */}
      <Drawer
        title={
          <Space>
            <InfoCircleOutlined style={{ color: '#1890ff' }} />
            <span>操作审计详情</span>
            {currentAuditLog && (
              <Tag color={auditActionMeta[currentAuditLog.action]?.color}>
                {auditActionMeta[currentAuditLog.action]?.label || currentAuditLog.action}
              </Tag>
            )}
          </Space>
        }
        placement="right"
        width={620}
        open={auditDrawerOpen}
        onClose={() => {
          setAuditDrawerOpen(false);
          setCurrentAuditLog(null);
        }}
      >
        {currentAuditLog && (
          <div>
            <Descriptions title="基本信息" bordered size="small" column={1} style={{ marginBottom: 20 }}>
              <Descriptions.Item label="操作时间">
                {currentAuditLog.createdAt ? new Date(currentAuditLog.createdAt).toLocaleString() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="操作用户">
                <strong>{currentAuditLog.operatorName || currentAuditLog.operatorId || '系统内置'}</strong>
                {currentAuditLog.operatorId && (
                  <span style={{ color: '#888', marginLeft: 8 }}>(ID: {currentAuditLog.operatorId})</span>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="动作类型">
                <Tag color={auditActionMeta[currentAuditLog.action]?.color}>
                  {auditActionMeta[currentAuditLog.action]?.label || currentAuditLog.action}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>请求参数 (Params)</span>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(currentAuditLog.params, null, 2));
                    message.success('参数 JSON 已复制到剪贴板');
                  }}
                >
                  复制 JSON
                </Button>
              </div>
              <pre
                style={{
                  background: '#1e1e1e',
                  color: '#9cdcfe',
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 12,
                  maxHeight: 220,
                  overflow: 'auto',
                  fontFamily: 'Consolas, Monaco, monospace',
                }}
              >
                {JSON.stringify(currentAuditLog.params || {}, null, 2)}
              </pre>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>执行结果 (Result)</span>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(currentAuditLog.result, null, 2));
                    message.success('结果 JSON 已复制到剪贴板');
                  }}
                >
                  复制 JSON
                </Button>
              </div>
              <pre
                style={{
                  background: '#1e1e1e',
                  color: '#6a9955',
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 12,
                  maxHeight: 260,
                  overflow: 'auto',
                  fontFamily: 'Consolas, Monaco, monospace',
                }}
              >
                {JSON.stringify(currentAuditLog.result || {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default AttachmentCleanerPage;
