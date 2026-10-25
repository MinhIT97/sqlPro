'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSession, previewImportFile } = require('../electron/database.cjs');

const COLUMNS = [
  { name: 'id', type: 'int', nullable: 'NO', key: 'PRI', extra: 'auto_increment' },
  { name: 'name', type: 'varchar(50)', nullable: 'YES', key: '', extra: '' },
  { name: 'score', type: 'int', nullable: 'YES', key: '', extra: '' },
  { name: 'payload', type: 'json', nullable: 'YES', key: '', extra: '' },
  { name: 'raw', type: 'varbinary(10)', nullable: 'YES', key: '', extra: '' }
];

test('JSON string transport preserves nested JSON export types and large numeric literals', async () => {
  const columns = [{ name: 'payload', type: 'json' }, { name: 'text', type: 'varchar(100)' }];
  const raw = '{"n":18446744073709551615,"enabled":true}';
  const { session } = createSession(columns, [[raw, raw]]);
  let output = '';
  await session.exportTableFile({ database: 'demo', table: 'items', format: 'json' }, async (chunk) => { output += chunk; });
  assert.ok(output.includes(`"payload":${raw}`));
  assert.ok(output.includes(`"text":${JSON.stringify(raw)}`));
  assert.equal(typeof JSON.parse(output)[0].payload, 'object');
});

function createSession(columns, rows = [], insertResult = () => ({ affectedRows: 1, info: 'Duplicates: 0' })) {
  const session = new DatabaseSession({});
  const calls = { inserts: [], queries: [], transactions: [], destroyed: 0 };
  session.listColumns = async () => columns;
  session.connection = {
    query(config, params, callback) {
      if (typeof config === 'object' && config !== null) {
        calls.queries.push(config);
        return {
          async *stream() {
            for (const row of rows) yield row;
          }
        };
      }
      calls.inserts.push({ sql: config, params });
      callback(null, insertResult(config, params));
    },
    beginTransaction(callback) {
      calls.transactions.push('begin');
      callback(null);
    },
    commit(callback) {
      calls.transactions.push('commit');
      callback(null);
    },
    rollback(callback) {
      calls.transactions.push('rollback');
      callback(null);
    },
    destroy() {
      calls.destroyed += 1;
      calls.transactions.push('destroy');
    }
  };
  return { session, calls };
}

