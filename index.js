const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, 
    ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

// 創建 SQLite 資料庫連接
const db = new sqlite3.Database('debts.db', (err) => {
    if (err) {
        console.error('資料庫連接錯誤:', err);
    } else {
        console.log('成功連接到 SQLite 資料庫');
        
        // 檢查表是否存在
        db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='debts'`, (err, row) => {
            if (err) {
                console.error('檢查表時發生錯誤:', err);
                return;
            }
            
            // 如果表不存在，則建立
            if (!row) {
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
                )`, (err) => {
                    if (err) {
                        console.error('創建表時發生錯誤:', err);
                    } else {
                        console.log('成功建立資料表');
                    }
                });
            } else {
                console.log('資料表已存在，無需建立');
            }
        });
    }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ]
});

// 暫存用戶選擇的資料
let debtData = new Map();

// 處理 Autocomplete 互動
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;

    const focusedOption = interaction.options.getFocused(true);
    let choices = [];

    if (focusedOption.name === 'debtor' || focusedOption.name === 'creditor' || focusedOption.name === 'user') {
        const searchTerm = focusedOption.value.toLowerCase();
        const members = await interaction.guild.members.fetch();
        
        choices = Array.from(members.values())
            .filter(member => 
                member.user.username.toLowerCase().includes(searchTerm) ||
                (member.nickname && member.nickname.toLowerCase().includes(searchTerm))
            )
            .slice(0, 25)
            .map(member => {
                const displayName = member.nickname || member.user.username;
                const username = member.user.username;
                return {
                    name: member.nickname ? `${displayName} (${username})` : displayName,
                    value: `${member.user.id}|${displayName}` // 儲存 ID 和顯示名稱
                };
            });
            
    }

    await interaction.respond(choices);
});

// 監聽斜線命令
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'adddebt') {
        const [debtorId, debtorName] = interaction.options.getString('debtor').split('|');
        const [creditorId, creditorName] = interaction.options.getString('creditor').split('|');

        // 儲存用戶選擇
        debtData.set(interaction.user.id, {
            debtor_id: debtorId,
            debtor_name: debtorName,
            creditor_id: creditorId,
            creditor_name: creditorName
        }); // 儲存用戶選擇

        // 顯示金額和用途的 Modal
        const modal = new ModalBuilder()
            .setCustomId('amount_purpose_modal')
            .setTitle('輸入金額和用途');

        const amountInput = new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('金額')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('請輸入有效的數字金額')
            .setRequired(true);

        const purposeInput = new TextInputBuilder()
            .setCustomId('purpose')
            .setLabel('用途')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('請說明借款用途')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(amountInput),
            new ActionRowBuilder().addComponents(purposeInput)
        );

        await interaction.showModal(modal);
    } // adddebt 
    else if (interaction.commandName === 'checkdebt') {
        const userInput = interaction.options.getString('user');
        console.log("原始 autocomplete 輸入:", userInput);
        
        // 因為是 autocomplete，所以一定會是 "userId|displayName" 格式
        const [userId, targetUser] = userInput.split('|');
        console.log("解析後的資料:", { userId, targetUser });
        // 查詢該使用者的債務記錄
        db.all(
            `SELECT * FROM debts WHERE debtor_name = ? OR creditor_name = ?`,
            [targetUser, targetUser],
            async (err, rows) => {
                if (err) {
                    console.error('查詢錯誤:', err);
                    return interaction.reply({
                        content: '查詢記錄時發生錯誤，請稍後再試。',
                        ephemeral: true
                    });
                }

                if (rows.length === 0) {
                    return interaction.reply({
                        content: '查無相關記錄。',
                        ephemeral: true
                    });
                }

                
                const records = rows
                    .filter(row => !row.confirmed)  // 先過濾出 confirmed 為 false 的記錄
                    .map(row => 
                        `日期：${row.date}\n<@${row.debtor_id}> 欠 <@${row.creditor_id}> ${row.amount} 元\n用途：${row.purpose}\n狀態：未收到\n-------------------`
                    ).join('\n');

                // 如果想顯示沒有未收到的記錄的訊息
                if (records.length === 0) {
                    return interaction.reply({
                        content: '沒有未收到的欠款記錄。',
                        ephemeral: true
                    });
                }

                await interaction.reply({
                    content: `未收到的欠款記錄：\n${records}`,
                    ephemeral: true
                });
            }
        );
    } // checkdebt 

}); // 
// 監聽斜線命令

