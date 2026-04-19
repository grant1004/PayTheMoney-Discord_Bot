const { Client, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const nacl = require('tweetnacl');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { search, SafeSearchType} = require('duck-duck-scrape');
require('dotenv').config();

// 創建 PostgreSQL 連接池
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 初始化 Anthropic 客戶端
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
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

// 對話歷史存儲（生產環境建議使用資料庫）
const conversationHistory = new Map();

// 使用次數限制
const userUsageMap = new Map();

// 暫存用戶選擇的資料
let debtData = new Map();

// 儲存排程提醒
let scheduleData = new Map();

// 儲存排程設定過程中的暫存資料
let scheduleSetupData = new Map();

// 儲存 CS2 demo 查詢暫存
let cs2DemoData = new Map();
let cs2PendingInteractions = new Map();
let cs2SelectedMatches = new Map();
let cs2ExistingFiles = new Set(); // 本機已存在的 .dem 檔名

// CS2 WebSocket 連線
let cs2WsClient = null;

function cs2WsSend(obj) {
    if (!cs2WsClient || cs2WsClient.readyState !== 1) {
        console.error('[CS2 WS] 無連線，無法傳送:', obj.type);
        return false;
    }
    cs2WsClient.send(JSON.stringify(obj));
    return true;
}

function handleCs2Message(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type, userId } = msg;
    console.log('[CS2 WS] 收到:', type, 'userId=' + userId);

    if (type === 'MATCHES_RESULT') {
        const pending = cs2PendingInteractions.get(userId);
        if (!pending) return;
        cs2PendingInteractions.delete(userId);
        const { matches } = msg;
        if (!matches || matches.length === 0) {
            pending.interaction.editReply('📭 沒有找到比賽記錄。').catch(() => {});
            return;
        }
        const limited = matches.slice(0, 5);
        cs2SelectedMatches.set(userId + '_matches', matches);
        const MAP_NAMES_CB = {
            'de_dust2': 'Dust2', 'de_mirage': 'Mirage', 'de_inferno': 'Inferno',
            'de_nuke': 'Nuke', 'de_overpass': 'Overpass', 'de_ancient': 'Ancient',
            'de_anubis': 'Anubis', 'de_vertigo': 'Vertigo', 'de_train': 'Train'
        };
        const options = limited.map((m, i) => {
            const mapName = m.mapName || MAP_NAMES_CB[m.map] || '未知地圖';
            return new StringSelectMenuOptionBuilder()
                .setLabel((mapName + ' - ' + m.time).slice(0, 100))
                .setValue(String(i))
                .setDescription('Match ID: ' + String(m.matchid).slice(-8));
        });
        const select = new StringSelectMenuBuilder()
            .setCustomId('cs2_demo_select')
            .setPlaceholder('選擇要下載的 demo（最多 5 場）')
            .setMinValues(1)
            .setMaxValues(limited.length)
            .addOptions(options);
        pending.interaction.editReply({
            content: '🎮 **找到 ' + matches.length + ' 場比賽**（顯示最近 ' + limited.length + ' 場）\n選擇要下載的 demo：',
            components: [new ActionRowBuilder().addComponents(select)]
        }).catch(err => console.error('[CS2] editReply failed:', err));
    }

    else if (type === 'PROGRESS') {
        const pending = cs2PendingInteractions.get(userId);
        if (!pending) return;
        const { current, total, pct } = msg;
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        pending.interaction.editReply(
            `⏳ **下載中...**\n[${bar}] ${pct}%  （${current} / ${total} 個檔案）`
        ).catch(() => {});
    }

    else if (type === 'DOWNLOAD_DONE') {
        const pending = cs2PendingInteractions.get(userId);
        if (!pending) return;
        cs2PendingInteractions.delete(userId);
        const { results } = msg;
        pending.interaction.editReply(
            `📁 **下載完成**\n${results.join('\n')}`
        ).catch(() => {});
    }

    else if (type === 'ERROR') {
        const pending = cs2PendingInteractions.get(userId);
        if (!pending) return;
        cs2PendingInteractions.delete(userId);
        pending.interaction.editReply(`❌ ${msg.message}`).catch(() => {});
    }

    else if (type === 'FILE_LIST') {
        cs2ExistingFiles = new Set(msg.files || []);
        console.log('[CS2 WS] 已更新檔案清單，共', cs2ExistingFiles.size, '個 .dem');
    }
}

// 生成未來7天的日期選項
function generateDateOptions() {
    const options = [];
    const today = new Date();
    
    for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;
        
        let label;
        if (i === 0) {
            label = `今天 (${month}/${day})`;
        } else if (i === 1) {
            label = `明天 (${month}/${day})`;
        } else {
            const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
            const weekday = weekdays[date.getDay()];
            label = `${month}/${day} (週${weekday})`;
        }
        
        options.push(new StringSelectMenuOptionBuilder()
            .setLabel(label)
            .setValue(dateStr)
        );
    }
    
    return options;
}

// 生成時間選項（每小時一個）
function generateTimeOptions() {
    const options = [];
    
    for (let hour = 0; hour < 24; hour++) {
        const timeStr = `${String(hour).padStart(2, '0')}:00`;
        const label = `${timeStr}`;
        
        options.push(new StringSelectMenuOptionBuilder()
            .setLabel(label)
            .setValue(timeStr)
        );
    }
    
    return options;
}

