'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSession } = require('../electron/database.cjs');
const {
  SchemaMigrationAdmission,
  SchemaMigrationApproval,
  createMainContextHooks,
  createSourceVerifier,
  planDigest: admissionPlanDigest
} = require('../electron/schema-migration-admission.cjs');
const { SchemaMigrationExecutor, planDigest } = require('../electron/schema-migration-executor.cjs');
const { computeSchemaFingerprint } = require('../electron/schema-snapshot.cjs');
const { ProductionApprovals } = require('../electron/production-approvals.cjs');

function sampleProfiles() {
  return {
    source: { id: 'source', name: 'Dev DB', host: 'source.fixture', port: 3306, user: 'root', readOnly: true, environment: 'local' },
    target: { id: 'target', name: 'Prod DB', host: 'target.fixture', port: 3306, user: 'root', readOnly: false, environment: 'production' }
  };
}

function sampleCandidate(overrides = {}) {
  const token = 'a'.repeat(64);
  const profiles = sampleProfiles();
  const scope = (id) => ({
    profileId: id,
    database: 'sample',
    sessionId: `session-${id}`,
    generation: 0,
    engine: 'MySQL',
    snapshotIdentity: (id === 'source' ? '1' : '2').repeat(64),
    profileFingerprint: computeSchemaFingerprint(profiles[id])
  });

  return {
    planId: 'plan-candidate-1',
    planToken: token,
    status: 'ready',
    applySupported: true,
    expiresAt: Date.now() + 180000,
    sourceScope: scope('source'),
    targetScope: scope('target'),
    options: { wrapForeignKeys: false, statementTimeoutMs: 30000 },
    statements: [
      { id: 'stmt_1', sql: 'CREATE TABLE orders (id INT PRIMARY KEY)', type: 'CREATE_TABLE', status: 'executable', enabled: true },
      { id: 'stmt_2', sql: 'ALTER TABLE orders ADD COLUMN amount DECIMAL(10,2)', type: 'ADD_COLUMN', status: 'executable', enabled: true }
    ],
    ...overrides
  };
}

const confirmDialog = async () => ({ response: 1 });

// ---------------------------------------------------------------------------
// 1. Admission Unit Tests
// ---------------------------------------------------------------------------

test('preview, blocked and partial plans cannot be self-promoted to ready without admission test bypass', () => {
  const admission = new SchemaMigrationAdmission();

  // Preview plan
  const previewPlan = sampleCandidate({ status: 'preview', applySupported: false });
  assert.throws(() => admission.admitCandidate(previewPlan), { code: 'MIGRATION_APPLY_NOT_READY' });

  // Blocked plan
  const blockedPlan = sampleCandidate({ status: 'blocked', applySupported: false });
  assert.throws(() => admission.admitCandidate(blockedPlan), { code: 'MIGRATION_APPLY_NOT_READY' });

  // Disabled or blocked statement
  const disabledStmt = sampleCandidate({
    statements: [{ id: 's1', sql: 'SELECT 1', status: 'executable', enabled: false }]
  });
  assert.throws(() => admission.admitCandidate(disabledStmt, { allowTestCandidate: true }), {
    code: 'MIGRATION_STATEMENTS_BLOCKED'
  });

  // wrapForeignKeys: true
  const fkWrap = sampleCandidate({ options: { wrapForeignKeys: true } });
  assert.throws(() => admission.admitCandidate(fkWrap, { allowTestCandidate: true }), {
    code: 'FK_OVERRIDE_UNSUPPORTED'
  });

  // Cross engine
  const crossEngine = sampleCandidate();
  crossEngine.targetScope.engine = 'MariaDB';
  assert.throws(() => admission.admitCandidate(crossEngine, { allowTestCandidate: true }), {
    code: 'CROSS_ENGINE_MIGRATION_UNSUPPORTED'
  });

  // Same profile and database
  const sameDb = sampleCandidate();
  sameDb.targetScope.profileId = sameDb.sourceScope.profileId;
  sameDb.targetScope.database = sameDb.sourceScope.database;
  assert.throws(() => admission.admitCandidate(sameDb, { allowTestCandidate: true }), {
    code: 'SAME_DATABASE'
  });
});

