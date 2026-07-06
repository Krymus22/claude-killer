import { webRead } from "../src/apiResearcher.js";

console.log("=== Full MCP docs ===\n");
const content = await webRead("https://create.roblox.com/docs/studio/mcp.md");
console.log(content);

process.exit(0);
