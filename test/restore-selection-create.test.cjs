'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewBasicCreate } = require('../electron/restore-selection-create.cjs');
const { RestoreSelectionInventory } = require('../electron/restore-selection.cjs');
const { assertStatementScope } = require('../electron/sql-script.cjs');
const create = definition => `CREATE TABLE \`items\` (${definition}) ENGINE=InnoDB`;

test('CREATE review matches exact quoted names, columns and basic indexes without retaining literals', () => {
  const sql = "CREATE TABLE `demo`.` a.``b ` (`id` bigint unsigned NOT NULL AUTO_INCREMENT, `text` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'private ''value''', PRIMARY KEY (`id`), UNIQUE KEY `text_idx` (`text`(10))) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='private-table-comment'";
  assert.deepEqual(reviewBasicCreate(sql), { version: 3, status: 'matched', code: 'BASIC_CREATE_MATCHED', table: ' a.`b ', schema: 'demo', columns: 2, indexes: 2, engine: 'InnoDB', foreignKeys: [], indexDefinitions: [
    { name: 'PRIMARY', kind: 'primary', columns: [{ name: 'id', prefixLength: null }] },
    { name: 'text_idx', kind: 'unique', columns: [{ name: 'text', prefixLength: 10 }] }
  ] });
  const serialized = JSON.stringify(reviewBasicCreate(sql));
  for (const secret of ['private', '9007199254740993', 'utf8mb4_bin']) assert.equal(serialized.includes(secret), false);
});

test('supported primitive types and literal defaults keep a bounded syntax-only report', () => {
  for (const definition of ['`id` int', '`id` tinyint(1) unsigned NOT NULL', '`id` decimal(65,30) DEFAULT -123.456', '`id` numeric(20) NULL',
    '`id` float DEFAULT +1e-10', '`id` double', '`id` bit(64)', '`id` date', '`id` datetime(6)', '`id` timestamp(0) DEFAULT NULL',
    '`id` time(3)', '`id` year', '`id` char(1)', '`id` varchar(80) DEFAULT TRUE', '`id` binary(16)', '`id` varbinary(16)',
    '`id` tinyblob', '`id` blob', '`id` mediumblob', '`id` longblob', '`id` tinytext', '`id` text', '`id` mediumtext', '`id` longtext',
    '`id` json DEFAULT NULL', '`id` bool', '`id` boolean', "`id` varchar(60) DEFAULT 'Việt -- /* text */; ) (' COMMENT 'hidden'",
    '`id` int, KEY `ix` (`id` ASC)', '`id` int, UNIQUE INDEX `ix` (`id`)']) {
    assert.equal(reviewBasicCreate(create(definition)).status, 'matched', definition);
  }
  assert.equal(reviewBasicCreate(`${create('`id` int')} ROW_FORMAT=DYNAMIC;`).status, 'matched');
  assert.equal(reviewBasicCreate('CREATE TABLE `bảng` (`select` int) ENGINE InnoDB DEFAULT CHARACTER SET utf8mb4').status, 'matched');
});

test('unsupported types, expressions and additional column attributes never match', () => {
  for (const definition of ["`id` enum('one','two')", "`id` set('one')", '`id` geometry', '`id` int ZEROFILL', '`id` int INVISIBLE',
    '`id` int GENERATED ALWAYS AS (1) STORED', '`id` timestamp DEFAULT CURRENT_TIMESTAMP', '`id` datetime ON UPDATE CURRENT_TIMESTAMP',
    '`id` int DEFAULT (1)', '`id` int DEFAULT udf()', '`id` int DEFAULT @variable', '`id` int DEFAULT 1+2',
    '`id` int CHECK (id>0)', '`id` int PRIMARY KEY',
    '`id` int, FULLTEXT KEY `ix` (`id`)', '`id` int, KEY `ix` ((`id`+1))', '`id` int, KEY `ix` (`id` DESC)', '`id` int, KEY `ix` (`id`) USING HASH']) {
    assert.equal(reviewBasicCreate(create(definition)).status, 'unsupported', definition);
  }
});

