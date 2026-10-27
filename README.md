# ff2async

Codemod that rewrites straight-line [`ff`](https://github.com/play-co/ff) chains to async/await. Chains it can't convert safely are left as they are and reported with the reason. The mapping follows [ff-behavior](../ff-behavior) and its `migrate-ff` skill.

```bash
npm install && npm run build
node build/cli.js --dry file.js ...   # print the result, change nothing
node build/cli.js file.js ...         # rewrite in place
npm test
```

## What it does

```js
const f = ff(
  () => {
    s3.putObject(params, f.wait());
  },
  () => {
    s3.getSignedUrl("getObject", params, f.slot());
  }
).onComplete(next);
```

becomes

```js
callbackify(async () => {
  await promisify(s3.putObject.bind(s3))(params);
  return promisify(s3.getSignedUrl.bind(s3))("getObject", params);
})(next);
```

| ff | output |
|----|--------|
| `fn(a, f.slot())`, slot last | `await promisify(fn)(a)`; `obj.m` becomes `promisify(obj.m.bind(obj))` |
| slot not last, `slotMulti(n)`, `slotPlain`, `waitPlain` | `await new Promise(...)` around the original call |
| several slots in one step | `const [a, b] = await Promise.all([...])`, in slot order |
| `f.wait()` | `await ...`, result dropped |
| `f.pass(v)` | `const <next step's param> = v` |
| slots or passes in `if`/`else` | each stores its promise or value in `pending[k]`, then `const [a, b] = await Promise.all(pending)`; a slot a branch skipped gives `undefined`, as in ff |
| `return f.succeed(v)` / `return f.fail(err)` | `return v` / `throw err` |
| `.onComplete(cb)` | `callbackify(async () => {...})(cb)` |
| `.onSuccess(s)` / `.onError(e)` | `(async () => {...})().then(s, e)` / `.catch(e)` |

The ff import is removed when no chain is left, and `promisify`/`callbackify` are imported from `util`.

## What it skips

A chain is skipped when converting it could change what it does:

- `f` used in a loop or a nested callback, passed as a value, or a slot that is never called back (`f.wait();`), which hung the chain in ff
- branches that give different values at the same arg position, or a value after a branch that gives fewer values than another, since the next step's args would shift
- after a slot on the same path: `succeed`, `fail`, `throw`, other code, or an `if` whose condition calls a function. ff ignored the slot's result there; after the rewrite its rejection would go unhandled
- `f.succeed()`/`f.fail()` without `return`, with code after it; that code still ran in ff
- a plain `return` in a step, which only ended that step
- code after the chain is set up (ff starts step 1 on the next tick, the async version starts it right away)
- a name declared in one step and declared or used in another, since all steps now share one scope
- `this`/`arguments` in a `function` step, `ff(ctx, ...)`, step parameters with defaults or rest
- a last step that gives several values to the handlers, or `succeed` with several values

A nested chain converts first; the chain around it converts on a later pass, when possible.

## Behaviour changes in converted code

- A slot callback called twice: ff took the second value, a promise keeps the first.
- `callbackify` turns a falsy rejection into an `Error` with `.reason`.
- A step's error goes to the handler as before. A throw inside a handler is now an unhandled rejection under `.then()`, not an uncaught exception; both crash Node by default.
- In TypeScript, `promisify` infers types from the callee, which ff ignored. A cast like `as (..., next: () => void) => void` now gives `Promise<void>`, and tsc reports it. Fix it by hand.