async function withTempDir(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlpro-file-transfer-'));
  try {
    return await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function writeTemp(directory, name, content) {
  const filePath = path.join(directory, name);
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

test('xuất CSV có header, escaping, NULL và binary', async () => {
  const rows = [
    [1, 'Alice, "A"', { a: 1 }, Buffer.from('00ff', 'hex')],
    [2, null, null, null],
    [3, 'line\nnext', 'text', Buffer.alloc(0)]
  ];
  const { session, calls } = createSession(COLUMNS, rows);
  const chunks = [];
  const progress = [];
  const result = await session.exportTableFile(
    {
      database: 'sample',
      table: 'items',
      format: 'csv',
      columns: ['id', 'name', 'payload', 'raw'],
      filters: [{ column: 'id', operator: '>=', value: 2 }],
      search: 'Alice',
      orderBy: { column: 'id', direction: 'DESC' },
      taskId: 'export-1'
    },
    async (chunk) => { chunks.push(chunk); },
    (value) => progress.push(value)
  );

  const text = chunks.join('');
  assert.equal(
    text,
    'id,name,payload,raw\n'
      + '1,"Alice, ""A""","{""a"":1}",0x00ff\n'
      + '2,\\N,\\N,\\N\n'
      + '3,"line\nnext",text,0x\n'
  );
  assert.equal(result.rows, 3);
  assert.equal(result.bytes, Buffer.byteLength(text));
  assert.deepEqual(result.columns, ['id', 'name', 'payload', 'raw']);
  assert.deepEqual(calls.queries[0].values, [2, '%Alice%', '%Alice%', '%Alice%', '%Alice%', '%Alice%']);
  assert.match(calls.queries[0].sql, /^SELECT `id`, `name`, `payload`, `raw` FROM `sample`\.`items`/);
  assert.match(calls.queries[0].sql, /WHERE \(`id` >= \?\) AND \(/);
  assert.match(calls.queries[0].sql, /ORDER BY `id` DESC$/);
  assert.equal(progress.at(-1).operation, 'export');
  assert.equal(progress.at(-1).rows, 3);
  assert.equal(session.activeTask, null);
});

test('xuất JSON là mảng hợp lệ và giữ NULL, object, binary', async () => {
  const rows = [
    [1, 'Alice, "A"', { a: 1 }, Buffer.from('00ff', 'hex')],
    [2, null, null, null]
  ];
  const { session } = createSession(COLUMNS.slice(0, 4), rows);
  const chunks = [];
  const result = await session.exportTableFile(
    { database: 'sample', table: 'items', format: 'json' },
    async (chunk) => { chunks.push(chunk); }
  );
  const parsed = JSON.parse(chunks.join(''));
  assert.deepEqual(parsed, [
    { id: 1, name: 'Alice, "A"', score: { a: 1 }, payload: '0x00ff' },
    { id: 2, name: null, score: null, payload: null }
  ]);
  assert.equal(result.rows, 2);
  assert.equal(result.format, 'json');
});

test('xuất theo lô, tôn trọng backpressure và ghi đủ byte', async () => {
  const value = 'x'.repeat(400000);
  const rows = Array.from({ length: 4 }, (_entry, index) => [index + 1, value]);
  const { session } = createSession(COLUMNS.slice(0, 2), rows);
  const chunks = [];
  const result = await session.exportTableFile(
    { database: 'sample', table: 'items', format: 'csv' },
    async (chunk) => { chunks.push(chunk); }
  );
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 1024 * 1024 + 400100));
  assert.equal(result.rows, 4);
  assert.equal(result.bytes, Buffer.byteLength(chunks.join('')));
  assert.equal((chunks.join('').match(/^4,/gm) || []).length, 1);
});

test('hủy export trả EXPORT_CANCELED kèm tiến độ một phần và giải phóng tác vụ', async () => {
  const { session } = createSession(COLUMNS.slice(0, 2), [
    [1, 'An'],
    [2, 'Binh']
  ]);
  let yielded = 0;
  session.connection.query = () => ({
    async *stream() {
      for (const row of [[1, 'An'], [2, 'Binh']]) {
        if (yielded === 1) session.cancelTask('export-cancel');
        yielded += 1;
        yield row;
      }
    }
  });
  await assert.rejects(
    session.exportTableFile(
      { database: 'sample', table: 'items', format: 'csv', taskId: 'export-cancel' },
      async () => {}
    ),
    (error) => {
      assert.equal(error.code, 'EXPORT_CANCELED');
      assert.equal(error.partial.rows, 1);
      assert.equal(error.partial.format, 'csv');
      return true;
    }
  );
  assert.equal(session.activeTask, null);
  assert.equal(session.dead, true);
});

test('nhập CSV ánh xạ cột, validate kiểu và giao dịch theo lô', async () => {
  await withTempDir(async (directory) => {
    const content = 'id;name;score;payload;raw\n'
      + '1;An;10;"{""a"":1}";0x00ff\n'
      + '2;Binh;;;\\\\N\n';
    const filePath = await writeTemp(directory, 'items.csv', content);
    const { session, calls } = createSession(COLUMNS);
    const progress = [];
    const result = await session.importFile(
      {
        database: 'sample',
        table: 'items',
        filePath,
        format: 'csv',
        delimiter: ';',
        mapping: { id: 'id', name: 'name', score: 'score', payload: 'payload', raw: 'raw' },
        mode: 'insert',
        transaction: 'batch',
        taskId: 'import-1'
      },
      (value) => progress.push(value)
    );

    assert.equal(result.rows, 2);
    assert.equal(result.written, 2);
    assert.equal(result.committed, 2);
    assert.equal(result.batches, 1);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.resumable, false);
    assert.equal(calls.inserts.length, 1);
    assert.equal(
      calls.inserts[0].sql,
      'INSERT INTO `sample`.`items` (`id`, `name`, `score`, `payload`, `raw`) '
        + 'VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)'
    );
    assert.deepEqual(calls.inserts[0].params, [
      '1', 'An', '10', '{"a":1}', Buffer.from('00ff', 'hex'),
      '2', 'Binh', null, null, '\\N'
    ]);
    assert.deepEqual(calls.transactions, ['begin', 'commit']);
    assert.equal(progress.at(-1).operation, 'import');
    assert.equal(progress.at(-1).committed, 2);
    assert.equal(session.activeTask, null);
  });
});

test('nhập CSV hỗ trợ chính sách bỏ qua và cập nhật khi trùng khóa', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(directory, 'items.csv', 'id,name\n1,An\n');
    const skip = createSession(
      COLUMNS.slice(0, 2),
      [],
      () => ({ affectedRows: 0, info: 'Duplicates: 1' })
    );
    const skipResult = await skip.session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'csv',
      mode: 'skip',
      transaction: 'none'
    });
    assert.match(skip.calls.inserts[0].sql, /ON DUPLICATE KEY UPDATE `id` = `id`$/);
    assert.equal(skipResult.duplicates, 1);
    assert.equal(skipResult.committed, 1);
    assert.deepEqual(skip.calls.transactions, []);

    const upsert = createSession(COLUMNS.slice(0, 2));
    await upsert.session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'csv',
      mode: 'upsert',
      transaction: 'none'
    });
    assert.match(
      upsert.calls.inserts[0].sql,
      /ON DUPLICATE KEY UPDATE `id` = VALUES\(`id`\), `name` = VALUES\(`name`\)$/
    );
    assert.equal(upsert.session.activeTask, null);
  });
});

