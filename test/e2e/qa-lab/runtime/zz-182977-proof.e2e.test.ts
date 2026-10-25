import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { sendChat, waitForRun } from "./gateway-recovery.test-support.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
} from "./native-provider-proof-fixture.js";

const PLUGIN_ID = "agent-end-proof";
const SESSION_KEY = "agent:qa:182977-proof";
const FIRST_TEXT = "ALPHA-DONE";
const STEER_TEXT = "BETA-DONE";

type ObservedMessage = { role?: string; content?: unknown };
type AgentEndObservation = { success?: boolean; messages?: ObservedMessage[] };
type ChatHistory = { messages?: ObservedMessage[] };

function textOf(message: ObservedMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (typeof message.content === "object" && message.content !== null) {
    if (!Array.isArray(message.content)) {
      const text = Reflect.get(message.content, "text");
      return typeof text === "string" ? text : "";
    }
    return message.content
      .filter(
        (block): block is { type?: string; text?: string } =>
          typeof block === "object" && block !== null,
      )
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeStart(response: ServerResponse, id: string, text: string): void {
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.flushHeaders();
  writeEvent(response, {
    type: "response.created",
    response: { id, status: "in_progress", output: [] },
  });
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] },
  });
  writeEvent(response, {
    type: "response.output_text.delta",
    item_id: id,
    output_index: 0,
    content_index: 0,
    delta: text.slice(0, 6),
  });
}

