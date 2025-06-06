# CLAUDE.md - Instructions for Claude

## Project Overview
This is a Discord bot for tracking borrowing and repaying money between users. The bot is built with Discord.js v14 and uses PostgreSQL for data persistence.

## Key Files
- `index.js` - Main bot entry point
- `package.json` - Project dependencies and scripts
- `test/` - Jest test files

## Development Commands
- `npm test` - Run Jest tests
- `npm start` - Start the Discord bot

## Dependencies
- Discord.js v14.17.3 for Discord API integration
- PostgreSQL (pg v8.16.0) for database operations
- Anthropic AI SDK for AI features
- dotenv for environment variable management

## Testing
- Uses Jest testing framework
- Test files located in `test/` directory
- Run tests with `npm test`

## Environment Setup
- Requires Discord bot token and database credentials in environment variables
- Uses dotenv for configuration management