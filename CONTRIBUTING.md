# Contributing

Thanks for helping! Humans and AI agents (Claude, Copilot, etc.) are equally welcome; the rules are the same.

1. **Open an issue first** for anything bigger than a small fix (use the templates).
2. Fork, branch from `main`, keep the diff small and focused. Plain Node.js CommonJS; no new dependencies or abstractions unless needed.
3. If you change protocol behaviour, update `Protocollo WarRock.md` (captured packet + what you learned).
4. Run `node --check` on the files you touched and the checks in `node/tools/` before opening the PR.
5. **Never commit** the game client, assets, `items.bin`/`weapondata.bin`, patched executables, credentials or personal data. PRs containing them are closed.
6. Behaviour must match the real client: a real capture beats the C# reference.

AI-assisted PRs: say so in the description and verify the code yourself; you are responsible for what you submit.
By contributing you agree that your work is released under the MIT license. Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
