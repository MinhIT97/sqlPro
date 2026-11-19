'use strict';

const crypto = require('node:crypto');
const { RestoreDependencyGraph } = require('./restore-dependency-graph.cjs');

const DEFAULT_SYNC_PLAN_OPTIONS = Object.freeze({
  planTtlMs: 5 * 60 * 1000,
  maxPendingPlans: 32
});

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

function computePlanDigest(payload) {
  const normalized = {
    sourceScope: payload.sourceScope,
    targetScope: payload.targetScope,
    primaryKeys: payload.primaryKeys,
    columns: payload.columns,
    counts: payload.counts,
    direction: payload.direction,
    tables: payload.tables || null,
    insertOrder: payload.insertOrder || null,
    deleteOrder: payload.deleteOrder || null,
    operations: (payload.operations || []).map(op => ({
      table: op.table || payload.targetScope?.table || null,
      type: op.type,
      rowKey: op.rowKey,
      pkValues: op.pkValues,
      values: op.values || null,
      originalValues: op.originalValues || null,
      changedColumns: op.changedColumns || null
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function projectPlanForRenderer(plan) {
  if (!plan) return null;
  const projectScope = scope => Object.freeze({ profileId: scope.profileId, database: scope.database, table: scope.table });
  return Object.freeze({
    planToken: plan.planToken,
    planDigest: plan.planDigest,
    expiresAt: plan.expiresAt,
    direction: plan.direction,
    sourceScope: projectScope(plan.sourceScope),
    targetScope: projectScope(plan.targetScope),
    applySupported: false,
    applyBlockReason: 'SYNC_APPLY_NOT_READY',
    primaryKeys: Object.freeze([...plan.primaryKeys]),
    columns: Object.freeze(plan.columns.map(c => Object.freeze({ name: c.name, type: c.type }))),
    insertOrder: plan.insertOrder ? Object.freeze([...plan.insertOrder]) : null,
    deleteOrder: plan.deleteOrder ? Object.freeze([...plan.deleteOrder]) : null,
    counts: Object.freeze({ ...plan.counts }),
    operationsPreview: Object.freeze(plan.operations.slice(0, 100).map(op => Object.freeze({
      type: op.type,
      rowKey: op.rowKey,
      changedColumns: op.changedColumns ? Object.freeze([...op.changedColumns]) : null
    })))
  });
}

class DataSyncPlanService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_SYNC_PLAN_OPTIONS, ...options };
    this.store = options.store || null;
    this.dataDiffService = options.dataDiffService || null;
    this.pendingPlans = new Map();
    this.usedTokens = new Set();
  }

  prune() {
    const now = Date.now();
    for (const [token, plan] of this.pendingPlans) {
      if (now >= plan.expiresAt) {
        this.pendingPlans.delete(token);
      }
    }
    if (this.usedTokens.size > 1000) {
      this.usedTokens.clear();
    }
  }

  clear() {
    this.pendingPlans.clear();
    this.usedTokens.clear();
  }

  createSyncPlanFromJob(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['jobId', 'direction', 'options'].includes(key))) {
      throw error('CALLER_FIELDS_REJECTED', 'Chỉ nhận jobId và lựa chọn đồng bộ, không nhận report/scope từ renderer.');
    }
    if (typeof payload.jobId !== 'string' || !payload.jobId || payload.jobId.length > 160) {
      throw error('DIFF_JOB_NOT_FOUND', 'Thiếu định danh kết quả so sánh do Main sở hữu.');
    }
    const options = payload.options ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => key !== 'includeDeletes')
        || options.includeDeletes !== undefined && typeof options.includeDeletes !== 'boolean') {
      throw error('INVALID_SYNC_OPTIONS', 'Lựa chọn đồng bộ không hợp lệ.');
    }
    return this.createSyncPlan({ ...payload, options });
  }

  createSyncPlan({
    jobId,
    diffReport,
    sourceScope,
    targetScope,
    direction = 'source-to-target',
    options = {}
  } = {}) {
    this.prune();

    if (this.pendingPlans.size >= this.options.maxPendingPlans) {
      throw error('SYNC_PLAN_BUSY', 'Quá nhiều kế hoạch đồng bộ đang chờ; vui lòng thử lại sau.');
    }

    let report = diffReport;
    let srcScope = sourceScope;
    let tgtScope = targetScope;

    if (jobId) {
      if (diffReport !== undefined || sourceScope !== undefined || targetScope !== undefined) {
        throw error('CALLER_FIELDS_REJECTED', 'Không nhận report/scope cùng jobId.');
      }
      if (typeof this.dataDiffService?.getJob !== 'function') {
        throw error('DIFF_JOB_SERVICE_UNAVAILABLE', 'Thiếu dịch vụ kết quả so sánh do Main sở hữu.');
      }
      const job = this.dataDiffService.getJob(jobId);
      if (!job || job.status !== 'completed' || !job.report) {
        throw error('DIFF_JOB_NOT_FOUND', 'Không tìm thấy kết quả so sánh hoàn tất từ Main.');
      }
      report = job.report;
      srcScope = job.sourceScope;
      tgtScope = job.targetScope;
      if (report.coverage?.complete !== true || report.coverage?.consistent !== true) {
        throw error('DIFF_REPORT_INCOMPLETE', 'Kết quả so sánh chưa đầy đủ hoặc thiếu snapshot nhất quán.');
      }
    }

    if (!report || typeof report !== 'object') {
      throw error('INVALID_DIFF_REPORT', 'Báo cáo so sánh dữ liệu không hợp lệ.');
    }

    if (!srcScope || !srcScope.profileId || !srcScope.database || !srcScope.table) {
      throw error('INVALID_SCOPE', 'Thông tin bảng nguồn không hợp lệ.');
    }
    if (!tgtScope || !tgtScope.profileId || !tgtScope.database || !tgtScope.table) {
      throw error('INVALID_SCOPE', 'Thông tin bảng đích không hợp lệ.');
    }

    if (direction !== 'source-to-target') {
      throw error('UNSUPPORTED_SYNC_DIRECTION', 'Hiện chỉ hỗ trợ đồng bộ chiều Nguồn -> Đích (source-to-target).');
    }

    const primaryKeys = Array.isArray(report.primaryKeys) ? report.primaryKeys : [];
    if (!primaryKeys.length) {
      throw error('DATA_DIFF_NO_PRIMARY_KEY', 'Bảng không có khóa chính; không thể tạo kế hoạch đồng bộ.');
    }

    const columns = Array.isArray(report.columns) ? report.columns : [];
    if (!columns.length) {
      throw error('INVALID_COLUMNS', 'Thông tin cột bảng không hợp lệ.');
    }

    const includeDeletes = options.includeDeletes === true;
    const operations = [];

    // 1. INSERTS (rows only in source)
    const onlyInSource = Array.isArray(report.onlyInSource) ? report.onlyInSource : [];
    for (const item of onlyInSource) {
      const row = item.row;
      const pkValues = [];
      const values = {};

      for (const col of columns) {
        const val = Array.isArray(row) ? row[columns.indexOf(col)] : row[col.name];
        values[col.name] = val;
        if (primaryKeys.includes(col.name)) {
          pkValues.push(val);
        }
      }

      operations.push({
        type: 'INSERT',
        rowKey: item.rowKey,
        pkValues,
        values
      });
    }

    // 2. UPDATES (rows differing between source and target)
    const different = Array.isArray(report.different) ? report.different : [];
    for (const item of different) {
      const sRow = item.sourceRow;
      const tRow = item.targetRow;
      const pkValues = [];
      const sourceValues = {};
      const originalValues = {};
      const changedColumns = (item.differences || []).map(d => d.column);

      for (const col of columns) {
        const sVal = Array.isArray(sRow) ? sRow[columns.indexOf(col)] : sRow[col.name];
        const tVal = Array.isArray(tRow) ? tRow[columns.indexOf(col)] : tRow[col.name];
        sourceValues[col.name] = sVal;
        originalValues[col.name] = tVal;
        if (primaryKeys.includes(col.name)) {
          pkValues.push(sVal);
        }
      }

      operations.push({
        type: 'UPDATE',
        rowKey: item.rowKey,
        pkValues,
        values: sourceValues,
        originalValues,
        changedColumns
      });
    }

    // 3. DELETES (rows only in target - OPT-IN ONLY)
    if (includeDeletes) {
      const onlyInTarget = Array.isArray(report.onlyInTarget) ? report.onlyInTarget : [];
      for (const item of onlyInTarget) {
        const row = item.row;
        const pkValues = [];
        const originalValues = {};

        for (const col of columns) {
          const val = Array.isArray(row) ? row[columns.indexOf(col)] : row[col.name];
          originalValues[col.name] = val;
          if (primaryKeys.includes(col.name)) {
            pkValues.push(val);
          }
        }

        operations.push({
          type: 'DELETE',
          rowKey: item.rowKey,
          pkValues,
          originalValues
        });
      }
    }

    if (operations.length === 0) {
      throw error('SYNC_PLAN_EMPTY', 'Không có thao tác nào cần đồng bộ dữ liệu.');
    }

    const counts = {
      inserts: operations.filter(op => op.type === 'INSERT').length,
      updates: operations.filter(op => op.type === 'UPDATE').length,
      deletes: operations.filter(op => op.type === 'DELETE').length,
      total: operations.length
    };

    const planToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.options.planTtlMs;

    const safeSourceScope = structuredClone(srcScope);
    const safeTargetScope = structuredClone(tgtScope);

    const payloadToHash = {
      sourceScope: safeSourceScope,
      targetScope: safeTargetScope,
      primaryKeys,
      columns,
      counts,
      direction,
      operations
    };

    const planDigest = computePlanDigest(payloadToHash);

    const plan = {
      kind: 'sqlpro-data-sync-plan',
      planToken,
      planDigest,
      expiresAt,
      jobId: jobId || null,
      // Bounded observations are preview evidence, never write authorization.
      applySupported: jobId ? false : undefined,
      direction,
      sourceScope: safeSourceScope,
      targetScope: safeTargetScope,
      primaryKeys,
      columns,
      counts,
      operations: deepFreeze(operations)
    };

    this.pendingPlans.set(planToken, plan);

    return projectPlanForRenderer(plan);
  }

  createMultiTableSyncPlan({
    tableDiffReports = [],
    sourceScope,
    targetScope,
    relations = [],
    direction = 'source-to-target',
    options = {}
  } = {}) {
    this.prune();

    if (this.pendingPlans.size >= this.options.maxPendingPlans) {
      throw error('SYNC_PLAN_BUSY', 'Quá nhiều kế hoạch đồng bộ đang chờ; vui lòng thử lại sau.');
    }

    if (!Array.isArray(tableDiffReports) || tableDiffReports.length === 0) {
      throw error('INVALID_DIFF_REPORT', 'Danh sách báo cáo so sánh dữ liệu bảng không được để trống.');
    }

    if (!sourceScope || !sourceScope.profileId || !sourceScope.database) {
      throw error('INVALID_SCOPE', 'Thông tin database nguồn không hợp lệ.');
    }
    if (!targetScope || !targetScope.profileId || !targetScope.database) {
      throw error('INVALID_SCOPE', 'Thông tin database đích không hợp lệ.');
    }

    if (direction !== 'source-to-target') {
      throw error('UNSUPPORTED_SYNC_DIRECTION', 'Hiện chỉ hỗ trợ đồng bộ chiều Nguồn -> Đích (source-to-target).');
    }

    // Build dependency DAG
    const graph = new RestoreDependencyGraph();
    const tableMap = new Map();

    for (const entry of tableDiffReports) {
      if (!entry.table || !entry.diffReport) {
        throw error('INVALID_DIFF_REPORT', 'Thông tin bảng hoặc báo cáo so sánh không hợp lệ.');
      }
      const tableName = String(entry.table);
      const key = RestoreDependencyGraph.nodeKey('table', tableName);
      graph.addNode({ type: 'table', name: tableName });
      tableMap.set(tableName.toLowerCase(), entry);
    }

    for (const rel of relations) {
      if (rel.tableName && rel.refTable) {
        const fromKey = RestoreDependencyGraph.nodeKey('table', rel.tableName);
        const toKey = RestoreDependencyGraph.nodeKey('table', rel.refTable);
        if (graph.hasNode(fromKey) && graph.hasNode(toKey)) {
          graph.addEdge(fromKey, toKey);
        }
      }
    }

    // Detect circular dependencies
    const cycles = graph.detectCycles();
    if (cycles.length > 0) {
      throw error('CIRCULAR_DEPENDENCY_DETECTED', `Phát hiện phụ thuộc vòng giữa các bảng: ${cycles[0].join(' -> ')}`);
    }

    // Topological sorting: parent first for inserts
    const { order } = graph.topologicalSort();
    const insertOrder = order.map(k => graph.getNode(k).name);
    const deleteOrder = [...insertOrder].reverse();

    const includeDeletes = options.includeDeletes === true;
    const operations = [];
    const tablesMeta = {};

    // 1. INSERTS in topological order (parents first)
    for (const tableName of insertOrder) {
      const entry = tableMap.get(tableName.toLowerCase());
      if (!entry) continue;
      const { diffReport } = entry;
      const primaryKeys = diffReport.primaryKeys || [];
      const columns = diffReport.columns || [];
      tablesMeta[tableName] = { primaryKeys, columns };

      const onlyInSource = Array.isArray(diffReport.onlyInSource) ? diffReport.onlyInSource : [];
      for (const item of onlyInSource) {
        const row = item.row;
        const pkValues = [];
        const values = {};
        for (const col of columns) {
          const val = Array.isArray(row) ? row[columns.indexOf(col)] : row[col.name];
          values[col.name] = val;
          if (primaryKeys.includes(col.name)) pkValues.push(val);
        }
        operations.push({
          type: 'INSERT',
          table: tableName,
          rowKey: item.rowKey,
          pkValues,
          values
        });
      }
    }

    // 2. UPDATES in topological order
    for (const tableName of insertOrder) {
      const entry = tableMap.get(tableName.toLowerCase());
      if (!entry) continue;
      const { diffReport } = entry;
      const primaryKeys = diffReport.primaryKeys || [];
      const columns = diffReport.columns || [];

      const different = Array.isArray(diffReport.different) ? diffReport.different : [];
      for (const item of different) {
        const sRow = item.sourceRow;
        const tRow = item.targetRow;
        const pkValues = [];
        const sourceValues = {};
        const originalValues = {};
        const changedColumns = (item.differences || []).map(d => d.column);

        for (const col of columns) {
          const sVal = Array.isArray(sRow) ? sRow[columns.indexOf(col)] : sRow[col.name];
          const tVal = Array.isArray(tRow) ? tRow[columns.indexOf(col)] : tRow[col.name];
          sourceValues[col.name] = sVal;
          originalValues[col.name] = tVal;
          if (primaryKeys.includes(col.name)) pkValues.push(sVal);
        }

        operations.push({
          type: 'UPDATE',
          table: tableName,
          rowKey: item.rowKey,
          pkValues,
          values: sourceValues,
          originalValues,
          changedColumns
        });
      }
    }

    // 3. DELETES in reverse topological order (children first)
    if (includeDeletes) {
      for (const tableName of deleteOrder) {
        const entry = tableMap.get(tableName.toLowerCase());
        if (!entry) continue;
        const { diffReport } = entry;
        const primaryKeys = diffReport.primaryKeys || [];
        const columns = diffReport.columns || [];

        const onlyInTarget = Array.isArray(diffReport.onlyInTarget) ? diffReport.onlyInTarget : [];
        for (const item of onlyInTarget) {
          const row = item.row;
          const pkValues = [];
          const originalValues = {};
          for (const col of columns) {
            const val = Array.isArray(row) ? row[columns.indexOf(col)] : row[col.name];
            originalValues[col.name] = val;
            if (primaryKeys.includes(col.name)) pkValues.push(val);
          }
          operations.push({
            type: 'DELETE',
            table: tableName,
            rowKey: item.rowKey,
            pkValues,
            originalValues
          });
        }
      }
    }

    if (operations.length === 0) {
      throw error('SYNC_PLAN_EMPTY', 'Không có thao tác nào cần đồng bộ dữ liệu.');
    }

    const counts = {
      inserts: operations.filter(op => op.type === 'INSERT').length,
      updates: operations.filter(op => op.type === 'UPDATE').length,
      deletes: operations.filter(op => op.type === 'DELETE').length,
      total: operations.length
    };

    const planToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.options.planTtlMs;

    const safeSourceScope = structuredClone(sourceScope);
    const safeTargetScope = structuredClone(targetScope);

    const payloadToHash = {
      sourceScope: safeSourceScope,
      targetScope: safeTargetScope,
      primaryKeys: [],
      columns: [],
      counts,
      direction,
      tables: tablesMeta,
      insertOrder,
      deleteOrder,
      operations
    };

    const planDigest = computePlanDigest(payloadToHash);

    const plan = {
      kind: 'sqlpro-data-sync-plan',
      planToken,
      planDigest,
      expiresAt,
      direction,
      sourceScope: safeSourceScope,
      targetScope: safeTargetScope,
      primaryKeys: [],
      columns: [],
      tables: tablesMeta,
      insertOrder,
      deleteOrder,
      counts,
      operations: deepFreeze(operations)
    };

    this.pendingPlans.set(planToken, plan);

    return projectPlanForRenderer(plan);
  }

  consumePlan(planToken) {
    if (typeof planToken !== 'string' || !planToken.trim()) {
      throw error('INVALID_PLAN_TOKEN', 'Token kế hoạch đồng bộ không hợp lệ.');
    }
    if (this.usedTokens.has(planToken)) {
      throw error('SYNC_PLAN_TOKEN_USED', 'Token kế hoạch đồng bộ đã được sử dụng; mỗi token chỉ dùng được một lần.');
    }

    const plan = this.pendingPlans.get(planToken);
    if (!plan) {
      throw error('SYNC_PLAN_NOT_FOUND', 'Không tìm thấy kế hoạch đồng bộ hoặc kế hoạch đã hết hạn.');
    }

    if (Date.now() >= plan.expiresAt) {
      this.pendingPlans.delete(planToken);
      throw error('SYNC_PLAN_EXPIRED', 'Kế hoạch đồng bộ đã hết hạn; vui lòng tạo lại preview.');
    }

    this.pendingPlans.delete(planToken);
    this.usedTokens.add(planToken);

    return deepFreeze(plan);
  }
}

module.exports = {
  DataSyncPlanService,
  computePlanDigest,
  projectPlanForRenderer
};
