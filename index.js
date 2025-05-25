const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, 
    ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// 創建 PostgreSQL 連接池
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 初始化資料庫表
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS debts (
                id TEXT PRIMARY KEY,
                debtor_id TEXT NOT NULL,
                debtor_name TEXT NOT NULL,
                creditor_id TEXT NOT NULL,
                creditor_name TEXT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                purpose TEXT NOT NULL,
                date TEXT NOT NULL,
                confirmed BOOLEAN DEFAULT FALSE
            )
        `);
        console.log('資料庫表初始化完成');
    } catch (err) {
        console.error('資料庫初始化錯誤:', err);
    }
}

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
        });

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
    } 
    else if (interaction.commandName === 'checkdebt') {
        const userInput = interaction.options.getString('user');
        const [userId, targetUser] = userInput.split('|');
        
        try {
            // 查詢該使用者的債務記錄
            const result = await pool.query(
                'SELECT * FROM debts WHERE debtor_name = $1 OR creditor_name = $1',
                [targetUser]
            );

            if (result.rows.length === 0) {
                return interaction.reply({
                    content: '查無相關記錄。',
                    ephemeral: true
                });
            }

            const records = result.rows
                .filter(row => !row.confirmed)
                .map(row => 
                    `日期：${row.date}\n<@${row.debtor_id}> 欠 <@${row.creditor_id}> ${row.amount} 元\n用途：${row.purpose}\n狀態：未收到\n-------------------`
                ).join('\n');

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
        } catch (err) {
            console.error('查詢錯誤:', err);
            return interaction.reply({
                content: '查詢記錄時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
});

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
            await pool.query(
                'INSERT INTO debts (id, debtor_id, debtor_name, creditor_id, creditor_name, amount, purpose, date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [
                    recordId,
                    data.debtor_id,
                    data.debtor_name,
                    data.creditor_id,
                    data.creditor_name,
                    parseFloat(amount),
                    purpose,
                    date
                ]
            );

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
            const result = await pool.query(
                'SELECT * FROM debts WHERE id = $1',
                [recordId]
            );

            if (result.rows.length === 0) {
                return interaction.reply({
                    content: '找不到該筆記錄。',
                    flags: ['Ephemeral']
                });
            }

            const record = result.rows[0];

            // 檢查點擊按鈕的人是否為債權人
            if (interaction.user.id !== record.creditor_id) {
                return interaction.reply({
                    content: '只有債權人可以確認收款。',
                    flags: ['Ephemeral']
                });
            }

            // 更新資料庫狀態
            await pool.query(
                'UPDATE debts SET confirmed = TRUE WHERE id = $1',
                [recordId]
            );

            await interaction.update({
                content: `${record.date}\n<@${record.debtor_id}> 今天欠 <@${record.creditor_id}> ${record.amount} 元\n用途：${record.purpose}\n狀態：已收到`,
                components: []
            });

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
        console.log('===== Bot 啟動中 =====');
        console.log(`登入身份: ${client.user.tag}`);
        
        // 初始化資料庫
        await initDatabase();
        
        // 註冊斜線命令
        const commands = [
            {
                name: 'adddebt',
                description: '新增一筆欠款記錄',
                options: [
                    {
                        name: 'debtor',
                        description: '借款人',
                        type: 3,
                        required: true,
                        autocomplete: true
                    },
                    {
                        name: 'creditor',
                        description: '貸款人',
                        type: 3,
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
process.on('SIGINT', async () => {
    await pool.end();
    console.log('資料庫連接已關閉');
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);