test('CREATE review requires explicit InnoDB and rejects unknown, duplicate or misused options', () => {
  for (const suffix of ['', 'ENGINE=MyISAM', 'ENGINE=MEMORY', 'ENGINE=unknown', 'ENGINE=InnoDB ENGINE=InnoDB', 'DEFAULT ENGINE=InnoDB',
    'ENGINE=InnoDB TABLESPACE `space`', "ENGINE=InnoDB DATA DIRECTORY='/private'", 'ENGINE=InnoDB PARTITION BY HASH(id)',
    'ENGINE=InnoDB DEFAULT ROW_FORMAT=DYNAMIC', 'ENGINE=InnoDB CHARSET=utf8mb4 CHARACTER SET utf8mb4', 'ENGINE=InnoDB COMMENT=udf()', 'ENGINE=InnoDB AUTO_INCREMENT=1+1']) {
    assert.equal(reviewBasicCreate(`CREATE TABLE \`items\` (\`id\` int) ${suffix}`).status, 'unsupported', suffix);
  }
});

test('CREATE recognizes exact FK column pairs, qualified parents and bounded referential actions', () => {
  const sql = create('`id` int, `pid` int, CONSTRAINT `fk.``name` FOREIGN KEY `local_idx` (`id`,`pid`) REFERENCES `demo`.`p.``arent` (`a`,`b`) ON UPDATE CASCADE ON DELETE SET NULL');
  const result = reviewBasicCreate(sql);
  assert.equal(result.status, 'matched'); assert.deepEqual(result.foreignKeys, [{ name: 'fk.`name', columns: ['id', 'pid'],
    referencedSchema: 'demo', referencedTable: 'p.`arent', referencedColumns: ['a', 'b'], onDelete: 'SET NULL', onUpdate: 'CASCADE' }]);
  for (const action of ['RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL']) {
    const reviewed = reviewBasicCreate(create(`\`id\` int, FOREIGN KEY (\`id\`) REFERENCES \`parent\` (\`id\`) ON DELETE ${action}`));
    assert.equal(reviewed.status, 'matched'); assert.equal(reviewed.foreignKeys[0].onDelete, action); assert.equal(reviewed.foreignKeys[0].onUpdate, null);
  }
});

test('FK rejects missing/duplicate columns, arity, prefix/expression, MATCH, deferrable and unknown actions', () => {
  const clauses = ['FOREIGN KEY (`missing`) REFERENCES `parent` (`id`)', 'FOREIGN KEY (`id`,`id`) REFERENCES `parent` (`a`,`b`)',
    'FOREIGN KEY (`id`) REFERENCES `parent` (`a`,`b`)', 'FOREIGN KEY (`id`) REFERENCES `parent` (`id`,`id`)',
    'FOREIGN KEY (`id`(4)) REFERENCES `parent` (`id`)', 'FOREIGN KEY ((`id`+1)) REFERENCES `parent` (`id`)',
    'FOREIGN KEY (`id`) REFERENCES `parent` (`id`) MATCH FULL', 'FOREIGN KEY (`id`) REFERENCES `parent` (`id`) DEFERRABLE',
    'FOREIGN KEY (`id`) REFERENCES `parent` (`id`) ON DELETE SET DEFAULT', 'FOREIGN KEY (`id`) REFERENCES `parent` (`id`) ON DELETE udf()',
    'FOREIGN KEY (`id`) REFERENCES `parent` (`id`) ON DELETE CASCADE ON DELETE RESTRICT', 'CONSTRAINT `not_fk` CHECK (`id`>0)',
    'FOREIGN KEY () REFERENCES `parent` (`id`)', 'FOREIGN KEY (`id`) REFERENCES parent (`id`)',
    'CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `parent` (`id`), CONSTRAINT `FK` FOREIGN KEY (`id`) REFERENCES `parent` (`id`)'];
  for (const clause of clauses) assert.equal(reviewBasicCreate(create(`\`id\` int, ${clause}`)).status, 'unsupported', clause);
  const many = Array.from({ length: 65 }, (_, i) => `CONSTRAINT \`fk${i}\` FOREIGN KEY (\`id\`) REFERENCES \`parent\` (\`id\`)`).join(',');
  assert.equal(reviewBasicCreate(create(`\`id\` int, ${many}`)).code, 'CREATE_FOREIGN_KEY_LIMIT');
  const wide = Array.from({ length: 17 }, (_, i) => `\`c${i}\``).join(',');
  const columns = Array.from({ length: 17 }, (_, i) => `\`c${i}\` int`).join(',');
  assert.equal(reviewBasicCreate(create(`${columns}, FOREIGN KEY (${wide}) REFERENCES \`parent\` (${wide})`)).code, 'CREATE_FOREIGN_KEY_COLUMNS_INVALID');
});

