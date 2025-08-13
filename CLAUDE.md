# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is a Discord bot for tracking borrowing and repaying money between users in Discord servers. The bot provides comprehensive debt management, AI chat capabilities, weather information, and time reminders.

## Architecture

### Core Features
1. **Debt Management System** - Track borrowing/lending with database persistence and confirmation workflow
2. **AI Chat Integration** - Claude AI integration with both single-use and conversation modes, includes web search
3. **Weather Service** - Taiwan weather information using Open-Meteo API
4. **Time Reminder System** - Scheduled reminders with recurring notifications
5. **Database Auto-cleanup** - Daily cleanup of confirmed debt records

### Key Components
- **Database Schema**: Single `debts` table with columns: id, debtor_id, debtor_name, creditor_id, creditor_name, amount, purpose, date, confirmed
- **In-Memory Storage**: Maps for conversation history, user usage limits, debt data, schedule data
- **Rate Limiting**: 20 AI interactions per user per day, search cooldowns
- **Taiwan Time Zone**: All scheduling uses Asia/Taipei timezone

### Command Architecture
- **Slash Commands**: `/adddebt`, `/checkdebt`, `/weather`, `/claude`, `/chat`, `/clear-chat`, `/schedule`
- **Autocomplete**: User selection, city selection for weather
- **Interactive Elements**: Modals for data input, buttons for confirmations, select menus for scheduling
- **Message Handlers**: Direct @ mentions trigger AI responses

## Development Commands

- `npm start` - Start the Discord bot

## Key Dependencies

- **Discord.js v14.17.3** - Discord API integration with slash commands, buttons, modals
- **PostgreSQL (pg v8.16.0)** - Database operations with connection pooling
- **Anthropic AI SDK v0.27.3** - Claude AI integration for chat features
- **duck-duck-scrape v2.2.7** - Web search functionality
- **dotenv v16.4.7** - Environment variable management

## Environment Variables Required

- `DISCORD_TOKEN` - Discord bot token
- `DATABASE_URL` - PostgreSQL connection string
- `ANTHROPIC_API_KEY` - Claude AI API key
- `NODE_ENV` - Set to 'production' for SSL database connections

## Database Operations

- Database auto-initializes on startup with required tables
- Automatic daily cleanup at 00:00 Taiwan time removes confirmed debt records
- Connection pooling handles concurrent operations
- Graceful shutdown closes database connections

## AI Integration Details

- **Model**: claude-sonnet-4-20250514
- **Usage Limits**: 20 requests per user per day
- **Conversation Memory**: Per-channel conversation history (max 20 messages)
- **Web Search**: Optional DuckDuckGo integration with rate limiting
- **Response Handling**: Automatic message splitting for responses > 2000 characters

## Scheduling System

- **Time Zone**: All operations use Asia/Taipei
- **Reminder Flow**: Event name → Date selection → Time selection → Reminder offset
- **Persistence**: In-memory storage with automatic cleanup
- **Recurring**: 10-minute intervals for unconfirmed reminders, auto-timeout after 2 hours