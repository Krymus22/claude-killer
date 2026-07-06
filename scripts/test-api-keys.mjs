/**
 * Testa todas as 4 API keys da NVIDIA.
 * Faz uma request mínima (max_tokens=1) para cada key.
 */
import dotenv from "dotenv";
dotenv.config();

const keys = process.env.NVIDIA_API_KEYS?.split(",").map(k => k.trim()).filter(k => k) ?? [];
console.log(`Found ${keys.length} keys\n`);

for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  const prefix = key.slice(0, 20);
  const suffix = key.slice(-4);
  const start = Date.now();

  try {
    const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const elapsed = Date.now() - start;
    const status = resp.status;
    const body = await resp.text();

    if (status === 200) {
      console.log(`Key #${i} (${prefix}...${suffix}): OK in ${elapsed}ms`);
    } else {
      const bodyPreview = body.slice(0, 200);
      console.log(`Key #${i} (${prefix}...${suffix}): FAIL ${status} in ${elapsed}ms`);
      console.log(`  Body: ${bodyPreview}`);
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`Key #${i} (${prefix}...${suffix}): ERROR in ${elapsed}ms`);
    console.log(`  ${err.message}`);
  }
}

process.exit(0);
