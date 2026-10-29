// Explicit local E2E service, not a Provider fixture. No network or business data.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFile } from 'node:fs/promises';
const [log, proof] = process.argv.slice(2);
await appendFile(log, 'started\n');
const server = new Server({name:'marketplace-probe',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'read_validation_code',description:'Read the local verification code required by the selected development skill.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if(request.params.name !== 'read_validation_code') throw new Error('unknown tool');
  await appendFile(log,'called\n');
  return {content:[{type:'text',text:JSON.stringify({verificationCode:proof})}]};
});
await server.connect(new StdioServerTransport());