test('admitted plan is immutable and external mutations do not affect stored state', () => {
  const admission = new SchemaMigrationAdmission();
  const candidate = sampleCandidate();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  assert.equal(admitted.status, 'ready');
  assert.equal(admitted.applySupported, true);
  assert.ok(admitted.planDigest);
  assert.equal(admitted.planDigest, planDigest(admitted));
  assert.equal(admitted.planDigest, admissionPlanDigest(admitted));

  // Attempt mutations on original candidate
  candidate.statements[0].sql = 'DROP DATABASE production_db';
  candidate.targetScope.database = 'hacked_db';

  // Consume plan
  const consumed = admission.consumePlan(admitted.planToken);
  assert.equal(consumed.statements[0].sql, 'CREATE TABLE orders (id INT PRIMARY KEY)');
  assert.equal(consumed.targetScope.database, 'sample');
  assert.throws(() => { consumed.statements[0].sql = 'CHANGE'; }, TypeError);
});

test('atomic consumption prevents token replay and concurrent consumption', async () => {
  const admission = new SchemaMigrationAdmission();
  const candidate = sampleCandidate();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  // First consumption succeeds
  const first = admission.consumePlan(admitted.planToken);
  assert.equal(first.planId, candidate.planId);

  // Second consumption fails immediately with MIGRATION_TOKEN_USED
  assert.throws(() => admission.consumePlan(admitted.planToken), { code: 'MIGRATION_TOKEN_USED' });

  // Concurrent consumption: exactly one succeeds
  const candidate2 = sampleCandidate({ planId: 'plan-2', planToken: 'b'.repeat(64) });
  const admitted2 = admission.admitCandidate(candidate2, { allowTestCandidate: true });

  const results = await Promise.allSettled([
    Promise.resolve().then(() => admission.consumePlan(admitted2.planToken)),
    Promise.resolve().then(() => admission.consumePlan(admitted2.planToken)),
    Promise.resolve().then(() => admission.consumePlan(admitted2.planToken))
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason.code, 'MIGRATION_TOKEN_USED');
  assert.equal(rejected[1].reason.code, 'MIGRATION_TOKEN_USED');
});

test('[Finding 4] expired candidate plan is rejected immediately upon admission and never auto-extended', () => {
  const virtualTime = 100000;
  const admission = new SchemaMigrationAdmission({ now: () => virtualTime });

  // Expired plan candidate
  const expiredCandidate = sampleCandidate({ expiresAt: virtualTime - 1 });
  assert.throws(() => admission.admitCandidate(expiredCandidate, { allowTestCandidate: true }), {
    code: 'MIGRATION_PLAN_EXPIRED'
  });

  // Candidate with invalid safe integer expiry
  const invalidExpiry = sampleCandidate({ expiresAt: 'invalid' });
  assert.throws(() => admission.admitCandidate(invalidExpiry, { allowTestCandidate: true }), {
    code: 'MIGRATION_PLAN_EXPIRED'
  });

  // Candidate exceeding maximum TTL
  const excessiveTtl = sampleCandidate({ expiresAt: virtualTime + 10 * 60 * 1000 });
  assert.throws(() => admission.admitCandidate(excessiveTtl, { allowTestCandidate: true }), {
    code: 'INVALID_PLAN_EXPIRY'
  });
});

test('[Finding 6] re-admitting a consumed token is strictly rejected', () => {
  const admission = new SchemaMigrationAdmission();
  const candidate = sampleCandidate();
  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  // Consume plan
  admission.consumePlan(admitted.planToken);

  // Attempting to re-admit using the exact same planToken is rejected with MIGRATION_TOKEN_USED
  assert.throws(() => admission.admitCandidate(candidate, { allowTestCandidate: true }), {
    code: 'MIGRATION_TOKEN_USED'
  });
});

// ---------------------------------------------------------------------------
// 2. Production Approval Unit Tests
// ---------------------------------------------------------------------------

test('[Finding 1] Production approval requires explicit confirmation dialog and cannot be bypassed', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // Omitting showConfirmDialog throws CONFIRM_DIALOG_REQUIRED
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source
  }), { code: 'CONFIRM_DIALOG_REQUIRED' });

  // Passing non-function showConfirmDialog throws CONFIRM_DIALOG_REQUIRED
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: 'not-a-function'
  }), { code: 'CONFIRM_DIALOG_REQUIRED' });
});