test('whole-statement grammar rejects appended SQL, conditional/temporary/create-select/like and bare names', () => {
  for (const sql of [create('`id` int') + '; DROP TABLE `other`', create('`id` int') + ' SELECT 1', create('`id` int') + ';;',
    'CREATE TABLE IF NOT EXISTS `items` (`id` int) ENGINE=InnoDB', 'CREATE TEMPORARY TABLE `items` (`id` int) ENGINE=InnoDB',
    'CREATE TABLE `items` LIKE `other`', 'CREATE TABLE `items` AS SELECT 1', 'CREATE VIEW `items` AS SELECT 1',
    'CREATE TABLE items (`id` int) ENGINE=InnoDB', 'CREATE TABLE `items` (id int) ENGINE=InnoDB',
    'CREATE TABLE `db`.`items`.`more` (`id` int) ENGINE=InnoDB', 'CREATE TABLE `items` () ENGINE=InnoDB']) {
    assert.equal(reviewBasicCreate(sql).status, 'unsupported', sql);
  }
});

test('ambiguous quote modes, escapes, executable/ordinary comments and malformed tokens stay unsupported', () => {
  for (const sql of [create('`id` int') + ' /* comment */', '/*!80000 ' + create('`id` int') + ' */',
    create('`id` int') + '/*M! DROP TABLE `other` */', create('`id` int') + '-- comment', create('`id` int') + '# comment',
    create('`id` varchar(60) DEFAULT "text"'), create("`id` varchar(60) DEFAULT 'back\\slash'"),
    'CREATE TABLE "items" ("id" int) ENGINE=InnoDB',
    create("`id` varchar(60) DEFAULT 'unterminated"), create('`unclosed int'), create('`id` int\0'),
    create('`id` varchar(60) DEFAULT 1.2.3'), create('`id` int DEFAULT 1e'), create('`id` int DEFAULT 0x1'),
    create('`id` int DEFAULT NULL NULL'), create('`id` int, /* comment */ `next` int'), 'CREATE\u00a0TABLE `items` (`id` int) ENGINE=InnoDB']) {
    assert.equal(reviewBasicCreate(sql).status, 'unsupported', sql);
  }
});

test('duplicate columns/indexes, absent key columns and malformed index lists are rejected', () => {
  for (const definition of ['`id` int, `ID` int', '`id` int, PRIMARY KEY (`id`), PRIMARY KEY (`id`)', '`id` int, KEY `ix` (`missing`)',
    '`id` int, KEY `ix` (`id`), KEY `IX` (`id`)', '`id` int, KEY `PRIMARY` (`id`)', '`id` int, KEY `ix` (`id`,`id`)',
    '`id` int, KEY `ix` ()', '`id` int, KEY `ix` (`id`,)', '`id` int,', '`id` int, KEY `ix` (`id`), `after` int']) {
    assert.equal(reviewBasicCreate(create(definition)).status, 'unsupported', definition);
  }
});

