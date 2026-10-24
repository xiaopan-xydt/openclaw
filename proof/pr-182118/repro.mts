import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestInstance } from "./test/helpers/openclaw-test-instance.ts";
import { setRuntimeConfigSnapshot } from "./src/config/runtime-snapshot.ts";
import { upsertSessionEntryCore } from "./src/config/sessions/session-accessor.entry.ts";
import { startGatewayServer } from "./src/gateway/server.ts";
import { registerSessionStateWatch } from "./src/sessions/session-state-events.ts";
import {
  listWatchedSessionUpstreamLinks,
  upsertSessionUpstreamLink,
} from "./src/sessions/session-upstream-links.ts";
import { getPluginRegistryState } from "./src/plugins/runtime-state.ts";
import { readSessionEntryReadOnlyInWorker } from "./src/config/sessions/session-entry-read-runtime.ts";
import { getFreePort } from "./src/test-utils/ports.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await getFreePort();
const instance = await createOpenClawTestInstance({
  name: "pr182118-real-gateway-monitor",
  port,
  reserveIdlePort: false,
  config: {
    plugins: {
      entries: {
        anthropic: { enabled: true, config: { sessionCatalog: { enabled: true } } },
      },
    },
    logging: { level: "info" },
  },
});

try {
  instance.state.applyEnv();
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  process.env.CLAUDE_CONFIG_DIR = path.join(instance.homeDir, ".claude");
  setRuntimeConfigSnapshot({});
  const transcriptDir = path.join(instance.homeDir, ".claude", "projects", "-proof-workspace");
  const transcript = path.join(transcriptDir, "pr182118-session.jsonl");
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "proof-user",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Gateway monitor proof" },
    })}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(transcript, 0o000);

  const sessionKey = "agent:main:adopted:pr182118-proof";
  const env = process.env;
  await upsertSessionEntryCore(
    { sessionKey, agentId: "main", env },
    { sessionId: "pr182118-session", updatedAt: Date.now() },
  );
  const linkWritten = upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-pr182118",
      upstreamKind: "claude-cli",
      upstreamRef: { filePath: transcript },
      marker: { offset: 0 },
    },
    { env },
  );
  const watchWritten = await registerSessionStateWatch(
    { watcherSessionKey: "agent:main:main", targetSessionKey: sessionKey },
    { env },
  );

  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  console.log(`GATEWAY_READY=ws://127.0.0.1:${port}`);
  await server.startupSettled;
  console.log("GATEWAY_STARTUP_SETTLED");
  const sessionEntry = await readSessionEntryReadOnlyInWorker(
    { sessionKey, agentId: "main", env },
    () => undefined,
  );
  console.log(`SESSION_ENTRY=${JSON.stringify(sessionEntry)}`);
  const catalogs = getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? [];
  const watched = await listWatchedSessionUpstreamLinks({ env });
  console.log(
    `MONITOR_DIAG linkWritten=${linkWritten} watchWritten=${watchWritten} catalogs=${catalogs.length} catalogsWithProbe=${catalogs.filter(({ provider }) => provider.checkUpstreamActivity).length} watched=${[...watched.values()].flat().length}`,
  );
  try {
    await fs.access(transcript, fs.constants.R_OK);
    console.log("TRANSCRIPT_ACCESS=readable");
  } catch (error) {
    console.log(`TRANSCRIPT_ACCESS=${String(error)}`);
  }
  await sleep(75_000);
  console.log("SCHEDULED_WAIT_DONE");
  const watchedAfter = await listWatchedSessionUpstreamLinks({ env });
  const linksAfter = [...watchedAfter.values()].flat();
  console.log(`MONITOR_AFTER watched=${linksAfter.length}`);
  console.log(`MONITOR_MARKERS=${JSON.stringify(linksAfter.map(({ marker }) => marker))}`);
  await server.close({ reason: "proof complete" });
} finally {
  await fs.chmod(
    path.join(instance.homeDir, ".claude", "projects", "-proof-workspace", "pr182118-session.jsonl"),
    0o600,
  ).catch(() => undefined);
  await instance.cleanup();
}