test('[Finding 2] target profile mismatch between display and authorized scope is rejected', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // 1. Target ID does not match targetScope.profileId
  const wrongIdTarget = { ...profiles.target, id: 'other_target' };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: wrongIdTarget,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'TARGET_PROFILE_MISMATCH' });

  // 2. Target fingerprint does not match targetScope.profileFingerprint (e.g. host altered)
  const alteredHostTarget = { ...profiles.target, host: 'evil-host.com' };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: alteredHostTarget,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'TARGET_PROFILE_MISMATCH' });

  // 3. Target profile altered in store during dialog await
  let storeProfile = { ...profiles.target };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    getProfileWithSecrets: () => storeProfile,
    showConfirmDialog: async () => {
      // While dialog is awaiting, store profile host changes!
      storeProfile.host = 'changed-during-dialog.com';
      return { response: 1 };
    }
  }), { code: 'PRODUCTION_CONTEXT_CHANGED' });
});

test('[Finding 3] approval requests cannot survive clear() / reset during dialog presentation', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: async () => {
      // While user is looking at confirmation dialog, application is logged out or reset!
      approval.clear();
      return { response: 1 };
    }
  }), { code: 'PRODUCTION_CONTEXT_CHANGED' });

  // Pending map must remain empty
  assert.equal(approval.pending.size, 0);
});

test('[Finding 7] concurrent approval requests reserve quota slots before await', async () => {
  const approval = new SchemaMigrationApproval({ limit: 1 });
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  let firstDialogResolve;
  const firstDialogEntered = new Promise(resolve => {
    firstDialogResolve = resolve;
  });

  let finishFirstDialog;
  const finishFirstPromise = new Promise(resolve => {
    finishFirstDialog = resolve;
  });

  const firstReq = approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: async () => {
      firstDialogResolve();
      await finishFirstPromise;
      return { response: 1 };
    }
  });

  // Wait until first call has entered the dialog await
  await firstDialogEntered;

  // Second concurrent call enters while first dialog is still pending.
  // Quota is 1, so the second call must be blocked immediately with PRODUCTION_APPROVAL_BUSY!
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'PRODUCTION_APPROVAL_BUSY' });

  // Release first dialog
  finishFirstDialog();
  const res = await firstReq;
  assert.ok(res.approvalToken);
  assert.equal(approval.pending.size, 1);
});

test('[Finding 1 - R2] target turning to read-only during checkContext await is rejected before saving token', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();
  const currentTarget = { ...profiles.target };

  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    getProfileWithSecrets: (id) => id === 'target' ? currentTarget : profiles.source,
    checkContext: async () => {
      // Target switches to readOnly while checkContext is awaiting!
      currentTarget.readOnly = true;
      return true;
    },
    showConfirmDialog: confirmDialog
  }), { code: 'CONNECTION_READ_ONLY' });

  assert.equal(approval.pending.size, 0);
});

test('[Finding 2 - R2] approval expiry is strictly clamped to plan.expiresAt and does not mismatch after dialog delay', async () => {
  let mockTime = 100000;
  const approval = new SchemaMigrationApproval({ now: () => mockTime, ttlMs: 120000 });
  // Plan expires in 1000ms (at mockTime = 101000)
  const plan = sampleCandidate({ expiresAt: 101000 });
  const profiles = sampleProfiles();

  const req = await approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: async () => {
      // Dialog takes 200ms
      mockTime += 200; // now is 100200
      return { response: 1 };
    }
  });

  // Expiry must be Math.min(plan.expiresAt, 100200 + 120000) = 101000
  assert.equal(req.expiresAt, 101000);
  assert.ok(req.expiresAt <= plan.expiresAt);

  // AuthorizeProduction must accept the token without mismatch
  const receipt = approval.authorizeProduction({
    plan,
    planDigest: planDigest(plan),
    approvalToken: req.approvalToken
  });
  assert.equal(receipt.expiresAt, 101000);
});

