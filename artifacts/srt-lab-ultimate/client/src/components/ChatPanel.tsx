import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string | number;
}

export function ChatPanel({ analysisId }: { analysisId: string }) {
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/analysis/${analysisId}/chat/history`);
      if (r.ok) {
        const data = await r.json() as ChatMessage[];
        setHistory(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
  }, [analysisId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streamedText]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const content = input;
    setInput("");
    setIsStreaming(true);
    setStreamedText("");

    try {
      const response = await fetch(`/api/analysis/${analysisId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!response.body) throw new Error("No body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let isDone = false;
      while (!isDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""));
          if (!dataLines.length) continue;
          const payload = dataLines.join("\n");
          try {
            const data = JSON.parse(payload) as { content?: string; done?: boolean };
            if (data.content) setStreamedText((prev) => prev + data.content);
            if (data.done) isDone = true;
          } catch {
            // ignore partial / malformed event
          }
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsStreaming(false);
      setStreamedText("");
      await loadHistory();
    }
  };

  return (
    <div className="flex flex-col h-full bg-sidebar border border-border rounded-md overflow-hidden">
      <div className="bg-muted px-4 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <Terminal className="w-4 h-4 text-primary" />
        <span className="font-mono text-xs uppercase tracking-wider">Analysis Chat</span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 min-h-0">
        {history.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] rounded-md px-4 py-2.5 ${
              msg.role === 'user'
                ? 'bg-primary/20 border border-primary/30 text-primary-foreground'
                : 'bg-card border border-border text-foreground font-mono'
            }`}>
              <pre className="whitespace-pre-wrap font-inherit text-sm leading-relaxed">{msg.content}</pre>
            </div>
          </div>
        ))}
        {isStreaming && (
          <div className="flex justify-start">
            <div className="max-w-[70%] rounded-md px-4 py-2.5 bg-card border border-border text-foreground font-mono">
              <pre className="whitespace-pre-wrap font-inherit text-sm leading-relaxed">{streamedText}</pre>
              <Loader2 className="w-3 h-3 mt-2 animate-spin text-primary" />
            </div>
          </div>
        )}
        {history.length === 0 && !isStreaming && (
          <p className="text-xs font-mono text-muted-foreground text-center pt-4">
            Ask anything about this binary — findings, patterns, next steps.
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="px-4 py-3 bg-muted/50 border-t border-border shrink-0">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about this binary..."
            className="font-mono text-sm bg-background"
            disabled={isStreaming}
          />
          <Button type="submit" size="icon" disabled={!input.trim() || isStreaming}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
