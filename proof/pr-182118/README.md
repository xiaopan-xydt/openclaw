# PR 182118 real-Gateway proof

## Revisions

- Head: `056d0d9621110fefa2b5725dd2b4bb6c9930af18`
- Current base: `315fba74e124470c5f6af4eb518b6a11b59cb1de`

## Scenario

The repro creates an isolated OpenClaw home and Gateway, adopts a synthetic Claude JSONL transcript, links it to a watched session, and changes the transcript mode to `000` before startup. It then waits for the real scheduled session-catalog monitor; it does not call a manual monitor tick.

The same `repro.mts` was copied to the root of both the head and base checkouts after `pnpm build:runtime`.

```bash
OPENCLAW_TEST_MINIMAL_GATEWAY=0 node --import ./scripts/tsx.mjs .tmp-pr182118-proof8.mts
```

## Result

Head (`head.log`): the scheduled monitor emitted the new recovery warning twice while the transcript remained `EACCES`. The watched link remained present with marker `{"offset":0}`.

Base (`base.log`): the same monitor saw the same `EACCES` and retained the same watched link and marker, but emitted no warning.

No manual tick was used. The temporary transcript was restored and the isolated state was removed after each run.

## Redaction

Ports and isolated state paths are replaced with `<redacted-port>` and `<isolated-home>`. The repro uses only synthetic local data and no credentials, external services, IP addresses, phone numbers, or private endpoints.
