// Built-in AI toolkit: chat, stream, embed - works with any OpenAI-compatible
// LLM (Ollama, vLLM, LM Studio, llama.cpp, or cloud APIs).
// No npm packages. No configuration for local Ollama.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // Auto-detect local LLM endpoint.
  const DEFAULTS = {
    ollama: "http://localhost:11434/v1",
    lmstudio: "http://localhost:1234/v1",
    vllm: "http://localhost:8000/v1",
    llamacpp: "http://localhost:8080/v1",
  };

  async function detectEndpoint() {
    for (const [name, url] of Object.entries(DEFAULTS)) {
      try {
        const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return { url, provider: name };
      } catch {}
    }
    return null;
  }

  class AI {
    #url;
    #model;
    #apiKey;
    #systemPrompt;
    #history = [];
    #maxHistory;
    #detected = null;

    constructor(options = {}) {
      if (typeof options === "string") options = { model: options };
      this.#url = options.url || options.baseURL || null;
      this.#model = options.model || null;
      this.#apiKey = options.apiKey || options.key || process.env.OPENAI_API_KEY || null;
      this.#systemPrompt = options.system || options.systemPrompt || null;
      this.#maxHistory = options.maxHistory ?? 20;
    }

    async #resolve() {
      if (this.#url && this.#model) return;
      if (!this.#detected) this.#detected = await detectEndpoint();
      if (this.#detected) {
        if (!this.#url) this.#url = this.#detected.url;
        if (!this.#model) {
          try {
            const res = await fetch(`${this.#url}/models`);
            const data = await res.json();
            this.#model = data.data?.[0]?.id || "default";
          } catch {
            this.#model = "default";
          }
        }
      }
      if (!this.#url) throw new Error("No LLM endpoint found. Install Ollama (ollama.com) or set malia.ai({ url: '...' })");
    }

    #buildMessages(input) {
      const messages = [];
      if (this.#systemPrompt) messages.push({ role: "system", content: this.#systemPrompt });
      for (const msg of this.#history) messages.push(msg);
      if (typeof input === "string") {
        messages.push({ role: "user", content: input });
      } else if (Array.isArray(input)) {
        messages.push(...input);
      } else if (input && typeof input === "object") {
        messages.push(input);
      }
      return messages;
    }

    // Simple chat: send message, get reply string.
    async chat(input, options = {}) {
      await this.#resolve();
      const messages = this.#buildMessages(input);
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

      const res = await fetch(`${this.#url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model || this.#model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? options.max_tokens,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || "";

      // Track conversation
      if (typeof input === "string") this.#history.push({ role: "user", content: input });
      this.#history.push({ role: "assistant", content: reply });
      while (this.#history.length > this.#maxHistory * 2) {
        this.#history.shift();
      }
      return reply;
    }

    // Streaming chat: returns async iterable of tokens.
    async *stream(input, options = {}) {
      await this.#resolve();
      const messages = this.#buildMessages(input);
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

      const res = await fetch(`${this.#url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model || this.#model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? options.max_tokens,
          stream: true,
        }),
      });
      if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullReply = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              fullReply += token;
              yield token;
            }
          } catch {}
        }
      }

      if (typeof input === "string") this.#history.push({ role: "user", content: input });
      this.#history.push({ role: "assistant", content: fullReply });
      while (this.#history.length > this.#maxHistory * 2) this.#history.shift();
    }

    // Generate embeddings.
    async embed(input, options = {}) {
      await this.#resolve();
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

      const texts = Array.isArray(input) ? input : [input];
      const res = await fetch(`${this.#url}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model || this.#model,
          input: texts,
        }),
      });
      if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const embeddings = data.data?.map(d => d.embedding) || [];
      return Array.isArray(input) ? embeddings : embeddings[0];
    }

    // Cosine similarity between two vectors.
    static similarity(a, b) {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Clear conversation history.
    clear() {
      this.#history = [];
      return this;
    }

    // Get conversation history.
    get history() {
      return [...this.#history];
    }
  }

  // Quick one-shot: malia.ai("prompt") or malia.ai({ model, system }, "prompt")
  let _default = null;
  function ai(optionsOrPrompt, maybePrompt) {
    if (typeof optionsOrPrompt === "string") {
      if (!_default) _default = new AI();
      return _default.chat(optionsOrPrompt);
    }
    if (maybePrompt !== undefined) {
      const instance = new AI(optionsOrPrompt);
      return instance.chat(maybePrompt);
    }
    return new AI(optionsOrPrompt);
  }
  ai.AI = AI;
  ai.similarity = AI.similarity;

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.ai = ai;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
