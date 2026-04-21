import React from "react";
import {
  List,
  Detail,
  Action,
  ActionPanel,
  Icon,
  Color,
  useNavigation,
  showToast,
  Toast,
  getPreferenceValues,
} from "@vicinae/api";
import { useState, useEffect, useRef, useCallback } from "react";
import { spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import * as os from "os";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  toolCalls?: string[];
}

interface Preferences {
  workingDirectory: string;
}

// ── Pi RPC Client ─────────────────────────────────────────────────────────────

function createPiClient(cwd: string) {
  const proc: ChildProcess = spawn("pi", ["--mode", "rpc", "--no-session"], {
    cwd: cwd || os.homedir(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const listeners: Array<(event: Record<string, unknown>) => void> = [];

  const onEvent = (cb: (event: Record<string, unknown>) => void) => {
    listeners.push(cb);
    return () => {
      const idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  if (proc.stdout) {
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          for (const l of listeners) l(event);
        } catch {
          // ignore malformed lines
        }
      }
    });
  }

  const send = (cmd: Record<string, unknown>) => {
    if (proc.stdin && !proc.killed) {
      proc.stdin.write(JSON.stringify(cmd) + "\n");
    }
  };

  const prompt = (message: string) => {
    send({ type: "prompt", message });
  };

  const abort = () => {
    send({ type: "abort" });
  };

  const destroy = () => {
    try { proc.kill(); } catch { /* ignore */ }
  };

  return { prompt, abort, destroy, onEvent, proc };
}

// ── Message Detail View ───────────────────────────────────────────────────────

function MessageDetail({ message }: { message: Message }) {
  const { pop } = useNavigation();
  const prefix = message.role === "user" ? "## You\n\n" : "## Pi\n\n";
  return (
    <Detail
      markdown={prefix + message.content}
      actions={
        <ActionPanel>
          <Action title="Back" icon={Icon.ArrowLeft} onAction={pop} />
          <Action.CopyToClipboard
            title="Copy Message"
            content={message.content}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

// ── Main Chat View ────────────────────────────────────────────────────────────

export default function PiChat() {
  const { push } = useNavigation();
  const prefs = getPreferenceValues<Preferences>();
  const cwd = prefs.workingDirectory || os.homedir();

  const [messages, setMessages] = useState<Message[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolCalls, setActiveToolCalls] = useState<string[]>([]);
  const [piReady, setPiReady] = useState(false);

  const clientRef = useRef<ReturnType<typeof createPiClient> | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  // ── Init pi RPC process ──
  useEffect(() => {
    // Check pi is installed before spawning
    const { execSync } = require("child_process") as typeof import("child_process");
    try {
      execSync("which pi", { stdio: "ignore" });
    } catch {
      showToast({
        style: Toast.Style.Failure,
        title: "pi not found",
        message: "Install pi first: https://github.com/mariozechner/pi-coding-agent",
      });
      return;
    }

    const client = createPiClient(cwd);
    clientRef.current = client;

    // Give pi a moment to start up
    const readyTimer = setTimeout(() => setPiReady(true), 800);

    const unsub = client.onEvent((event) => {
      const type = event.type as string;

      if (type === "message_update") {
        const ame = event.assistantMessageEvent as Record<string, unknown>;
        if (ame?.type === "text_delta") {
          const delta = ame.delta as string;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === streamingIdRef.current) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + delta },
              ];
            }
            return prev;
          });
        }
      }

      if (type === "tool_execution_start") {
        const name = event.toolName as string;
        setActiveToolCalls((prev) => [...prev, name]);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.id === streamingIdRef.current) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                toolCalls: [...(last.toolCalls ?? []), name],
              },
            ];
          }
          return prev;
        });
      }

      if (type === "tool_execution_end") {
        const name = event.toolName as string;
        setActiveToolCalls((prev) => prev.filter((t) => t !== name));
      }

      if (type === "agent_end") {
        streamingIdRef.current = null;
        setIsStreaming(false);
        setActiveToolCalls([]);
        // Mark last message as no longer streaming
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
          }
          return prev;
        });
      }
    });

    client.proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        showToast({
          style: Toast.Style.Failure,
          title: "pi not found",
          message: "Install pi first: https://github.com/mariozechner/pi-coding-agent",
        });
      } else {
        showToast({
          style: Toast.Style.Failure,
          title: "Pi process error",
          message: err.message,
        });
      }
    });

    return () => {
      clearTimeout(readyTimer);
      unsub();
      client.destroy();
    };
  }, [cwd]);

  // ── Send message ──
  const sendMessage = useCallback(() => {
    const text = searchText.trim();
    if (!text || !piReady || isStreaming || !clientRef.current) return;

    const userId = `user-${Date.now()}`;
    const assistantId = `assistant-${Date.now()}`;
    streamingIdRef.current = assistantId;

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "", isStreaming: true, toolCalls: [] },
    ]);
    setSearchText("");
    setIsStreaming(true);

    clientRef.current.prompt(text);
  }, [searchText, piReady, isStreaming]);

  // ── Abort ──
  const abortStreaming = useCallback(() => {
    clientRef.current?.abort();
    setIsStreaming(false);
    setActiveToolCalls([]);
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.isStreaming) {
        return [
          ...prev.slice(0, -1),
          { ...last, isStreaming: false, content: last.content || "_(aborted)_" },
        ];
      }
      return prev;
    });
  }, []);

  // ── Clear chat ──
  const clearChat = useCallback(() => {
    if (isStreaming) clientRef.current?.abort();
    setMessages([]);
    setIsStreaming(false);
    setActiveToolCalls([]);
  }, [isStreaming]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isEmpty = messages.length === 0;

  return (
    <List
      isLoading={!piReady}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={
        isStreaming
          ? activeToolCalls.length > 0
            ? `Pi is running: ${activeToolCalls.join(", ")}…`
            : "Pi is thinking…"
          : "Ask pi anything… (↵ to send)"
      }
    >
      {/* Send item — always first so ↵ always sends */}
      {searchText.trim().length > 0 && (
        <List.Item
          key="send-prompt"
          icon={
            isStreaming
              ? { source: Icon.XMarkCircle, tintColor: Color.Red }
              : { source: Icon.PaperPlane, tintColor: Color.Green }
          }
          title={isStreaming ? `Abort` : `Send: "${searchText}"`}
          accessories={[{ tag: { value: isStreaming ? "streaming" : "↵ send", color: isStreaming ? Color.Red : Color.Green } }]}
          actions={
            <ActionPanel>
              <Action
                title={isStreaming ? "Abort" : "Send"}
                icon={isStreaming ? Icon.XMarkCircle : Icon.PaperPlane}
                onAction={isStreaming ? abortStreaming : sendMessage}
              />
              <Action
                title="Clear Chat"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={clearChat}
                shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
              />
            </ActionPanel>
          }
        />
      )}

      {/* Empty state — only when no text and no messages */}
      {isEmpty && searchText.trim().length === 0 && (
        <List.EmptyView
          icon={{ source: Icon.SpeechBubble }}
          title="Chat with Pi"
          description={
            piReady
              ? "Type your message and press ↵ to send"
              : "Starting pi…"
          }
        />
      )}

      {/* Messages */}
      {messages.map((msg) => {
        const isUser = msg.role === "user";
        const isThisStreaming = msg.isStreaming;
        const hasTools = (msg.toolCalls?.length ?? 0) > 0;

        // Build subtitle
        let subtitle = "";
        if (isThisStreaming) {
          if (activeToolCalls.length > 0) {
            subtitle = `🔧 ${activeToolCalls.join(", ")}`;
          } else {
            subtitle = "●●●";
          }
        } else if (hasTools && !isUser) {
          subtitle = `Used: ${msg.toolCalls!.join(", ")}`;
        }

        // Truncate content for list display
        const displayContent = msg.content.length > 120
          ? msg.content.slice(0, 117) + "…"
          : msg.content || (isThisStreaming ? "thinking…" : "");

        return (
          <List.Item
            key={msg.id}
            icon={
              isUser
                ? { source: Icon.Person, tintColor: Color.Blue }
                : isThisStreaming
                ? { source: Icon.CircleProgress, tintColor: Color.Green }
                : { source: Icon.SpeechBubble, tintColor: Color.Purple }
            }
            title={displayContent}
            subtitle={subtitle}
            accessories={
              isUser
                ? [{ tag: { value: "You", color: Color.Blue } }]
                : isThisStreaming
                ? [{ tag: { value: "…", color: Color.Green } }]
                : [{ tag: { value: "Pi", color: Color.Purple } }]
            }
            actions={
              <ActionPanel>
                {/* Primary: send message */}
                <Action
                  title={isStreaming ? "Abort" : "Send Message"}
                  icon={isStreaming ? Icon.XMarkCircle : Icon.ArrowRight}
                  onAction={isStreaming ? abortStreaming : sendMessage}
                />
                {/* View full message */}
                <Action
                  title="View Full Message"
                  icon={Icon.Eye}
                  onAction={() => push(<MessageDetail message={msg} />)}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                />
                <Action.CopyToClipboard
                  title="Copy Message"
                  content={msg.content}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
                <Action
                  title="Clear Chat"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={clearChat}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
                />
              </ActionPanel>
            }
          />
        );
      })}

    </List>
  );
}