// 生成提前提醒選項
function generateReminderOptions() {
    const options = [
        new StringSelectMenuOptionBuilder()
            .setLabel('準時提醒（不提前）')
            .setValue('0'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 5 分鐘')
            .setValue('5'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 10 分鐘')
            .setValue('10'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 15 分鐘')
            .setValue('15'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 30 分鐘')
            .setValue('30'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 1 小時')
            .setValue('60'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 2 小時')
            .setValue('120'),
        new StringSelectMenuOptionBuilder()
            .setLabel('提前 24 小時')
            .setValue('1440')
    ];
    
    return options;
}

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

// 搜尋頻率限制
const searchCooldown = new Map();

// 網路搜尋功能
async function webSearch(query) {
    try {
        console.log(`執行網路搜尋: ${query}`);
        
        // 檢查搜尋冷卻時間（每個查詢至少間隔5秒）
        const now = Date.now();
        const lastSearch = searchCooldown.get('lastSearch') || 0;
        const timeSinceLastSearch = now - lastSearch;
        
        if (timeSinceLastSearch < 5000) {
            const waitTime = 5000 - timeSinceLastSearch;
            console.log(`搜尋冷卻中，等待 ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        // 更新最後搜尋時間
        searchCooldown.set('lastSearch', Date.now());
        
        const results = await search(query, {
            time: 'm',
            region: 'tw-tzh', // 台灣地區設定
            safeSearch: SafeSearchType.MODERATE
        });
        
        if (!results || !results.results) {
            console.log('搜尋結果為空');
            return [];
        }
        
        const searchResults = results.results.slice(0, 5).map(result => ({
            title: result.title || '無標題',
            url: result.url || '',
            description: result.description || '無描述'
        }));
        
        console.log(`搜尋到 ${searchResults.length} 個結果`);
        return searchResults;
    } catch (error) {
        console.error('網路搜尋錯誤:', error.message);
        
        // 如果是速率限制錯誤，增加更長的冷卻時間
        if (error.message.includes('anomaly') || error.message.includes('quickly')) {
            console.log('偵測到速率限制，設定30秒冷卻時間');
            searchCooldown.set('lastSearch', Date.now() + 25000); // 額外25秒冷卻
        }
        
        return [];
    }
}

// 格式化搜尋結果
function formatSearchResults(results) {
    if (results.length === 0) {
        return '沒有找到相關的網路資訊。';
    }
    
    return results.map((result, index) => 
        `${index + 1}. **${result.title}**\n${result.description}\n🔗 ${result.url}\n`
    ).join('\n');
}

// 輔助函數：分割長訊息
function splitMessage(text, maxLength) {
    const chunks = [];
    let currentChunk = '';
    
    // 按段落分割
    const paragraphs = text.split('\n\n');
    
    for (const paragraph of paragraphs) {
        if ((currentChunk + paragraph + '\n\n').length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = paragraph + '\n\n';
            } else {
                // 如果單段就超過限制，按句子分割
                const sentences = paragraph.split('. ');
                for (const sentence of sentences) {
                    if ((currentChunk + sentence + '. ').length > maxLength) {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                            currentChunk = sentence + '. ';
                        } else {
                            // 強制分割
                            chunks.push(sentence.substring(0, maxLength - 3) + '...');
                            currentChunk = '...' + sentence.substring(maxLength - 3) + '. ';
                        }
                    } else {
                        currentChunk += sentence + '. ';
                    }
                }
            }
        } else {
            currentChunk += paragraph + '\n\n';
        }
    }
    
    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks.length > 0 ? chunks : [text];
}

// 使用次數檢查函數
function checkUsageLimit(userId) {
    const today = new Date().toDateString();
    const userKey = `${userId}-${today}`;
    
    if (!userUsageMap.has(userKey)) {
        userUsageMap.set(userKey, 0);
    }
    
    const currentUsage = userUsageMap.get(userKey);
    if (currentUsage >= 20) { // 每天限制 20 次
        return false;
    }
    
    userUsageMap.set(userKey, currentUsage + 1);
    return true;
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
                    `日期：${row.date}\n<@${row.debtor_id}> 欠 <@${row.creditor_id}> ${Math.round(row.amount)} 元\n用途：${row.purpose}\n狀態：未收到\n-------------------`
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
                // 第一行：目前溫度狀況                
                {
                    name: '☔ 降雨機率',
                    value: `${daily.precipitation_probability_max[0]}%`,
                    inline: true
                },
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
                
                // 第二行：今日溫度範圍與時段
                {
                    name: '🔥 今日最高溫',
                    value: `${daily.temperature_2m_max[0]}°C`,
                    inline: true
                },
                {
                    name: '❄️ 今日最低溫',
                    value: `${daily.temperature_2m_min[0]}°C`,
                    inline: true
                },                               
                {
                    name: '💧 濕度',
                    value: `${current.relative_humidity_2m}%`,
                    inline: true
                },
                
                // 第三行：天氣狀況                
                {
                    name: '🌅 時段',
                    value: current.is_day ? '☀️ 白天' : '🌙 夜晚',
                    inline: true
                }, 
                {
                    name: '💨 風速',
                    value: `${current.wind_speed_10m} km/h`,
                    inline: true
                },
                {
                    name: '\u200B', // 空白欄位用於對齊
                    value: '\u200B',
                    inline: true
                }
            )
            .setFooter({ 
                text: `資料來源：Open-Meteo.com | 更新時間：${new Date().toLocaleTimeString('zh-TW')}`,
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
    // Claude AI 單次對話
    else if (interaction.commandName === 'claude') {
        // 檢查使用次數
        if (!checkUsageLimit(interaction.user.id)) {
            return interaction.reply({
                content: '你今天的 AI 對話次數已用完，明天再來吧！',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const userMessage = interaction.options.getString('message');
            const enableSearch = interaction.options.getBoolean('search') || false;
            
            let searchResults = [];
            let finalMessage = userMessage;
            
            // 如果啟用搜尋功能
            if (enableSearch) {
                searchResults = await webSearch(userMessage);
                if (searchResults.length > 0) {
                    const searchContext = formatSearchResults(searchResults);
                    finalMessage = `用戶問題: ${userMessage}\n\n以下是相關的網路搜尋結果:\n${searchContext}\n\n請根據以上搜尋結果回答用戶的問題。`;
                }
            }
            
            const message = await anthropic.messages.create({
                model: "claude-sonnet-4-20250514",
                max_tokens: 1000,
                temperature: 0.7,
                system: "你是一個友善且樂於助人的 AI 助手，請用繁體中文回答問題。回答要準確、有用且易於理解。如果有提供網路搜尋結果，請結合這些資訊來回答。",
                messages: [
                    {
                        role: "user",
                        content: finalMessage
                    }
                ]
            });

            const aiResponse = message.content[0].text;

            if (aiResponse.length > 2000) {
                const chunks = splitMessage(aiResponse, 2000);
                await interaction.editReply(chunks[0]);
                
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp(chunks[i]);
                }
            } else {
                await interaction.editReply(aiResponse);
            }

        } catch (error) {
            console.error('Claude API 錯誤:', error);
            
            let errorMessage = '抱歉，AI 服務暫時無法使用，請稍後再試。';
            
            if (error.status === 429) {
                errorMessage = '請求太頻繁，請稍後再試。';
            } else if (error.status === 401) {
                errorMessage = 'API 金鑰無效或已過期。';
            } else if (error.status === 403) {
                errorMessage = 'API 額度不足或權限不夠。';
            }

            await interaction.editReply({
                content: errorMessage,
                ephemeral: true
            });
        }
    }
    // Claude AI 多輪對話
    else if (interaction.commandName === 'chat') {
        // 檢查使用次數
        if (!checkUsageLimit(interaction.user.id)) {
            return interaction.reply({
                content: '你今天的 AI 對話次數已用完，明天再來吧！',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const userMessage = interaction.options.getString('message');
            const enableSearch = interaction.options.getBoolean('search') || false;
            const conversationId = `${interaction.guild.id}-${interaction.channel.id}`;
            
            // 獲取對話歷史
            if (!conversationHistory.has(conversationId)) {
                conversationHistory.set(conversationId, []);
            }
            
            const history = conversationHistory.get(conversationId);
            
            let finalMessage = userMessage;
            
            // 如果啟用搜尋功能
            if (enableSearch) {
                const searchResults = await webSearch(userMessage);
                if (searchResults.length > 0) {
                    const searchContext = formatSearchResults(searchResults);
                    finalMessage = `用戶問題: ${userMessage}\n\n以下是相關的網路搜尋結果:\n${searchContext}\n\n請根據以上搜尋結果回答用戶的問題。`;
                }
            }
            
            // 構建訊息陣列
            const messages = [
                ...history,
                {
                    role: "user",
                    content: finalMessage
                }
            ];
            
            // 限制對話歷史長度避免超出 token 限制
            if (messages.length > 20) {
                messages.splice(0, messages.length - 20);
            }

            const message = await anthropic.messages.create({
                model: "claude-sonnet-4-20250514",
                max_tokens: 1000,
                temperature: 0.7,
                system: "你是一個友善的 Discord 機器人助手，名字叫做「小克勞德」。請用繁體中文回答問題，回答要有趣且實用。如果用戶問起你的身份，說你是使用 Claude AI 的 Discord 機器人。如果有提供網路搜尋結果，請結合這些資訊來回答。",
                messages: messages
            });

            const aiResponse = message.content[0].text;
            
            // 更新對話歷史（使用原始用戶訊息，不包含搜尋結果）
            history.push(
                { role: "user", content: userMessage },
                { role: "assistant", content: aiResponse }
            );
            conversationHistory.set(conversationId, history);

            // 回應用戶
            if (aiResponse.length > 2000) {
                const chunks = splitMessage(aiResponse, 2000);
                await interaction.editReply(chunks[0]);
                
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp(chunks[i]);
                }
            } else {
                await interaction.editReply(aiResponse);
            }

        } catch (error) {
            console.error('Claude 對話錯誤:', error);
            await interaction.editReply({
                content: '抱歉，對話服務暫時無法使用，請稍後再試。',
                ephemeral: true
            });
        }
    }
    // 清除對話歷史命令
    else if (interaction.commandName === 'clear-chat') {
        const conversationId = `${interaction.guild.id}-${interaction.channel.id}`;
        conversationHistory.delete(conversationId);
        
        await interaction.reply({
            content: '✅ 對話歷史已清除！',
            ephemeral: true
        });
    }
    else if (interaction.commandName === 'schedule') {
        // 顯示事件名稱輸入的 Modal
        const modal = new ModalBuilder()
            .setCustomId('schedule_name_modal')
            .setTitle('設定時間提醒');

        const nameInput = new TextInputBuilder()
            .setCustomId('event_name')
            .setLabel('事件名稱')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('請輸入要提醒的事件名稱')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput)
        );

        await interaction.showModal(modal);
    }
    else if (interaction.commandName === 'cs2demos') {
        if (!cs2WsClient || cs2WsClient.readyState !== 1) {
            return interaction.reply({ content: '❌ 本機 CS2 Service 未連線，請確認 service 是否運行中。', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const dateStr = interaction.options.getString('date') || '';
        cs2PendingInteractions.set(interaction.user.id, { interaction, requestedAt: Date.now() });
        cs2WsSend({ type: 'FETCH_MATCHES', userId: interaction.user.id, date: dateStr });
        await interaction.editReply('⏳ 正在取得比賽記錄，請稍候...');
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
                content: `${date}\n<@${data.debtor_id}> 今天欠 <@${data.creditor_id}> ${Math.round(amount)} 元\n用途：${purpose}\n狀態：未收到`,
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
    else if (interaction.customId === 'cs2_filename_modal') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const selectedMatches = cs2SelectedMatches.get(interaction.user.id);
            if (!selectedMatches) return interaction.editReply('❌ 資料已過期，請重新選擇。');
            cs2SelectedMatches.delete(interaction.user.id);
            if (!cs2WsClient || cs2WsClient.readyState !== 1) {
                return interaction.editReply('❌ 本機 CS2 Service 已斷線，無法下載。');
            }
            const downloads = selectedMatches.map((match, i) => ({
                ...match,
                filename: interaction.fields.getTextInputValue('filename_' + i) + '.dem'
            }));

            // 檢查重複檔名
            const duplicates = downloads.filter(d => cs2ExistingFiles.has(d.filename));
            if (duplicates.length > 0) {
                const list = duplicates.map(d => `• \`${d.filename}\``).join('\n');
                return interaction.editReply(
                    `⚠️ **以下檔名已存在，請重新選擇並修改檔名：**\n${list}`
                );
            }

            cs2PendingInteractions.set(interaction.user.id, { interaction, requestedAt: Date.now() });
            cs2WsSend({ type: 'DOWNLOAD', userId: interaction.user.id, matches: downloads });
            const list = downloads.map(d => '• ' + d.filename).join('\n');
            await interaction.editReply('⏳ **開始下載...**\n' + list);
        } catch (err) {
            console.error('cs2_filename_modal 錯誤:', err);
            await interaction.editReply('❌ 處理檔名時發生錯誤。');
        }
    }
    else if (interaction.customId === 'schedule_name_modal') {
        try {
            const eventName = interaction.fields.getTextInputValue('event_name');
            
            // 儲存事件名稱到暫存資料
            scheduleSetupData.set(interaction.user.id, {
                eventName: eventName,
                step: 'date_selection'
            });
            
            // 顯示日期選擇選單
            const dateSelect = new StringSelectMenuBuilder()
                .setCustomId('schedule_date_select')
                .setPlaceholder('請選擇日期')
                .addOptions(generateDateOptions());
            
            const row = new ActionRowBuilder()
                .addComponents(dateSelect);
            
            await interaction.reply({
                content: `📅 **設定提醒：${eventName}**\n請選擇日期：`,
                components: [row],
                ephemeral: true
            });
            
        } catch (error) {
            console.error('處理事件名稱模態框錯誤:', error);
            await interaction.reply({
                content: '處理事件名稱時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
});

// 處理選擇選單互動
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu()) return;

    // 處理日期選擇
    if (interaction.customId === 'schedule_date_select') {
        try {
            const setupData = scheduleSetupData.get(interaction.user.id);
            if (!setupData) {
                return interaction.reply({
                    content: '設定資料已過期，請重新開始。',
                    ephemeral: true
                });
            }

            const selectedDate = interaction.values[0];
            setupData.selectedDate = selectedDate;
            setupData.step = 'time_selection';
            scheduleSetupData.set(interaction.user.id, setupData);

            // 顯示時間選擇選單
            const timeSelect = new StringSelectMenuBuilder()
                .setCustomId('schedule_time_select')
                .setPlaceholder('請選擇時間')
                .addOptions(generateTimeOptions());

            const row = new ActionRowBuilder()
                .addComponents(timeSelect);

            await interaction.update({
                content: `🕐 **設定提醒：${setupData.eventName}**\n已選擇日期：${selectedDate}\n請選擇時間：`,
                components: [row]
            });

        } catch (error) {
            console.error('處理日期選擇錯誤:', error);
            await interaction.reply({
                content: '處理日期選擇時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
    // 處理時間選擇
    else if (interaction.customId === 'schedule_time_select') {
        try {
            const setupData = scheduleSetupData.get(interaction.user.id);
            if (!setupData) {
                return interaction.reply({
                    content: '設定資料已過期，請重新開始。',
                    ephemeral: true
                });
            }

            const selectedTime = interaction.values[0];
            setupData.selectedTime = selectedTime;
            setupData.step = 'reminder_selection';
            scheduleSetupData.set(interaction.user.id, setupData);

            // 顯示提前提醒選擇選單
            const reminderSelect = new StringSelectMenuBuilder()
                .setCustomId('schedule_reminder_select')
                .setPlaceholder('請選擇提前提醒時間')
                .addOptions(generateReminderOptions());

            const row = new ActionRowBuilder()
                .addComponents(reminderSelect);

            await interaction.update({
                content: `⏰ **設定提醒：${setupData.eventName}**\n已選擇日期：${setupData.selectedDate}\n已選擇時間：${selectedTime}\n請選擇提前提醒時間：`,
                components: [row]
            });

        } catch (error) {
            console.error('處理時間選擇錯誤:', error);
            await interaction.reply({
                content: '處理時間選擇時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
    // 處理提前提醒選擇
    else if (interaction.customId === 'schedule_reminder_select') {
        try {
            const setupData = scheduleSetupData.get(interaction.user.id);
            if (!setupData) {
                return interaction.reply({
                    content: '設定資料已過期，請重新開始。',
                    ephemeral: true
                });
            }

            const reminderMinutes = parseInt(interaction.values[0]);
            
            // 計算目標時間（使用台北時區）
            const [year, month, day] = setupData.selectedDate.split('-');
            const [hours, minutes] = setupData.selectedTime.split(':');
            
            // 創建台北時區的時間
            const taipeiTimeString = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00+08:00`;
            const targetTime = new Date(taipeiTimeString);

            // 檢查時間是否在未來（使用台北時區）
            const nowUTC = new Date();
            const nowTaipei = new Date(nowUTC.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
            if (targetTime <= nowTaipei) {
                return interaction.update({
                    content: '❌ 設定的時間必須是未來的時間！請重新設定。',
                    components: []
                });
            }

            // 計算提醒時間
            const reminderTime = new Date(targetTime.getTime() - reminderMinutes * 60 * 1000);

            const scheduleId = `${interaction.guild.id}-${interaction.channel.id}-${Date.now()}`;
            
            // 儲存排程資料
            scheduleData.set(scheduleId, {
                name: setupData.eventName,
                targetTime: targetTime,
                reminderTime: reminderTime,
                reminderMinutes: reminderMinutes,
                channelId: interaction.channel.id,
                userId: interaction.user.id,
                reminded: false,
                confirmed: false,
                lastReminderTime: null
            });

            // 清除暫存資料
            scheduleSetupData.delete(interaction.user.id);

            const formattedTargetTime = targetTime.toLocaleString('zh-TW', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Taipei'
            });

            const formattedReminderTime = reminderTime.toLocaleString('zh-TW', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Taipei'
            });

            let reminderText = '';
            if (reminderMinutes > 0) {
                if (reminderMinutes >= 60) {
                    const hours = Math.floor(reminderMinutes / 60);
                    reminderText = `\n📢 將在 ${formattedReminderTime} 開始提醒（提前 ${hours} 小時）`;
                } else {
                    reminderText = `\n📢 將在 ${formattedReminderTime} 開始提醒（提前 ${reminderMinutes} 分鐘）`;
                }
            } else {
                reminderText = '\n📢 將在事件時間準時提醒';
            }

            await interaction.update({
                content: `✅ **提醒設定完成**\n\n📅 事件：${setupData.eventName}\n🕐 時間：${formattedTargetTime}${reminderText}\n\n⚠️ 提醒時需要點擊確認按鈕，否則每 10 分鐘重複提醒。`,
                components: []
            });

        } catch (error) {
            console.error('處理提前提醒選擇錯誤:', error);
            await interaction.reply({
                content: '處理提前提醒選擇時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }

    if (interaction.customId === 'cs2_demo_select') {
        const selectedIndexes = interaction.values.map(v => parseInt(v));
        const storedMatches = cs2SelectedMatches.get(interaction.user.id + '_matches');
        if (!storedMatches) return interaction.reply({ content: '❌ 資料已過期，請重新執行 /cs2demos。', ephemeral: true });
        const selectedMatches = selectedIndexes.map(i => storedMatches[i]).filter(Boolean);
        cs2SelectedMatches.set(interaction.user.id, selectedMatches);
        const MAP_NAMES_SM = {
            'de_dust2': 'Dust2', 'de_mirage': 'Mirage', 'de_inferno': 'Inferno',
            'de_nuke': 'Nuke', 'de_overpass': 'Overpass', 'de_ancient': 'Ancient',
            'de_anubis': 'Anubis', 'de_vertigo': 'Vertigo', 'de_train': 'Train'
        };
        const modal = new ModalBuilder()
            .setCustomId('cs2_filename_modal')
            .setTitle('設定檔案名稱');
        selectedMatches.forEach((match, i) => {
            const mapName = match.mapName || MAP_NAMES_SM[match.map] || '未知地圖';
            const d = new Date();
            const yy = d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '');
            const defaultName = yy + '_' + mapName + '_' + match.time.replace(':', '');
            const input = new TextInputBuilder()
                .setCustomId('filename_' + i)
                .setLabel((mapName + ' (' + match.time + ')').slice(0, 45))
                .setStyle(TextInputStyle.Short)
                .setValue(defaultName.slice(0, 100))
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
        });
        await interaction.showModal(modal);
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
                content: `${record.date}\n<@${record.debtor_id}> 今天欠 <@${record.creditor_id}> ${Math.round(record.amount)} 元\n用途：${record.purpose}\n狀態：已收到`,
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
    // 處理喝水確認按鈕
    else if (interaction.customId === 'water_yes') {
        try {
            const today = new Date().toISOString().split('T')[0];

            // 檢查今天是否已經確認過
            const existing = await pool.query(
                'SELECT id FROM water_log WHERE user_id = $1 AND date = $2',
                [interaction.user.id, today]
            );

            if (existing.rows.length > 0) {
                return interaction.reply({
                    content: '你今天已經確認過喝水了！繼續保持 💧',
                    flags: ['Ephemeral']
                });
            }

            await pool.query(
                'INSERT INTO water_log (user_id, user_name, date) VALUES ($1, $2, $3)',
                [interaction.user.id, interaction.user.displayName || interaction.user.username, today]
            );

            await interaction.reply({
                content: `✅ <@${interaction.user.id}> 已確認喝水！繼續保持健康 💧`,
            });

        } catch (error) {
            console.error('處理喝水確認錯誤:', error);
            await interaction.reply({
                content: '處理確認時發生錯誤，請稍後再試。',
                flags: ['Ephemeral']
            });
        }
    }
    // 處理還沒喝水按鈕
    else if (interaction.customId === 'water_no') {
        try {
            await interaction.reply({
                content: `⚠️ <@${interaction.user.id}> 還沒喝水！快去喝一杯水吧 🚰`,
            });
        } catch (error) {
            console.error('處理喝水未確認錯誤:', error);
        }
    }
    // 處理提醒確認按鈕
    else if (interaction.customId.startsWith('reminder_confirm_')) {
        try {
            const scheduleId = interaction.customId.split('reminder_confirm_')[1];
            
            const schedule = scheduleData.get(scheduleId);
            if (!schedule) {
                return interaction.update({
                    content: '⚠️ 該提醒已過期或不存在。',
                    components: []
                });
            }

            // 檢查點擊按鈕的人是否為設定提醒的人
            if (interaction.user.id !== schedule.userId) {
                return interaction.reply({
                    content: '只有設定提醒的人可以確認提醒。',
                    ephemeral: true
                });
            }

            // 標記為已確認
            schedule.confirmed = true;
            scheduleData.set(scheduleId, schedule);

            await interaction.update({
                content: `✅ **提醒已確認**\n📅 事件：${schedule.name}\n🕐 時間已到，提醒完成！`,
                components: []
            });

            // 延遲清除排程資料（5分鐘後）
            setTimeout(() => {
                scheduleData.delete(scheduleId);
            }, 5 * 60 * 1000);

        } catch (error) {
            console.error('處理提醒確認錯誤:', error);
            await interaction.reply({
                content: '處理提醒確認時發生錯誤，請稍後再試。',
                ephemeral: true
            });
        }
    }
});

// 處理直接 @ 機器人的訊息
client.on('messageCreate', async message => {
    // 忽略機器人自己的訊息
    if (message.author.bot) return;
    
    // 只在被 @ 時回應
    if (message.mentions.has(client.user)) {
        // 檢查使用次數
        if (!checkUsageLimit(message.author.id)) {
            return message.reply('你今天的 AI 對話次數已用完，明天再來吧！');
        }
        
        // 移除 @ 標記
        const content = message.content.replace(`<@${client.user.id}>`, '').trim();
        
        if (!content) return;

        try {
            // 顯示 "正在輸入..." 狀態
            await message.channel.sendTyping();

            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-20250514",
                max_tokens: 800,
                temperature: 0.7,
                system: "你是一個友善的 Discord 機器人助手「小克勞德」。請用繁體中文回答問題，回答要簡潔有趣。",
                messages: [
                    {
                        role: "user",
                        content: content
                    }
                ]
            });

            const aiResponse = response.content[0].text;
            
            // 處理長回應
            if (aiResponse.length > 2000) {
                const chunks = splitMessage(aiResponse, 2000);
                let firstChunk = true;
                for (const chunk of chunks) {
                    if (firstChunk) {
                        await message.reply(chunk);
                        firstChunk = false;
                    } else {
                        await message.channel.send(chunk);
                    }
                }
            } else {
                await message.reply(aiResponse);
            }

        } catch (error) {
            console.error('Claude API 錯誤:', error);
            await message.reply('抱歉，我現在無法回應，請稍後再試。');
        }
    }
});

// 自動清理資料庫功能
async function cleanupDatabase() {
    try {
        console.log('開始執行資料庫清理...');
        
        // 清理已確認付款的債務記錄 (confirmed = true)
        const result = await pool.query(
            'DELETE FROM debts WHERE confirmed = TRUE'
        );
        
        const deletedCount = result.rowCount;
        console.log(`資料庫清理完成，已刪除 ${deletedCount} 筆已確認的債務記錄`);
        
        return deletedCount;
    } catch (error) {
        console.error('資料庫清理錯誤:', error);
        return 0;
    }
}

// 檢查是否為每日 00:00 (台北時區)
function shouldRunDailyCleanup() {
    const nowUTC = new Date();
    const now = new Date(nowUTC.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    // 檢查是否為 00:00 (允許在 00:00-00:01 之間執行)
    return hour === 0 && minute === 0;
}

// 記錄上次清理日期
let lastCleanupDate = null;

// 時間檢查和提醒功能
function checkScheduledReminders() {
    // 取得台北時區的當前時間
    const nowUTC = new Date();
    const now = new Date(nowUTC.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
    
    // 檢查是否需要執行每日資料庫清理
    const today = now.toDateString();
    if (shouldRunDailyCleanup() && lastCleanupDate !== today) {
        cleanupDatabase().then(deletedCount => {
            console.log(`每日資料庫清理執行完成 (${today})，清理了 ${deletedCount} 筆記錄`);
        });
        lastCleanupDate = today;
    }
    
    for (const [scheduleId, schedule] of scheduleData.entries()) {
        const channel = client.channels.cache.get(schedule.channelId);
        
        // 如果頻道不存在，直接刪除排程
        if (!channel) {
            scheduleData.delete(scheduleId);
            continue;
        }

        // 檢查是否到達提醒時間且已確認，清除排程
        if (schedule.confirmed) {
            continue; // 已確認的提醒不需要再處理
        }

        // 檢查是否到達提醒時間
        const shouldRemind = now >= schedule.reminderTime;
        
        if (shouldRemind && !schedule.reminded) {
            // 第一次提醒
            const confirmButton = new ButtonBuilder()
                .setCustomId(`reminder_confirm_${scheduleId}`)
                .setLabel('確認收到提醒')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const row = new ActionRowBuilder()
                .addComponents(confirmButton);

            const targetTimeStr = schedule.targetTime.toLocaleString('zh-TW', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Taipei'
            });

            let reminderText = '';
            if (schedule.reminderMinutes > 0) {
                if (schedule.reminderMinutes >= 60) {
                    const hours = Math.floor(schedule.reminderMinutes / 60);
                    reminderText = `（提前 ${hours} 小時提醒）`;
                } else {
                    reminderText = `（提前 ${schedule.reminderMinutes} 分鐘提醒）`;
                }
            }

            channel.send({
                content: `⏰ <@${schedule.userId}> **提醒時間到了！**\n\n📅 **事件：** ${schedule.name}\n🕐 **時間：** ${targetTimeStr} ${reminderText}\n\n⚠️ 請點擊下方按鈕確認收到提醒，否則每 10 分鐘會重複提醒。`,
                components: [row]
            });

            // 標記為已提醒並記錄提醒時間
            schedule.reminded = true;
            schedule.lastReminderTime = now;
            scheduleData.set(scheduleId, schedule);
        }
        // 檢查是否需要重複提醒（每10分鐘）
        else if (schedule.reminded && !schedule.confirmed && schedule.lastReminderTime) {
            const timeSinceLastReminder = now.getTime() - schedule.lastReminderTime.getTime();
            const tenMinutes = 10 * 60 * 1000; // 10分鐘的毫秒數

            if (timeSinceLastReminder >= tenMinutes) {
                // 檢查是否超過事件時間太久（超過2小時就停止提醒）
                const timeSinceTarget = now.getTime() - schedule.targetTime.getTime();
                const twoHours = 2 * 60 * 60 * 1000; // 2小時的毫秒數

                if (timeSinceTarget > twoHours) {
                    // 超過事件時間2小時，停止提醒並清除排程
                    channel.send({
                        content: `⏰ <@${schedule.userId}> 事件「${schedule.name}」的提醒已超時停止。`
                    });
                    scheduleData.delete(scheduleId);
                } else {
                    // 發送重複提醒
                    const confirmButton = new ButtonBuilder()
                        .setCustomId(`reminder_confirm_${scheduleId}`)
                        .setLabel('確認收到提醒')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅');

                    const row = new ActionRowBuilder()
                        .addComponents(confirmButton);

                    const targetTimeStr = schedule.targetTime.toLocaleString('zh-TW', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'Asia/Taipei'
                    });

                    channel.send({
                        content: `🔔 <@${schedule.userId}> **重複提醒**\n\n📅 **事件：** ${schedule.name}\n🕐 **時間：** ${targetTimeStr}\n\n⚠️ 請點擊按鈕確認收到提醒。`,
                        components: [row]
                    });

                    // 更新最後提醒時間
                    schedule.lastReminderTime = now;
                    scheduleData.set(scheduleId, schedule);
                }
            }
        }
        
        // 清除過期的排程（超過24小時未處理的）
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if (schedule.targetTime < oneDayAgo && !schedule.confirmed) {
            scheduleData.delete(scheduleId);
        }
    }
}

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
            },
            {
                name: 'claude',
                description: '與 Claude AI 單次對話',
                options: [
                    {
                        name: 'message',
                        description: '你想問的問題',
                        type: 3,
                        required: true
                    },
                    {
                        name: 'search',
                        description: '是否啟用網路搜尋（預設：否）',
                        type: 5,
                        required: false
                    }
                ]
            },
            {
                name: 'chat',
                description: '與 Claude AI 多輪對話（有記憶）',
                options: [
                    {
                        name: 'message',
                        description: '你想說的話',
                        type: 3,
                        required: true
                    },
                    {
                        name: 'search',
                        description: '是否啟用網路搜尋（預設：否）',
                        type: 5,
                        required: false
                    }
                ]
            },
            {
                name: 'clear-chat',
                description: '清除此頻道的對話歷史'
            },
            {
                name: 'schedule',
                description: '設定時間提醒'
            },
            {
                name: 'cs2demos',
                description: '查詢並下載 CS2 對戰 demo',
                options: [
                    {
                        name: 'date',
                        description: '查詢日期（格式：YYYY-MM-DD，預設今天）',
                        type: 3,
                        required: false
                    }
                ]
            }
        ];

        console.log('正在註冊斜線命令...');
        const registeredCommands = await client.application.commands.set(commands);
        console.log('已註冊的命令:', registeredCommands.map(cmd => cmd.name).join(', '));
        
        console.log('===== Bot 啟動完成 =====');
        console.log('支援功能: 債務管理、天氣查詢、Claude AI 對話、時間提醒');
        console.log('支援的縣市:', Object.keys(taiwanCities).join(', '));
        console.log('AI 對話: 每日限制 20 次，支援單次對話和多輪對話');
        
        // 啟動定時檢查提醒（每30秒檢查一次）
        setInterval(checkScheduledReminders, 30000);
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

// ─── CLUCODE Interactions HTTP Server ───────────────────────────────────────
// 處理 CLUCODE bot 發出的按鈕互動（水提醒等），透過 HTTP POST 接收 Discord 互動
const CLUCODE_PUBLIC_KEY = 'c326e4274894f034d6825e6f6cfa2e3df1c921f7436c82a848f9cd4bc2fd2676';
const interactionsApp = express();
const HTTP_PORT = process.env.PORT || 7414;

interactionsApp.use(express.raw({ type: 'application/json' }));

interactionsApp.post('/interactions', async (req, res) => {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body;

    // 驗證 Discord 簽名
    try {
        const isValid = nacl.sign.detached.verify(
            Buffer.from(timestamp + rawBody.toString()),
            Buffer.from(signature, 'hex'),
            Buffer.from(CLUCODE_PUBLIC_KEY, 'hex')
        );
        if (!isValid) return res.status(401).send('Invalid signature');
    } catch (e) {
        return res.status(401).send('Invalid signature');
    }

    const interaction = JSON.parse(rawBody.toString());

    // Discord PING 驗證
    if (interaction.type === 1) {
        return res.json({ type: 1 });
    }

    // 按鈕互動
    if (interaction.type === 3) {
        const customId = interaction.data?.custom_id;
        const userObj = interaction.member?.user || interaction.user;
        const userId = userObj?.id;
        const userName = userObj?.global_name || userObj?.username;

        if (customId === 'water_yes') {
            try {
                const today = new Date().toISOString().split('T')[0];
                const existing = await pool.query(
                    'SELECT id FROM water_log WHERE user_id = $1 AND date = $2',
                    [userId, today]
                );
                if (existing.rows.length > 0) {
                    return res.json({ type: 4, data: { content: '你今天已經確認過喝水了！繼續保持 💧', flags: 64 } });
                }
                await pool.query(
                    'INSERT INTO water_log (user_id, user_name, date) VALUES ($1, $2, $3)',
                    [userId, userName, today]
                );
                return res.json({ type: 4, data: { content: `✅ <@${userId}> 已確認喝水！繼續保持健康 💧` } });
            } catch (error) {
                console.error('喝水確認錯誤:', error);
                return res.json({ type: 4, data: { content: '處理時發生錯誤，請稍後再試。', flags: 64 } });
            }
        }

        if (customId === 'water_no') {
            return res.json({ type: 4, data: { content: `⚠️ <@${userId}> 還沒喝水！快去喝一杯水吧 🚰` } });
        }
    }

    return res.status(400).json({ error: 'Unknown interaction type' });
});

const httpServer = http.createServer(interactionsApp);

// CS2 WebSocket Server
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname === '/cs2-ws') {
        const token = searchParams.get('token') || req.headers['x-cs2-token'];
        if (token !== process.env.CS2_SECRET_TOKEN) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    console.log('[CS2 WS] 本機 service 已連線');
    cs2WsClient = ws;
    ws.on('message', (data) => handleCs2Message(data.toString()));
    ws.on('close', () => {
        console.log('[CS2 WS] 本機 service 已斷線');
        if (cs2WsClient === ws) cs2WsClient = null;
    });
    ws.on('error', (err) => console.error('[CS2 WS] 錯誤:', err.message));
});

httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP + WS server listening on port ${HTTP_PORT}`);
});
// ────────────────────────────────────────────────────────────────────────────

// 在程式結束時關閉資料庫連接
process.on('SIGINT', async () => {
    await pool.end();
    console.log('資料庫連接已關閉');
    process.exit(0);
});



client.login(process.env.DISCORD_TOKEN);


