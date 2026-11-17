'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DataMasking = require('../data-masking.js');

test('maskEmail preserves domain and obfuscates local part', () => {
  assert.equal(DataMasking.maskEmail('john.doe@example.com'), 'j***e@example.com');
  assert.equal(DataMasking.maskEmail('alex@company.vn'), 'a***x@company.vn');
  assert.equal(DataMasking.maskEmail('ab@domain.org'), '*@domain.org');
  assert.equal(DataMasking.maskEmail('a@b.com'), '*@b.com');
  assert.equal(DataMasking.maskEmail('invalid-email'), '***');
  assert.equal(DataMasking.maskEmail(''), '');
  assert.equal(DataMasking.maskEmail(null), null);
});

test('maskPhone preserves prefix and suffix while masking middle digits', () => {
  assert.equal(DataMasking.maskPhone('0912345678'), '091****678');
  assert.equal(DataMasking.maskPhone('+84 90 123 4567'), '+84 9* *** *567');
  assert.equal(DataMasking.maskPhone('12345'), '*****'); // short phone
  assert.equal(DataMasking.maskPhone(null), null);
});

test('maskCardNumber preserves only the last 4 digits', () => {
  assert.equal(DataMasking.maskCardNumber('4111 2222 3333 4444'), '**** **** **** 4444');
  assert.equal(DataMasking.maskCardNumber('4111222233334444'), '************4444');
  assert.equal(DataMasking.maskCardNumber('123456789012'), '********9012');
  assert.equal(DataMasking.maskCardNumber(null), null);
});

test('maskSecret masks passwords and tokens with asterisks', () => {
  assert.equal(DataMasking.maskSecret('my_super_secret_password_123'), '********');
  assert.equal(DataMasking.maskSecret('sk_live_1234567890abcdef'), '********');
  assert.equal(DataMasking.maskSecret(null), null);
});

test('maskIdNumber masks citizen ID / Passport numbers', () => {
  assert.equal(DataMasking.maskIdNumber('001099123456'), '001*******56');
  assert.equal(DataMasking.maskIdNumber('B1234567'), 'B12****67');
  assert.equal(DataMasking.maskIdNumber('1234'), '******');
  assert.equal(DataMasking.maskIdNumber(null), null);
});

test('detectMaskType recognizes common sensitive column names in English and Vietnamese', () => {
  assert.equal(DataMasking.detectMaskType('email'), 'email');
  assert.equal(DataMasking.detectMaskType('customer_email'), 'email');
  assert.equal(DataMasking.detectMaskType('thu_dien_tu'), 'email');

  assert.equal(DataMasking.detectMaskType('phone'), 'phone');
  assert.equal(DataMasking.detectMaskType('telephone_number'), 'phone');
  assert.equal(DataMasking.detectMaskType('so_dien_thoai'), 'phone');
  assert.equal(DataMasking.detectMaskType('sdt'), 'phone');

  assert.equal(DataMasking.detectMaskType('credit_card'), 'card');
  assert.equal(DataMasking.detectMaskType('card_number'), 'card');
  assert.equal(DataMasking.detectMaskType('so_the'), 'card');

  assert.equal(DataMasking.detectMaskType('password'), 'secret');
  assert.equal(DataMasking.detectMaskType('auth_token'), 'secret');
  assert.equal(DataMasking.detectMaskType('mat_khau'), 'secret');

  assert.equal(DataMasking.detectMaskType('citizen_id'), 'id_card');
  assert.equal(DataMasking.detectMaskType('so_dinh_danh'), 'id_card');
  assert.equal(DataMasking.detectMaskType('cccd'), 'id_card');

  assert.equal(DataMasking.detectMaskType('created_at'), null);
  assert.equal(DataMasking.detectMaskType('username'), null);
  assert.equal(DataMasking.detectMaskType('order_total'), null);
});

test('createMaskingConfig creates rule mapping and accepts manual overrides', () => {
  const columns = [
    { name: 'id', type: 'INT' },
    { name: 'user_email', type: 'VARCHAR(255)' },
    { name: 'phone_number', type: 'VARCHAR(50)' },
    { name: 'notes', type: 'TEXT' }
  ];

  const config = DataMasking.createMaskingConfig(columns, {
    notes: 'secret' // manual override
  });

  assert.equal(config.get('user_email'), 'email');
  assert.equal(config.get('phone_number'), 'phone');
  assert.equal(config.get('notes'), 'secret');
  assert.equal(config.has('id'), false);
});

test('maskRow and maskRows immutably mask array and object rows', () => {
  const columns = [
    { name: 'id' },
    { name: 'name' },
    { name: 'email' },
    { name: 'phone' }
  ];

  const config = DataMasking.createMaskingConfig(columns);

  const arrayRow = [1, 'Alice', 'alice@test.org', '0912345678'];
  const maskedArray = DataMasking.maskRow(arrayRow, columns, config);

  assert.equal(maskedArray[0], 1);
  assert.equal(maskedArray[1], 'Alice');
  assert.equal(maskedArray[2], 'a***e@test.org');
  assert.equal(maskedArray[3], '091****678');
  assert.notEqual(maskedArray, arrayRow, 'Must return a new array instance');

  // Original array row remains untouched
  assert.equal(arrayRow[2], 'alice@test.org');

  // Object row test
  const objRow = { id: 2, name: 'Bob', email: 'bob@corp.vn', phone: '0987654321' };
  const maskedObj = DataMasking.maskRow(objRow, columns, config);

  assert.equal(maskedObj.id, 2);
  assert.equal(maskedObj.email, 'b***b@corp.vn');
  assert.equal(maskedObj.phone, '098****321');
  assert.notEqual(maskedObj, objRow, 'Must return a new object instance');

  // Batch rows test
  const rows = [arrayRow, [2, 'Charlie', 'charlie@test.org', '0901112222']];
  const maskedRows = DataMasking.maskRows(rows, columns, config);
  assert.equal(maskedRows.length, 2);
  assert.equal(maskedRows[0][2], 'a***e@test.org');
  assert.equal(maskedRows[1][2], 'c***e@test.org');
});