test('giao dịch all chỉ commit một lần sau khi đọc hết tệp', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(directory, 'items.csv', 'id,name\n1,An\n2,Binh\n3,Chi\n');
    const { session, calls } = createSession(COLUMNS.slice(0, 2));
    const result = await session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'csv',
      mode: 'insert',
      transaction: 'all'
    });
    assert.deepEqual(calls.transactions, ['begin', 'commit']);
    assert.equal(result.written, 3);
    assert.equal(result.committed, 3);
  });
});

test('lỗi validate báo đúng dòng, cột và tiến độ một phần', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(directory, 'items.csv', 'id,name,score\n1,An,khong-phai-so\n');
    const { session, calls } = createSession(COLUMNS);
    await assert.rejects(
      session.importFile({
        database: 'sample',
        table: 'items',
        filePath,
        format: 'csv',
        mode: 'insert',
        transaction: 'batch'
      }),
      (error) => {
        assert.equal(error.code, 'IMPORT_VALUE_INVALID');
        assert.equal(error.row, 1);
        assert.equal(error.column, 'score');
        assert.match(error.message, /Dòng 1/);
        assert.equal(error.partial.rows, 1);
        assert.equal(error.partial.written, 0);
        assert.equal(error.partial.resumable, false);
        return true;
      }
    );
    assert.equal(calls.inserts.length, 0);
    assert.equal(session.activeTask, null);
  });
});

test('hủy import trả IMPORT_CANCELED, không cho resume và dọn tác vụ', async () => {
  await withTempDir(async (directory) => {
    const lines = ['id,name'];
    for (let index = 1; index <= 250; index += 1) lines.push(`${index},User ${index}`);
    const filePath = await writeTemp(directory, 'items.csv', `${lines.join('\n')}\n`);
    const { session, calls } = createSession(COLUMNS.slice(0, 2));
    let canceled = false;
    await assert.rejects(
      session.importFile(
        {
          database: 'sample',
          table: 'items',
          filePath,
          format: 'csv',
          mode: 'insert',
          transaction: 'none',
          taskId: 'import-cancel'
        },
        (value) => {
          if (!canceled && value.operation === 'import' && value.written >= 200) {
            canceled = true;
            session.cancelTask('import-cancel');
          }
        }
      ),
      (error) => {
        assert.equal(error.code, 'IMPORT_CANCELED');
        assert.equal(error.partial.written, 200);
        assert.equal(error.partial.rows, 200);
        assert.equal(error.partial.resumable, false);
        assert.equal(error.resumable, false);
        return true;
      }
    );
    assert.equal(calls.inserts.length, 1);
    assert.equal(session.activeTask, null);
    assert.equal(session.dead, true);
  });
});

test('nhập tệp lớn hơn 5.000 dòng theo nhiều lô', async () => {
  await withTempDir(async (directory) => {
    const lines = ['id'];
    for (let index = 1; index <= 6000; index += 1) lines.push(String(index));
    const filePath = await writeTemp(directory, 'ids.csv', `${lines.join('\n')}\n`);
    const { session, calls } = createSession([COLUMNS[0]]);
    const result = await session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'csv',
      mode: 'insert',
      transaction: 'batch'
    });
    assert.equal(result.rows, 6000);
    assert.equal(result.written, 6000);
    assert.equal(result.committed, 6000);
    assert.equal(result.batches, 30);
    assert.equal(calls.inserts.length, 30);
    assert.equal(calls.inserts[0].params.length, 200);
    assert.equal(calls.inserts.at(-1).params.length, 200);
  });
});

test('nhập JSON dùng key của object, giữ object lồng và bỏ qua key thiếu', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(
      directory,
      'items.json',
      '[{"id":1,"name":"An","payload":{"a":1}},{"id":2}]'
    );
    const { session, calls } = createSession(COLUMNS.slice(0, 4));
    const result = await session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'json',
      mapping: { id: 'id', name: 'name', payload: 'payload' },
      mode: 'insert',
      transaction: 'batch'
    });
    assert.equal(result.rows, 2);
    assert.deepEqual(calls.inserts[0].params, [
      '1', 'An', '{"a":1}',
      '2', null, null
    ]);
  });
});

