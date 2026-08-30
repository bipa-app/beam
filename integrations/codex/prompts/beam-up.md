# /beam-up — hand this Codex session to a remote sandbox

Run `beam up --tool codex -m "<the user's instructions, if any>"` with the
shell tool from the current project directory.

- If beam is missing or unconfigured, surface the error and point the user at
  `beam setup box` / `beam check`.
- On success, report the beam id plus the watch commands (`beam status <id>`,
  `beam attach <id>`), then the return sequence: `beam down <id>`,
  `beam integrate <id>`, and finally `beam kill <id> --purge`.
- Remind the user to exit this local session so the shipped transcript does
  not diverge.