test('[Finding 3 - R2] clear() during in-flight approval does not cause quota counter to go negative', async () => {
  const approval = new SchemaMigrationApproval({ limit: 1 });
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  let resolveDialog;
  const dialogPromise = new Promise(r => { resolveDialog = r; });

  const inFlight = approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: async () => {
      await dialogPromise;
      return { response: 1 };
    }
  });

  // While request is in flight, clear() is called
  approval.clear();
  assert.equal(approval.inFlightSlots.size, 0);

  // Now the in-flight dialog resolves
  resolveDialog();
  await assert.rejects(inFlight, { code: 'PRODUCTION_CONTEXT_CHANGED' });

  // The in-flight slot counter must NOT be negative!
  assert.equal(approval.inFlightSlots.size, 0);

  // Next request with limit: 1 should succeed without leaking quota
  const secondReq = await approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  });
  assert.ok(secondReq.approvalToken);
  assert.equal(approval.pending.size, 1);

  // Another concurrent request should be rejected as busy
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'PRODUCTION_APPROVAL_BUSY' });
});

test('[Finding 4 - R2] source profile mismatch between display and authorized scope is rejected', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // 1. Wrong source ID
  const wrongIdSource = { ...profiles.source, id: 'wrong_source' };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: wrongIdSource,
    showConfirmDialog: confirmDialog
  }), { code: 'SOURCE_PROFILE_MISMATCH' });

  // 2. Altered source host / fingerprint
  const alteredHostSource = { ...profiles.source, host: 'attacker.host' };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: alteredHostSource,
    showConfirmDialog: confirmDialog
  }), { code: 'SOURCE_PROFILE_MISMATCH' });
});

test('Production approval validates target environment, writable status and binds digest/target', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // Read-only target profile is rejected before approval request is issued
  const readOnlyTarget = { ...profiles.target, readOnly: true };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: readOnlyTarget,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'CONNECTION_READ_ONLY' });

  // Non-production target profile does not require approval
  const localTarget = { ...profiles.target, environment: 'local' };
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: localTarget,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'PRODUCTION_APPROVAL_NOT_REQUIRED' });

  // Valid approval request
  const request = await approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  });
  assert.ok(request.approvalToken);
  assert.equal(request.preview.statementCount, 2);
  assert.equal(request.preview.target.environment, 'production');
  assert.ok(request.expiresAt <= plan.expiresAt);

  // Authorize with valid receipt
  const receipt = approval.authorizeProduction({
    plan,
    planDigest: planDigest(plan),
    approvalToken: request.approvalToken
  });

  assert.equal(receipt.planToken, plan.planToken);
  assert.equal(receipt.planDigest, planDigest(plan));
  assert.equal(receipt.targetProfileFingerprint, plan.targetScope.profileFingerprint);

  // Replay of approvalToken fails
  assert.throws(() => approval.authorizeProduction({
    plan,
    planDigest: planDigest(plan),
    approvalToken: request.approvalToken
  }), { code: 'PRODUCTION_APPROVAL_EXPIRED' });
});

