# Vendored `@joow/sdk`

This is a **built copy** of the JooW mini-app boundary SDK (`@joow/sdk`,
v0.8.0), vendored into the reader so the production Docker build resolves it
from the build context (a cross-repo `file:` dependency cannot be resolved
inside the container, whose build context is only this reader repo).

- **Source of truth:** `yquran/packages/joow-sdk-ts` (`@joow/sdk`).
- **Contents:** the compiled ESM under `dist/` (`.js` + source maps). Type
  declarations are intentionally omitted — the reader is plain JSX.
- **Consumed as:** a local `file:./vendor/joow-sdk` dependency in the reader's
  `package.json`, imported as `@joow/sdk`.

## Refreshing after an SDK change

```sh
cd yquran/packages/joow-sdk-ts && npm ci && npm run build
# then re-copy dist/ into this folder (js + js.map, preserving the clients/ subdir)
```

Only `JoowSdk` + `attachBridge` are used today (see `src/lib/shell.js`).
