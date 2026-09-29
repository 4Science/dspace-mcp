/**
 * HTTP transport entry point.
 * Works both for local development AND on AWS Lambda via Lambda Web Adapter.
 * Stateless: each request creates a fresh server+transport (Lambda-safe).
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../server.js';
import { config } from '../config.js';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: config.name, version: config.version });
});

// MCP endpoint — stateless: fresh server+transport per request
app.post('/mcp', async (req, res) => {
  try {
    const { server } = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });

    res.on('close', () => {
      transport.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Handle GET/DELETE for MCP protocol (returns 405 in stateless mode)
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed — this server is stateless' });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed — this server is stateless' });
});

const host = process.env.AWS_LAMBDA_FUNCTION_NAME ? '0.0.0.0' : '127.0.0.1';
app.listen(config.port, host, () => {
  console.error(`DSpace MCP HTTP server listening on http://${host}:${config.port}/mcp`);
});
