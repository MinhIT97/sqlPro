'use strict';

/**
 * restore-object-inventory.cjs
 *
 * Full-spectrum inventory and dependency extraction for database objects
 * (tables, views, routines, triggers, events) from MySQL/MariaDB dumps.
 * Generates immutable execution plans with preflight checks and topological ordering.
 *
 * Implements G3.1 & G3.2.
 */

const crypto = require('node:crypto');
const { RestoreDependencyGraph } = require('./restore-dependency-graph.cjs');
const { createTarget, scrubSql, stripLeadingComments, parseDropTargets, parseAlterRename, parseRenameTable, parseQualifiedIdentifier } = require('./sql-script.cjs');
const { analyzeTableColumns } = require('./restore-selection-columns.cjs');

const MAX_OBJECTS_PER_TYPE = 5000;
const MAX_FINDINGS = 100;

const IDENTIFIER_PATTERN = '(?:`(?:[^`]|``)+`|[\\p{L}\\p{N}_$]+)';
const REFERENCE_PATTERN = `${IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${IDENTIFIER_PATTERN})?`;

const CREATE_TARGET_PATTERN = new RegExp(
  `^(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?(?:(?:ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)|DEFINER\\s*=\\s*(?:\`[^\`]+\`|'[^']+'|"[^"]+"|[A-Za-z0-9_@$]+))\\s+)*(TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:(\`[^\`]+\`|\\w+)\\s*\\.\\s*)?(\`[^\`]+\`|\\w+)`,
  'i'
);

function unquote(val) {
  const s = String(val || '').trim();
  if (s.startsWith('`') && s.endsWith('`')) return s.slice(1, -1).replace(/``/g, '`');
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1').replace(/''/g, "'").replace(/""/g, '"');
  }
  return s;
}

function parseReference(raw) {
  const parts = String(raw || '').trim().split('.');
  if (parts.length === 2) {
    return { schema: unquote(parts[0]), table: unquote(parts[1]) };
  }
  return { schema: null, table: unquote(parts[0]) };
}

/**
 * Extracts table and view references from a SELECT query (such as in a VIEW definition).
 */
