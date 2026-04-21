import React from "react";
import {
  List,
  Action,
  ActionPanel,
  Icon,
  Color,
  showToast,
  Toast,
  getPreferenceValues,
  Clipboard,
  updateCommandMetadata,
  LaunchProps,
} from "@vicinae/api";
import { useState, useEffect, useRef, useCallback } from "react";
import { spawn, ChildProcess, execSync } from "child_process";
import { StringDecoder } from "string_decoder";
import * as os from "os";
import * as fs from "fs";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  entryId?: string; // pi session entry ID, used for forking
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  toolCalls?: string[];
  model?: string;
  tokens?: number;
  cost?: number;
  timestamp: number;
}

interface Model {
  id: string;
  name: string;
  provider: string;
}

interface SessionStats {
  cost: number;
  tokens: { total: number; input: number; output: number };
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
}

interface Preferences {
  workingDirectory: string;
}

const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_ICONS: Record<ThinkingLevel, string> = {
  off: "⚡",
  low: "🧠",
  medium: "🧠🧠",
  high: "🧠🧠🧠",
};


// ── RPC Client ────────────────────────────────────────────────────────────────

function createPiClient(cwd: string) {
  const proc: ChildProcess = spawn("pi", ["--mode", "rpc", "--continue"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrOutput = "";
  const eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  const pendingRequests = new Map<
    string,
    (response: Record<string, unknown>) => void
  >();
  let requestCounter = 0;

  const processLine = (line: string) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.type === "response" && typeof msg.id === "string") {
        const resolve = pendingRequests.get(msg.id);
        if (resolve) {
          pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } else {
        for (const l of eventListeners) l(msg);
      }
    } catch {
      /* ignore malformed lines */
    }
  };

  if (proc.stdout) {
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer +=
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const nl = stdoutBuffer.indexOf("\n");
        if (nl === -1) break;
        let line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        processLine(line);
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
  }

  const sendCommand = (
    cmd: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const id = `req-${++requestCounter}`;
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Command timed out: ${cmd.type}`));
      }, 15000);

      pendingRequests.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      if (proc.stdin && !proc.killed) {
        proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
      } else {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        reject(new Error("Process not running"));
      }
    });
  };

  return {
    prompt: (message: string) => sendCommand({ type: "prompt", message }),
    abort: () => sendCommand({ type: "abort" }),
    newSession: () => sendCommand({ type: "new_session" }),
    getLastAssistantText: () => sendCommand({ type: "get_last_assistant_text" }),
    getAvailableModels: () => sendCommand({ type: "get_available_models" }),
    setModel: (provider: string, modelId: string) =>
      sendCommand({ type: "set_model", provider, modelId }),
    getState: () => sendCommand({ type: "get_state" }),
    getSessionStats: () => sendCommand({ type: "get_session_stats" }),
    setThinkingLevel: (level: string) =>
      sendCommand({ type: "set_thinking_level", level }),
    compact: () => sendCommand({ type: "compact" }),
    getForkMessages: () => sendCommand({ type: "get_fork_messages" }),
    fork: (entryId: string) => sendCommand({ type: "fork", entryId }),
    onEvent: (cb: (event: Record<string, unknown>) => void) => {
      eventListeners.push(cb);
      return () => {
        const idx = eventListeners.indexOf(cb);
        if (idx !== -1) eventListeners.splice(idx, 1);
      };
    },
    getStderr: () => stderrOutput,
    destroy: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    proc,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setSubtitle(text: string) {
  updateCommandMetadata({ subtitle: text }).catch(() => {});
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function PiChat(props: LaunchProps) {
  const prefs = getPreferenceValues<Preferences>();
  const cwd = prefs.workingDirectory?.trim() || os.homedir();

  const [messages, setMessages] = useState<Message[]>([]);
  const [searchText, setSearchText] = useState(props.fallbackText ?? "");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolCalls, setActiveToolCalls] = useState<string[]>([]);
  const [piReady, setPiReady] = useState(false);
  const [crashed, setCrashed] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [currentModel, setCurrentModel] = useState<Model | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);

  const clientRef = useRef<ReturnType<typeof createPiClient> | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  const startClient = useCallback(() => {
    if (!fs.existsSync(cwd)) {
      showToast({
        style: Toast.Style.Failure,
        title: "Working directory not found",
        message: `"${cwd}" does not exist. Check extension preferences.`,
      });
      return;
    }

    const client = createPiClient(cwd);
    clientRef.current = client;
    setCrashed(null);
    setPiReady(false);

    // Handshake: get_state → get_available_models → get_messages
    client
      .getState()
      .then((res) => {
        const data = res.data as Record<string, unknown>;
        const model = data?.model as Model | null;
        const level = data?.thinkingLevel as ThinkingLevel | undefined;
        if (model) {
          setCurrentModel(model);
          setSubtitle(model.name);
        }
        if (level) setThinkingLevel(level);
        return client.getAvailableModels();
      })
      .then((res) => {
        const data = res.data as Record<string, unknown>;
        setAvailableModels((data?.models as Model[]) ?? []);
        return client.getLastAssistantText();
      })
      .then((res) => {
        try {
          const text = (res.data as Record<string, unknown>)?.text as string | null;
          if (text?.trim()) {
            setMessages([
              {
                id: "restored-assistant",
                role: "assistant",
                content: text,
                timestamp: Date.now(),
              },
            ]);
          }
        } catch {
          // ignore
        }
        setPiReady(true);
      })
      .catch(() => {
        // Process may have exited — close handler will show error
      });

    // Event stream
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
              { ...last, toolCalls: [...(last.toolCalls ?? []), name] },
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
        const msgs = (event.messages ?? []) as Record<string, unknown>[];
        const lastAssistant = [...msgs]
          .reverse()
          .find((m) => m.role === "assistant") as
          | Record<string, unknown>
          | undefined;
        const usage = lastAssistant?.usage as
          | Record<string, unknown>
          | undefined;
        const cost = usage?.cost as Record<string, unknown> | undefined;
        const totalCost = cost?.total as number | undefined;
        const modelName = lastAssistant?.model as string | undefined;

        streamingIdRef.current = null;
        setIsStreaming(false);
        setActiveToolCalls([]);

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                isStreaming: false,
                model: modelName,
                tokens: usage
                  ? ((usage.input as number) ?? 0) +
                    ((usage.output as number) ?? 0)
                  : undefined,
                cost: totalCost,
              },
            ];
          }
          return prev;
        });

        // Update subtitle with cost
        client.getSessionStats().then((res) => {
          const stats = res.data as unknown as SessionStats;
          setSessionStats(stats);
          const label = [
            currentModel?.name ?? modelName,
            stats.cost !== undefined ? `$${stats.cost.toFixed(4)}` : null,
            stats.contextUsage
              ? `ctx ${stats.contextUsage.percent}%`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
          setSubtitle(label);
        }).catch(() => {});
      }
    });

    unsubRef.current = unsub;

    client.proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        showToast({
          style: Toast.Style.Failure,
          title: "pi not found",
          message:
            "Install pi: https://github.com/mariozechner/pi-coding-agent",
        });
      } else {
        showToast({
          style: Toast.Style.Failure,
          title: "Process error",
          message: err.message,
        });
      }
    });

    client.proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        const stderr = client.getStderr().trim();
        const hint = stderr.includes("API key")
          ? "No API key configured. Run `pi` in a terminal to set one up."
          : stderr || `Exited with code ${code}`;
        setCrashed(hint);
        setPiReady(false);
        setIsStreaming(false);
        setActiveToolCalls([]);
        setSubtitle("crashed");
      }
    });
  }, [cwd]);

  useEffect(() => {
    try {
      execSync("which pi", { stdio: "ignore" });
    } catch {
      showToast({
        style: Toast.Style.Failure,
        title: "pi not found",
        message: "Install pi: https://github.com/mariozechner/pi-coding-agent",
      });
      return;
    }

    startClient();

    return () => {
      unsubRef.current?.();
      clientRef.current?.destroy();
    };
  }, [startClient]);

  // Auto-send when launched as a fallback command
  useEffect(() => {
    if (props.fallbackText && piReady && !isStreaming) {
      sendMessage(props.fallbackText);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piReady]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (text?: string) => {
      const msg = (text ?? searchText).trim();
      if (!msg || !piReady || isStreaming || !clientRef.current) return;

      const userId = `user-${Date.now()}`;
      const assistantId = `assistant-${Date.now()}`;
      streamingIdRef.current = assistantId;

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: msg, timestamp: Date.now() },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          isStreaming: true,
          toolCalls: [],
          timestamp: Date.now(),
        },
      ]);
      setSearchText("");
      setIsStreaming(true);
      setSubtitle("streaming…");

      clientRef.current.prompt(msg);
    },
    [searchText, piReady, isStreaming]
  );

  const abortStreaming = useCallback(() => {
    clientRef.current?.abort();
    setIsStreaming(false);
    setActiveToolCalls([]);
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.isStreaming) {
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            isStreaming: false,
            content: last.content || "_(aborted)_",
          },
        ];
      }
      return prev;
    });
    setSubtitle(currentModel?.name ?? "Pi");
  }, [currentModel]);

  const handleFork = useCallback(async (msg: Message) => {
    if (!clientRef.current) return;

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Forking conversation…",
    });

    try {
      const res = await clientRef.current.getForkMessages();
      const forkable = (
        (res.data as Record<string, unknown>)?.messages ?? []
      ) as { entryId: string; text: string }[];

      const match = forkable.find((f) => f.text === msg.content);
      if (!match) {
        toast.style = Toast.Style.Failure;
        toast.title = "This message can't be forked";
        return;
      }

      const result = await clientRef.current.fork(match.entryId);
      const resultData = result.data as Record<string, unknown>;

      if (resultData?.cancelled) {
        toast.style = Toast.Style.Failure;
        toast.title = "Fork was cancelled";
        return;
      }

      // Remove the forked message and everything after it
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msg.id);
        return idx >= 0 ? prev.slice(0, idx) : prev;
      });

      // Pre-fill search bar with original text so user can edit and resend
      setSearchText(msg.content);

      toast.style = Toast.Style.Success;
      toast.title = "Forked — edit your message and press ↵";
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fork failed";
      toast.message =
        err instanceof Error ? err.message : "Unknown error";
    }
  }, []);

  const handleNewSession = useCallback(async () => {
    if (isStreaming) clientRef.current?.abort();
    try {
      await clientRef.current?.newSession();
      setMessages([]);
      setIsStreaming(false);
      setActiveToolCalls([]);
      setSessionStats(null);
      setSubtitle(currentModel?.name ?? "Pi");
      showToast({ style: Toast.Style.Success, title: "New session started" });
    } catch {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to start new session",
      });
    }
  }, [isStreaming, currentModel]);

  const handleSwitchModel = useCallback(async (model: Model) => {
    try {
      await clientRef.current?.setModel(model.provider, model.id);
      setCurrentModel(model);
      setSubtitle(model.name);
      showToast({ style: Toast.Style.Success, title: `Switched to ${model.name}` });
    } catch {
      showToast({ style: Toast.Style.Failure, title: "Failed to switch model" });
    }
  }, []);

  const handleCycleThinking = useCallback(async () => {
    const idx = THINKING_LEVELS.indexOf(thinkingLevel);
    const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
    try {
      await clientRef.current?.setThinkingLevel(next);
      setThinkingLevel(next);
      showToast({
        style: Toast.Style.Success,
        title: `Thinking: ${next} ${THINKING_ICONS[next]}`,
      });
    } catch {
      showToast({ style: Toast.Style.Failure, title: "Failed to set thinking level" });
    }
  }, [thinkingLevel]);

  const handleCompact = useCallback(async () => {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Compacting context…",
    });
    try {
      await clientRef.current?.compact();
      const res = await clientRef.current?.getSessionStats();
      if (res) setSessionStats(res.data as unknown as SessionStats);
      toast.style = Toast.Style.Success;
      toast.title = "Context compacted";
    } catch {
      toast.style = Toast.Style.Failure;
      toast.title = "Compact failed";
    }
  }, []);

  const handleAskClipboard = useCallback(async () => {
    const text = await Clipboard.readText();
    if (!text?.trim()) {
      showToast({ style: Toast.Style.Failure, title: "Clipboard is empty" });
      return;
    }
    sendMessage(text.trim());
  }, [sendMessage]);

  const handleRestart = useCallback(() => {
    unsubRef.current?.();
    clientRef.current?.destroy();
    setMessages([]);
    setSessionStats(null);
    setIsStreaming(false);
    setActiveToolCalls([]);
    startClient();
  }, [startClient]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const contextPercent = sessionStats?.contextUsage?.percent;
  const contextWarning = contextPercent !== undefined && contextPercent > 70;
  const isEmpty = messages.length === 0;

  const statusLine = piReady
    ? [
        currentModel?.name,
        `${THINKING_ICONS[thinkingLevel]} ${thinkingLevel}`,
        contextPercent !== undefined
          ? `ctx: ${contextPercent}%${contextWarning ? " ⚠️" : ""}`
          : null,
        sessionStats?.cost !== undefined
          ? `$${sessionStats.cost.toFixed(4)}`
          : null,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "Starting pi…";

  // ── Shared action panel sections ──────────────────────────────────────────

  const modelSection = availableModels.length > 0 && (
    <ActionPanel.Section title="Switch Model">
      {availableModels.map((m) => (
        <Action
          key={`${m.provider}/${m.id}`}
          title={m.name}
          icon={
            currentModel?.id === m.id
              ? { source: Icon.Checkmark, tintColor: Color.Green }
              : Icon.Circle
          }
          onAction={() => handleSwitchModel(m)}
        />
      ))}
    </ActionPanel.Section>
  );

  const sessionSection = (
    <ActionPanel.Section title="Session">
      <Action
        title={`Thinking: ${thinkingLevel} ${THINKING_ICONS[thinkingLevel]}`}
        icon={Icon.LightBulb}
        onAction={handleCycleThinking}
        shortcut={{ modifiers: ["cmd"], key: "t" }}
      />
      <Action
        title={
          contextWarning
            ? `Compact Context (${contextPercent}% full)`
            : "Compact Context"
        }
        icon={Icon.Minimize}
        onAction={handleCompact}
        shortcut={{ modifiers: ["cmd"], key: "k" }}
      />
      <Action
        title="Ask About Clipboard"
        icon={Icon.Clipboard}
        onAction={handleAskClipboard}
        shortcut={{ modifiers: ["cmd"], key: "b" }}
      />
      <Action
        title="New Session"
        icon={Icon.RotateClockwise}
        onAction={handleNewSession}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
      />
      <Action
        title="Clear Messages"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={() => {
          if (isStreaming) abortStreaming();
          setMessages([]);
          setSessionStats(null);
        }}
        shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
      />
    </ActionPanel.Section>
  );

  // ── Crash screen ──────────────────────────────────────────────────────────

  if (crashed) {
    return (
      <List>
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Pi crashed"
          description={crashed}
          actions={
            <ActionPanel>
              <Action
                title="Restart Pi"
                icon={Icon.RotateClockwise}
                onAction={handleRestart}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────

  return (
    <List
      isLoading={!piReady}
      isShowingDetail={!isEmpty}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => { if (id && id !== "send-prompt") setSelectedId(id); }}
      searchBarPlaceholder={
        isStreaming
          ? activeToolCalls.length > 0
            ? `🔧 Running: ${activeToolCalls.join(", ")}…`
            : "Pi is thinking…"
          : statusLine
      }
    >
      {/* ── Send / Abort item — always first when typing ── */}
      {searchText.trim().length > 0 && (
        <List.Item
          id="send-prompt"
          icon={
            isStreaming
              ? { source: Icon.XMarkCircle, tintColor: Color.Red }
              : { source: Icon.PaperPlane, tintColor: Color.Green }
          }
          title={isStreaming ? "Abort" : `Send: "${searchText}"`}
          accessories={[
            {
              tag: {
                value: isStreaming ? "streaming" : "↵ send",
                color: isStreaming ? Color.Red : Color.Green,
              },
            },
          ]}
          detail={<List.Item.Detail markdown={`**You:** ${searchText}`} />}
          actions={
            <ActionPanel>
              <Action
                title={isStreaming ? "Abort" : "Send"}
                icon={isStreaming ? Icon.XMarkCircle : Icon.PaperPlane}
                onAction={isStreaming ? abortStreaming : sendMessage}
              />
              {modelSection}
              {sessionSection}
            </ActionPanel>
          }
        />
      )}

      {/* ── Empty state ── */}
      {isEmpty && searchText.trim().length === 0 && (
        <List.EmptyView
          icon={{ source: Icon.SpeechBubble, tintColor: Color.Purple }}
          title={piReady ? "Chat with Pi" : "Starting pi…"}
          description={
            piReady
              ? `${currentModel?.name ?? "…"} · Type a message and press ↵`
              : ""
          }
          actions={
            <ActionPanel>
              <Action
                title="Ask About Clipboard"
                icon={Icon.Clipboard}
                onAction={handleAskClipboard}
              />
              {modelSection}
              {sessionSection}
            </ActionPanel>
          }
        />
      )}

      {/* ── Message list — newest first ── */}
      {[...messages].reverse().map((msg) => {
        const isUser = msg.role === "user";
        const isThisStreaming = msg.isStreaming;
        const hasTools = (msg.toolCalls?.length ?? 0) > 0;

        const rawContent = msg.content || (isThisStreaming ? "thinking…" : "");
        const title =
          rawContent.length > 80 ? rawContent.slice(0, 77) + "…" : rawContent;

        let subtitle = "";
        if (isThisStreaming && activeToolCalls.length > 0) {
          subtitle = `🔧 ${activeToolCalls.join(", ")}`;
        } else if (isThisStreaming) {
          subtitle = "●●●";
        } else if (hasTools && !isUser) {
          subtitle = msg.toolCalls!.join(", ");
        }

        const accessories = isUser
          ? [{ tag: { value: "You", color: Color.Blue } }]
          : isThisStreaming
          ? [{ tag: { value: "●●●", color: Color.Green } }]
          : [
              ...(msg.cost !== undefined
                ? [
                    {
                      tag: {
                        value: `$${msg.cost.toFixed(4)}`,
                        color: Color.SecondaryText,
                      },
                    },
                  ]
                : []),
              { tag: { value: "Pi", color: Color.Purple } },
            ];

        const detailMarkdown = isUser
          ? `**You**\n\n---\n\n${msg.content}`
          : msg.content || (isThisStreaming ? "_thinking…_" : "");

        const detailMetadata =
          !isUser && !isThisStreaming ? (
            <List.Item.Detail.Metadata>
              {msg.model && (
                <List.Item.Detail.Metadata.Label
                  title="Model"
                  text={msg.model}
                />
              )}
              {msg.tokens !== undefined && (
                <List.Item.Detail.Metadata.Label
                  title="Tokens"
                  text={msg.tokens.toLocaleString()}
                />
              )}
              {msg.cost !== undefined && (
                <List.Item.Detail.Metadata.Label
                  title="Cost"
                  text={`$${msg.cost.toFixed(5)}`}
                />
              )}
              {hasTools && (
                <>
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label
                    title="Tools used"
                    text={msg.toolCalls!.join(", ")}
                  />
                </>
              )}
              {sessionStats?.contextUsage && (
                <>
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label
                    title="Context window"
                    text={`${sessionStats.contextUsage.percent}% used`}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="Session cost"
                    text={`$${sessionStats.cost.toFixed(4)}`}
                  />
                </>
              )}
            </List.Item.Detail.Metadata>
          ) : undefined;

        return (
          <List.Item
            key={msg.id}
            id={msg.id}
            icon={
              isUser
                ? { source: Icon.Person, tintColor: Color.Blue }
                : isThisStreaming
                ? { source: Icon.CircleProgress, tintColor: Color.Green }
                : { source: Icon.SpeechBubble, tintColor: Color.Purple }
            }
            title={title}
            subtitle={subtitle}
            accessories={accessories}
            detail={
              <List.Item.Detail
                markdown={detailMarkdown}
                metadata={detailMetadata}
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section title="Message">
                  <Action
                    title={isStreaming ? "Abort" : "Send Message"}
                    icon={isStreaming ? Icon.XMarkCircle : Icon.ArrowRight}
                    onAction={isStreaming ? abortStreaming : sendMessage}
                  />
                  <Action.CopyToClipboard
                    title="Copy Message"
                    content={msg.content}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  {isUser && (
                    <Action
                      title="Fork — Edit & Retry"
                      icon={Icon.ArrowNe}
                      onAction={() => handleFork(msg)}
                      shortcut={{ modifiers: ["cmd"], key: "f" }}
                    />
                  )}
                </ActionPanel.Section>
                {modelSection}
                {sessionSection}
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
