## What and why

## Checklist
- [ ] Small, focused diff; no new dependency unless justified
- [ ] `node --check` passes on touched files, `node node/tools/test-hardening.js` passes
- [ ] Tested against the real client (or marked `needs live test`)
- [ ] `docs/protocol/` updated if protocol behaviour changed
- [ ] No client files, assets, `.bin`, executables or secrets
- [ ] AI-assisted? Said so and reviewed it myself