test('plan digest consistency across admission, approval and executor', async () => {
  const admission = new SchemaMigrationAdmission();
  const approval = new SchemaMigrationApproval();
  const profiles = sampleProfiles();
  const candidate = sampleCandidate();

  const admitted = admission.admitCandidate(candidate, { allowTestCandidate: true });

  // 1. Digest equality: admitted.planDigest matches planDigest(admitted)
  assert.equal(admitted.planDigest, planDigest(admitted));
  assert.equal(admitted.planDigest, admissionPlanDigest(admitted));
  assert.equal(typeof admitted.planDigest, 'string');
  assert.match(admitted.planDigest, /^[a-f0-9]{64}$/);

  // 2. Digest stability: presence or variation of planDigest property does not affect hash
  const { planDigest: _discarded, ...withoutDigest } = admitted;
  assert.equal(planDigest(withoutDigest), admitted.planDigest);
  assert.equal(planDigest({ ...admitted, planDigest: '0'.repeat(64) }), admitted.planDigest);
  assert.equal(planDigest({ ...admitted, planDigest: undefined }), admitted.planDigest);

  // 3. Digest sensitivity: modifying actual payload alters the hash
  assert.notEqual(
    planDigest({ ...admitted, statements: [{ id: 'stmt_x', status: 'executable', enabled: true, sql: 'SELECT 1;' }] }),
    admitted.planDigest
  );

  // 4. Approval request and authorization directly using admitted.planDigest
  const request = await approval.requestApproval({
    plan: admitted,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  });
  assert.ok(request.approvalToken);

  // Authorize passing admitted.planDigest directly without re-hashing
  const receipt = approval.authorizeProduction({
    plan: admitted,
    planDigest: admitted.planDigest,
    approvalToken: request.approvalToken
  });

  assert.equal(receipt.planToken, admitted.planToken);
  assert.equal(receipt.planDigest, admitted.planDigest);
  assert.equal(receipt.targetProfileFingerprint, admitted.targetScope.profileFingerprint);

  // 5. Tampered digest causes mismatch rejection
  const request2 = await approval.requestApproval({
    plan: admitted,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  });
  assert.throws(() => approval.authorizeProduction({
    plan: admitted,
    planDigest: '1'.repeat(64),
    approvalToken: request2.approvalToken
  }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });

  // 6. Consumed plan retains matching digest
  const consumed = admission.consumePlan(admitted.planToken);
  assert.equal(consumed.planDigest, admitted.planDigest);
  assert.equal(planDigest(consumed), admitted.planDigest);
});

