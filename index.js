const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

// 儲存債務記錄的對象
const debtRecords = new Map();

client.once('ready', () => {
    console.log('Bot is ready!');
    console.log(`Logged in as ${client.user.tag}`);
});

// 監聽斜線命令
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'adddebt') {
        // 創建模態框
        const modal = new ModalBuilder()
            .setCustomId('debtModal')
            .setTitle('新增欠款記錄');

        // 債務人姓名輸入
        const debtorInput = new TextInputBuilder()
            .setCustomId('debtorName')
            .setLabel('借錢的腦殘(翁星堯)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        // 債權人姓名輸入
        const creditorInput = new TextInputBuilder()
            .setCustomId('creditorName')
            .setLabel('該收錢的人')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        // 金額輸入
        const amountInput = new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('金額')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        // 用途輸入
        const purposeInput = new TextInputBuilder()
            .setCustomId('purpose')
            .setLabel('用途')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        // 將輸入框添加到模態框中
        modal.addComponents(
            new ActionRowBuilder().addComponents(debtorInput),
            new ActionRowBuilder().addComponents(creditorInput),
            new ActionRowBuilder().addComponents(amountInput),
            new ActionRowBuilder().addComponents(purposeInput)
        );

        await interaction.showModal(modal);
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

            // 創建確認按鈕
            const confirmButton = new ButtonBuilder()
                .setCustomId(`confirm_${Date.now()}`)
                .setLabel('確認已收到')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder()
                .addComponents(confirmButton);

            // 記錄資訊
            const record = {
                debtor,
                creditor,
                amount,
                purpose,
                date,
                confirmed: false
            };

            // 儲存記錄
            const recordId = Date.now().toString();
            debtRecords.set(recordId, record);

            await interaction.reply({
                content: `${date}\n${debtor} 今天欠 ${creditor} ${amount} 元\n用途：${purpose}\n狀態：未收到`,
                components: [row]
            });
        } catch (error) {
            console.error('Error handling modal submit:', error);
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
            const record = debtRecords.get(recordId);

            if (record) {
                record.confirmed = true;
                await interaction.update({
                    content: `${record.date}\n${record.debtor} 今天欠 ${record.creditor} ${record.amount} 元\n用途：${record.purpose}\n狀態：已收到`,
                    components: []
                });
            }
        } catch (error) {
            console.error('Error handling button click:', error);
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
        const commands = [{
            name: 'adddebt',
            description: '新增一筆欠款記錄'
        }];
        
        await client.application.commands.set(commands);
        console.log('Slash commands registered successfully');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// 錯誤處理
client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// 替換成您的 Discord Bot Token
require('dotenv').config();
client.login(process.env.DISCORD_TOKEN)
