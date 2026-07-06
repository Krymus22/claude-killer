import { webRead } from "../src/apiResearcher.js";

console.log("=== Roblox Studio MCP setup instructions ===\n");
const content = await webRead("https://create.roblox.com/docs/studio/mcp");
// Procurar pela seção de JSON configuration
const jsonSection = content.indexOf("JSON configuration");
if (jsonSection > -1) {
  console.log(content.slice(jsonSection, jsonSection + 3000));
} else {
  console.log(content.slice(2000, 6000));
}

process.exit(0);
