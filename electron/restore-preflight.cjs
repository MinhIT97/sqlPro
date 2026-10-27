'use strict';

const { createTarget, scrubSql, stripLeadingComments } = require('./sql-script.cjs');

const PREFLIGHT_VERSION = 1;
const MAX_FINDINGS = 50;
const ROUTINE_TYPES = new Set(['trigger', 'procedure', 'function', 'event']);

function flag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (['ON', 'YES', 'TRUE'].includes(normalized)) return true;
    if (['OFF', 'NO', 'FALSE'].includes(normalized)) return false;
  }
  return null;
}

function unquoteIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1).replace(/``/g, '`');
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replace(/\\(.)/g, '$1').replace(/''/g, "'").replace(/""/g, '"');
  }
  return text;
}

function parseDefiner(sql) {
  const source = String(sql || '');
  const match = /\bDEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|[^\s]+)\s*@\s*(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|[^\s]+)/i.exec(source);
  if (!match) {
    const current = /\bDEFINER\s*=\s*CURRENT_USER\b/i.exec(source);
    return current ? 'CURRENT_USER' : null;
  }
  return `${unquoteIdentifier(match[1])}@${unquoteIdentifier(match[2])}`;
}

function functionHeader(sql) {
  const source = String(sql || '');
  const returns = /\bRETURNS\b/i.exec(source);
  if (!returns) return '';
  const after = source.slice(returns.index + returns[0].length);
  const body = /\bRETURN\b|\bBEGIN\b/i.exec(after);
  return body ? after.slice(0, body.index) : after;
}

function analyzeRoutineCharacteristics(sql) {
  const header = scrubSql(functionHeader(sql));
  const notDeterministic = /\bNOT\s+DETERMINISTIC\b/i.test(header);
  const deterministic = !notDeterministic && /\bDETERMINISTIC\b/i.test(header);
  const noSql = /\bNO\s+SQL\b/i.test(header);
  const readsSqlData = /\bREADS\s+SQL\s+DATA\b/i.test(header);
  const modifiesSqlData = /\bMODIFIES\s+SQL\s+DATA\b/i.test(header);
  const containsSql = /\bCONTAINS\s+SQL\b/i.test(header);
  return {
    deterministic,
    noSql,
    readsSqlData,
    modifiesSqlData,
    containsSql,
    binlogCompliant: deterministic || noSql || readsSqlData
  };
}

function analyzeCreateObject(statement, target = null) {
  const sql = stripLeadingComments(statement);
  const created = target || createTarget(sql);
  if (!created || !created.name) return null;
  const scrubbed = scrubSql(sql);
  const object = {
    type: created.type,
    name: created.name,
    ifNotExists: /\bIF\s+NOT\s+EXISTS\b/i.test(scrubbed),
    orReplace: /\bCREATE\s+OR\s+REPLACE\b/i.test(scrubbed),
    aggregate: created.type === 'function' && /\bCREATE\s+(?:OR\s+REPLACE\s+)?AGGREGATE\b/i.test(scrubbed)
  };
  if (ROUTINE_TYPES.has(created.type)) {
    object.definer = parseDefiner(sql);
    if (created.type === 'function') {
      object.characteristics = analyzeRoutineCharacteristics(sql);
      object.binlogCompliant = object.aggregate || object.characteristics.binlogCompliant;
    }
  }
  return object;
}

function normalizeObjectKey(object, caseInsensitive) {
  const name = String(object?.name || '');
  const type = String(object?.type || '').toLowerCase();
  const namespace = type === 'view' ? 'table' : type;
  const fold = caseInsensitive || ['procedure', 'function', 'event'].includes(type);
  return `${namespace}\u0000${fold ? name.toLowerCase() : name}`;
}

