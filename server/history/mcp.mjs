import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { historyTools, historyToolInstructions } from "./index.mjs";

const socketPath = process.env.AGENTFORGE_HISTORY_SOCKET;
if (!socketPath) throw new Error("历史查询桥未配置");
const server = new Server({name:"agentforge-history",version:"1.0.0"},{capabilities:{tools:{}},instructions:historyToolInstructions});
server.setRequestHandler(ListToolsRequestSchema,async () => ({tools:historyTools}));
server.setRequestHandler(CallToolRequestSchema,async request => {
  try {
    if (!historyTools.some(t => t.name === request.params.name)) throw new Error("未知历史工具");
    const result = await new Promise((resolve,reject) => {
      const req = http.request({socketPath,path:"/query",method:"POST",headers:{"Content-Type":"application/json"}},res => {
        let body=""; res.setEncoding("utf8");
        res.on("data",chunk => { body+=chunk; if (body.length>4000000) req.destroy(new Error("历史结果过大")); });
        res.on("end",() => { try { const value=JSON.parse(body); value.error ? reject(new Error(value.error)) : resolve(value.result); } catch(error) {reject(error);} });
      });
      req.setTimeout(15000,() => req.destroy(new Error("历史查询超时")));
      req.on("error",reject); req.end(JSON.stringify({tool:request.params.name,args:request.params.arguments || {}}));
    });
    return {content:[{type:"text",text:JSON.stringify(result)}]};
  } catch (error) { return {isError:true,content:[{type:"text",text:/^历史|^缺少历史|^交付文件|^二进制|^当前入口|^未知历史/.test(error.message) ? error.message : "历史查询桥不可用，请稍后重试"}]}; }
});
await server.connect(new StdioServerTransport());
