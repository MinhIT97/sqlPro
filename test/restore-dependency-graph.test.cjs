'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestoreDependencyGraph } = require('../electron/restore-dependency-graph.cjs');

test('dependency graph registers nodes and manages direct and reverse edges', () => {
  const graph = new RestoreDependencyGraph();
  const k1 = graph.addNode({ type: 'table', name: 'users' });
  const k2 = graph.addNode({ type: 'table', name: 'orders' });

  assert.equal(graph.hasNode(k1), true);
  assert.equal(graph.hasNode(k2), true);
  assert.equal(graph.hasNode('table:nonexistent'), false);

  graph.addEdge(k2, k1); // orders depends on users (FK)

  assert.deepEqual(graph.getDependencies(k2), [k1]);
  assert.deepEqual(graph.getDependents(k1), [k2]);
  assert.deepEqual(graph.getDependencies(k1), []);
});

test('topological sort orders tables by foreign key dependency hierarchy', () => {
  const graph = new RestoreDependencyGraph();
  // Hierarchy: users -> orders -> order_items
  //                         categories -> products -> order_items
  const users = graph.addNode({ type: 'table', name: 'users' });
  const orders = graph.addNode({ type: 'table', name: 'orders' });
  const items = graph.addNode({ type: 'table', name: 'order_items' });
  const categories = graph.addNode({ type: 'table', name: 'categories' });
  const products = graph.addNode({ type: 'table', name: 'products' });

  graph.addEdge(orders, users); // orders -> users
  graph.addEdge(items, orders); // items -> orders
  graph.addEdge(products, categories); // products -> categories
  graph.addEdge(items, products); // items -> products

  const { order, unresolved, hasCycles } = graph.topologicalSort();

  assert.equal(hasCycles, false);
  assert.deepEqual(unresolved, []);

  // Independent parent tables must precede dependent child tables
  const idxUsers = order.indexOf(users);
  const idxOrders = order.indexOf(orders);
  const idxItems = order.indexOf(items);
  const idxCategories = order.indexOf(categories);
  const idxProducts = order.indexOf(products);

  assert.ok(idxUsers < idxOrders, 'users must be restored before orders');
  assert.ok(idxOrders < idxItems, 'orders must be restored before order_items');
  assert.ok(idxCategories < idxProducts, 'categories must be restored before products');
  assert.ok(idxProducts < idxItems, 'products must be restored before order_items');
});

test('cycle detection identifies circular foreign keys and reports path', () => {
  const graph = new RestoreDependencyGraph();
  // A depends on B, B depends on A
  const a = graph.addNode({ type: 'table', name: 'table_a' });
  const b = graph.addNode({ type: 'table', name: 'table_b' });
  const c = graph.addNode({ type: 'table', name: 'table_c' });

  graph.addEdge(a, b);
  graph.addEdge(b, a);
  graph.addEdge(c, a);

  const cycles = graph.detectCycles();
  assert.equal(cycles.length >= 1, true);

  const cycle = cycles[0];
  assert.ok(cycle.includes(a));
  assert.ok(cycle.includes(b));

  const { unresolved, hasCycles } = graph.topologicalSort();
  assert.equal(hasCycles, true);
  assert.ok(unresolved.includes(a));
  assert.ok(unresolved.includes(b));
});

test('multi-type hierarchy orders tables, functions, views, procedures, triggers, events', () => {
  const graph = new RestoreDependencyGraph();

  const tblUsers = graph.addNode({ type: 'table', name: 'users' });
  const fnTax = graph.addNode({ type: 'function', name: 'calc_tax' });
  const vwUserSummary = graph.addNode({ type: 'view', name: 'v_user_summary' });
  const procRegister = graph.addNode({ type: 'procedure', name: 'sp_register_user' });
  const trUserAudit = graph.addNode({ type: 'trigger', name: 'tr_user_audit' });
  const evNightly = graph.addNode({ type: 'event', name: 'ev_nightly_cleanup' });

  // Dependencies:
  // View depends on table users
  graph.addEdge(vwUserSummary, tblUsers);
  // Trigger depends on table users
  graph.addEdge(trUserAudit, tblUsers);
  // Procedure calls fnTax and queries users
  graph.addEdge(procRegister, fnTax);
  graph.addEdge(procRegister, tblUsers);
  // Event calls sp_register_user
  graph.addEdge(evNightly, procRegister);

  const { order, hasCycles } = graph.topologicalSort();
  assert.equal(hasCycles, false);

  const idxTable = order.indexOf(tblUsers);
  const idxFn = order.indexOf(fnTax);
  const idxView = order.indexOf(vwUserSummary);
  const idxProc = order.indexOf(procRegister);
  const idxTrigger = order.indexOf(trUserAudit);
  const idxEvent = order.indexOf(evNightly);

  // Verification of layered ordering:
  // 1. Table
  // 2. Function
  // 3. View
  // 4. Procedure
  // 5. Trigger
  // 6. Event
  assert.ok(idxTable < idxView, 'table before view');
  assert.ok(idxFn < idxProc, 'function before procedure');
  assert.ok(idxTable < idxTrigger, 'table before trigger');
  assert.ok(idxProc < idxEvent, 'procedure before event');
});

test('computeDropOrder yields reverse topological order', () => {
  const graph = new RestoreDependencyGraph();
  const parent = graph.addNode({ type: 'table', name: 'parent' });
  const child = graph.addNode({ type: 'table', name: 'child' });
  const view = graph.addNode({ type: 'view', name: 'v_child' });

  graph.addEdge(child, parent);
  graph.addEdge(view, child);

  const { dropOrder, hasCycles } = graph.computeDropOrder();
  assert.equal(hasCycles, false);

  const idxView = dropOrder.indexOf(view);
  const idxChild = dropOrder.indexOf(child);
  const idxParent = dropOrder.indexOf(parent);

  assert.ok(idxView < idxChild, 'view dropped before child table');
  assert.ok(idxChild < idxParent, 'child table dropped before parent table');
});

test('validateSelection checks missing dependencies and reports consumers', () => {
  const graph = new RestoreDependencyGraph();
  const parent = graph.addNode({ type: 'table', name: 'parent' });
  const child = graph.addNode({ type: 'table', name: 'child' });
  const view = graph.addNode({ type: 'view', name: 'v_child' });

  graph.addEdge(child, parent);
  graph.addEdge(view, child);

  // If user only selects 'child' (omitting 'parent')
  const val1 = graph.validateSelection([child]);
  assert.equal(val1.valid, false);
  assert.equal(val1.missingDependencies.length, 1);
  assert.equal(val1.missingDependencies[0].consumerKey, child);
  assert.equal(val1.missingDependencies[0].requiredDependencyKey, parent);

  // If 'parent' is available in target database facts
  const targetFacts = new Set([parent]);
  const val2 = graph.validateSelection([child], targetFacts);
  assert.equal(val2.valid, true);
  assert.equal(val2.missingDependencies.length, 0);

  // If user selects child and parent together
  const val3 = graph.validateSelection([child, parent]);
  assert.equal(val3.valid, true);
});
