/**
 * test-web-search-debug.mjs — Testa buscar_web em condições reais.
 * Simula exatamente o que acontece quando a IA chama buscar_web.
 */
import * as fs from "node:fs";

const ENV_PATH = "/home/z/my-project/claude-killer/.env";
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
process.env.HOME = "/home/z";
process.chdir("/home/z/my-project/claude-killer");

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m" };

console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}DEBUG: buscar_web com Kimi K2.6${C.reset}`);
console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}\n`);

// 1. Testar webSearch diretamente
console.log(`${C.yellow}=== TESTE 1: webSearch() direto ===${C.reset}`);
const { webSearch } = await import("/home/z/my-project/claude-killer/dist/apiResearcher.js");

const queries = [
  "AI artificial intelligence news July 1 2026",
  "AI news today",
  "notícias inteligência artificial julho 2026",
];

for (const query of queries) {
  console.log(`\n${C.cyan}Query: "${query}"${C.reset}`);
  const start = Date.now();
  try {
    const results = await webSearch(query, 5);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ${C.green}✓ ${results.length} resultados em ${elapsed}s${C.reset}`);
    for (const r of results.slice(0, 3)) {
      console.log(`    ${C.dim}-${C.reset} ${r.title?.slice(0, 60)}`);
      console.log(`      ${C.dim}${r.url?.slice(0, 80)}${C.reset}`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ${C.red}✗ Erro em ${elapsed}s: ${err.message}${C.reset}`);
  }
}

// 2. Testar o Bing raw (sem parseBingResults)
console.log(`\n${C.yellow}=== TESTE 2: Bing raw (curl direto) ===${C.reset}`);
const { execSync } = await import("node:child_process");

const testQueries = ["AI news today", "artificial intelligence 2026"];
for (const q of testQueries) {
  console.log(`\n${C.cyan}Query: "${q}"${C.reset}`);
  try {
    const html = execSync(
      `curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --max-time 8 ` +
      `"https://www.bing.com/search?q=${encodeURIComponent(q)}&count=5&setlang=en"`,
      { encoding: "utf8", timeout: 15000 }
    );
    console.log(`  HTML size: ${html.length} bytes`);
    
    // Check for b_algo
    const algoCount = (html.match(/class="b_algo"/g) || []).length;
    console.log(`  b_algo blocks: ${algoCount}`);
    
    // Check for h2
    const h2Count = (html.match(/<h2/g) || []).length;
    console.log(`  h2 tags: ${h2Count}`);
    
    // Try to decode URLs
    const decoded = html.replace(/&amp;/g, "&");
    const urlMatches = decoded.match(/u=a1([A-Za-z0-9+/=_-]+)/g) || [];
    console.log(`  u=a1 matches: ${urlMatches.length}`);
    
    // Check for CAPTCHA or blocks
    if (html.includes("anomaly") || html.includes("captcha") || html.includes("blocked")) {
      console.log(`  ${C.red}⚠️ CAPTCHA/BLOCK detected!${C.reset}`);
    }
    
    // Show first 200 chars of first b_algo block
    const algoBlocks = html.split(/class="b_algo"/).slice(1);
    if (algoBlocks.length > 0) {
      const cleanText = algoBlocks[0]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      console.log(`  First block text: ${cleanText}`);
    }
  } catch (err) {
    console.log(`  ${C.red}✗ Erro: ${err.message?.slice(0, 100)}${C.reset}`);
  }
}

// 3. Testar buscar_web via agent (como a IA usa)
console.log(`\n${C.yellow}=== TESTE 3: buscar_web via agent (Kimi K2.6) ===${C.reset}`);
const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");

const prompt = `Use a ferramenta buscar_web para pesquisar "AI news today July 2026". 
Depois me diga quantos resultados retornaram e liste os títulos.
Se não retornar resultados, me diga exatamente o que aconteceu.`;

try {
  const result = await agent.runAgentLoop(
    prompt,
    undefined, undefined, undefined, undefined,
    (name, args) => {
      if (name === "buscar_web") {
        console.log(`  ${C.yellow}[TOOL] buscar_web: ${args?.query}${C.reset}`);
      }
    },
    (n, ok, r) => {
      console.log(`  ${ok ? C.green : C.red}[RESULT] ${n} ok=${ok}${C.reset} ${r.slice(0, 200)}`);
    },
    undefined, false
  );
  console.log(`\n${C.dim}Result: ${String(result).slice(0, 300)}${C.reset}`);
} catch (err) {
  console.log(`  ${C.red}ERROR: ${err.message?.slice(0, 300)}${C.reset}`);
}

console.log(`\n${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.dim}Debug complete.${C.reset}\n`);
process.exit(0);