// 處理模態框提交
client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'amount_purpose_modal') {
        try {
            const data = debtData.get(interaction.user.id);
            if (!data) {
                return interaction.reply({
                    content: '發生錯誤，請重新開始。',
                    ephemeral: true
                });
            }

            const amount = interaction.fields.getTextInputValue('amount');
            const purpose = interaction.fields.getTextInputValue('purpose');
            const date = new Date().toLocaleDateString();
            const recordId = Date.now().toString();

            // 驗證金額
            if (isNaN(amount) || parseFloat(amount) <= 0) {
                return interaction.reply({
                    content: '請輸入有效的金額！',
                    ephemeral: true
                });
            }

            // 存入資料庫
            db.run(
                `INSERT INTO debts (id, debtor_id, debtor_name, creditor_id, creditor_name, amount, purpose, date) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    recordId,
                    data.debtor_id,
                    data.debtor_name,
                    data.creditor_id,
                    data.creditor_name,
                    parseFloat(amount),
                    purpose,
                    date
                ],
                async (err) => {
                    if (err) {
                        console.error('插入記錄錯誤:', err);
                        return interaction.reply({
                            content: '儲存記錄時發生錯誤，請稍後再試。',
                            ephemeral: true
                        });
                    }

                    const confirmButton = new ButtonBuilder()
                        .setCustomId(`confirm_${recordId}`)
                        .setLabel('確認已收到')
                        .setStyle(ButtonStyle.Success);

                    const row = new ActionRowBuilder()
                        .addComponents(confirmButton);

                    await interaction.reply({
                        content: `${date}\n<@${data.debtor_id}> 今天欠 <@${data.creditor_id}> ${amount} 元\n用途：${purpose}\n狀態：未收到`,
                        components: [row]
                    });

                    // 清除暫存資料
                    debtData.delete(interaction.user.id);
                }
            );
        } catch (error) {
            console.error('處理模態框錯誤:', error);
            await interaction.reply({
                content: '處理記錄時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
});

// 處理按鈕點擊
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('confirm_')) {
        try {
            const recordId = interaction.customId.split('_')[1];
            
            // 先檢查記錄存在且使用者是否為債權人
            db.get(
                `SELECT * FROM debts WHERE id = ?`,
                [recordId],
                async (err, record) => {
                    if (err || !record) {
                        return interaction.reply({
                            content: '找不到該筆記錄。',
                            flags: ['Ephemeral']
                        });
                    }

                    // 檢查點擊按鈕的人是否為債權人
                    if (interaction.user.id !== record.creditor_id) {
                        return interaction.reply({
                            content: '只有債權人可以確認收款。',
                            flags: ['Ephemeral']
                        });
                    }

                    // 如果是債權人，才更新資料庫狀態
                    db.run(
                        `UPDATE debts SET confirmed = TRUE WHERE id = ?`,
                        [recordId],
                        async (err) => {
                            if (err) {
                                console.error('更新記錄錯誤:', err);
                                return interaction.reply({
                                    content: '更新狀態時發生錯誤，請稍後再試。',
                                    ephemeral: true
                                });
                            }

                            // 查詢更新後的記錄
                            db.get(
                                `SELECT * FROM debts WHERE id = ?`,
                                [recordId],
                                async (err, record) => {
                                    if (err || !record) {
                                        return interaction.reply({
                                            content: '查詢記錄時發生錯誤，請稍後再試。',
                                            ephemeral: true
                                        });
                                    }

                                    await interaction.update({
                                        content: `${record.date}\n<@${record.debtor_id}> 今天欠 <@${record.creditor_id}> ${record.amount} 元\n用途：${record.purpose}\n狀態：已收到`,
                                        components: []
                                    });
                                }
                            );
                        }
                    );
                } 
            );
                
        } // try 
        catch (error) {
            console.error('處理按鈕點擊錯誤:', error);
            await interaction.reply({
                content: '處理確認時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        } // catch
    } // if 
}); // client 

// 註冊斜線命令
client.once('ready', async () => {
    try {
        console.log('===== Bot 啟動中 =====');
        console.log(`登入身份: ${client.user.tag}`);
        
        // 註冊斜線命令
        const commands = [
            {
                name: 'adddebt',
                description: '新增一筆欠款記錄',
                options: [
                    {
                        name: 'debtor',
                        description: '借款人',
                        type: 3, // STRING
                        required: true,
                        autocomplete: true
                    },
                    {
                        name: 'creditor',
                        description: '貸款人',
                        type: 3, // STRING
                        required: true,
                        autocomplete: true
                    }
                ]
            },
            {
                name: 'checkdebt',
                description: '查詢欠款記錄',
                options: [
                    {
                        name: 'user',
                        description: '要查詢的使用者名稱',
                        type: 3,
                        required: true,
                        autocomplete: true
                    }
                ]
            }
        ];

        console.log('正在註冊斜線命令...');
        console.log('準備註冊的命令:', commands.map(cmd => cmd.name).join(', '));
        
        const registeredCommands = await client.application.commands.set(commands);
        console.log('已註冊的命令:', registeredCommands.map(cmd => cmd.name).join(', '));
        
        console.log('===== Bot 啟動完成 =====');
    } catch (error) {
        console.error('Bot 啟動過程發生錯誤:', error);
    }
});

// 錯誤處理
client.on('error', error => {
    console.error('Discord client 錯誤:', error);
});

process.on('unhandledRejection', error => {
    console.error('未處理的 Promise 拒絕:', error);
});

// 在程式結束時關閉資料庫連接
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('關閉資料庫時發生錯誤:', err);
        } else {
            console.log('資料庫連接已關閉');
        }
        process.exit(0);
    });
});

require('dotenv').config();
client.login(process.env.DISCORD_TOKEN);