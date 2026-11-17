'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RestoreObjectInventory,
  extractQueryReferences,
  checkDynamicSql,
  parseTriggerDetails
} = require('../electron/restore-object-inventory.cjs');

test('extractQueryReferences parses FROM, JOIN and comma-separated tables', () => {
  const q1 = 'SELECT u.id, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.active = 1';
  assert.deepEqual(extractQueryReferences(q1).sort(), ['orders', 'users'].sort());

  const q2 = 'SELECT * FROM `customers`, `invoices` WHERE customers.id = invoices.customer_id';
  assert.deepEqual(extractQueryReferences(q2).sort(), ['customers', 'invoices'].sort());

  const q3 = 'SELECT a.val FROM schema1.table_a a LEFT JOIN `table_b` b ON a.id = b.id';
  assert.deepEqual(extractQueryReferences(q3).sort(), ['table_a', 'table_b'].sort());
});

test('checkDynamicSql detects PREPARE and EXECUTE in routines', () => {
  assert.equal(checkDynamicSql('BEGIN SELECT 1; END'), false);
  assert.equal(checkDynamicSql("BEGIN PREPARE stmt FROM 'SELECT 1'; EXECUTE stmt; END"), true);
  assert.equal(checkDynamicSql("BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END"), true);
});

test('parseTriggerDetails extracts timing, event and target table', () => {
  const sql = 'CREATE TRIGGER `tr_order_audit` AFTER INSERT ON `orders` FOR EACH ROW BEGIN INSERT INTO audit VALUES(NEW.id); END';
  const details = parseTriggerDetails(sql);
  assert.equal(details.name, 'tr_order_audit');
  assert.equal(details.timing, 'AFTER');
  assert.equal(details.event, 'INSERT');
  assert.equal(details.targetTable, 'orders');
});

test('inventory parses full SQL dump with tables, views, routines, triggers, events', () => {
  const inv = new RestoreObjectInventory('demo');
  const statements = [
    'SET NAMES utf8mb4;',
    'CREATE TABLE `users` (`id` int PRIMARY KEY, `name` varchar(50));',
    'CREATE TABLE `orders` (`id` int PRIMARY KEY, `user_id` int, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`));',
    'INSERT INTO `users` VALUES (1, "Alice");',
    'INSERT INTO `orders` VALUES (101, 1);',
    'CREATE VIEW `v_user_orders` AS SELECT u.name, o.id FROM users u JOIN orders o ON u.id = o.user_id;',
    'CREATE FUNCTION `calc_discount`(amt int) RETURNS int DETERMINISTIC BEGIN RETURN amt * 0.1; END;',
    'CREATE PROCEDURE `sp_create_order`(IN uid int) BEGIN INSERT INTO orders VALUES (102, uid); END;',
    'CREATE TRIGGER `tr_order_ai` AFTER INSERT ON `orders` FOR EACH ROW BEGIN UPDATE users SET name="updated" WHERE id=NEW.user_id; END;',
    'CREATE EVENT `ev_cleanup` ON SCHEDULE EVERY 1 DAY DO CALL sp_create_order(1);'
  ];

  for (let i = 0; i < statements.length; i++) {
    inv.addStatement(statements[i], i + 1);
  }

  assert.equal(inv.tables.size, 2);
  assert.equal(inv.views.size, 1);
  assert.equal(inv.functions.size, 1);
  assert.equal(inv.procedures.size, 1);
  assert.equal(inv.triggers.size, 1);
  assert.equal(inv.events.size, 1);

  const preview = inv.previewSelection();
  assert.equal(preview.valid, true);
  assert.equal(preview.counts.totalObjects, 7);

  // Check topological ordering: users -> orders -> calc_discount -> v_user_orders -> sp_create_order -> tr_order_ai -> ev_cleanup
  const names = preview.order.map(n => n.name);
  const idxUsers = names.indexOf('users');
  const idxOrders = names.indexOf('orders');
  const idxView = names.indexOf('v_user_orders');
  const idxTrigger = names.indexOf('tr_order_ai');
  const idxProc = names.indexOf('sp_create_order');
  const idxEvent = names.indexOf('ev_cleanup');

  assert.ok(idxUsers < idxOrders, 'users before orders (FK)');
  assert.ok(idxOrders < idxView, 'orders before view');
  assert.ok(idxOrders < idxTrigger, 'orders before trigger');
  assert.ok(idxProc < idxEvent, 'procedure before event');
});

test('selection validation reports MISSING_DEPENDENCY when view or trigger target is omitted', () => {
  const inv = new RestoreObjectInventory('demo');
  inv.addStatement('CREATE TABLE `users` (`id` int PRIMARY KEY);', 1);
  inv.addStatement('CREATE VIEW `v_users` AS SELECT * FROM users;', 2);
  inv.addStatement('CREATE TRIGGER `tr_users` AFTER INSERT ON `users` FOR EACH ROW BEGIN END;', 3);

  // If user only selects the view (omitting 'users')
  const viewOnly = inv.previewSelection({
    tables: [],
    views: ['v_users'],
    procedures: [],
    functions: [],
    triggers: [],
    events: []
  });
  assert.equal(viewOnly.valid, false);
  const missing = viewOnly.findings.find(f => f.code === 'MISSING_DEPENDENCY');
  assert.ok(missing);
  assert.equal(missing.objectName, 'v_users');
  assert.equal(missing.requiredDependency, 'users');

  // If users exists on target database
  const targetFacts = {
    objects: [{ type: 'table', name: 'users' }]
  };
  const viewWithTarget = inv.previewSelection({
    tables: [],
    views: ['v_users'],
    procedures: [],
    functions: [],
    triggers: [],
    events: [],
    targetFacts
  });
  assert.equal(viewWithTarget.valid, true);
});

test('generateExecutionPlan produces an immutable, gated execution plan with SHA-256 planId', () => {
  const inv = new RestoreObjectInventory('demo');
  inv.addStatement('SET NAMES utf8mb4;', 1);
  inv.addStatement('CREATE TABLE `products` (`id` int PRIMARY KEY);', 2);
  inv.addStatement('INSERT INTO `products` VALUES (1);', 3);
  inv.addStatement('CREATE VIEW `v_products` AS SELECT * FROM products;', 4);

  const checksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const targetId = 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000000';

  // Successful plan when both table and view are selected
  const plan = inv.generateExecutionPlan({
    selection: {
      tables: ['products'],
      views: ['v_products'],
      includeStructure: true,
      includeData: true
    },
    fileChecksum: checksum,
    targetIdentity: targetId
  });

  assert.equal(plan.kind, 'sqlpro-restore-execution-plan');
  assert.equal(plan.canExecute, true);
  assert.equal(plan.blockers.length, 0);
  assert.equal(typeof plan.planId, 'string');
  assert.equal(plan.planId.length, 64);
  assert.equal(Object.isFrozen(plan), true);

  // Check candidate steps: SET -> candidate, CREATE TABLE products -> candidate, INSERT products -> candidate, CREATE VIEW -> candidate
  const candidates = plan.steps.filter(s => s.decision === 'candidate');
  assert.equal(candidates.length, 4);

  // Blocked plan when missing dependency
  const blockedPlan = inv.generateExecutionPlan({
    selection: {
      tables: [],
      views: ['v_products'],
      includeStructure: true,
      includeData: true
    },
    fileChecksum: checksum,
    targetIdentity: targetId
  });

  assert.equal(blockedPlan.canExecute, false);
  assert.ok(blockedPlan.blockers.some(b => b.code === 'MISSING_DEPENDENCY'));
});
