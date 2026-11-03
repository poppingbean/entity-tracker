#!/usr/bin/env node
// Safe Near Agent Guard over stdio, for an MCP client that starts the server itself (Claude Desktop, Codex, Cursor, a custom agent).
// It needs no database: it asks the public API of a Safe Near deployment (SAFE_NEAR_URL, default https://app.safe-near.org).
//   node src/agent/mcp-stdio.js            SAFE_NEAR_API_KEY=<key> lifts the per-IP rate limit
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentGuard } from './mcp.js';
import { httpApi } from './api.js';

const server = createAgentGuard(httpApi());
await server.connect(new StdioServerTransport());
process.stderr.write(`Safe Near Agent Guard (stdio) ready · checks via ${process.env.SAFE_NEAR_URL || 'https://app.safe-near.org'}\n`);