test('preview CSV tôn trọng delimiter, header và giới hạn dòng', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(directory, 'items.csv', 'name;score\nAn;1\nBinh;2\nChi;3\n');
    const preview = await previewImportFile({
      filePath,
      format: 'csv',
      delimiter: ';',
      hasHeader: true,
      limit: 2
    });
    assert.equal(preview.format, 'csv');
    assert.equal(preview.delimiter, ';');
    assert.deepEqual(preview.headers, ['name', 'score']);
    assert.deepEqual(preview.rows, [['An', '1'], ['Binh', '2']]);
    assert.equal(preview.truncated, true);
    assert.equal(preview.totalBytes, Buffer.byteLength('name;score\nAn;1\nBinh;2\nChi;3\n'));
    assert.ok(preview.sampledBytes > 0);

    const noHeader = await previewImportFile({ filePath, format: 'csv', delimiter: ';', hasHeader: false });
    assert.deepEqual(noHeader.headers, ['0', '1']);
    assert.deepEqual(noHeader.rows[0], ['name', 'score']);
  });
});

test('preview JSON hợp nhất key của nhiều object', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(
      directory,
      'items.json',
      '[{"id":1,"name":"An"},{"id":2,"email":"b@example.com"}]'
    );
    const preview = await previewImportFile({ filePath, format: 'json' });
    assert.deepEqual(preview.headers, ['id', 'name', 'email']);
    assert.deepEqual(preview.rows, [
      [1, 'An', null],
      [2, null, 'b@example.com']
    ]);
    assert.equal(preview.truncated, false);
  });
});

test('preview JSON giữ nguyên số lớn và object lồng khi hiển thị', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(
      directory,
      'precise.json',
      '[{"id":9007199254740993,"small":2,"nested":{"n":18446744073709551615}}]'
    );
    const preview = await previewImportFile({ filePath, format: 'json' });
    assert.deepEqual(preview.rows, [
      ['9007199254740993', 2, '{"n":18446744073709551615}']
    ]);
  });
});

test('nhập JSON giữ nguyên số lớn và áp dụng quy tắc kiểu giống trình sửa dòng', async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeTemp(
      directory,
      'precise.json',
      '[{"id":9007199254740993,"flags":"1010","born":"2024-02-29","ratio":12345678901234567890.123456789}]'
    );
    const columns = [
      { name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI', extra: '' },
      { name: 'flags', type: 'bit(4)', nullable: 'YES', key: '', extra: '' },
      { name: 'born', type: 'date', nullable: 'YES', key: '', extra: '' },
      { name: 'ratio', type: 'decimal(30,9)', nullable: 'YES', key: '', extra: '' }
    ];
    const { session, calls } = createSession(columns);
    await session.importFile({
      database: 'sample',
      table: 'items',
      filePath,
      format: 'json',
      mode: 'insert',
      transaction: 'batch'
    });
    assert.deepEqual(calls.inserts[0].params, [
      '9007199254740993',
      Buffer.from('0a', 'hex'),
      '2024-02-29',
      '12345678901234567890.123456789'
    ]);
  });
});

test('nhập JSON từ chối ngày, số nguyên và BIT không hợp lệ trước khi ghi', async () => {
  await withTempDir(async (directory) => {
    const cases = [
      { name: 'date.json', value: '{"born":"2026-02-30"}', column: { name: 'born', type: 'date' }, pattern: /Dòng 1, cột "born"/ },
      { name: 'tinyint.json', value: '{"score":256}', column: { name: 'score', type: 'tinyint unsigned' }, pattern: /255/ },
      { name: 'bit.json', value: '{"flags":"10101"}', column: { name: 'flags', type: 'bit(4)' }, pattern: /4 bit/ }
    ];
    for (const entry of cases) {
      const filePath = await writeTemp(directory, entry.name, `[${entry.value}]`);
      const { session, calls } = createSession([{ ...entry.column, nullable: 'YES', key: '', extra: '' }]);
      await assert.rejects(
        session.importFile({ database: 'sample', table: 'items', filePath, format: 'json', mode: 'insert', transaction: 'batch' }),
        (error) => error.code === 'IMPORT_VALUE_INVALID' && entry.pattern.test(error.message)
      );
      assert.equal(calls.inserts.length, 0);
    }
  });
});
