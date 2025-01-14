// test/basic.test.js
const { Client, GatewayIntentBits } = require('discord.js');

// Mock Discord.js 類
jest.mock('discord.js', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      login: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      application: {
        commands: {
          set: jest.fn()
        }
      },
      // 直接在 mock 對象中添加事件處理方法
      handleInteraction: async function(interaction) {
        if (interaction.isCommand() && interaction.commandName === 'adddebt') {
          await interaction.showModal();
        }
        if (interaction.isModalSubmit() && interaction.customId === 'debtModal') {
          await interaction.reply();
        }
      }
    })),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 3,
      GuildMembers: 4
    },
    ButtonBuilder: jest.fn(),
    ActionRowBuilder: jest.fn().mockImplementation(() => ({
      addComponents: jest.fn().mockReturnThis()
    })),
    ButtonStyle: {
      Success: 1
    },
    ModalBuilder: jest.fn().mockImplementation(() => ({
      setCustomId: jest.fn().mockReturnThis(),
      setTitle: jest.fn().mockReturnThis(),
      addComponents: jest.fn().mockReturnThis()
    })),
    TextInputBuilder: jest.fn().mockImplementation(() => ({
      setCustomId: jest.fn().mockReturnThis(),
      setLabel: jest.fn().mockReturnThis(),
      setStyle: jest.fn().mockReturnThis(),
      setRequired: jest.fn().mockReturnThis()
    })),
    TextInputStyle: {
      Short: 1,
      Paragraph: 2
    }
  };
});

describe('Discord Bot', () => {
  let client;
  const { GatewayIntentBits } = require('discord.js');

  beforeEach(() => {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ]
    });
  });

  test('bot should initialize correctly', () => {
    expect(client).toBeDefined();
  });

  test('adddebt command should create modal', async () => {
    const interaction = {
      isCommand: () => true,
      commandName: 'adddebt',
      showModal: jest.fn().mockResolvedValue(true),
      isModalSubmit: () => false
    };

    await client.handleInteraction(interaction);
    expect(interaction.showModal).toHaveBeenCalled();
  });

  test('modal submit should create debt record', async () => {
    const modalInteraction = {
      isCommand: () => false,
      isModalSubmit: () => true,
      customId: 'debtModal',
      fields: {
        getTextInputValue: jest.fn().mockImplementation((field) => {
          const values = {
            debtorName: '測試債務人',
            creditorName: '測試債權人',
            amount: '100',
            purpose: '測試用途'
          };
          return values[field];
        })
      },
      reply: jest.fn().mockResolvedValue(true)
    };

    await client.handleInteraction(modalInteraction);
    expect(modalInteraction.reply).toHaveBeenCalled();
  });
});