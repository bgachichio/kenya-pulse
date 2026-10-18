# Claude Code notes

This file is a short pointer. Project context, plans and standing rules are not kept in this repository.

- **Context.** The project notes live in `Efforts/Kenya Pulse/Kenya Pulse.md` in the notes repository. The live site is https://kenyapulse.gachichio.org. Data collection and publishing run on the owner's own infrastructure, not in a cloud session.
- **Starting a cloud session.** Attach this repository and `bgachichio/Obsidian`, then tell Claude to read `Obsidian/CLAUDE.md` first. With only this repository attached, Claude has none of that context.
- **Working here.** Read, edit and test the code, commit on a `claude/*` branch, push it and open a pull request. Never push to `main`.
- **Deploys and secrets stay local.** A cloud session never deploys and never prints, stores or commits a secret. When it changes deployable code it appends an entry to `Efforts/Deploy Queue.md` in the notes repository (so attach it) and says so in its last message; the owner deploys from the laptop using this project's `DEPLOY.md`.
- **House style.** UK English; dates as YYYY-MM-DD.
