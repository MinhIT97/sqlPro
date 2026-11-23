'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSession } = require('../electron/database.cjs');
const { SchemaSnapshotCollector, computeSchemaFingerprint, projectSnapshotForRenderer } = require('../electron/schema-snapshot.cjs');
const { saveBackupFile } = require('../electron/backup-file.cjs');
const { extractTableReferences, getContext, rankSuggestions } = require('../sql-autocomplete.js');

const DB_NAME = 'sqlpro_demo';

const profile = {
  id: 'test-profile-sqlpro',
  name: 'Local Laragon MySQL',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: DB_NAME,
  ssl: { enabled: false },
  ssh: { enabled: false }
};

const results = [];

function logSection(title) {
  console.log(`\n============================================================`);
  console.log(`🔹 ${title}`);
  console.log(`============================================================`);
}

function recordPass(testName, details) {
  results.push({ name: testName, status: 'PASSED', details });
  console.log(`  ✅ [PASS] ${testName}${details ? ` -> ${details}` : ''}`);
}

function recordFail(testName, err) {
  results.push({ name: testName, status: 'FAILED', error: err.message });
  console.error(`  ❌ [FAIL] ${testName}:`, err.message);
}

async function runAllTests() {
  console.log(`🚀 Bắt đầu kiểm thử toàn diện tính năng SqlPro với cơ sở dữ liệu: "${DB_NAME}"...\n`);

  const session = new DatabaseSession(profile);

  try {
    // -------------------------------------------------------------
    // TEST 1: Session Connection & Server Info
    // -------------------------------------------------------------
    logSection('1. Kết nối phiên (Session Connection) & Thông tin máy chủ');
    try {
      await session.connect();
      assert.ok(session.connection && !session.dead, 'Phiên kết nối phải mở và khả dụng');
      assert.ok(session.connection.threadId > 0, 'Phải có MySQL threadId hợp lệ');
      const info = await session.serverInfo();
      assert.ok(info.version, 'Phải lấy được thông tin phiên bản MySQL');
      recordPass('Kết nối MySQL DatabaseSession', `Phiên bản: ${info.version}, Thread ID: ${session.connection.threadId}`);
    } catch (err) {
      recordFail('Kết nối MySQL DatabaseSession', err);
    }

    // -------------------------------------------------------------
    // TEST 2: Schema Discovery & Introspection
    // -------------------------------------------------------------
    logSection('2. Khảo sát cấu trúc Schema (Schema Introspection)');
    try {
      const dbs = await session.listDatabases();
      assert.ok(dbs.includes(DB_NAME), `Danh sách database phải chứa "${DB_NAME}"`);
      recordPass('Lấy danh sách Databases (listDatabases)', `Tổng cộng ${dbs.length} databases.`);

      const tables = await session.listTables(DB_NAME);
      const tableNames = tables.map(t => t.name);
      assert.ok(tables.length >= 10, 'Phải có ít nhất 10 bảng');
      assert.ok(tableNames.includes('products'), 'Bảng products phải tồn tại');
      assert.ok(tableNames.includes('orders'), 'Bảng orders phải tồn tại');
      assert.ok(tableNames.includes('v_orders_summary'), 'View v_orders_summary phải tồn tại');
      recordPass('Lấy danh sách Tables & Views (listTables)', `Tìm thấy ${tables.length} bảng/views (${tables.filter(t => t.type === 'view').length} views).`);

      const columns = await session.listColumns(DB_NAME, 'products');
      const colNames = columns.map(c => c.name || c.COLUMN_NAME);
      assert.ok(colNames.includes('id') && colNames.includes('name') && colNames.includes('price') && colNames.includes('specs'));
      recordPass('Đọc danh sách Cột (listColumns products)', `${columns.length} cột, hỗ trợ kiểu JSON (specs), DECIMAL, ENUM.`);

      const indexes = await session.listIndexes(DB_NAME, 'products');
      const indexNames = indexes.map(i => i.name || i.INDEX_NAME);
      assert.ok(indexNames.includes('PRIMARY'), 'Phải có chỉ mục PRIMARY');
      assert.ok(indexNames.includes('idx_ft_products'), 'Phải nhận diện Fulltext index idx_ft_products');
      recordPass('Đọc danh sách Chỉ mục (listIndexes products)', `${indexes.length} chỉ mục (PRIMARY, UNIQUE, FULLTEXT, Composite).`);

      const relations = await session.listRelations(DB_NAME, 'order_items');
      assert.ok(relations && relations.outbound && relations.outbound.length >= 2, 'Bảng order_items phải có 2 foreign keys');
      recordPass('Đọc khóa ngoại (listRelations order_items)', `Phát hiện ${relations.outbound.length} khóa ngoại liên kết tới orders và products.`);

      const routines = await session.listRoutines(DB_NAME);
      const routineNames = routines.map(r => r.name || r.ROUTINE_NAME);
      assert.ok(routineNames.includes('sp_get_customer_stats'), 'Stored Procedure sp_get_customer_stats phải tồn tại');
      recordPass('Đọc Stored Routines (listRoutines)', `Tìm thấy thủ tục: ${routineNames.join(', ')}.`);
    } catch (err) {
      recordFail('Khảo sát cấu trúc Schema', err);
    }

    // -------------------------------------------------------------
    // TEST 3: Full Schema Snapshot & Fingerprint Collector
    // -------------------------------------------------------------
    logSection('3. Thu thập Schema Snapshot & Dấu vân tay (Fingerprint)');
    try {
      const collector = new SchemaSnapshotCollector(session);
      const snapshot = await collector.collect(DB_NAME);

      assert.equal(snapshot.database, DB_NAME);
      assert.equal(snapshot.engine, 'MySQL');
      assert.ok(snapshot.tables && Object.keys(snapshot.tables).length >= 10);
      assert.ok(snapshot.views && Object.keys(snapshot.views).length >= 2);

      const fingerprint = computeSchemaFingerprint(snapshot);
      assert.ok(typeof fingerprint === 'string' && fingerprint.length === 64, 'Fingerprint phải là SHA-256 hash 64 ký tự');

      const projected = projectSnapshotForRenderer(snapshot);
      assert.ok(projected.tables.length > 0, 'Phải tạo được bản chiếu (projection) cho Renderer');

      recordPass('Schema Snapshot Collector', `Engine: ${snapshot.engine}, Fingerprint SHA-256: ${fingerprint.slice(0, 16)}...`);
    } catch (err) {
      recordFail('Schema Snapshot Collector', err);
    }

    // -------------------------------------------------------------
    // TEST 4: Table Data Service & Pagination
    // -------------------------------------------------------------
    logSection('4. Phân trang dữ liệu bảng (TableData Pagination & Sorting)');
    try {
      const countResult = await session.countTableRows({ database: DB_NAME, table: 'products' });
      assert.equal(countResult.total, 10, 'Số lượng sản phẩm ban đầu phải là 10');

      const page1 = await session.tableData({
        database: DB_NAME,
        table: 'products',
        page: 1,
        pageSize: 5,
        orderBy: 'price',
        orderDir: 'DESC'
      });

      assert.equal(page1.rows.length, 5, 'Trang 1 phải có đúng 5 dòng');
      assert.equal(page1.total, 10, 'Tổng số dòng báo cáo là 10');
      // Verify descending order
      const firstPrice = Number(page1.rows[0].price);
      const secondPrice = Number(page1.rows[1].price);
      assert.ok(firstPrice >= secondPrice, 'Dữ liệu phải được sắp xếp giá giảm dần');

      recordPass('TableData Pagination & Sorting', `Lấy 5/10 sản phẩm, cao nhất: ${page1.rows[0].name} (${Number(page1.rows[0].price).toLocaleString()} VND)`);
    } catch (err) {
      recordFail('TableData Pagination & Sorting', err);
    }

    // -------------------------------------------------------------
    // TEST 5: Data Mutation (Insert, Update, Delete)
    // -------------------------------------------------------------
    logSection('5. Thao tác ghi dữ liệu (Data CRUD Planning & Execution)');
    let insertedCategoryId = null;
    const testSlug = `smartwatch-test-${Date.now()}`;
    try {
      // Dọn dẹp bất kỳ test slug cũ nào
      await session.runQuery(`DELETE FROM categories WHERE slug LIKE 'smartwatch-test%'`);

      // 5.1 Plan & Insert Row
      const insertPlan = await session.planInsertRow({
        database: DB_NAME,
        table: 'categories',
        values: {
          name: 'Đồng hồ thông minh & Smartwatch',
          slug: testSlug,
          description: 'Danh mục thiết bị đeo thông minh kiểm thử',
          display_order: 10,
          is_active: 1
        }
      });
      assert.ok(insertPlan.sql, 'Phải sinh câu lệnh INSERT an toàn');

      const insertResult = await session.insertRow({
        database: DB_NAME,
        table: 'categories',
        values: {
          name: 'Đồng hồ thông minh & Smartwatch',
          slug: testSlug,
          description: 'Danh mục thiết bị đeo thông minh kiểm thử',
          display_order: 10,
          is_active: 1
        }
      });
      insertedCategoryId = Number(insertResult.insertId);
      assert.ok(insertedCategoryId > 0, 'Insert ID phải hợp lệ');
      recordPass('Thêm dòng mới (insertRow)', `Đã thêm category mới với ID: ${insertedCategoryId}`);

      // 5.2 Plan & Update Row
      const updatePlan = await session.planUpdateRow({
        database: DB_NAME,
        table: 'categories',
        keys: { id: insertedCategoryId },
        values: { description: 'Đã cập nhật mô tả mới thành công' }
      });
      assert.ok(updatePlan.sql, 'Phải sinh câu lệnh UPDATE với WHERE an toàn');

      await session.updateRow({
        database: DB_NAME,
        table: 'categories',
        keys: { id: insertedCategoryId },
        values: { description: 'Đã cập nhật mô tả mới thành công' }
      });

      // Verify update
      const verifyQuery = await session.runQuery(`SELECT description FROM categories WHERE id = ${insertedCategoryId}`);
      assert.equal(verifyQuery.rows[0][0], 'Đã cập nhật mô tả mới thành công');
      recordPass('Cập nhật dòng (updateRow)', `Cập nhật chính xác bản ghi ID: ${insertedCategoryId}`);

      // 5.3 Delete Row
      await session.deleteRows({
        database: DB_NAME,
        table: 'categories',
        keysList: [{ id: insertedCategoryId }]
      });

      const afterDelete = await session.runQuery(`SELECT COUNT(*) FROM categories WHERE id = ${insertedCategoryId}`);
      assert.equal(Number(afterDelete.rows[0][0]), 0);
      recordPass('Xóa dòng (deleteRows)', `Đã xóa an toàn bản ghi ID: ${insertedCategoryId}`);
    } catch (err) {
      recordFail('Thao tác ghi dữ liệu (CRUD)', err);
    }

    // -------------------------------------------------------------
    // TEST 6: Transaction & Rollback Safety
    // -------------------------------------------------------------
    logSection('6. Quản lý Giao dịch & An toàn Rollback');
    try {
      await session.runQuery('START TRANSACTION');
      assert.equal(session.inTransaction, true, 'Phiên phải ở trạng thái inTransaction');

      await session.runQuery(`INSERT INTO tags (name, color_code) VALUES ('Rollback-Tag', '#999999')`);
      const duringTx = await session.runQuery(`SELECT COUNT(*) FROM tags WHERE name = 'Rollback-Tag'`);
      assert.equal(Number(duringTx.rows[0][0]), 1, 'Trong transaction dữ liệu phải hiển thị');

      await session.runQuery('ROLLBACK');
      assert.equal(session.inTransaction, false, 'Sau ROLLBACK trạng thái inTransaction phải là false');

      const afterRollback = await session.runQuery(`SELECT COUNT(*) FROM tags WHERE name = 'Rollback-Tag'`);
      assert.equal(Number(afterRollback.rows[0][0]), 0, 'Dữ liệu không được phép tồn tại sau Rollback');
      recordPass('Transaction Rollback Safety', 'Khôi phục toàn vẹn dữ liệu thành công sau ROLLBACK.');
    } catch (err) {
      if (session.inTransaction) await session.runQuery('ROLLBACK');
      recordFail('Transaction Rollback Safety', err);
    }

    // -------------------------------------------------------------
    // TEST 7: Advanced Queries & EXPLAIN / Analyze
    // -------------------------------------------------------------
    logSection('7. Thực thi truy vấn phức tạp (JOIN, Aggregate, Routine)');
    try {
      const complexSql = `
        SELECT 
          c.name AS category_name,
          COUNT(p.id) AS total_items,
          COALESCE(MIN(p.price), 0) AS min_price,
          COALESCE(MAX(p.price), 0) AS max_price,
          COALESCE(AVG(p.price), 0) AS avg_price
        FROM categories c
        LEFT JOIN products p ON c.id = p.category_id
        GROUP BY c.id, c.name
        HAVING total_items > 0
        ORDER BY total_items DESC;
      `;
      const queryResult = await session.runQuery(complexSql);
      assert.equal(queryResult.kind, 'rows');
      assert.ok(queryResult.rows.length > 0, 'Truy vấn phải trả về kết quả');
      assert.equal(queryResult.columns.length, 5, 'Phải có 5 cột dữ liệu');
      recordPass('Truy vấn phức tạp (Aggregate + GROUP BY)', `Trả về ${queryResult.rows.length} nhóm danh mục.`);

      // Query View
      const viewResult = await session.runQuery('SELECT * FROM v_orders_summary');
      assert.equal(viewResult.kind, 'rows');
      assert.ok(viewResult.rows.length >= 5, 'View v_orders_summary phải trả về dữ liệu');
      recordPass('Truy vấn Database View (v_orders_summary)', `Đọc thành công ${viewResult.rows.length} đơn hàng qua VIEW.`);

      // Stored Procedure Call via raw
      const procRes = await session.raw('CALL sp_get_customer_stats(1)');
      const firstSet = procRes.rows[0];
      assert.ok(Array.isArray(firstSet) && firstSet.length > 0, 'Thủ tục phải trả về kết quả');
      assert.equal(firstSet[0].customer_code, 'CUST-2026-001');
      recordPass('Gọi Stored Procedure (sp_get_customer_stats)', `Thực thi thành công thủ tục cho khách hàng: ${firstSet[0].customer_code}, doanh thu: ${Number(firstSet[0].total_spent).toLocaleString()} VND.`);
    } catch (err) {
      recordFail('Thực thi truy vấn phức tạp', err);
    }

    // -------------------------------------------------------------
    // TEST 8: Export Table Data
    // -------------------------------------------------------------
    logSection('8. Xuất dữ liệu bảng (Table Data Export)');
    try {
      const chunks = [];
      await session.exportTableFile(
        { database: DB_NAME, table: 'products', format: 'json' },
        async (chunk) => {
          chunks.push(chunk);
        }
      );

      const jsonStr = chunks.join('');
      const parsed = JSON.parse(jsonStr);
      assert.ok(Array.isArray(parsed), 'File JSON xuất ra phải là danh sách');
      assert.equal(parsed.length, 10, 'Phải xuất đủ 10 dòng sản phẩm');
      assert.ok(parsed[0].sku && parsed[0].name && parsed[0].price);

      recordPass('Xuất bảng ra JSON (exportTableFile)', `Đã xuất đủ ${parsed.length} dòng dữ liệu sản phẩm, định dạng JSON hợp lệ.`);
    } catch (err) {
      recordFail('Xuất bảng ra JSON', err);
    }

    // -------------------------------------------------------------
    // TEST 9: Full Database Backup & Inventory Scan
    // -------------------------------------------------------------
    logSection('9. Sao lưu cơ sở dữ liệu & Quét kiểm kê (Backup & Inventory)');
    try {
      const backupPath = path.join(os.tmpdir(), `sqlpro_backup_${Date.now()}.sql`);
      const backupStats = await saveBackupFile(backupPath, write => session.backupDatabase({
        database: DB_NAME,
        includeStructure: true,
        includeData: true,
        dropTables: true
      }, write, () => {}));

      assert.ok(fs.existsSync(backupPath), 'File backup phải tồn tại');
      assert.ok(backupStats.bytes > 0, 'Kích thước file backup phải > 0');

      // Scan inventory of the created backup
      const invResult = await session.scanRestoreInventory({
        filePath: backupPath,
        database: DB_NAME,
        totalBytes: backupStats.bytes,
        dropExisting: false,
        readChunkBytes: 64 * 1024
      });

      assert.ok(invResult && invResult.inventory && invResult.inventory.tables, 'Inventory phải quét được danh sách bảng');
      assert.ok(invResult.inventory.tables.has('products'), 'Inventory phải tìm thấy bảng products');
      assert.ok(invResult.inventory.tables.has('orders'), 'Inventory phải tìm thấy bảng orders');

      try { fs.unlinkSync(backupPath); } catch {}
      try { fs.unlinkSync(`${backupPath}.json`); } catch {}

      recordPass('Tạo Backup & Quét kiểm kê (Backup & Scan)', `Ghi thành công ${(backupStats.bytes / 1024).toFixed(2)} KB, kiểm kê nhận diện đầy đủ ${invResult.inventory.tables.size} bảng dữ liệu.`);
    } catch (err) {
      recordFail('Sao lưu & Quét kiểm kê', err);
    }

    // -------------------------------------------------------------
    // TEST 10: SQL Autocomplete Context & Suggestions
    // -------------------------------------------------------------
    logSection('10. Kiểm tra bộ gợi ý thông minh SQL Autocomplete');
    try {
      // 10.1 Table reference extraction
      const sqlQuery = 'SELECT p.name, c.name FROM products p JOIN categories c ON p.category_id = c.id WHERE p.na';
      const refs = extractTableReferences(sqlQuery);
      assert.ok(Array.isArray(refs), 'refs phải là mảng');
      const pRef = refs.find(r => r.alias === 'p');
      assert.ok(pRef, 'Phải nhận diện alias "p"');
      assert.equal(pRef.table, 'products');

      // 10.2 Context extraction
      const caret = sqlQuery.length;
      const context = getContext(sqlQuery, caret);
      assert.equal(context.prefix, 'na');
      assert.equal(context.qualifier, 'p');

      // 10.3 Rank suggestions
      const mockProductColumns = [
        { label: 'id', insertText: 'id', type: 'column', detail: 'int' },
        { label: 'name', insertText: 'name', type: 'column', detail: 'varchar(200)' },
        { label: 'price', insertText: 'price', type: 'column', detail: 'decimal(12,2)' }
      ];
      const ranked = rankSuggestions(mockProductColumns, context.prefix);
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].label, 'name', 'Gợi ý khớp nhất với prefix "na" phải là "name"');

      recordPass('Gợi ý hoàn thiện SQL (sql-autocomplete)', `Trích xuất alias "p" -> bảng "products", tiền tố "na" -> gợi ý chính xác cột "${ranked[0].label}".`);
    } catch (err) {
      recordFail('Gợi ý hoàn thiện SQL', err);
    }

  } finally {
    await session.close();
  }

  // Summary
  console.log(`\n============================================================`);
  console.log(`📊 TỔNG KẾT KẾT QUẢ KIỂM THỬ TÍNH NĂNG VỚI "sqlpro_demo":`);
  console.log(`============================================================`);
  const total = results.length;
  const passed = results.filter(r => r.status === 'PASSED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;
  console.log(`Tổng số bài test: ${total}`);
  console.log(`Thành công (PASS): ${passed}`);
  console.log(`Thất bại   (FAIL): ${failed}`);

  if (failed === 0) {
    console.log(`\n🎉 HOÀN TẤT: 100% TÍNH NĂNG CHỦ CHỐT CỦA SQLPRO ĐÃ ĐƯỢC KIỂM THỬ THÀNH CÔNG!`);
  }
}

runAllTests().catch(err => {
  console.error('Lỗi nghiêm trọng trong quá trình kiểm thử:', err);
  process.exit(1);
});