test('authorization re-hashes plan contents instead of trusting a stale claimed digest', async () => {
  const profiles = sampleProfiles();
  const admitted = new SchemaMigrationAdmission().admitCandidate(sampleCandidate());
  const mutations = [
    plan => { plan.statements[0].sql = 'DROP TABLE orders'; },
    plan => { plan.statements.reverse(); },
    plan => { plan.options.statementTimeoutMs = 60000; },
    plan => { plan.sourceScope.database = 'another_source'; },
    plan => { plan.targetScope.profileId = 'another_target'; }
  ];
  for (const mutate of mutations) {
    const approval = new SchemaMigrationApproval();
    const request = await approval.requestApproval({
      plan: admitted, targetProfile: profiles.target, sourceProfile: profiles.source,
      showConfirmDialog: confirmDialog
    });
    const altered = structuredClone(admitted);
    mutate(altered);
    assert.throws(() => approval.authorizeProduction({
      plan: altered, planDigest: admitted.planDigest, approvalToken: request.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
    assert.throws(() => approval.authorizeProduction({
      plan: admitted, planDigest: admitted.planDigest, approvalToken: request.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_EXPIRED' });
  }
});

test('altered SQL, statement order, options or target causes approval mismatch', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // 1. Altered statement SQL
  {
    const req = await approval.requestApproval({
      plan,
      targetProfile: profiles.target,
      sourceProfile: profiles.source,
      showConfirmDialog: confirmDialog
    });
    const tampered = structuredClone(plan);
    tampered.statements[0].sql = 'DROP TABLE orders';
    assert.throws(() => approval.authorizeProduction({
      plan: tampered,
      planDigest: planDigest(tampered),
      approvalToken: req.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
  }

  // 2. Swapped statement order
  {
    const req = await approval.requestApproval({
      plan,
      targetProfile: profiles.target,
      sourceProfile: profiles.source,
      showConfirmDialog: confirmDialog
    });
    const reordered = structuredClone(plan);
    reordered.statements = [reordered.statements[1], reordered.statements[0]];
    assert.throws(() => approval.authorizeProduction({
      plan: reordered,
      planDigest: planDigest(reordered),
      approvalToken: req.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
  }

  // 3. Altered options
  {
    const req = await approval.requestApproval({
      plan,
      targetProfile: profiles.target,
      sourceProfile: profiles.source,
      showConfirmDialog: confirmDialog
    });
    const alteredOptions = structuredClone(plan);
    alteredOptions.options.statementTimeoutMs = 60000;
    assert.throws(() => approval.authorizeProduction({
      plan: alteredOptions,
      planDigest: planDigest(alteredOptions),
      approvalToken: req.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
  }

  // 4. Altered target fingerprint
  {
    const req = await approval.requestApproval({
      plan,
      targetProfile: profiles.target,
      sourceProfile: profiles.source,
      showConfirmDialog: confirmDialog
    });
    const alteredTarget = structuredClone(plan);
    alteredTarget.targetScope.profileFingerprint = '0'.repeat(64);
    assert.throws(() => approval.authorizeProduction({
      plan: alteredTarget,
      planDigest: planDigest(plan),
      approvalToken: req.approvalToken
    }), { code: 'PRODUCTION_APPROVAL_MISMATCH' });
  }
});

test('approval dialog cancellation and expiry stops approval issuance', async () => {
  const approval = new SchemaMigrationApproval();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // User cancels dialog
  await assert.rejects(approval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: async () => ({ response: 0 }) // 0 is Cancel
  }), { code: 'MIGRATION_APPROVAL_CANCELED' });

  // Plan expired before confirmation
  const expiredPlan = sampleCandidate({ expiresAt: Date.now() - 100 });
  await assert.rejects(approval.requestApproval({
    plan: expiredPlan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  }), { code: 'MIGRATION_PLAN_EXPIRED' });
});

test('generic ProductionApprovals tokens cannot authenticate migrations and vice versa', async () => {
  const migrationApproval = new SchemaMigrationApproval();
  const genericApprovals = new ProductionApprovals();
  const plan = sampleCandidate();
  const profiles = sampleProfiles();

  // 1. Generic approval issued for a query/commit
  let genericCallbackRun = false;
  const genericErr = genericApprovals.issue({ operation: 'commit' }, () => { genericCallbackRun = true; });
  assert.equal(genericErr.code, 'PRODUCTION_CONFIRM_REQUIRED');
  const genericToken = genericErr.preview.token;

  // Passing genericToken to migration approval fails
  assert.throws(() => migrationApproval.authorizeProduction({
    plan,
    planDigest: planDigest(plan),
    approvalToken: genericToken
  }), { code: 'PRODUCTION_APPROVAL_EXPIRED' });
  assert.equal(genericCallbackRun, false);

  // 2. Migration approval token passed to genericApprovals.confirm fails
  const req = await migrationApproval.requestApproval({
    plan,
    targetProfile: profiles.target,
    sourceProfile: profiles.source,
    showConfirmDialog: confirmDialog
  });
  await assert.rejects(genericApprovals.confirm(req.approvalToken), { code: 'PRODUCTION_APPROVAL_EXPIRED' });
});

test('[Finding 5] Source verifier in E1 explicitly fails closed with SOURCE_VERIFIER_NOT_READY', async () => {
  const verifier = createSourceVerifier();
  await assert.rejects(verifier({ snapshotIdentity: '1'.repeat(64) }), {
    code: 'SOURCE_VERIFIER_NOT_READY'
  });
});

// ---------------------------------------------------------------------------
// 3. Main Integration Tests with Real VM
// ---------------------------------------------------------------------------

function mainFixture() {
  const handlers = new Map(), profiles = {}, queries = [], sessions = [];
  const root = path.join(__dirname, '../electron');
  const controls = { onRaw: null, showMessageBoxResponse: 1 };
  class Session extends DatabaseSession {
    constructor(profile) { super(profile); this.version = '8.4.0'; sessions.push(this); }
    async connect() { this.connection = {}; }
    async close() { this.connection = null; this.dead = true; }
    async raw(sql, params, timeoutMs) {
      queries.push({ sql, params, timeoutMs, profileId: this.profile.id });
      if (controls.onRaw) await controls.onRaw(sql, this);
      if (sql.includes("COLUMN_NAME IN ('EXPRESSION'")) return { result: [] };
      if (sql.includes('information_schema.TABLES')) return { result: [{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB' }] };
      if (sql.includes('information_schema.COLUMNS')) return { result: [{ name: 'id', type: 'int', nullable: 'NO', position: 1 }] };
      return { result: [] };
    }
  }
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/tmp/sqlpro-main-admission-tests' },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        dialog: {
          showMessageBox: async (win, opts) => ({ response: controls.showMessageBoxResponse })
        }
      };
      if (id === './database.cjs') return { ...require(path.join(root, id)), DatabaseSession: Session };
      if (id === './store.cjs') return { getWithSecrets: id => ({ id, host: 'fixture', port: 3306, user: 'fixture', ssh: {}, ...profiles[id] }) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      return require(id.startsWith('./') ? path.join(root, id) : id);
    }, __dirname: root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), context, { filename: 'main.cjs' });
  return {
    profiles, queries, sessions, controls,
    evaluate: code => vm.runInContext(code, context),
    call: (channel, payload) => handlers.get(channel)({ sender: null }, payload)
  };
}

test('Main context hooks reject logout, config change, credential change and busy sessions', async () => {
  const r = mainFixture();
  r.profiles.src = { id: 'src', host: 'source.host', readOnly: true, environment: 'local' };
  r.profiles.tgt = { id: 'tgt', host: 'target.host', readOnly: false, environment: 'production' };

  // Ensure sessions
  const srcEntry = await r.evaluate("ensureSession('src')");
  const tgtEntry = await r.evaluate("ensureSession('tgt')");

  const buildPlan = () => ({
    sourceScope: {
      profileId: 'src',
      sessionId: srcEntry.sessionId,
      generation: 0,
      database: 'db1',
      engine: 'MySQL',
      snapshotIdentity: '1'.repeat(64),
      profileFingerprint: r.evaluate("productionProfileFingerprint(store.getWithSecrets('src'))")
    },
    targetScope: {
      profileId: 'tgt',
      sessionId: tgtEntry.sessionId,
      generation: 0,
      database: 'db2',
      engine: 'MySQL',
      snapshotIdentity: '2'.repeat(64),
      profileFingerprint: r.evaluate("productionProfileFingerprint(store.getWithSecrets('tgt'))")
    }
  });

  const check = () => r.evaluate('(p) => schemaMigrationContextHooks.checkContext(p)')(buildPlan());

  // Initially valid
  assert.equal(await check(), true);

  // 1. Logout / stopBackupSchedules
  r.evaluate('stopBackupSchedules()');
  assert.equal(await check(), false, 'Generation drift on logout must invalidate context');

  // Reset generation for next checks
  r.evaluate('backupContextGeneration = 0');
  assert.equal(await check(), true);

  // 2. Config changed (host changed)
  r.profiles.tgt.host = 'altered.host';
  assert.equal(await check(), false, 'Profile configuration drift must invalidate context');
  r.profiles.tgt.host = 'target.host'; // restore
  assert.equal(await check(), true);

  // 3. Credential drift (password changed)
  r.profiles.tgt.password = 'new-secret-password';
  assert.equal(await check(), false, 'Credential drift must be detected via assertSessionProfile');
  delete r.profiles.tgt.password; // restore
  assert.equal(await check(), true);

  // 4. Session in transaction
  r.evaluate("openSessions.get('tgt').session.inTransaction = true");
  assert.equal(await check(), false, 'Session in transaction must block context');
  r.evaluate("openSessions.get('tgt').session.inTransaction = false");
  assert.equal(await check(), true);

  // 5. Session autocommit false
  r.evaluate("openSessions.get('tgt').session.autocommit = false");
  assert.equal(await check(), false, 'Disabled autocommit must block context');
  r.evaluate("openSessions.get('tgt').session.autocommit = true");
  assert.equal(await check(), true);

  // 6. Session active task
  r.evaluate("openSessions.get('tgt').session.activeTask = true");
  assert.equal(await check(), false, 'Active task must block context');
  r.evaluate("openSessions.get('tgt').session.activeTask = false");
  assert.equal(await check(), true);

  // 7. Lease held in sessionRegistry
  r.evaluate("globalThis._testRelease = sessionRegistry.acquire(openSessions.get('tgt'))");
  assert.equal(await check(), false, 'Active lease must block context');
  r.evaluate("globalThis._testRelease(); delete globalThis._testRelease;");
  assert.equal(await check(), true);
});

test('SchemaMigrationExecutor executes admitted candidate when wired with Main hooks', async () => {
  const r = mainFixture();
  r.profiles.src = { id: 'src', host: 'source.host', readOnly: true, environment: 'local' };
  r.profiles.tgt = { id: 'tgt', host: 'target.host', readOnly: false, environment: 'production' };

  const srcEntry = await r.evaluate("ensureSession('src')");
  const tgtEntry = await r.evaluate("ensureSession('tgt')");

  const candidate = sampleCandidate({
    sourceScope: {
      profileId: 'src',
      sessionId: srcEntry.sessionId,
      generation: r.evaluate('backupContextGeneration'),
      database: 'db_src',
      engine: 'MySQL',
      snapshotIdentity: '1'.repeat(64),
      profileFingerprint: r.evaluate("productionProfileFingerprint(store.getWithSecrets('src'))")
    },
    targetScope: {
      profileId: 'tgt',
      sessionId: tgtEntry.sessionId,
      generation: r.evaluate('backupContextGeneration'),
      database: 'db_tgt',
      engine: 'MySQL',
      snapshotIdentity: '2'.repeat(64),
      profileFingerprint: r.evaluate("productionProfileFingerprint(store.getWithSecrets('tgt'))")
    }
  });

  const admitted = r.evaluate('(c) => schemaMigrationAdmission.admitCandidate(c, { allowTestCandidate: true })')(candidate);

  // Request approval for production target
  const targetProf = r.evaluate("store.getWithSecrets('tgt')");
  const sourceProf = r.evaluate("store.getWithSecrets('src')");
  const approvalRes = await r.evaluate('(p, t, s) => schemaMigrationApproval.requestApproval({ plan: p, targetProfile: t, sourceProfile: s, showConfirmDialog: async () => ({ response: 1 }) })')(
    admitted, targetProf, sourceProf
  );

  let workerCreated = 0, workerClosed = 0;
  const workerQueries = [];
  const fakeWorker = {
    connection: {},
    async connect() {},
    async useDatabase() {},
    async close() { workerClosed++; },
    async raw(sql) {
      workerQueries.push(sql);
      if (sql.startsWith('SELECT @@SESSION')) {
        return { result: [{ fkChecks: 1, autocommit: 1 }] };
      }
      return { result: [] };
    }
  };

  const proof = scope => ({
    database: scope.database,
    scope: { ...scope },
    coverage: 'complete',
    snapshotIdentity: scope.snapshotIdentity
  });

  const executor = new SchemaMigrationExecutor({
    consumePlan: token => r.evaluate('(t) => schemaMigrationAdmission.consumePlan(t)')(token),
    getProfileWithSecrets: id => r.evaluate('(id) => schemaMigrationContextHooks.getProfileWithSecrets(id)')(id),
    fingerprintProfile: profile => r.evaluate('(p) => schemaMigrationContextHooks.fingerprintProfile(p)')(profile),
    checkContext: plan => r.evaluate('(p) => schemaMigrationContextHooks.checkContext(p)')(plan),
    verifySource: async scope => proof(scope),
    authorizeProduction: args => r.evaluate('(a) => schemaMigrationApproval.authorizeProduction(a)')(args),
    createSession: () => { workerCreated++; return fakeWorker; },
    createCollector: (_, ctx) => ({ collect: async () => ({ ...proof(admitted.targetScope), scope: { ...admitted.targetScope, sessionId: ctx.sessionId } }) })
  });

  const result = await executor.executePlan({
    planToken: admitted.planToken,
    approvalToken: approvalRes.approvalToken
  });

  assert.equal(result.success, true);
  assert.equal(result.executedCount, 2);
  assert.equal(workerCreated, 1);
  assert.equal(workerClosed, 1);
  assert.ok(workerQueries.some(q => q.includes('CREATE TABLE orders')));
  assert.ok(workerQueries.some(q => q.includes('ALTER TABLE orders')));

  // Token was consumed: cannot replay
  await assert.rejects(executor.executePlan({
    planToken: admitted.planToken,
    approvalToken: approvalRes.approvalToken
  }), { code: 'MIGRATION_TOKEN_USED' });
});

test('Main Apply IPC rejects forged confirmation and invalid tokens before opening sessions', async () => {
  const r = mainFixture();
  const res = await r.call('db:apply-migration-plan', { confirmed: true, planToken: 'forged' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INVALID_MIGRATION_APPLY');
  assert.equal(r.sessions.length, 0);
  assert.equal(r.queries.length, 0);
});