function writeFinish(response: ServerResponse, id: string, text: string, delta = ""): void {
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  if (delta) {
    writeEvent(response, {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }
  writeEvent(response, {
    type: "response.output_text.done",
    item_id: id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeEvent(response, { type: "response.output_item.done", output_index: 0, item: message });
  writeEvent(response, {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [message],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  response.end("data: [DONE]\n\n");
}

async function writeProofPlugin(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@openclaw/agent-end-proof",
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, configSchema: { type: "object", properties: {} } }),
  );
  await fs.writeFile(
    path.join(dir, "index.cjs"),
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on("agent_end", async (event) => {
      const target = process.env.OPENCLAW_QA_AGENT_END_PROOF;
      if (!target) throw new Error("missing OPENCLAW_QA_AGENT_END_PROOF");
      fs.appendFileSync(target, JSON.stringify({ success: event.success, messages: event.messages }) + "\\n");
    });
  },
};
`,
  );
}

it(
  "real Gateway delivers the original user and a native steering input to one agent_end",
  { timeout: 300_000 },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-182977-proof-"));
    const pluginDir = path.join(tempRoot, "plugin");
    const proofPath = path.join(tempRoot, "agent-end.jsonl");
    await fs.mkdir(pluginDir);
    await writeProofPlugin(pluginDir);

    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStreaming!: () => void;
    const streaming = new Promise<void>((resolve) => {
      firstStreaming = resolve;
    });
    let providerRequests = 0;
    const provider = createNativeProvider(
      async (request, response, body) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          respondJson(response, { data: [{ id: "gpt-5.6-luna", object: "model" }] });
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          respondJson(response, {});
          return;
        }
        providerRequests += 1;
        if (providerRequests === 1) {
          writeStart(response, "proof-first", FIRST_TEXT);
          firstStreaming();
          await firstRelease;
          if (!response.destroyed) {
            writeFinish(response, "proof-first", FIRST_TEXT, FIRST_TEXT.slice(6));
          }
          return;
        }
        const parsed = JSON.parse(body) as unknown;
        const serialized = JSON.stringify(parsed);
        writeStart(response, "proof-steer", STEER_TEXT);
        writeFinish(
          response,
          "proof-steer",
          serialized.includes("Also beta") ? STEER_TEXT : FIRST_TEXT,
          STEER_TEXT.slice(6),
        );
      },
      (error, response) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      },
    );

    const owner = createQaGatewayChild();
    try {
      await runQaGatewayFixture(
        async () => {
          const providerUrl = await listenNativeProvider(provider);
          const gateway = await owner.start({
            repoRoot: process.cwd(),
            forcedRuntime: "codex",
            providerMode: "mock-openai",
            providerBaseUrl: providerUrl,
            primaryModel: "openai/gpt-5.6-luna",
            alternateModel: "openai/gpt-5.6-luna",
            transportBaseUrl: "",
            controlUiEnabled: false,
            runtimeEnvPatch: { OPENCLAW_QA_AGENT_END_PROOF: proofPath },
            mutateConfig: (config) => {
              const plugins = (config.plugins ??= {});
              plugins.allow = [...(plugins.allow ?? []), PLUGIN_ID];
              plugins.load = {
                ...plugins.load,
                paths: [...(plugins.load?.paths ?? []), pluginDir],
              };
              plugins.entries = {
                ...plugins.entries,
                [PLUGIN_ID]: {
                  enabled: true,
                  hooks: { allowConversationAccess: true },
                },
              };
              return config;
            },
          });

          const first = (await sendChat(gateway, SESSION_KEY, "Remember alpha", {
            idempotencyKey: randomUUID(),
          })) as { runId: string; status: string };
          await Promise.race([
            streaming,
            delay(30_000).then(() => {
              throw new Error("provider never started streaming the first turn");
            }),
          ]);
          let historyBeforeSteer: ChatHistory | undefined;
          for (let attempt = 0; attempt < 400; attempt += 1) {
            try {
              historyBeforeSteer = (await gateway.call("chat.history", {
                sessionKey: SESSION_KEY,
                limit: 10,
              })) as ChatHistory;
              if (
                (historyBeforeSteer.messages ?? []).some((message) =>
                  textOf(message).includes("Remember alpha"),
                )
              ) {
                break;
              }
            } catch {
              // session creation is still in flight
            }
            await delay(25);
          }
          if (
            !(historyBeforeSteer?.messages ?? []).some((message) =>
              textOf(message).includes("Remember alpha"),
            )
          ) {
            throw new Error("original request was not persisted before steering");
          }
          const steer = (await sendChat(gateway, SESSION_KEY, "Also beta", {
            idempotencyKey: randomUUID(),
            queueMode: "steer",
          })) as { runId?: string; status?: string };
          releaseFirst();
          const completed = await waitForRun(gateway, first.runId, 120_000, 125_000);
          await delay(500);

          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              if ((await fs.stat(proofPath)).size > 0) {
                break;
              }
            } catch {
              // wait for the hook process to append
            }
            await delay(100);
          }
          const observations = (await fs.readFile(proofPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as AgentEndObservation);
          const history = (await gateway.call("chat.history", {
            sessionKey: SESSION_KEY,
            limit: 50,
          })) as ChatHistory;
          const rows = (history.messages ?? []).map((message) => ({
            role: message.role,
            text: textOf(message),
          }));
          await fs.writeFile(
            "/tmp/182977-proof-result.json",
            JSON.stringify(
              { first, steer, completed, historyBeforeSteer, rows, history, observations },
              null,
              2,
            ),
          );
          await fs.writeFile("/tmp/182977-proof-gateway.log", gateway.logs());
          console.log("PROOF_ROWS", JSON.stringify(rows));
          console.log("PROOF_AGENT_END", JSON.stringify(observations));
          console.log("PROOF_PROVIDER_REQUESTS", providerRequests);

          expect(
            rows.filter((row) => row.role === "user" && row.text.includes("Remember alpha")),
          ).toHaveLength(1);
          expect(
            rows.filter((row) => row.role === "user" && row.text.includes("Also beta")),
          ).toHaveLength(1);
          const observation = observations.find((entry) =>
            (entry.messages ?? []).some(
              (message) => message.role === "user" && textOf(message).includes("Remember alpha"),
            ),
          );
          expect(observation, gateway.logs()).toBeDefined();
          expect(
            (observation?.messages ?? []).filter(
              (message) => message.role === "user" && textOf(message).includes("Remember alpha"),
            ),
          ).toHaveLength(1);
          expect(
            (observation?.messages ?? []).filter(
              (message) => message.role === "user" && textOf(message).includes("Also beta"),
            ),
          ).toHaveLength(1);
          expect(
            (observation?.messages ?? []).filter((message) => message.role === "assistant").length,
          ).toBeGreaterThanOrEqual(1);
        },
        () => stopQaGatewayFixture(owner),
        () => closeNativeProvider(provider),
      );
    } finally {
      await fs
        .cp(tempRoot, "/tmp/182977-proof-temp", { recursive: true, force: true })
        .catch(() => {});
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
