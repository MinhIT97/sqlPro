'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertStatementScope,
  targetReferences,
  countInsertRows,
  scrubSql,
  skipReason
} = require('../electron/sql-script.cjs');

const rejected = (sql, schema = 'other', table = null) => {
  assert.throws(
    () => assertStatementScope(sql, 'target', 7),
    (error) => {
      assert.equal(error.code, 'RESTORE_SCOPE_REJECTED', sql);
      assert.equal(error.schema, schema, sql);
      if (table) assert.equal(error.table, table, sql);
      assert.equal(error.statementNumber, 7);
      return true;
    }
  );
};

const allowed = (sql) => {
  assert.doesNotThrow(() => assertStatementScope(sql, 'target', 1), sql);
};

test('restore scope chặn mọi câu ghi vào schema khác', () => {
  rejected('INSERT INTO other.items (id) VALUES (1)', 'other', 'items');
  rejected('INSERT INTO `other`.`items` SET id=1', 'other', 'items');
  rejected('REPLACE INTO other.items VALUES (1)');
  rejected('UPDATE other.items SET id=1');
  rejected('UPDATE target.items JOIN other.audit ON 1=1 SET target.items.id=1');
  rejected('DELETE FROM other.items WHERE id=1');
  rejected('TRUNCATE TABLE other.items');
  rejected('DROP TABLE target.items, other.items');
  rejected('CREATE TABLE other.items (id int)');
  rejected('ALTER TABLE other.items ADD COLUMN name text');
  rejected('ALTER DATABASE other DEFAULT CHARACTER SET latin1');
  rejected('ALTER SCHEMA `other` DEFAULT COLLATE latin1_bin');
  rejected('RENAME TABLE items TO other.items', 'other', 'items');
  rejected('RENAME TABLE other.items TO items', 'other', 'items');
  rejected('CREATE INDEX idx ON other.items (id)', 'other', 'items');
  rejected('DROP INDEX idx ON other.items', 'other', 'items');
  rejected('LOAD DATA INFILE "/tmp/a.csv" INTO TABLE other.items');
  rejected('LOCK TABLES other.items WRITE');
  rejected('ANALYZE TABLE other.items');
  rejected('CREATE TRIGGER tr BEFORE INSERT ON other.items FOR EACH ROW SET @x=1', 'other', 'items');
  rejected('CREATE PROCEDURE p() BEGIN UPDATE other.items SET id=1; END', 'other', 'items');
  rejected('CREATE FUNCTION f() RETURNS int BEGIN DELETE FROM other.items; RETURN 1; END', 'other', 'items');
  rejected('CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO INSERT INTO other.items VALUES (1)', 'other', 'items');
  rejected('/*!50000 UPDATE other.items SET id=1 */', 'other', 'items');
  rejected('/*!40000 INSERT INTO other.items VALUES (1) */', 'other', 'items');
});

test('restore scope từ chối câu lệnh có thể ghi ngoài phạm vi hoặc chưa phân tích', () => {
  for (const sql of [
    'CALL p()',
    'PREPARE s FROM @sql',
    'EXECUTE s',
    'PREPARE',
    'DEALLOCATE PREPARE s',
    'DO SLEEP(1)',
    'GRANT ALL ON *.* TO u',
    'REVOKE ALL ON *.* FROM u',
    'HANDLER t OPEN',
    'CREATE USER u',
    'DROP USER u',
    'ALTER USER u',
    'ALTER INSTANCE ROTATE INNODB MASTER KEY',
    'SET GLOBAL max_connections=25',
    'SET @@GLOBAL.foreign_key_checks=0',
    'SET PERSIST sql_mode=""',
    'SET SESSION sql_mode="", GLOBAL max_connections=25',
    'SET @fixture=1, @@GLOBAL.max_connections=25',
    'SET SESSION sql_log_bin=0',
    'FLUSH TABLES WITH READ LOCK',
    'FLUSH PRIVILEGES',
    'START REPLICA',
    'XA COMMIT "fixture"',
    'DROP ROLE r',
    'CREATE SERVER s FOREIGN DATA WRAPPER x',
    'DROP TABLESPACE ts',
    'SELECT * FROM items INTO OUTFILE "/tmp/out"',
    'SELECT * FROM items INTO DUMPFILE "/tmp/out"'
  ]) {
    assert.throws(
      () => assertStatementScope(sql, 'target', 2),
      { code: 'RESTORE_SCOPE_REJECTED' },
      sql
    );
  }
});

