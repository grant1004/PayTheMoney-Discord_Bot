// test/database.test.js
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('discord.js');

// Mock Discord.js
jest.mock('discord.js');

// 建立測試用的資料庫連接
const db = new sqlite3.Database(':memory:'); // 使用記憶體資料庫進行測試

describe('Database Operations', () => {
  beforeAll((done) => {
    // 在測試開始前建立資料表
    db.run(`CREATE TABLE IF NOT EXISTS debts (
      id TEXT PRIMARY KEY,
      debtor_id TEXT NOT NULL,
      debtor_name TEXT NOT NULL,
      creditor_id TEXT NOT NULL,
      creditor_name TEXT NOT NULL,
      amount REAL NOT NULL,
      purpose TEXT NOT NULL,
      date TEXT NOT NULL,
      confirmed BOOLEAN DEFAULT FALSE
    )`, done);
  });

  beforeEach((done) => {
    // 在每個測試前插入測試資料
    db.run(`INSERT INTO debts (id, debtor_id, debtor_name, creditor_id, creditor_name, amount, purpose, date, confirmed) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test123',
       'user1',
       'testUser1',
       'user2',
       'testUser2',
       100,
       '測試用途',
       '2024-01-27',
       false
      ], done);
  });

  afterEach((done) => {
    // 在每個測試後清空資料表
    db.run('DELETE FROM debts', done);
  });

  afterAll((done) => {
    // 測試結束後關閉資料庫連接
    db.close(done);
  });

  test('should find debt record by debtor name', (done) => {
    db.all(
      `SELECT * FROM debts WHERE debtor_name = ?`,
      ['testUser1'],
      (err, rows) => {
        expect(err).toBeNull();
        expect(rows.length).toBe(1);
        expect(rows[0].debtor_name).toBe('testUser1');
        expect(rows[0].amount).toBe(100);
        done();
      }
    );
  });

  test('should find debt record by creditor name', (done) => {
    db.all(
      `SELECT * FROM debts WHERE creditor_name = ?`,
      ['testUser2'],
      (err, rows) => {
        expect(err).toBeNull();
        expect(rows.length).toBe(1);
        expect(rows[0].creditor_name).toBe('testUser2');
        expect(rows[0].amount).toBe(100);
        done();
      }
    );
  });

  test('should find no records for non-existent user', (done) => {
    db.all(
      `SELECT * FROM debts WHERE debtor_name = ? OR creditor_name = ?`,
      ['nonexistentUser', 'nonexistentUser'],
      (err, rows) => {
        expect(err).toBeNull();
        expect(rows.length).toBe(0);
        done();
      }
    );
  });

  test('should find records by both debtor and creditor name', (done) => {
    db.all(
      `SELECT * FROM debts WHERE debtor_name = ? OR creditor_name = ?`,
      ['testUser1', 'testUser1'],
      (err, rows) => {
        expect(err).toBeNull();
        expect(rows.length).toBe(1);
        expect(rows[0].debtor_name).toBe('testUser1');
        done();
      }
    );
  });
});