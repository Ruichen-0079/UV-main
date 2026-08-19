# Yuvi AgentBus Browser Bridge

The normal deployment is a Mozilla-signed XPI installed by Firefox
`ExtensionSettings` policy. It survives Firefox restart and machine reboot; it
does not edit a Firefox profile and does not disable signature enforcement.

Build the deterministic unsigned artifact:

```sh
PYTHONPATH=tools python3 -m agentbus --repo /path/to/yuvi-agentbus browser package
```

Configure Mozilla Add-ons unlisted-signing credentials as
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, then run:

```sh
PYTHONPATH=tools python3 -m agentbus --repo /path/to/yuvi-agentbus browser sign
PYTHONPATH=tools python3 -m agentbus --repo /path/to/yuvi-agentbus browser install
```

`browser install` merges only the `yuvi-agentbus-bridge@local` entry into the
supported Firefox policy file and preserves unrelated policy entries. A
standard Firefox Release cannot persist an unsigned add-on; temporary add-on
loading is development-only and is not part of the normal workflow.

The bridge polls the read-only `http://127.0.0.1:6738` job endpoint, inserts
prompts into the bound inactive ChatGPT conversation, and presses its semantic
Send button. It never activates or focuses Firefox tabs/windows and does not
read GPT replies; only durable GitHub envelopes advance workflow.
