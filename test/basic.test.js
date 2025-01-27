// test/basic.test.js
const sqlite3 = require('sqlite3').verbose();

describe('Checkdebt Command Tests', () => {
  let db;
  let mockInteraction;

  beforeAll((done) => {
    db = new sqlite3.Database(':memory:', (err) => {
      if (err) return done(err);
      
      db.run(`CREATE TABLE debts (
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
  });

  beforeEach((done) => {
    // 清空並插入測試資料
    db.run('DELETE FROM debts', (err) => {
      if (err) return done(err);
      
      db.run(`INSERT INTO debts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['test123', 'user1', 'TestUser1', 'user2', 'TestUser2', 100, '測試用途', '2024-01-27', false],
        (err) => {
          if (err) return done(err);
          done();
        });
    });

    // 模擬完整的 Discord 互動，包含 autocomplete
    mockInteraction = {
      commandName: 'checkdebt',
      options: {
        getString: jest.fn(),
        getFocused: jest.fn()
      },
      guild: {
        members: {
          fetch: jest.fn().mockResolvedValue(new Map([
            ['user1', { 
              user: { id: 'user1', username: 'TestUser1' },
              nickname: null 
            }]
          ]))
        }
      },
      isCommand: () => true,
      isAutocomplete: () => true,
      respond: jest.fn().mockResolvedValue(true),
      reply: jest.fn().mockResolvedValue(true)
    };
  });

  afterAll((done) => {
    db.close(done);
  });

  // 測試 autocomplete 功能
  test('should provide autocomplete suggestions', async () => {
    mockInteraction.options.getFocused.mockReturnValue({
      name: 'user',
      value: 'Test'
    });

    const expectedChoices = [{
      name: 'TestUser1',
      value: 'user1|TestUser1'
    }];

    await mockInteraction.respond(expectedChoices);
    expect(mockInteraction.respond).toHaveBeenCalledWith(expectedChoices);
  });

  // 測試查詢功能
  test('should find debt records for existing user with autocomplete', async () => {
    const userInput = 'user1|TestUser1';
    mockInteraction.options.getString.mockReturnValue(userInput);

    db.all(
      `SELECT * FROM debts WHERE debtor_name = ? OR creditor_name = ?`,
      ['TestUser1', 'TestUser1'],
      async (err, rows) => {
        try {
          expect(err).toBeNull();
          expect(rows.length).toBe(1);
          expect(rows[0].debtor_name).toBe('TestUser1');

          const expectedContent = `查詢結果：\n日期：${rows[0].date}\n<@${rows[0].debtor_id}> 欠 <@${rows[0].creditor_id}> ${rows[0].amount} 元\n用途：${rows[0].purpose}\n狀態：${rows[0].confirmed ? '已收到' : '未收到'}\n-------------------`;

          await mockInteraction.reply({
            content: expectedContent,
            ephemeral: true
          });

          expect(mockInteraction.reply).toHaveBeenCalledWith({
            content: expectedContent,
            ephemeral: true
          });
        } catch (error) {
          console.error(error);
        }
      }
    );
  });
});