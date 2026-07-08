import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "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",
  baseURL: "https://integrate.api.nvidia.com/v1",
});

// Test 1: Simple
console.log("=== Test 1: Simple (no tools, no stream_options) ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 50,
    stream: false,
  });
  console.log("OK:", r.choices[0].message.content?.slice(0, 50));
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 100));
}

// Test 2: With stream_options
console.log("=== Test 2: With stream_options ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 50,
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const chunk of r) {}
  console.log("OK: stream consumed");
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 100));
}

// Test 3: With tools + parallel_tool_calls
console.log("=== Test 3: With tools + parallel_tool_calls ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 50,
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Le arquivo",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  });
  console.log("OK:", r.choices[0].message.content?.slice(0, 50));
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 100));
}

// Test 4: With chat_template_kwargs
console.log("=== Test 4: With chat_template_kwargs ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 50,
    stream: false,
    chat_template_kwargs: { thinking_mode: "enabled" },
  });
  console.log("OK:", r.choices[0].message.content?.slice(0, 50));
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 100));
}

// Test 5: Everything together (like createStreamRequest)
console.log("=== Test 5: Everything (like createStreamRequest) ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 32768,
    stream: true,
    stream_options: { include_usage: true },
    tools: [{
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Le arquivo",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    temperature: 1.0,
    top_p: 0.95,
    chat_template_kwargs: { thinking_mode: "enabled" },
  });
  for await (const chunk of r) {}
  console.log("OK: full stream consumed");
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 200));
}

// Test 6: Without chat_template_kwargs but everything else
console.log("=== Test 6: Everything EXCEPT chat_template_kwargs ===");
try {
  const r = await client.chat.completions.create({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "diga ola" }],
    max_tokens: 32768,
    stream: true,
    stream_options: { include_usage: true },
    tools: [{
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Le arquivo",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    temperature: 1.0,
    top_p: 0.95,
  });
  for await (const chunk of r) {}
  console.log("OK: stream consumed (no chat_template_kwargs)");
} catch (e) {
  console.log("ERR:", e.status, e.message?.slice(0, 200));
}
