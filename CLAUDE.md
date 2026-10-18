# Claude Code notes

This file is a short pointer. Project context, plans and standing rules are not kept in this repository.

- **Context.** The project notes live in `Efforts/Kenya Pulse/Kenya Pulse.md` in the notes repository. The live site is https://kenyapulse.gachichio.org. Data collection and publishing run on the owner's own infrastructure, not in a cloud session.
- **Starting a cloud session.** Attach this repository and `bgachichio/Obsidian`, then tell Claude to read `Obsidian/CLAUDE.md` first. With only this repository attached, Claude has none of that context.
- **What a cloud session may do here.** Read, edit and test the code, commit on a `claude/*` branch, push it and open a pull request. Never push to `main`.
- **What stays local.** Deploys, servers, credentials, tokens and production data. A cloud session must not deploy, must not ask for or store a secret, and must stop and report any step that needs one.
- **House style.** UK English; dates as YYYY-MM-DD.