function extractQueryReferences(selectQuerySql, defaultDatabase = null) {
  const scrubbed = scrubSql(selectQuerySql);
  const references = new Set();

  // Pattern matches FROM / JOIN / STRAIGHT_JOIN followed by table references
  const clausePattern = /\b(?:FROM|JOIN|STRAIGHT_JOIN)\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
  let match;
  while ((match = clausePattern.exec(scrubbed)) !== null) {
    const rawRef = match[1].trim();
    if (rawRef && !/^(?:SELECT|VALUES|WHERE|ON|GROUP|ORDER|LIMIT|HAVING)$/i.test(rawRef)) {
      const parsed = parseReference(rawRef);
      if (parsed.table) {
        references.add(parsed.table.toLowerCase());
      }
    }
  }

  // Also match comma-separated FROM tables: FROM t1, t2, t3
  const fromMatch = /\bFROM\s+([`\w$,\s.]+?)(?:\b(?:WHERE|JOIN|GROUP|ORDER|LIMIT|HAVING|WINDOW|PROCEDURE|INTO)\b|$)/i.exec(scrubbed);
  if (fromMatch) {
    const tableList = fromMatch[1].split(',');
    for (const item of tableList) {
      const trimmed = item.trim().split(/\s+/)[0]; // take the table identifier before alias
      if (trimmed && !trimmed.includes('(') && !trimmed.includes(')')) {
        const parsed = parseReference(trimmed);
        if (parsed.table && !/^(?:SELECT|VALUES)$/i.test(parsed.table)) {
          references.add(parsed.table.toLowerCase());
        }
      }
    }
  }

  return Array.from(references);
}

/**
 * Checks for dynamic SQL execution inside stored procedures, functions, or triggers.
 */
function checkDynamicSql(sql) {
  const scrubbed = scrubSql(sql);
  const hasPrepare = /\bPREPARE\s+[A-Za-z0-9_$]+\s+FROM\b/i.test(scrubbed);
  const hasExecute = /\bEXECUTE\s+[A-Za-z0-9_$]+\b/i.test(scrubbed);
  const hasExecuteImmediate = /\bEXECUTE\s+IMMEDIATE\b/i.test(scrubbed);
  return hasPrepare || hasExecute || hasExecuteImmediate;
}

/**
 * Extracts called routine names from a routine or event body.
 */
function extractRoutineCalls(sql) {
  const scrubbed = scrubSql(sql);
  const calls = new Set();
  const callPattern = /\bCALL\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
  let match;
  while ((match = callPattern.exec(scrubbed)) !== null) {
    const parsed = parseReference(match[1]);
    if (parsed.table) calls.add(parsed.table.toLowerCase());
  }
  return Array.from(calls);
}

/**
 * Extracts table write references from routine body (INSERT, UPDATE, DELETE).
 */
function extractRoutineWrites(sql) {
  const scrubbed = scrubSql(sql);
  const writes = new Set();

  const insertPattern = /\b(?:INSERT|REPLACE)\s+(?:INTO\s+)?([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
  let match;
  while ((match = insertPattern.exec(scrubbed)) !== null) {
    const parsed = parseReference(match[1]);
    if (parsed.table) writes.add(parsed.table.toLowerCase());
  }

  const updatePattern = /\bUPDATE\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
  while ((match = updatePattern.exec(scrubbed)) !== null) {
    const parsed = parseReference(match[1]);
    if (parsed.table) writes.add(parsed.table.toLowerCase());
  }

  const deletePattern = /\bDELETE\s+FROM\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
  while ((match = deletePattern.exec(scrubbed)) !== null) {
    const parsed = parseReference(match[1]);
    if (parsed.table) writes.add(parsed.table.toLowerCase());
  }

  return Array.from(writes);
}

/**
 * Extracts trigger event, timing, and target table.
 */
function parseTriggerDetails(sql) {
  const scrubbed = scrubSql(sql);
  const match = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?))\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/i.exec(scrubbed);
  if (!match) return null;
  const triggerRef = parseReference(match[1]);
  const timing = match[2].toUpperCase();
  const event = match[3].toUpperCase();
  const tableRef = parseReference(match[4]);
  return {
    name: triggerRef.table,
    schema: triggerRef.schema,
    timing,
    event,
    targetTable: tableRef.table,
    targetSchema: tableRef.schema
  };
}

class RestoreObjectInventory {
  constructor(database) {
    this.database = String(database || '');
    this.tables = new Map();
    this.views = new Map();
    this.procedures = new Map();
    this.functions = new Map();
    this.triggers = new Map();
    this.events = new Map();
    this.statements = [];
    this.findings = [];
    this.opaqueObjects = [];
    this.truncated = false;
  }

  finding(code, statementNumber, objectName = null, details = null) {
    if (this.findings.length < MAX_FINDINGS) {
      this.findings.push({ code, statementNumber, objectName, details });
    } else {
      this.truncated = true;
    }
  }

  addStatement(sql, statementNumber) {
    const text = String(sql || '').trim();
    if (!text) return null;

    const target = createTarget(text);
    const command = (/^([A-Za-z]+)/.exec(scrubSql(text)) || [])[1]?.toUpperCase() || '';
    const dropInfo = command === 'DROP' ? parseDropTargets(text) : null;

    const entry = {
      number: statementNumber,
      command,
      type: target?.type || dropInfo?.type || 'unknown',
      name: target?.name || dropInfo?.targets?.[0]?.name || null,
      sql: text
    };
    this.statements.push(entry);

    if (dropInfo) {
      for (const t of dropInfo.targets) {
        if (t.schema && this.database && t.schema !== this.database) {
          this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, t.name, `Lệnh DROP trỏ tới database khác (${t.schema}), không khớp database đích (${this.database}).`);
        }
        this.recordDrop(text, { type: dropInfo.type, name: t.name }, statementNumber, entry);
      }
      return entry;
    }

    if (command === 'CREATE') {
      const createMatch = CREATE_TARGET_PATTERN.exec(text);
      if (createMatch) {
        const schema = createMatch[2] ? unquote(createMatch[2]) : null;
        if (schema && this.database && schema !== this.database) {
          this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, unquote(createMatch[3]), `Lệnh CREATE trỏ tới database khác (${schema}), không khớp database đích (${this.database}).`);
        }
      }
      if (target) {
        this.recordCreate(text, target, statementNumber, entry);
      }
    } else if (command === 'DROP' && target) {
      if (target.schema && this.database && target.schema !== this.database) {
        this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, target.name, `Lệnh DROP trỏ tới database khác (${target.schema}), không khớp database đích (${this.database}).`);
      }
      this.recordDrop(text, target, statementNumber, entry);
    } else if (command === 'ALTER') {
      const alterRename = parseAlterRename(text);
      if (alterRename) {
        if (alterRename.source?.schema && this.database && alterRename.source.schema !== this.database) {
          this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, alterRename.source.name, `Lệnh ALTER TABLE trỏ tới database khác (${alterRename.source.schema}), không khớp database đích (${this.database}).`);
        }
        const allDests = alterRename.destinations && alterRename.destinations.length > 0
          ? alterRename.destinations
          : (alterRename.destination ? [alterRename.destination] : []);
        for (const dst of allDests) {
          if (dst?.schema && this.database && dst.schema !== this.database) {
            this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, dst.name, `Lệnh ALTER TABLE RENAME trỏ tới database khác (${dst.schema}), không khớp database đích (${this.database}).`);
          }
        }
        entry.name = alterRename.source?.name || null;
        entry.destinationName = alterRename.destination?.name || null;
        entry.destinations = allDests;
      }
    } else if (command === 'RENAME') {
      const renameTable = parseRenameTable(text);
      if (renameTable) {
        for (const pair of renameTable.pairs) {
          if (pair.source?.schema && this.database && pair.source.schema !== this.database) {
            this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, pair.source.name, `Lệnh RENAME TABLE trỏ tới database khác (${pair.source.schema}), không khớp database đích (${this.database}).`);
          }
          if (pair.destination?.schema && this.database && pair.destination.schema !== this.database) {
            this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, pair.destination.name, `Lệnh RENAME TABLE trỏ tới database đích khác (${pair.destination.schema}), không khớp database đích (${this.database}).`);
          }
        }
      }
    } else if (command === 'INSERT' || command === 'REPLACE') {
      this.recordData(text, statementNumber, entry);
    } else if (command === 'SET') {
      entry.type = 'context';
    } else {
      if (target) {
        this.recordOther(text, target, statementNumber, entry);
      }
    }

    return entry;
  }

  recordCreate(sql, target, statementNumber, entry) {
    const type = target.type;
    const name = target.name;
    const key = name;

    if (type === 'table') {
      let t = this.tables.get(key);
      if (!t) {
        t = { name, type: 'table', createStatements: 0, dataStatements: 0, dropStatements: 0, dependencies: [], sql };
        this.tables.set(key, t);
      }
      t.createStatements++;
      // Parse foreign keys
      const scrubbed = scrubSql(sql);
      const fkPattern = /\bFOREIGN\s+KEY\s*(?:\([`\w$,\s]+\))?\s*REFERENCES\s+([`\w$]+(?:\s*\.\s*[`\w$]+)?)/gi;
      let match;
      while ((match = fkPattern.exec(scrubbed)) !== null) {
        const ref = parseReference(match[1]);
        if (ref.table && !t.dependencies.some(d => d.table.toLowerCase() === ref.table.toLowerCase())) {
          t.dependencies.push({ schema: ref.schema, table: ref.table });
        }
      }
    } else if (type === 'view') {
      const scrubbed = scrubSql(sql);
      const asSelectMatch = /\bAS\s+(?:SELECT|\(SELECT)\b/i.exec(scrubbed);
      const selectQuery = asSelectMatch ? scrubbed.slice(asSelectMatch.index + 2) : '';
      const refs = extractQueryReferences(selectQuery, this.database);

      let v = this.views.get(key);
      if (!v) {
        v = {
          name,
          type: 'view',
          createStatements: 0,
          dropStatements: 0,
          referencedTables: refs,
          sql
        };
        this.views.set(key, v);
      }
      v.createStatements++;
    } else if (type === 'procedure') {
      const hasDyn = checkDynamicSql(sql);
      const calls = extractRoutineCalls(sql);
      const writes = extractRoutineWrites(sql);

      let p = this.procedures.get(key);
      if (!p) {
        p = {
          name,
          type: 'procedure',
          createStatements: 0,
          dropStatements: 0,
          hasDynamicSql: hasDyn,
          calledRoutines: calls,
          referencedTables: writes,
          sql
        };
        this.procedures.set(key, p);
      }
      p.createStatements++;
      if (hasDyn) {
        this.finding('DYNAMIC_DEPENDENCY_DETECTED', statementNumber, name, 'Procedure uses dynamic SQL (PREPARE/EXECUTE) which cannot be statically analyzed for object dependencies.');
      }
    } else if (type === 'function') {
      const hasDyn = checkDynamicSql(sql);
      const calls = extractRoutineCalls(sql);
      const writes = extractRoutineWrites(sql);

      let f = this.functions.get(key);
      if (!f) {
        f = {
          name,
          type: 'function',
          createStatements: 0,
          dropStatements: 0,
          hasDynamicSql: hasDyn,
          calledRoutines: calls,
          referencedTables: writes,
          sql
        };
        this.functions.set(key, f);
      }
      f.createStatements++;
      if (hasDyn) {
        this.finding('DYNAMIC_DEPENDENCY_DETECTED', statementNumber, name, 'Function uses dynamic SQL (PREPARE/EXECUTE).');
      }
    } else if (type === 'trigger') {
      const details = parseTriggerDetails(sql);
      const targetTable = details?.targetTable || null;

      let tr = this.triggers.get(key);
      if (!tr) {
        tr = {
          name,
          type: 'trigger',
          createStatements: 0,
          dropStatements: 0,
          targetTable,
          timing: details?.timing || null,
          event: details?.event || null,
          sql
        };
        this.triggers.set(key, tr);
      }
      tr.createStatements++;
      if (!targetTable) {
        this.finding('TRIGGER_TARGET_TABLE_UNRESOLVED', statementNumber, name, 'Cannot determine target table for trigger.');
      }
    } else if (type === 'event') {
      const calls = extractRoutineCalls(sql);
      let ev = this.events.get(key);
      if (!ev) {
        ev = {
          name,
          type: 'event',
          createStatements: 0,
          dropStatements: 0,
          calledRoutines: calls,
          sql
        };
        this.events.set(key, ev);
      }
      ev.createStatements++;
    } else {
      this.opaqueObjects.push({ type: 'unknown', name, command: 'CREATE', statementNumber });
    }
  }

  recordDrop(sql, target, statementNumber, entry) {
    const type = target.type;
    const key = target.name;

    const collection = type === 'table' ? this.tables
      : type === 'view' ? this.views
      : type === 'procedure' ? this.procedures
      : type === 'function' ? this.functions
      : type === 'trigger' ? this.triggers
      : type === 'event' ? this.events : null;

    if (collection) {
      let item = collection.get(key);
      if (!item) {
        item = {
          name: target.name,
          type,
          createStatements: 0,
          dropStatements: 0,
          dependencies: [],
          referencedTables: [],
          calledRoutines: []
        };
        collection.set(key, item);
      }
      item.dropStatements++;
    }
  }

  recordData(sql, statementNumber, entry) {
    const scrubbed = scrubSql(sql);
    const match = /\b(?:INSERT|REPLACE)\s+(?:INTO\s+)?([`\w$]+(?:\s*\.\s*[`\w$]+)?)/i.exec(scrubbed);
    if (match) {
      const parsed = parseReference(match[1]);
      if (parsed.schema && this.database && parsed.schema !== this.database) {
        this.finding('RESTORE_CROSS_DATABASE_BLOCKED', statementNumber, parsed.table, `Lệnh INSERT/REPLACE trỏ tới database khác (${parsed.schema}), không khớp database đích (${this.database}).`);
      }
      if (parsed.table) {
        const key = parsed.table;
        let t = this.tables.get(key);
        if (!t) {
          t = { name: parsed.table, type: 'table', createStatements: 0, dataStatements: 0, dropStatements: 0, dependencies: [] };
          this.tables.set(key, t);
        }
        t.dataStatements++;
        entry.name = parsed.table;
        entry.type = 'table';
      }
    }
  }

  recordOther(sql, target, statementNumber, entry) {
    this.opaqueObjects.push({ type: target.type, name: target.name, command: entry.command, statementNumber });
  }

  /**
   * Constructs the full RestoreDependencyGraph for all discovered objects.
   */
  buildDependencyGraph() {
    const graph = new RestoreDependencyGraph();

    // 1. Add all nodes
    for (const [key, t] of this.tables) {
      graph.addNode({ type: 'table', name: t.name, metadata: { createStatements: t.createStatements, dataStatements: t.dataStatements } });
    }
    for (const [key, v] of this.views) {
      graph.addNode({ type: 'view', name: v.name, metadata: { createStatements: v.createStatements } });
    }
    for (const [key, f] of this.functions) {
      graph.addNode({ type: 'function', name: f.name, metadata: { createStatements: f.createStatements, hasDynamicSql: f.hasDynamicSql } });
    }
    for (const [key, p] of this.procedures) {
      graph.addNode({ type: 'procedure', name: p.name, metadata: { createStatements: p.createStatements, hasDynamicSql: p.hasDynamicSql } });
    }
    for (const [key, tr] of this.triggers) {
      graph.addNode({ type: 'trigger', name: tr.name, metadata: { createStatements: tr.createStatements, targetTable: tr.targetTable } });
    }
    for (const [key, ev] of this.events) {
      graph.addNode({ type: 'event', name: ev.name, metadata: { createStatements: ev.createStatements } });
    }

    // 2. Add table FK edges
    for (const [key, t] of this.tables) {
      const childKey = RestoreDependencyGraph.nodeKey('table', t.name);
      for (const dep of t.dependencies) {
        const parentKey = RestoreDependencyGraph.nodeKey('table', dep.table);
        if (graph.hasNode(parentKey)) {
          graph.addEdge(childKey, parentKey);
        }
      }
    }

    // 3. Add view edges (views depend on tables or other views)
    for (const [key, v] of this.views) {
      const viewKey = RestoreDependencyGraph.nodeKey('view', v.name);
      for (const refName of v.referencedTables) {
        const asTable = RestoreDependencyGraph.nodeKey('table', refName);
        const asView = RestoreDependencyGraph.nodeKey('view', refName);
        if (graph.hasNode(asTable)) {
          graph.addEdge(viewKey, asTable);
        } else if (graph.hasNode(asView)) {
          graph.addEdge(viewKey, asView);
        }
      }
    }

    // 4. Add trigger edges (triggers depend on target table)
    for (const [key, tr] of this.triggers) {
      if (tr.targetTable) {
        const triggerKey = RestoreDependencyGraph.nodeKey('trigger', tr.name);
        const tableKey = RestoreDependencyGraph.nodeKey('table', tr.targetTable);
        if (graph.hasNode(tableKey)) {
          graph.addEdge(triggerKey, tableKey);
        }
      }
    }

    // 5. Add procedure edges (calls to functions/procedures, writes to tables)
    for (const [key, p] of this.procedures) {
      const procKey = RestoreDependencyGraph.nodeKey('procedure', p.name);
      for (const called of p.calledRoutines) {
        const asFn = RestoreDependencyGraph.nodeKey('function', called);
        const asProc = RestoreDependencyGraph.nodeKey('procedure', called);
        if (graph.hasNode(asFn)) graph.addEdge(procKey, asFn);
        else if (graph.hasNode(asProc)) graph.addEdge(procKey, asProc);
      }
      for (const tbl of p.referencedTables) {
        const asTable = RestoreDependencyGraph.nodeKey('table', tbl);
        if (graph.hasNode(asTable)) graph.addEdge(procKey, asTable);
      }
    }

    // 6. Add event edges (calls to procedures)
    for (const [key, ev] of this.events) {
      const eventKey = RestoreDependencyGraph.nodeKey('event', ev.name);
      for (const called of ev.calledRoutines) {
        const asProc = RestoreDependencyGraph.nodeKey('procedure', called);
        if (graph.hasNode(asProc)) graph.addEdge(eventKey, asProc);
      }
    }

    return graph;
  }

  /**
   * Generates a preview and validates user object selection.
   */
  previewSelection({
    tables = null,
    views = null,
    procedures = null,
    functions = null,
    triggers = null,
    events = null,
    includeStructure = true,
    includeData = true,
    targetFacts = null
  } = {}) {
    const graph = this.buildDependencyGraph();

    // If explicit lists are omitted, select all by default
    const selectAllTables = tables === null;
    const selectedTables = selectAllTables ? Array.from(this.tables.values()).map(t => t.name) : (tables || []);
    const selectedViews = views === null ? Array.from(this.views.values()).map(v => v.name) : (views || []);
    const selectedProcedures = procedures === null ? Array.from(this.procedures.values()).map(p => p.name) : (procedures || []);
    const selectedFunctions = functions === null ? Array.from(this.functions.values()).map(f => f.name) : (functions || []);
    const selectedTriggers = triggers === null ? Array.from(this.triggers.values()).map(tr => tr.name) : (triggers || []);
    const selectedEvents = events === null ? Array.from(this.events.values()).map(e => e.name) : (events || []);

    const selectedKeys = new Set();
    for (const name of selectedTables) selectedKeys.add(RestoreDependencyGraph.nodeKey('table', name));
    for (const name of selectedViews) selectedKeys.add(RestoreDependencyGraph.nodeKey('view', name));
    for (const name of selectedFunctions) selectedKeys.add(RestoreDependencyGraph.nodeKey('function', name));
    for (const name of selectedProcedures) selectedKeys.add(RestoreDependencyGraph.nodeKey('procedure', name));
    for (const name of selectedTriggers) selectedKeys.add(RestoreDependencyGraph.nodeKey('trigger', name));
    for (const name of selectedEvents) selectedKeys.add(RestoreDependencyGraph.nodeKey('event', name));

    if (selectedKeys.size === 0) {
      throw new Error('Chưa chọn đối tượng nào để phục hồi.');
    }

    // Build available target keys from targetFacts if supplied
    const availableTargetKeys = new Set();
    if (targetFacts?.objects && Array.isArray(targetFacts.objects)) {
      for (const obj of targetFacts.objects) {
        availableTargetKeys.add(RestoreDependencyGraph.nodeKey(obj.type, obj.name));
      }
    }

    // Dependency validation
    const validation = graph.validateSelection(selectedKeys, availableTargetKeys);

    // Topological order
    const { order, unresolved, cycles, hasCycles } = graph.topologicalSort(selectedKeys);
    const { dropOrder } = graph.computeDropOrder(selectedKeys);

    const findings = [...this.findings];

    if (!validation.valid) {
      for (const missing of validation.missingDependencies) {
        findings.push({
          code: 'MISSING_DEPENDENCY',
          objectName: missing.consumer.name,
          objectType: missing.consumer.type,
          requiredDependency: missing.requiredDependency.name,
          requiredType: missing.requiredDependency.type,
          details: `Đối tượng \`${missing.consumer.name}\` (${missing.consumer.type}) phụ thuộc vào \`${missing.requiredDependency.name}\` (${missing.requiredDependency.type}) nhưng đối tượng này chưa được chọn và không có trên cơ sở dữ liệu đích.`
        });
      }
    }

    if (hasCycles) {
      for (const cycle of cycles) {
        const readablePath = cycle.map(k => graph.getNode(k)?.name || k).join(' -> ');
        findings.push({
          code: 'CIRCULAR_DEPENDENCY',
          cyclePath: cycle,
          details: `Phát hiện phụ thuộc vòng giữa các đối tượng: ${readablePath}`
        });
      }
    }

    // Tally totals
    let createCount = 0;
    let dataCount = 0;
    let dropCount = 0;

    for (const name of selectedTables) {
      const t = this.tables.get(name);
      if (t) {
        if (includeStructure) { createCount += t.createStatements; dropCount += t.dropStatements; }
        if (includeData) { dataCount += t.dataStatements; }
      }
    }
    for (const name of selectedViews) {
      const v = this.views.get(name);
      if (v && includeStructure) { createCount += v.createStatements; dropCount += v.dropStatements; }
    }
    for (const name of selectedFunctions) {
      const f = this.functions.get(name);
      if (f && includeStructure) { createCount += f.createStatements; dropCount += f.dropStatements; }
    }
    for (const name of selectedProcedures) {
      const p = this.procedures.get(name);
      if (p && includeStructure) { createCount += p.createStatements; dropCount += p.dropStatements; }
    }
    for (const name of selectedTriggers) {
      const tr = this.triggers.get(name);
      if (tr && includeStructure) { createCount += tr.createStatements; dropCount += tr.dropStatements; }
    }
    for (const name of selectedEvents) {
      const ev = this.events.get(name);
      if (ev && includeStructure) { createCount += ev.createStatements; dropCount += ev.dropStatements; }
    }

    return {
      version: 1,
      sourceDatabase: this.database,
      selection: {
        tables: selectedTables,
        views: selectedViews,
        functions: selectedFunctions,
        procedures: selectedProcedures,
        triggers: selectedTriggers,
        events: selectedEvents,
        includeStructure,
        includeData
      },
      counts: {
        tables: selectedTables.length,
        views: selectedViews.length,
        functions: selectedFunctions.length,
        procedures: selectedProcedures.length,
        triggers: selectedTriggers.length,
        events: selectedEvents.length,
        totalObjects: selectedKeys.size
      },
      totals: {
        createStatements: createCount,
        dataStatements: dataCount,
        dropStatements: dropCount
      },
      order: order.map(k => graph.getNode(k)),
      dropOrder: dropOrder.map(k => graph.getNode(k)),
      unresolved: unresolved.map(k => graph.getNode(k)),
      cycles,
      hasCycles,
      valid: validation.valid && !hasCycles,
      findings
    };
  }

  /**
   * Generates an immutable, canonical execution plan (G3.2).
   */
  generateExecutionPlan({
    selection,
    fileChecksum,
    targetIdentity,
    targetFacts = null,
    dropExisting = false
  }) {
    if (!fileChecksum || typeof fileChecksum !== 'string' || !/^[a-f0-9]{64}$/i.test(fileChecksum)) {
      throw new Error('Thiếu mã băm SHA-256 của tệp sao lưu.');
    }
    if (!targetIdentity || typeof targetIdentity !== 'string') {
      throw new Error('Thiếu định danh cơ sở dữ liệu đích.');
    }

    const preview = this.previewSelection({ ...selection, targetFacts });
    const blockers = [];
    const warnings = [];

    for (const finding of preview.findings) {
      if (finding.code === 'MISSING_DEPENDENCY' || finding.code === 'CIRCULAR_DEPENDENCY' || finding.code === 'RESTORE_CROSS_DATABASE_BLOCKED' || finding.code === 'RESTORE_MIXED_SELECTION_BLOCKED') {
        blockers.push(finding);
      } else {
        warnings.push(finding);
      }
    }

    // Check statements for multi-object DROP statements, ALTER RENAME, and RENAME TABLE with mixed selection
    for (const s of this.statements) {
      const dropTargets = parseDropTargets(s.sql);
      if (dropTargets && dropTargets.targets.length > 1) {
        const selectedCount = dropTargets.targets.filter(t => preview.selection.tables.includes(t.name)).length;
        if (selectedCount > 0 && selectedCount < dropTargets.targets.length) {
          blockers.push({
            code: 'RESTORE_MIXED_SELECTION_BLOCKED',
            statementNumber: s.number,
            details: `Câu lệnh DROP đa đối tượng (${dropTargets.targets.map(t => t.name).join(', ')}) chứa đối tượng ngoài danh sách lựa chọn.`
          });
        }
      }
      const alterRename = parseAlterRename(s.sql);
      if (alterRename) {
        if (alterRename.source?.schema && this.database && alterRename.source.schema !== this.database) {
          blockers.push({
            code: 'RESTORE_CROSS_DATABASE_BLOCKED',
            statementNumber: s.number,
            details: `Lệnh ALTER TABLE trỏ tới database khác (${alterRename.source.schema}), không khớp database đích (${this.database}).`
          });
        }
        const allDests = alterRename.destinations && alterRename.destinations.length > 0
          ? alterRename.destinations
          : (alterRename.destination ? [alterRename.destination] : []);
        for (const dst of allDests) {
          if (dst?.schema && this.database && dst.schema !== this.database) {
            blockers.push({
              code: 'RESTORE_CROSS_DATABASE_BLOCKED',
              statementNumber: s.number,
              details: `Lệnh ALTER TABLE RENAME trỏ tới database khác (${dst.schema}), không khớp database đích (${this.database}).`
            });
          }
          const srcSel = preview.selection.tables.includes(alterRename.source.name);
          const dstSel = preview.selection.tables.includes(dst.name);
          if (srcSel !== dstSel) {
            blockers.push({
              code: 'RESTORE_MIXED_SELECTION_BLOCKED',
              statementNumber: s.number,
              details: `Lệnh ALTER TABLE RENAME chứa bảng ngoài danh sách lựa chọn: ${srcSel ? dst.name : alterRename.source.name}.`
            });
          }
        }
      }
      const renameTable = parseRenameTable(s.sql);
      if (renameTable && renameTable.pairs.length > 0) {
        const allSel = renameTable.pairs.every(p => preview.selection.tables.includes(p.source.name) && preview.selection.tables.includes(p.destination.name));
        const noneSel = renameTable.pairs.every(p => !preview.selection.tables.includes(p.source.name) && !preview.selection.tables.includes(p.destination.name));
        if (!allSel && !noneSel) {
          blockers.push({
            code: 'RESTORE_MIXED_SELECTION_BLOCKED',
            statementNumber: s.number,
            details: 'Lệnh RENAME TABLE chứa bảng ngoài danh sách lựa chọn phục hồi.'
          });
        }
      }
    }

    const steps = [];
    let stepNumber = 1;

    // Filter statements that belong to the selection with exact-case identity
    const selectedTableNames = new Set(preview.selection.tables);
    const selectedViewNames = new Set(preview.selection.views);
    const selectedFnNames = new Set(preview.selection.functions);
    const selectedProcNames = new Set(preview.selection.procedures);
    const selectedTriggerNames = new Set(preview.selection.triggers);
    const selectedEventNames = new Set(preview.selection.events);

    const isObjectSelected = (type, name) => {
      if (!name) return false;
      if (type === 'table') return selectedTableNames.has(name);
      if (type === 'view') return selectedViewNames.has(name);
      if (type === 'function') return selectedFnNames.has(name);
      if (type === 'procedure') return selectedProcNames.has(name);
      if (type === 'trigger') return selectedTriggerNames.has(name);
      if (type === 'event') return selectedEventNames.has(name);
      return false;
    };

    for (const stmt of this.statements) {
      let decision = 'excluded';
      let reason = 'NOT_SELECTED';

      if (stmt.type === 'context') {
        decision = 'candidate';
        reason = 'SESSION_CONTEXT';
      } else if (isObjectSelected(stmt.type, stmt.name)) {
        if (stmt.command === 'DROP') {
          if (dropExisting) {
            decision = 'candidate';
            reason = 'DROP_EXISTING_ENABLED';
          } else {
            decision = 'excluded';
            reason = 'DROP_EXISTING_DISABLED';
          }
        } else if (stmt.command === 'CREATE') {
          if (preview.selection.includeStructure) {
            decision = 'candidate';
            reason = 'CREATE_STRUCTURE_SELECTED';
          } else {
            decision = 'excluded';
            reason = 'STRUCTURE_EXCLUDED';
          }
        } else if (stmt.command === 'INSERT' || stmt.command === 'REPLACE') {
          if (preview.selection.includeData) {
            decision = 'candidate';
            reason = 'DATA_SELECTED';
          } else {
            decision = 'excluded';
            reason = 'DATA_EXCLUDED';
          }
        }
      }

      steps.push({
        stepNumber: stepNumber++,
        sourceStatementNumber: stmt.number,
        command: stmt.command,
        objectType: stmt.type,
        objectName: stmt.name,
        decision,
        reason
      });
    }

    const planData = {
      version: 1,
      kind: 'sqlpro-restore-execution-plan',
      fileChecksum,
      targetIdentity,
      sourceDatabase: this.database,
      selection: preview.selection,
      dropExisting: Boolean(dropExisting),
      order: preview.order,
      dropOrder: preview.dropOrder,
      steps,
      blockers,
      warnings,
      canExecute: blockers.length === 0,
      createdAt: new Date().toISOString()
    };

    // Calculate deterministic planId
    const canonicalBinding = JSON.stringify({
      fileChecksum,
      targetIdentity,
      selection: preview.selection,
      dropExisting: Boolean(dropExisting),
      steps: steps.map(s => `${s.command}:${s.objectType}:${s.objectName}:${s.decision}`)
    });
    planData.planId = crypto.createHash('sha256').update(canonicalBinding).digest('hex');

    // Freeze plan for immutability
    return Object.freeze(planData);
  }
}

module.exports = {
  RestoreObjectInventory,
  extractQueryReferences,
  checkDynamicSql,
  extractRoutineCalls,
  extractRoutineWrites,
  parseTriggerDetails
};
