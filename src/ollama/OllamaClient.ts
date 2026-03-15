export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface TagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

interface StreamChunk {
  message?: {
    role?: string;
    content?: string;
  };
  error?: string;
  done?: boolean;
}

export class OllamaClient {
  public constructor(private readonly baseUrl: string) {}

  public async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(this.url('/api/tags'), {
      signal
    });
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status} ${response.statusText}.`);
    }

    const payload = (await response.json()) as TagsResponse;
    return (payload.models ?? [])
      .map((model) => model.name ?? model.model ?? '')
      .filter((name) => name.length > 0);
  }

  public async streamChat(
    model: string,
    messages: ChatMessage[],
    onChunk: (text: string) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status} ${response.statusText}.`);
    }

    if (!response.body) {
      throw new Error('Ollama did not return a response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const chunk = JSON.parse(line) as StreamChunk;
        if (chunk.error) {
          throw new Error(chunk.error);
        }

        const content = chunk.message?.content ?? '';
        if (content) {
          await onChunk(content);
        }

        if (chunk.done) {
          return;
        }
      }
    }

    const trailing = buffer.trim();
    if (!trailing) {
      return;
    }

    const chunk = JSON.parse(trailing) as StreamChunk;
    if (chunk.error) {
      throw new Error(chunk.error);
    }

    const content = chunk.message?.content ?? '';
    if (content) {
      await onChunk(content);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }
}
