const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, 
    ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

// 創建 SQLite 資料庫連接
const db = new sqlite3.Database('debts.db', (err) => {
    if (err) {
        console.error('資料庫連接錯誤:', err);
    } else {
        console.log('成功連接到 SQLite 資料庫');
        // 創建債務記錄表
        db.run(`CREATE TABLE IF NOT EXISTS debts (
            id TEXT PRIMARY KEY,
            debtor TEXT NOT NULL,
            creditor TEXT NOT NULL,
            amount REAL NOT NULL,
            purpose TEXT NOT NULL,
            date TEXT NOT NULL,
            confirmed BOOLEAN DEFAULT FALSE
        )`);
    }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

client.once('ready', () => {
    console.log('Bot is ready!');
    console.log(`Logged in as ${client.user.tag}`);
});

// 監聽斜線命令
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'adddebt') {
        const modal = new ModalBuilder()
            .setCustomId('debtModal')
            .setTitle('新增欠款記錄');

        const debtorInput = new TextInputBuilder()
            .setCustomId('debtorName')
            .setLabel('借錢的人')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('請輸入借款人名稱')
            .setRequired(true);

        const creditorInput = new TextInputBuilder()
            .setCustomId('creditorName')
            .setLabel('該收錢的人')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('請輸入貸款人名稱')
            .setRequired(true);

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
            new ActionRowBuilder().addComponents(debtorInput),
            new ActionRowBuilder().addComponents(creditorInput),
            new ActionRowBuilder().addComponents(amountInput),
            new ActionRowBuilder().addComponents(purposeInput)
        );

        await interaction.showModal(modal);
    } else if (interaction.commandName === 'checkdebt') {
        const targetUser = interaction.options.getString('user');
        
        // 查詢該使用者的債務記錄
        db.all(
            `SELECT * FROM debts WHERE debtor = ? OR creditor = ?`,
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

                const records = rows.map(row => 
                    `日期：${row.date}\n${row.debtor} 欠 ${row.creditor} ${row.amount} 元\n用途：${row.purpose}\n狀態：${row.confirmed ? '已收到' : '未收到'}\n-------------------`
                ).join('\n');

                await interaction.reply({
                    content: `查詢結果：\n${records}`,
                    ephemeral: true
                });
            }
        );
    }
});

// 處理模態框提交
client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'debtModal') {
        try {
            const debtor = interaction.fields.getTextInputValue('debtorName');
            const creditor = interaction.fields.getTextInputValue('creditorName');
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
                `INSERT INTO debts (id, debtor, creditor, amount, purpose, date) VALUES (?, ?, ?, ?, ?, ?)`,
                [recordId, debtor, creditor, parseFloat(amount), purpose, date],
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
                        content: `${date}\n${debtor} 今天欠 ${creditor} ${amount} 元\n用途：${purpose}\n狀態：未收到`,
                        components: [row]
                    });
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
            
            // 更新資料庫中的確認狀態
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
                                content: `${record.date}\n${record.debtor} 今天欠 ${record.creditor} ${record.amount} 元\n用途：${record.purpose}\n狀態：已收到`,
                                components: []
                            });
                        }
                    );
                }
            );
        } catch (error) {
            console.error('處理按鈕點擊錯誤:', error);
            await interaction.reply({
                content: '處理確認時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
});

// 註冊斜線命令
client.once('ready', async () => {
    try {
        const commands = [
            {
                name: 'adddebt',
                description: '新增一筆欠款記錄'
            },
            {
                name: 'checkdebt',
                description: '查詢欠款記錄',
                options: [
                    {
                        name: 'user',
                        description: '要查詢的使用者名稱',
                        type: 3, // STRING type
                        required: true
                    }
                ]
            }
        ];
        
        await client.application.commands.set(commands);
        console.log('斜線命令註冊成功');
    } catch (error) {
        console.error('註冊斜線命令錯誤:', error);
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