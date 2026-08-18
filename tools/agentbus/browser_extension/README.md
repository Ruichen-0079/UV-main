# Yuvi AgentBus Browser Bridge

One-time Firefox setup:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…**.
3. Select this directory's `manifest.json`.

Firefox must already be running. AgentBus never launches or focuses it. The
extension polls the read-only localhost job endpoint, inserts prompts into the
bound inactive ChatGPT conversation, and presses its semantic Send button.
It does not read GPT replies; only durable GitHub envelopes advance workflow.
