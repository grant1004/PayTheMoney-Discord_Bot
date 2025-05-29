const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, 
    ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// 創建 PostgreSQL 連接池
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 台灣縣市經緯度資料
const taiwanCities = {
    '台北市': { lat: 25.033, lon: 121.565, name: '台北市' },
    '新北市': { lat: 25.012, lon: 121.465, name: '新北市' },
    '桃園市': { lat: 24.993, lon: 121.301, name: '桃園市' },
    '台中市': { lat: 24.163, lon: 120.647, name: '台中市' },
    '台南市': { lat: 22.999, lon: 120.227, name: '台南市' },
    '高雄市': { lat: 22.627, lon: 120.302, name: '高雄市' },
    '新竹市': { lat: 24.806, lon: 120.968, name: '新竹市' },
    '新竹縣': { lat: 24.832, lon: 121.018, name: '新竹縣' },
    '苗栗縣': { lat: 24.560, lon: 120.821, name: '苗栗縣' },
    '彰化縣': { lat: 24.052, lon: 120.516, name: '彰化縣' },
    '南投縣': { lat: 23.961, lon: 120.972, name: '南投縣' },
    '雲林縣': { lat: 23.709, lon: 120.431, name: '雲林縣' },
    '嘉義市': { lat: 23.480, lon: 120.449, name: '嘉義市' },
    '嘉義縣': { lat: 23.452, lon: 120.258, name: '嘉義縣' },
    '屏東縣': { lat: 22.673, lon: 120.549, name: '屏東縣' },
    '宜蘭縣': { lat: 24.702, lon: 121.738, name: '宜蘭縣' },
    '花蓮縣': { lat: 23.993, lon: 121.611, name: '花蓮縣' },
    '台東縣': { lat: 22.755, lon: 121.144, name: '台東縣' },
    '澎湖縣': { lat: 23.571, lon: 119.579, name: '澎湖縣' },
    '金門縣': { lat: 24.449, lon: 118.377, name: '金門縣' },
    '連江縣': { lat: 26.197, lon: 119.950, name: '連江縣' },
    '基隆市': { lat: 25.128, lon: 121.739, name: '基隆市' }
};

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