test('restore scope cho phép câu ghi trong database đích và đọc chéo schema', () => {
  allowed('INSERT INTO target.items (id) VALUES (1)');
  allowed('INSERT INTO `target`.`items` VALUES (1)');
  allowed('INSERT INTO items VALUES (1)');
  allowed('UPDATE items i SET i.name = ? WHERE i.id = ?');
  allowed('UPDATE target.items i JOIN target.audit a ON a.id = i.id SET i.name = "x"');
  allowed('DELETE i FROM target.items i JOIN target.audit a ON a.id = i.id');
  allowed('RENAME TABLE target.items TO target.items_old');
  allowed('CREATE TABLE target.items (id int)');
  allowed('CREATE INDEX idx ON target.items (id)');
  allowed('ALTER TABLE target.items ADD COLUMN name text');
  allowed('CREATE TRIGGER tr BEFORE INSERT ON target.items FOR EACH ROW SET @x=1');
  allowed('CREATE PROCEDURE p() BEGIN UPDATE items i SET i.total = 1 WHERE i.id = 1; END');
  allowed('CREATE PROCEDURE p() BEGIN UPDATE target.items SET id=1; END');
  allowed('INSERT INTO target.items SELECT * FROM other.items');
  allowed('SELECT * FROM other.items');
  allowed('SELECT x.id FROM target.items x JOIN other.audit y ON y.id = x.id');
  allowed('SET FOREIGN_KEY_CHECKS=0');
  allowed('ALTER DATABASE target DEFAULT CHARACTER SET utf8mb4');
  allowed('ALTER SCHEMA `target` DEFAULT COLLATE utf8mb4_bin');
  allowed('SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE="NO_AUTO_VALUE_ON_ZERO"');
  allowed('SET SESSION sql_mode=CONCAT(@@SESSION.sql_mode, ",STRICT_ALL_TABLES"), UNIQUE_CHECKS=0');
  allowed('SET @@SESSION.foreign_key_checks=0, @@LOCAL.unique_checks=0');
  allowed('SET NAMES utf8mb4 COLLATE utf8mb4_bin');
  allowed('SET CHARACTER SET utf8mb4');
  allowed('LOCK TABLES target.items WRITE');
  allowed('ANALYZE TABLE target.items');
  allowed('/*!40101 SET NAMES utf8mb4 */');
  assert.equal(skipReason('USE other'), 'USE');
});

test('restore scope uses exact schema spelling and ignores comments and strings', () => {
  rejected('INSERT INTO `TARGET`.`items` (note) VALUES ("x, y)")', 'TARGET');
  allowed('INSERT INTO `target`.`items` (note) VALUES ("x, y)")');
  allowed('-- comment with other.items\nUPDATE items SET id=1');
  allowed('/* comment other.items */ DELETE FROM items');
  allowed('INSERT INTO target.items (note) VALUES ("UPDATE other.items")');
});

test('targetReferences trả command và target dù có executable comment của mysqldump', () => {
  const result = targetReferences('/*!40000 ALTER TABLE `target`.`items` DISABLE KEYS */');
  assert.equal(result.command, 'ALTER');
  assert.deepEqual(result.refs, [{ schema: 'target', table: 'items' }]);
  assert.equal(scrubSql("INSERT INTO t VALUES ('a(b)')").includes("'"), false);
});

test('countInsertRows đếm tuple VALUES, SET và đánh dấu INSERT SELECT không chắc chắn', () => {
  assert.deepEqual(countInsertRows('INSERT INTO t (a) VALUES (1), (2), (3)'), { rows: 3, reliable: true });
  assert.deepEqual(countInsertRows("INSERT INTO t (a) VALUES ('x),(y'), ('z'), (3)"), { rows: 3, reliable: true });
  assert.deepEqual(countInsertRows('INSERT INTO t SET a=1'), { rows: 1, reliable: true });
  assert.deepEqual(countInsertRows('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a=VALUES(a)'), { rows: 1, reliable: true });
  assert.deepEqual(countInsertRows('INSERT INTO t (a) SELECT a FROM source'), { rows: null, reliable: false });
  assert.deepEqual(countInsertRows('REPLACE INTO t VALUES (1), (2)'), { rows: 2, reliable: true });
  assert.deepEqual(countInsertRows('INSERT INTO t () VALUES ()'), { rows: 1, reliable: true });
  assert.deepEqual(countInsertRows("INSERT INTO t (a) VALUES ('x),(y'), ('z')", 'INSERT INTO t (a) VALUES (?), (?)'), { rows: 2, reliable: true });
});
