export interface SseMessage {
  event: string;
  data: string;
  id: string | undefined;
}

/**
 * Incremental Server-Sent Events parser (WHATWG spec subset: event, data, id; comments ignored).
 * Feed it decoded text chunks of any size.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onMessage: (msg: SseMessage) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) return;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
  }

  private dispatch(): void {
    if (this.data.length > 0) {
      this.onMessage({ event: this.event || "message", data: this.data.join("\n"), id: this.id });
    }
    this.event = "";
    this.data = [];
  }
}