test('type arguments and quotas are checked without converting large literals or exposing them', () => {
  for (const definition of ['`id` int(0)', '`id` int(999)', '`id` decimal(66,2)', '`id` decimal(5,6)', '`id` decimal(65,31)',
    '`id` varchar(0)', '`id` binary(256)', '`id` datetime(7)', '`id` bit(65)', '`id` int(1e2)', '`id` int, KEY `ix` (`id`(0))',
    Array.from({ length: 257 }, (_, i) => `\`c${i}\` int`).join(','), '`id` int,' + Array.from({ length: 129 }, (_, i) => `KEY \`i${i}\` (\`id\`)`).join(',')]) {
    assert.equal(reviewBasicCreate(create(definition)).status, 'unsupported', definition.slice(0, 100));
  }
  for (const sql of [null, `CREATE TABLE \`${'n'.repeat(65)}\` (\`id\` int) ENGINE=InnoDB`, create("`id` text COMMENT '" + 'ự'.repeat(800000) + "'")]) {
    const review = reviewBasicCreate(sql);
    assert.equal(review.status, 'unsupported'); assert.ok(JSON.stringify(review).length < 150);
  }
});

test('collector uses original CREATE SQL, preserves exact target and shares a syntax byte budget with INSERT', () => {
  const collector = new RestoreSelectionInventory('demo');
  const sql = create("`id` int DEFAULT 123456789, `name` varchar(40) DEFAULT 'secret-default'");
  collector.add(sql, assertStatementScope(sql, 'demo'), 1);
  const first = collector.finish().statementLedger.entries[0];
  assert.equal(first.syntaxReview.status, 'matched'); assert.equal(first.syntaxReview.table, first.table);
  assert.equal(JSON.stringify(first).includes('secret-default'), false); assert.equal(JSON.stringify(first).includes('123456789'), false);
  collector.syntaxValidationBytes = 32 * 1024 * 1024;
  collector.add(sql, assertStatementScope(sql, 'demo'), 2);
  collector.add('INSERT INTO items VALUES(1)', assertStatementScope('INSERT INTO items VALUES(1)', 'demo'), 3);
  assert.equal(collector.finish().statementLedger.entries[1].syntaxReview.code, 'CREATE_VALIDATION_LIMIT');
  assert.equal(collector.finish().statementLedger.entries[2].syntaxReview.code, 'INSERT_VALIDATION_LIMIT');
});

test('collector refuses FK evidence beyond per-file definition or column-pair quotas', () => {
  const sql = create('`id` int, FOREIGN KEY (`id`) REFERENCES `parent` (`id`)');
  for (const field of ['foreignKeyEvidenceCount', 'foreignKeyEvidencePairs']) {
    const collector = new RestoreSelectionInventory('demo');
    collector[field] = field === 'foreignKeyEvidenceCount' ? 2000 : 10000;
    collector.add(sql, assertStatementScope(sql, 'demo'), 1);
    const review = collector.finish().statementLedger.entries[0].syntaxReview;
    assert.equal(review.status, 'unsupported'); assert.equal(review.code, 'CREATE_FOREIGN_KEY_EVIDENCE_LIMIT');
    assert.equal(review.foreignKeys, undefined);
  }
});


test('collector bounds total retained index definitions and parts without retaining partial evidence', () => {
  const sql = create('`id` int, PRIMARY KEY (`id`)');
  for (const property of ['indexEvidenceCount', 'indexEvidenceParts']) {
    const collector = new RestoreSelectionInventory('demo');
    collector[property] = property === 'indexEvidenceCount' ? 5000 : 20000;
    collector.add(sql, assertStatementScope(sql, 'demo'), 1);
    const review = collector.finish().statementLedger.entries[0].syntaxReview;
    assert.deepEqual(review, { version: 3, status: 'unsupported', code: 'CREATE_INDEX_EVIDENCE_LIMIT' });
    assert.equal(collector.foreignKeyEvidenceCount, 0);
  }
});
