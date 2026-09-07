---
description: Open the Questlog map — starts the local server if it is not running and opens the Overworld in the browser. Use only when the founder asks to open, show or see the map/dashboard.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/desktop/launch.mjs"*)
---

Open the **Overworld** — the founder's map of every registered road.

Run this **once**, with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/desktop/launch.mjs"
```

It returns within a few seconds. The server it starts is detached and keeps
running after the command exits, so do not re-run it, do not background it, and
do not wait on it.

Then:

- **Tell the founder the URL from its last stdout line, and nothing else.** The
  browser window is already opening; a wall of explanation is noise.
- **Exit 2** means the port is answered by something that is not Questlog. Relay
  the launcher's message verbatim — it names the port and where to change it.
- **Exit 1** means the server never came up. Say so and point at
  `~/.questlog/launcher.log`.
- If the log line says **DRIFT**, the server that was running was older than the
  code on disk and has been gracefully restarted onto it. Mention that in one
  line — the founder should know their dashboard just reloaded.
