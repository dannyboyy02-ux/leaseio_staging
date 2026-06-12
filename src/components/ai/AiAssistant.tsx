import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Loader2, Sparkles, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
}

const SUGGESTED_QUESTIONS = [
  'What are my total monthly lease obligations?',
  'Which leases expire in the next 12 months?',
  'Do any leases have flagged risk items?',
  'What is the total annual rent commitment?',
];

export function AiAssistant() {
  const { workspace, canAccessFeature } = useApp();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isBusiness = canAccessFeature('business');

  // Scroll to bottom whenever messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && isBusiness && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open, isBusiness]);

  const sendMessage = useCallback(async (question: string) => {
    if (!question.trim() || streaming || !workspace?.id) return;

    const userMsg: Message = { role: 'user', content: question.trim() };
    const assistantMsg: Message = { role: 'assistant', content: '', loading: true };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setStreaming(true);

    abortRef.current = new AbortController();

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: 'Your session expired — sign in again to continue.' };
          return updated;
        });
        return;
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const functionUrl = `${supabaseUrl}/functions/v1/ai-assistant`;

      const res = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
        },
        body: JSON.stringify({ question: question.trim(), workspaceId: workspace.id }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.error) {
              console.error('[ai-assistant] Server error:', event.error);
              assembled = "I couldn't complete that request. Please try again.";
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: assembled };
                return updated;
              });
              break;
            }
            if (event.delta) {
              assembled += event.delta;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: assembled, loading: false };
                return updated;
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Finalize
      setMessages(prev => {
        const updated = [...prev];
        if (updated[updated.length - 1]?.loading) {
          updated[updated.length - 1] = { role: 'assistant', content: assembled || "I didn't get a response. Please try your question again." };
        } else {
          updated[updated.length - 1] = { ...updated[updated.length - 1], loading: false };
        }
        return updated;
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: "I couldn't finish that response. Try sending again — the connection may have dropped.",
        };
        return updated;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, workspace?.id]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setOpen(false);
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all',
          'bg-primary text-primary-foreground hover:bg-primary/90',
          open && 'rotate-90',
        )}
        aria-label="Open AI assistant"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className={cn(
            'fixed bottom-22 right-6 z-40 flex flex-col rounded-xl border border-border bg-background shadow-2xl',
            'w-[360px] sm:w-[400px]',
          )}
          style={{ height: '520px', bottom: '4.5rem' }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 rounded-t-xl border-b border-border bg-muted/40 px-4 py-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Ask Claude</p>
              <p className="text-[11px] text-muted-foreground">Answers from your lease portfolio</p>
            </div>
          </div>

          {!isBusiness ? (
            /* Upgrade gate */
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Lock className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">Business plan required</p>
              <p className="text-xs text-muted-foreground">
                Upgrade to Business to ask questions about your lease portfolio.
              </p>
              <Button size="sm" variant="default" className="mt-1" asChild>
                <a href="/app/settings/account?tab=billing">Upgrade to Business</a>
              </Button>
            </div>
          ) : (
            <>
              {/* Messages area */}
              <ScrollArea className="flex-1 px-4 py-3" ref={scrollRef as any}>
                <div className="space-y-3">
                  {messages.length === 0 ? (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Ask anything about your lease portfolio. Claude answers from your actual data.
                      </p>
                      <div className="space-y-1.5">
                        {SUGGESTED_QUESTIONS.map((q) => (
                          <button
                            key={q}
                            onClick={() => sendMessage(q)}
                            className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((msg, i) => (
                      <div
                        key={i}
                        className={cn(
                          'flex',
                          msg.role === 'user' ? 'justify-end' : 'justify-start',
                        )}
                      >
                        <div
                          className={cn(
                            'max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed',
                            msg.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-foreground',
                          )}
                        >
                          {msg.loading && !msg.content ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <span className="whitespace-pre-wrap">{msg.content}</span>
                          )}
                          {msg.loading && msg.content && (
                            <span className="ml-1 inline-block h-2 w-1 animate-pulse bg-current opacity-60" />
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>

              {/* Input area */}
              <div className="border-t border-border p-3">
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask about your leases…"
                    className="min-h-[36px] max-h-[120px] resize-none text-xs"
                    rows={1}
                    disabled={streaming}
                  />
                  <Button
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || streaming}
                  >
                    {streaming ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Enter to send · Shift+Enter for new line
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