function dedupeObjects(objects) {
  const seen = new Set();
  const result = [];
  for (const object of objects) {
    if (!object || !object.type || !object.name) continue;
    const key = `${object.type}\u0000${String(object.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(object);
  }
  return result;
}

function targetObjectIndex(target) {
  const raw = target?.lowerCaseTableNames;
  const lowerCaseTableNames = raw === null || raw === undefined ? null : Number(raw);
  const caseInsensitive = lowerCaseTableNames === 1 || lowerCaseTableNames === 2;
  const exact = new Map();
  const folded = new Map();
  for (const object of Array.isArray(target?.objects) ? target.objects : []) {
    const key = normalizeObjectKey(object, false);
    exact.set(key, object);
    const lower = normalizeObjectKey(object, true);
    if (!folded.has(lower)) folded.set(lower, []);
    folded.get(lower).push(object);
  }
  return { exact, folded, caseInsensitive, lowerCaseTableNames };
}

function updateObjectIndex(index, object, remove = false) {
  const key = normalizeObjectKey(object, false);
  const folded = normalizeObjectKey(object, true);
  if (remove) {
    index.exact.delete(key);
    const remaining = (index.folded.get(folded) || []).filter((entry) => normalizeObjectKey(entry, false) !== key);
    if (remaining.length) index.folded.set(folded, remaining);
    else index.folded.delete(folded);
  } else {
    index.exact.set(key, object);
    index.folded.set(folded, [...(index.folded.get(folded) || [])
      .filter((entry) => normalizeObjectKey(entry, false) !== key), object]);
  }
}

function countTypes(objects) {
  const counts = { tables: 0, views: 0, routines: 0, procedures: 0, functions: 0, triggers: 0, events: 0 };
  for (const object of objects) {
    if (object.type === 'table') counts.tables += 1;
    else if (object.type === 'view') counts.views += 1;
    else if (object.type === 'procedure') { counts.routines += 1; counts.procedures += 1; }
    else if (object.type === 'function') { counts.routines += 1; counts.functions += 1; }
    else if (object.type === 'trigger') counts.triggers += 1;
    else if (object.type === 'event') counts.events += 1;
  }
  return counts;
}

function truncateFindings(findings) {
  if (findings.length <= MAX_FINDINGS) return findings;
  const omitted = findings.length - MAX_FINDINGS;
  return [
    ...findings.slice(0, MAX_FINDINGS),
    {
      severity: findings[0]?.severity || 'warning',
      code: 'FINDINGS_TRUNCATED',
      message: `Còn ${omitted} vấn đề khác không hiển thị hết. Hãy xem lại tệp SQL hoặc chạy kiểm tra chi tiết.`
    }
  ];
}

function buildRestorePreflight({ filePath = '', fileSize = 0, inventory = {}, target = {}, options = {} } = {}) {
  const found = [];
  const add = (severity, code, message, details = {}) => {
    found.push({ severity, code, message, ...details });
  };
  const createdObjects = dedupeObjects(Array.isArray(inventory.createdObjects) ? inventory.createdObjects : []);
  const targetIndex = targetObjectIndex(target);
  const dropExisting = options.dropExisting === true;
  const createDatabaseIfNotExists = options.createDatabaseIfNotExists === true;
  const database = options.database || target.database || '';

  if (inventory.error) {
    add('unknown', 'INVENTORY_INCOMPLETE', `Không đọc đầy đủ tệp SQL: ${inventory.error}`);
  }
  if (inventory.objectsTruncated === true) {
    add('unknown', 'INVENTORY_OBJECTS_TRUNCATED', 'Tệp SQL có quá nhiều đối tượng để đối chiếu trong một lượt; danh sách kiểm tra có thể chưa đầy đủ.');
  }
  if (!createdObjects.length && !inventory.statements) {
    add('warning', 'NO_OBJECTS_FOUND', 'Không nhận diện được đối tượng nào trong tệp SQL. Hãy kiểm tra tệp có đúng định dạng dump không.');
  }

  if (target.databaseExists === false) {
    if (!createDatabaseIfNotExists) {
      add('warning', 'TARGET_DATABASE_MISSING', `Database đích "${database}" không tồn tại. Hãy bật tạo database mới hoặc chọn database khác; phục hồi sẽ dừng trước khi ghi nếu database vẫn không tồn tại.`, {
        objectType: 'database',
        objectName: database
      });
    }
  } else if (target.databaseExists === null) {
    add('unknown', 'TARGET_DATABASE_EXISTS_UNKNOWN', `Không xác minh được database đích "${database}" có tồn tại hay không.`);
  }

  const targetErrors = Array.isArray(target.errors) ? target.errors : [];
  if (targetErrors.length) {
    add('unknown', 'TARGET_FACTS_INCOMPLETE', `Không xác minh đầy đủ trạng thái đích: ${targetErrors.map((entry) => entry.check).join(', ')}.`, {
      checks: targetErrors.map((entry) => entry.check)
    });
  }
  if (target.objectsComplete === false) {
    add('unknown', 'TARGET_OBJECTS_UNKNOWN', 'Không đọc đầy đủ danh sách đối tượng hiện có ở database đích; không thể kết luận chắc chắn về xung đột tên.');
  }
  if (target.objectsTruncated === true) {
    add('unknown', 'TARGET_OBJECTS_TRUNCATED', 'Database đích có quá nhiều đối tượng để đối chiếu xung đột tên trong một lượt.');
  }

  let conflicts = 0;
  let overwritten = 0;
  const operations = Array.isArray(inventory.objectOperations)
    ? inventory.objectOperations
    : createdObjects.map((object) => ({ command: 'CREATE', ...object }));
  for (const object of operations) {
    const exactKey = normalizeObjectKey(object, false);
    let existing = targetIndex.exact.get(exactKey);
    if (!existing && targetIndex.caseInsensitive) {
      existing = targetIndex.folded.get(normalizeObjectKey(object, true))?.[0];
    }
    if (existing && existing.type !== object.type) {
      add('blocking', 'TARGET_OBJECT_TYPE_MISMATCH', `Không thể ${object.command} ${object.type} "${object.name}": tên này đang thuộc ${existing.type}. Cần DROP đúng loại đối tượng trước khi tạo lại.`, {
        objectType: object.type, objectName: object.name
      });
      continue;
    }
    if (object.command === 'DROP') {
      if (existing) {
        updateObjectIndex(targetIndex, existing, true);
        overwritten += 1;
      }
      continue;
    }
    if (!existing) {
      if (targetIndex.lowerCaseTableNames === null || targetIndex.lowerCaseTableNames === undefined) {
        const ambiguous = targetIndex.folded.get(normalizeObjectKey(object, true)) || [];
        if (ambiguous.length) {
          add('unknown', 'TARGET_OBJECT_CASE_AMBIGUOUS', `Không chắc tên "${object.name}" có trùng với ${ambiguous[0].type} hiện có khi chưa biết lower_case_table_names của máy chủ đích.`, {
            objectType: object.type,
            objectName: object.name
          });
        }
      }
      updateObjectIndex(targetIndex, object);
      continue;
    }
    conflicts += 1;
    if (dropExisting) {
      overwritten += 1;
      updateObjectIndex(targetIndex, existing, true);
      updateObjectIndex(targetIndex, object);
      continue;
    }
    if (object.ifNotExists || object.orReplace) {
      add('warning', 'TARGET_OBJECT_EXISTS_IF_NOT_EXISTS', `${object.type} "${object.name}" đã tồn tại; câu lệnh IF NOT EXISTS/OR REPLACE có thể giữ dữ liệu cũ thay vì tạo mới.`, {
        objectType: object.type,
        objectName: object.name
      });
      if (object.orReplace) updateObjectIndex(targetIndex, object);
      continue;
    }
    add('blocking', 'TARGET_OBJECT_EXISTS', `${object.type} "${object.name}" đã tồn tại ở database đích và tùy chọn xóa đối tượng trùng tên đang tắt.`, {
      objectType: object.type,
      objectName: object.name,
      action: 'Bật "Xóa bảng/view/trigger/routine/event trùng tên", chọn database mới, hoặc bỏ đối tượng này khỏi tệp.'
    });
  }

  const existingCount = Array.isArray(target.objects) ? target.objects.length : null;
  if (existingCount && !conflicts && !dropExisting) {
    add('warning', 'TARGET_DATABASE_NON_EMPTY', `Database đích đã có ${existingCount} đối tượng. Tệp sẽ ghi thêm vào database hiện có, không phải database trống.`);
  }

  const functions = createdObjects.filter((object) => object.type === 'function');
  const logBin = flag(target.logBin);
  const trustFunctionCreators = flag(target.logBinTrustFunctionCreators);
  if (functions.length) {
    if (logBin === false) {
      // Binary logging is off on the target; MySQL does not require routine characteristics.
    } else if (logBin === true && trustFunctionCreators === true) {
      // The target explicitly allows functions without deterministic characteristics.
    } else if (logBin === true && trustFunctionCreators === false) {
      for (const fn of functions) {
        if (fn.binlogCompliant) continue;
        add('blocking', 'BINARY_LOG_FUNCTION_NOT_COMPLIANT', `Function "${fn.name}" thiếu DETERMINISTIC, NO SQL hoặc READS SQL DATA trong khi database đích bật binary logging và tắt log_bin_trust_function_creators.`, {
          objectType: 'function',
          objectName: fn.name,
          action: 'Sửa định nghĩa function nếu đúng ngữ nghĩa, nhờ DBA cấu hình quyền/chính sách binary logging, hoặc bỏ chọn function này.'
        });
      }
    } else {
      for (const fn of functions) {
        if (fn.binlogCompliant) continue;
        add('unknown', 'BINARY_LOG_FUNCTION_UNVERIFIED', `Chưa xác minh được binary logging trên database đích cho function "${fn.name}"; lệnh CREATE FUNCTION có thể bị từ chối.`, {
          objectType: 'function',
          objectName: fn.name
        });
      }
    }
  }

  const currentUser = String(target.currentUser || '').toLowerCase();
  if (currentUser) {
    for (const object of createdObjects) {
      if (!ROUTINE_TYPES.has(object.type) || !object.definer || object.definer === 'CURRENT_USER') continue;
      if (object.definer.toLowerCase() === currentUser) continue;
      add('unknown', 'ROUTINE_DEFINER_UNVERIFIED', `${object.type} "${object.name}" có DEFINER ${object.definer}, khác tài khoản đang phục hồi; máy chủ đích có thể yêu cầu quyền SUPER/SET_USER_ID.`, {
        objectType: object.type,
        objectName: object.name
      });
    }
  }

  const blocking = found.filter((entry) => entry.severity === 'blocking');
  const warning = found.filter((entry) => entry.severity === 'warning');
  const unknown = found.filter((entry) => entry.severity === 'unknown');
  const status = blocking.length ? 'blocking' : warning.length ? 'warning' : unknown.length ? 'unknown' : 'ok';
  const createCounts = countTypes(createdObjects);

  return {
    version: PREFLIGHT_VERSION,
    generatedAt: new Date().toISOString(),
    status,
    canProceed: blocking.length === 0,
    blocking: truncateFindings(blocking),
    warning: truncateFindings(warning),
    unknown: truncateFindings(unknown),
    findings: truncateFindings(found),
    file: {
      name: String(filePath || '').split(/[\\/]/).pop() || '',
      bytes: Number(fileSize) || 0
    },
    impact: {
      database,
      targetDatabaseExists: target.databaseExists,
      targetObjectCount: existingCount,
      statements: Number(inventory.statements) || 0,
      skipped: Number(inventory.skipped) || 0,
      objects: createdObjects.length,
      createCounts,
      conflicts,
      overwritten,
      dropExisting
    },
    target: {
      database,
      version: target.version || null,
      flavor: target.flavor || null,
      lowerCaseTableNames: target.lowerCaseTableNames ?? null,
      logBin,
      logBinTrustFunctionCreators: trustFunctionCreators,
      checkedAt: target.checkedAt || null
    }
  };
}

module.exports = {
  PREFLIGHT_VERSION,
  analyzeCreateObject,
  analyzeRoutineCharacteristics,
  buildRestorePreflight,
  parseDefiner
};
