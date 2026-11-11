// Built-in AI toolkit: chat, stream, embed - works with frontier models
// (OpenAI, Anthropic, Google, Mistral, Groq, xAI) and local LLMs
// (Ollama, vLLM, LM Studio, llama.cpp). No npm packages.
"use strict";

((globalThis) => {

  // ---- Provider registry ------------------------------------------------

  const PROVIDERS = {
    openai:    { url: "https://api.openai.com/v1",             envKey: "OPENAI_API_KEY",    defaultModel: "gpt-4o" },
    anthropic: { url: "https://api.anthropic.com/v1",          envKey: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-20250514", format: "anthropic" },
    google:    { url: "https://generativelanguage.googleapis.com/v1beta", envKey: "GOOGLE_API_KEY", defaultModel: "gemini-2.0-flash", format: "google" },
    mistral:   { url: "https://api.mistral.ai/v1",            envKey: "MISTRAL_API_KEY",   defaultModel: "mistral-large-latest" },
    groq:      { url: "https://api.groq.com/openai/v1",       envKey: "GROQ_API_KEY",      defaultModel: "llama-3.3-70b-versatile" },
    deepseek:  { url: "https://api.deepseek.com/v1",          envKey: "DEEPSEEK_API_KEY",  defaultModel: "deepseek-chat" },
    together:  { url: "https://api.together.xyz/v1",           envKey: "TOGETHER_API_KEY",  defaultModel: "meta-llama/Llama-3-70b-chat-hf" },
    fireworks: { url: "https://api.fireworks.ai/inference/v1", envKey: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct" },
    perplexity:{ url: "https://api.perplexity.ai",            envKey: "PERPLEXITY_API_KEY",defaultModel: "llama-3.1-sonar-large-128k-online" },
    xai:       { url: "https://api.x.ai/v1",                  envKey: "XAI_API_KEY",       defaultModel: "grok-3" },
    ollama:    { url: "http://localhost:11434/v1",             local: true },
    lmstudio:  { url: "http://localhost:1234/v1",              local: true },
    vllm:      { url: "http://localhost:8000/v1",              local: true },
    llamacpp:  { url: "http://localhost:8080/v1",              local: true },
  };

  function inferProvider(model) {
    if (!model) return null;
    const m = model.toLowerCase();
    if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "openai";
    if (m.startsWith("claude-")) return "anthropic";
    if (m.startsWith("gemini-")) return "google";
    if (m.startsWith("mistral-") || m.startsWith("codestral") || m.startsWith("pixtral")) return "mistral";
    if (m.startsWith("llama-") || m.startsWith("mixtral-") || m.startsWith("gemma-")) return "groq";
    if (m.startsWith("deepseek-")) return "deepseek";
    if (m.startsWith("grok-")) return "xai";
    return null;
  }

  async function detectLocal() {
    for (const [name, p] of Object.entries(PROVIDERS)) {
      if (!p.local) continue;
      try {
        const r = await fetch(`${p.url}/models`, { signal: AbortSignal.timeout(500) });
        if (r.ok) return name;
      } catch {}
    }
    return null;
  }

  // ---- AI class ---------------------------------------------------------

  class AI {
    #url;
    #model;
    #apiKey;
    #format; // "openai" | "anthropic" | "google"
    #systemPrompt;
    #history = [];
    #maxHistory;
    #resolved = false;

    constructor(options = {}) {
      if (typeof options === "string") options = { model: options };
      this.#url = options.url || options.baseURL || null;
      this.#model = options.model || null;
      this.#apiKey = options.apiKey || options.key || null;
      this.#systemPrompt = options.system || options.systemPrompt || null;
      this.#maxHistory = options.maxHistory ?? 20;
      this.#format = null;

      let provider = options.provider || null;
      if (!provider && this.#model) provider = inferProvider(this.#model);
      if (provider && PROVIDERS[provider]) {
        const p = PROVIDERS[provider];
        if (!this.#url) this.#url = p.url;
        if (!this.#model && p.defaultModel) this.#model = p.defaultModel;
        if (!this.#apiKey && p.envKey) this.#apiKey = process.env[p.envKey] || null;
        this.#format = p.format || "openai";
      }
    }

    async #resolve() {
      if (this.#resolved) return;
      this.#resolved = true;
      if (this.#url && this.#model) return;

      // Check env vars for known cloud providers
      if (!this.#url) {
        for (const [, p] of Object.entries(PROVIDERS)) {
          if (p.envKey && process.env[p.envKey]) {
            this.#url = p.url;
            this.#model = this.#model || p.defaultModel;
            this.#apiKey = process.env[p.envKey];
            this.#format = p.format || "openai";
            return;
          }
        }
      }

      // Auto-detect local LLM
      if (!this.#url) {
        const local = await detectLocal();
        if (local) {
          this.#url = PROVIDERS[local].url;
          this.#format = "openai";
          if (!this.#model) {
            try {
              const data = await (await fetch(`${this.#url}/models`)).json();
              this.#model = data.data?.[0]?.id || "default";
            } catch { this.#model = "default"; }
          }
          return;
        }
      }

      if (!this.#format) this.#format = "openai";
      if (!this.#url) throw new Error(
        "No LLM found. Set an API key env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, " +
        "GOOGLE_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, XAI_API_KEY) or install Ollama (ollama.com)"
      );
    }

    #messages(input) {
      const msgs = [];
      if (this.#systemPrompt) msgs.push({ role: "system", content: this.#systemPrompt });
      msgs.push(...this.#history);
      if (typeof input === "string") msgs.push({ role: "user", content: input });
      else if (Array.isArray(input)) msgs.push(...input);
      else if (input && typeof input === "object") msgs.push(input);
      return msgs;
    }

    #pushHistory(role, content) {
      this.#history.push({ role, content });
      while (this.#history.length > this.#maxHistory * 2) this.#history.shift();
    }

    // ---- Chat (non-streaming) -------------------------------------------

    async chat(input, options = {}) {
      await this.#resolve();
      const msgs = this.#messages(input);
      const model = options.model || this.#model;
      let reply;

      if (this.#format === "anthropic") {
        reply = await this.#anthropicChat(msgs, model, options);
      } else if (this.#format === "google") {
        reply = await this.#googleChat(msgs, model, options);
      } else {
        reply = await this.#openaiChat(msgs, model, options);
      }

      if (typeof input === "string") this.#pushHistory("user", input);
      this.#pushHistory("assistant", reply);
      return reply;
    }

    async #openaiChat(msgs, model, opts) {
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;
      const res = await fetch(`${this.#url}/chat/completions`, {
        method: "POST", headers,
        body: JSON.stringify({ model, messages: msgs, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens || opts.max_tokens, stream: false }),
      });
      if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);
      return (await res.json()).choices?.[0]?.message?.content?.trim() || "";
    }

    async #anthropicChat(msgs, model, opts) {
      const system = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
      const body = {
        model, messages: msgs.filter(m => m.role !== "system"),
        max_tokens: opts.maxTokens || opts.max_tokens || 4096,
        temperature: opts.temperature ?? 0.7,
        stream: false,
      };
      if (system) body.system = system;
      const res = await fetch(`${this.#url}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.#apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
      return (await res.json()).content?.[0]?.text || "";
    }

    async #googleChat(msgs, model, opts) {
      const system = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
      const contents = msgs.filter(m => m.role !== "system").map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const body = { contents, generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: opts.maxTokens || opts.max_tokens || 4096 } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await fetch(`${this.#url}/models/${model}:generateContent?key=${this.#apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Google AI error ${res.status}: ${await res.text()}`);
      return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    // ---- Streaming ------------------------------------------------------

    async *stream(input, options = {}) {
      await this.#resolve();
      const msgs = this.#messages(input);
      const model = options.model || this.#model;
      let fullReply = "";

      if (this.#format === "anthropic") {
        yield* this.#anthropicStream(msgs, model, options, t => fullReply += t);
      } else if (this.#format === "google") {
        // Google streaming uses SSE on a different endpoint
        yield* this.#googleStream(msgs, model, options, t => fullReply += t);
      } else {
        yield* this.#openaiStream(msgs, model, options, t => fullReply += t);
      }

      if (typeof input === "string") this.#pushHistory("user", input);
      this.#pushHistory("assistant", fullReply);
    }

    async *#readSSE(res) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            yield data;
          }
        }
      }
    }

    async *#openaiStream(msgs, model, opts, collect) {
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;
      const res = await fetch(`${this.#url}/chat/completions`, {
        method: "POST", headers,
        body: JSON.stringify({ model, messages: msgs, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens || opts.max_tokens, stream: true }),
      });
      if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);
      for await (const data of this.#readSSE(res)) {
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) { collect(token); yield token; }
        } catch {}
      }
    }

    async *#anthropicStream(msgs, model, opts, collect) {
      const system = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
      const body = {
        model, messages: msgs.filter(m => m.role !== "system"),
        max_tokens: opts.maxTokens || opts.max_tokens || 4096,
        temperature: opts.temperature ?? 0.7, stream: true,
      };
      if (system) body.system = system;
      const res = await fetch(`${this.#url}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.#apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
      for await (const data of this.#readSSE(res)) {
        try {
          const evt = JSON.parse(data);
          const token = evt.delta?.text || evt.completion;
          if (token) { collect(token); yield token; }
        } catch {}
      }
    }

    async *#googleStream(msgs, model, opts, collect) {
      const system = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
      const contents = msgs.filter(m => m.role !== "system").map(m => ({
        role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }],
      }));
      const body = { contents, generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: opts.maxTokens || opts.max_tokens || 4096 } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await fetch(`${this.#url}/models/${model}:streamGenerateContent?alt=sse&key=${this.#apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Google AI error ${res.status}: ${await res.text()}`);
      for await (const data of this.#readSSE(res)) {
        try {
          const token = JSON.parse(data).candidates?.[0]?.content?.parts?.[0]?.text;
          if (token) { collect(token); yield token; }
        } catch {}
      }
    }

    // ---- Embeddings -----------------------------------------------------

    async embed(input, options = {}) {
      await this.#resolve();
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;
      const texts = Array.isArray(input) ? input : [input];

      if (this.#format === "google") {
        const model = options.model || "text-embedding-004";
        const res = await fetch(`${this.#url}/models/${model}:embedContent?key=${this.#apiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: { parts: [{ text: texts[0] }] } }),
        });
        if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
        const vec = (await res.json()).embedding?.values || [];
        return Array.isArray(input) ? [vec] : vec;
      }

      const res = await fetch(`${this.#url}/embeddings`, {
        method: "POST", headers,
        body: JSON.stringify({ model: options.model || this.#model, input: texts }),
      });
      if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
      const vecs = (await res.json()).data?.map(d => d.embedding) || [];
      return Array.isArray(input) ? vecs : vecs[0];
    }

    // ---- Utilities ------------------------------------------------------

    static similarity(a, b) {
      let dot = 0, nA = 0, nB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
      return dot / (Math.sqrt(nA) * Math.sqrt(nB));
    }

    clear() { this.#history = []; return this; }
    get history() { return [...this.#history]; }
    get model() { return this.#model; }
    get provider() { return this.#format; }
  }

  // ---- Quick API --------------------------------------------------------

  let _default = null;
  function ai(optionsOrPrompt, maybePrompt) {
    if (typeof optionsOrPrompt === "string") {
      if (!_default) _default = new AI();
      return _default.chat(optionsOrPrompt);
    }
    if (maybePrompt !== undefined) return new AI(optionsOrPrompt).chat(maybePrompt);
    return new AI(optionsOrPrompt);
  }
  ai.AI = AI;
  ai.similarity = AI.similarity;

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.ai = ai;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
