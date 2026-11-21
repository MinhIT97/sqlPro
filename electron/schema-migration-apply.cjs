'use strict';

const crypto = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });

class SchemaMigrationApply {
  constructor({ service, orchestrator, store, checkSnapshot, checkPolicy, getGeneration, claimTransfer, releaseTransfer, confirm }) {
    Object.assign(this, { service, orchestrator, store, checkSnapshot, checkPolicy, getGeneration, claimTransfer, releaseTransfer, confirm });
  }

  async execute(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['planToken', 'taskId'].includes(key))
        || typeof payload.planToken !== 'string' || !/^[a-f0-9]{64}$/.test(payload.planToken)
        || payload.taskId !== undefined && (typeof payload.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.taskId))) {
      throw fail('INVALID_MIGRATION_APPLY', 'Chỉ nhận token kế hoạch và taskId hợp lệ; không nhận SQL hoặc cờ xác nhận.');
    }
    const preview = this.service.getPreviewPlan(payload.planToken);
    if (preview.applySupported !== true) throw fail('MIGRATION_APPLY_NOT_READY', 'Kế hoạch chưa hỗ trợ áp dụng trực tiếp.');
    const source = this.service.getSnapshot(preview.sourceSnapshotId), target = this.service.getSnapshot(preview.targetSnapshotId);
    this.checkSnapshot(source); this.checkSnapshot(target); this.checkPolicy(target.scope.profileId);
    const taskId = payload.taskId || `migration-${crypto.randomBytes(16).toString('hex')}`;
    const generation = this.getGeneration();
    const transfer = this.claimTransfer({ operation: 'schema-migration', profileId: target.scope.profileId,
      database: target.database, sourceProfileId: source.scope.profileId, taskId, pending: true });
    let admitted, approvalToken;
    const check = () => {
      if (transfer.controller.signal.aborted || transfer.canceled) throw fail('QUERY_CANCELED', 'Đã hủy migration.');
      if (this.getGeneration() !== generation) throw fail('MIGRATION_CONTEXT_CHANGED', 'Phiên ứng dụng đã thay đổi.');
      if (Date.now() >= preview.expiresAt) throw fail('MIGRATION_PLAN_EXPIRED', 'Kế hoạch đã hết hạn.');
      this.checkSnapshot(source); this.checkSnapshot(target); this.checkPolicy(target.scope.profileId);
    };
    try {
      const candidate = this.service.consumeApplyCandidate(payload.planToken);
      admitted = this.orchestrator.admitPlan(candidate);
      const profile = this.store.getWithSecrets(target.scope.profileId);
      if (profile.environment === 'production') {
        const receipt = await this.orchestrator.requestProductionApproval(admitted.planToken);
        approvalToken = receipt.approvalToken;
      } else {
        const result = await this.confirm({ type: 'warning', title: 'Áp dụng migration schema',
          message: `Áp dụng ${admitted.statements.length} lệnh DDL vào ${target.database}?`,
          detail: `Kết nối: ${profile.name || profile.id}\nMáy chủ: ${profile.host || ''}:${profile.port || 3306}\nNguồn: ${source.database}\nĐích: ${target.database}\n\nChỉ tạo bảng, thêm cột và thêm index trong phạm vi đã xem trước. Chạy bằng phiên riêng. DDL có thể khóa/rebuild bảng và commit ngầm; không thể rollback toàn bộ. Hãy có backup phù hợp trước khi chạy. Khi lỗi/hủy, đích có thể đã thay đổi một phần; không tự retry.`,
          buttons: ['Hủy', 'Xác nhận đúng đích và áp dụng'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return { canceled: true, taskId };
      }
      check(); transfer.pending = false;
      try {
        const job = await this.orchestrator.executeMigrationJob({ planToken: admitted.planToken, approvalToken, signal: transfer.controller.signal });
        return { taskId, job };
      } catch (error) {
        // The job projection contains only whitelisted ledger/status fields.
        if (error.job?.kind === 'sqlpro-migration-job') return { taskId, job: error.job };
        throw error;
      }
    } catch (error) {
      if (error.code === 'MIGRATION_APPROVAL_CANCELED') return { canceled: true, taskId };
      throw error;
    } finally {
      if (admitted) { try { this.orchestrator.admission.consumePlan(admitted.planToken); } catch {} }
      if (approvalToken) this.orchestrator.approval.cancel(approvalToken);
      this.releaseTransfer(transfer);
    }
  }
}

module.exports = { SchemaMigrationApply };