// 獲取台灣指定縣市天氣資訊
async function getCityWeather(cityData) {
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${cityData.lat}&longitude=${cityData.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_probability_mean,precipitation_probability_min&timezone=Asia%2FTaipei&forecast_days=1`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`獲取 ${cityData.name} 天氣資訊時發生錯誤:`, error);
        throw error;
    }
}

// 天氣代碼對應描述（WMO Weather interpretation codes）
function getWeatherDescription(code) {
    const weatherCodes = {
        0: '☀️ 晴朗',
        1: '🌤️ 大致晴朗',
        2: '⛅ 部分多雲',
        3: '☁️ 陰天',
        45: '🌫️ 霧',
        48: '🌫️ 結霜霧',
        51: '🌦️ 小毛毛雨',
        53: '🌦️ 中等毛毛雨',
        55: '🌦️ 密集毛毛雨',
        56: '🌦️ 輕微凍毛毛雨',
        57: '🌦️ 密集凍毛毛雨',
        61: '🌧️ 小雨',
        63: '🌧️ 中雨',
        65: '🌧️ 大雨',
        66: '🌧️ 輕微凍雨',
        67: '🌧️ 嚴重凍雨',
        71: '🌨️ 小雪',
        73: '🌨️ 中雪',
        75: '🌨️ 大雪',
        77: '🌨️ 雪粒',
        80: '🌦️ 小陣雨',
        81: '🌦️ 中等陣雨',
        82: '🌦️ 強烈陣雨',
        85: '🌨️ 小雪陣',
        86: '🌨️ 大雪陣',
        95: '⛈️ 雷暴',
        96: '⛈️ 輕微冰雹雷暴',
        99: '⛈️ 嚴重冰雹雷暴'
    };
    
    return weatherCodes[code] || '🌤️ 未知天氣';
}

// 根據天氣代碼決定顏色
function getWeatherColor(code) {
    if (code === 0) return 0xFFD700; // 晴朗 - 金色
    if (code >= 1 && code <= 3) return 0x87CEEB; // 晴朗到多雲 - 天藍色
    if (code >= 45 && code <= 48) return 0x708090; // 霧 - 灰色
    if (code >= 51 && code <= 67) return 0x4682B4; // 毛毛雨到凍雨 - 鋼藍色
    if (code >= 71 && code <= 86) return 0xF0F8FF; // 雪 - 愛麗絲藍
    if (code >= 95 && code <= 99) return 0x483D8B; // 雷暴 - 暗藍紫色
    return 0x0099FF; // 預設 - 藍色
}

// 根據降雨機率提供建議
function getRainAdvice(probability) {
    if (probability >= 80) return '🌧️ 高機率降雨，記得帶雨具！';
    if (probability >= 60) return '☂️ 可能下雨，建議攜帶雨傘';
    if (probability >= 40) return '🌦️ 有機會降雨，可備雨具';
    if (probability >= 20) return '🌤️ 降雨機率偏低，但不排除';
    return '☀️ 降雨機率很低，適合戶外活動';
}

// 風向轉換
function getWindDirection(degree) {
    const directions = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
    const index = Math.round(degree / 45) % 8;
    return directions[index];
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
    } else if (focusedOption.name === 'city') {
        // 縣市自動完成
        const searchTerm = focusedOption.value.toLowerCase();
        choices = Object.keys(taiwanCities)
            .filter(city => city.toLowerCase().includes(searchTerm))
            .slice(0, 25)
            .map(city => ({
                name: city,
                value: city
            }));
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
    else if (interaction.commandName === 'weather') {
        // 延遲回應，因為 API 請求可能需要一些時間
        await interaction.deferReply();

        try {
            // 取得選擇的城市，如果沒有選擇則預設為台北市
            const selectedCity = interaction.options.getString('city') || '台北市';
            const cityData = taiwanCities[selectedCity];

            if (!cityData) {
                return interaction.editReply({
                    content: '抱歉，找不到指定的縣市。請選擇有效的台灣縣市。'
                });
            }

            const weatherData = await getCityWeather(cityData);
            const current = weatherData.current;
            const daily = weatherData.daily;
            
            // 建立天氣資訊嵌入式訊息
            const rainAdvice = getRainAdvice(daily.precipitation_probability_max[0]);
            
            const weatherEmbed = new EmbedBuilder()
                .setTitle(`🌤️ ${cityData.name}今日天氣`)
                .setDescription(`${getWeatherDescription(current.weather_code)}\n\n💡 **今日建議**\n${rainAdvice}`)
                .setColor(getWeatherColor(current.weather_code))
                .setTimestamp(new Date(current.time))
                .addFields(
                    {
                        name: '🌡️ 目前溫度',
                        value: `${current.temperature_2m}°C`,
                        inline: true
                    },
                    {
                        name: '🌡️ 體感溫度',
                        value: `${current.apparent_temperature}°C`,
                        inline: true
                    },
                    {
                        name: '💧 濕度',
                        value: `${current.relative_humidity_2m}%`,
                        inline: true
                    },
                    {
                        name: '🌡️ 今日最高溫',
                        value: `${daily.temperature_2m_max[0]}°C`,
                        inline: true
                    },
                    {
                        name: '🌡️ 今日最低溫',
                        value: `${daily.temperature_2m_min[0]}°C`,
                        inline: true
                    },
                    {
                        name: '🌧️ 降雨量',
                        value: `${current.precipitation || 0} mm`,
                        inline: true
                    },
                    {
                        name: '☔ 降雨機率',
                        value: `最高: ${daily.precipitation_probability_max[0]}%\n平均: ${daily.precipitation_probability_mean[0]}%`,
                        inline: true
                    },
                    {
                        name: '💨 風速',
                        value: `${current.wind_speed_10m} km/h`,
                        inline: true
                    },
                    {
                        name: '🧭 風向',
                        value: `${getWindDirection(current.wind_direction_10m)} (${current.wind_direction_10m}°)`,
                        inline: true
                    },
                    {
                        name: '🌅 時段',
                        value: current.is_day ? '白天' : '夜晚',
                        inline: true
                    },
                    {
                        name: '📊 今日預計總降雨',
                        value: `${daily.precipitation_sum[0]} mm`,
                        inline: true
                    }
                )
                .setFooter({ 
                    text: `資料來源：Open-Meteo.com | 降雨機率為全日預測 | 更新時間：${new Date().toLocaleTimeString('zh-TW')}`,
                    iconURL: 'https://open-meteo.com/favicon.ico'
                });

            await interaction.editReply({ embeds: [weatherEmbed] });

        } catch (error) {
            console.error('獲取天氣資訊錯誤:', error);
            await interaction.editReply({
                content: '抱歉，無法獲取天氣資訊，請稍後再試。',
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
            },
            {
                name: 'weather',
                description: '查看台灣縣市今日天氣資訊',
                options: [
                    {
                        name: 'city',
                        description: '選擇縣市（預設：台北市）',
                        type: 3,
                        required: false,
                        autocomplete: true
                    }
                ]
            }
        ];

        console.log('正在註冊斜線命令...');
        const registeredCommands = await client.application.commands.set(commands);
        console.log('已註冊的命令:', registeredCommands.map(cmd => cmd.name).join(', '));
        
        console.log('===== Bot 啟動完成 =====');
        console.log('支援的縣市:', Object.keys(taiwanCities).join(', '));
        console.log('天氣功能: 溫度、濕度、風速、降雨量、降雨機率預測');
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