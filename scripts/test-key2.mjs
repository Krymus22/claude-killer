/**
 * Testa key #2 com timeout de 2 minutos.
 */
import dotenv from "dotenv";
dotenv.config();

const keys = process.env.NVIDIA_API_KEYS?.split(",").map(k => k.trim()).filter(k => k) ?? [];
const key2 = keys[2]; // Key #2

console.log(`Testing Key #2 (${key2.slice(0, 20)}...${key2.slice(-4)})`);
console.log(`Timeout: 120 seconds (2 minutes)`);
console.log(`Waiting...\n`);

const start = Date.now();

try {
  const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key2}`,
    },
    body: JSON.stringify({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000), // 2 minutes
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const status = resp.status;
  const body = await resp.text();

  if (status === 200) {
    console.log(`✅ Key #2: OK in ${elapsed}s`);
  } else {
    console.log(`❌ Key #2: FAIL ${status} in ${elapsed}s`);
    console.log(`Body: ${body.slice(0, 300)}`);
  }
} catch (err) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`❌ Key #2: ERROR in ${elapsed}s`);
  console.log(`  ${err.message}`);
}

process.exit(0);
