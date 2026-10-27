# ff2async

Codemod that rewrites straight-line [`ff`](https://github.com/play-co/ff) chains to async/await. Chains it can't convert safely are left as they are and reported with the reason. The mapping follows [ff-behavior](https://github.com/andriyor/ff-behavior) and its `migrate-ff` skill.

```bash
git clone https://github.com/andriyor/ff2async.git && cd ff2async
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

When the chain is the whole function, after setup that can't throw (declarations of literals, names, arrays, objects or functions), and its `onComplete` gets the function's own callback as `next` or `h(next)`, the body moves to an async function next to it:

```js
const getStatus = function (doc, next) {
  callbackify(getStatusAsync)(doc, error.hc(next));
};

async function getStatusAsync(doc) {
  // setup and chain body
}
```

`getStatusAsync` is exported wherever `getStatus` is, so callers can move to it one at a time. It rejects with the raw error, before `h` (here `error.hc`) is applied. Any other `onComplete` keeps the inline `callbackify(async () => {...})(cb)`.

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
- A step's error goes to the handler as before. A throw inside a handler is now an unhandled rejection under `.then()`, not an uncaught exception; both crash Node by default. See [`callbackify` for `.onComplete`](#callbackify-for-oncomplete-then-for-onsuccessonerror).
- In TypeScript, `promisify` infers types from the callee, which ff ignored. A cast like `as (..., next: () => void) => void` now gives `Promise<void>`, and tsc reports it. Fix it by hand.

## Technical decisions

### `callbackify` for `.onComplete`, `.then` for `.onSuccess`/`.onError`

An `.onComplete(cb)` chain becomes `callbackify(...)(cb)`, not the shorter

```js
(async () => { ... })().then((v) => cb(null, v), (err) => cb(err));
```

The two differ only when the callback itself throws, for example when `next` crashes while rendering a response:

| | ff | `callbackify` | `.then(s, e)` |
|---|---|---|---|
| Callback throws | uncaught exception | uncaught exception, rethrown on the next tick | rejection nothing handles |
| Process | crashes | crashes | crashes on Node 15+ with the default `--unhandled-rejections=throw`; keeps running if the app has an `unhandledRejection` handler or that flag is changed |
| Reported as | uncaught exception | uncaught exception | unhandled rejection |

`callbackify` matches ff in every row. `.then(s, e)` matches only while Node's default holds, and even then the crash is reported as a different kind of error, which error-reporting tools can treat differently.

`.onSuccess`/`.onError` chains still end in `.then(s, e)` or `.catch(e)`: their handlers are two separate functions, not one Node callback, so `callbackify` doesn't fit. They carry the risk above; check the target app's `unhandledRejection` handling before relying on them.

### A named `fnAsync` instead of an inline wrapper

Where the chain is the whole function, its body moves to `fnAsync` and `fn` becomes `callbackify(fnAsync)(..., next)`. It's the same amount of `callbackify`, but less nesting, and each function gets an async version that callers can switch to one at a time. Once nothing calls `fn` with a callback, `fn` can be deleted.

It is only done when it can't change behaviour:

- **Setup must not throw.** Before, a throw in the setup reached `fn`'s caller; inside `fnAsync` it would reach the callback. Only declarations of literals, names, arrays, objects and functions are moved.
- **The callback is `next` or `h(next)`.** A custom `function (err) {...}` that logs or reshapes the result belongs to the callback API, so that wrapper stays inline.
- **The callback is used nowhere else.** `next = next || noop` or a second use keeps the inline form.

`fnAsync` rejects with the raw error, before `h` (e.g. a helper that wraps errors) is applied. Callback callers see no change; callers moved to `fnAsync` get the raw error.

### Not removing `promisify`

`promisify` can only go where the callee already returns a promise, and that is a fact about the callee, not the call site:

- **Callback-only libraries** keep it; removing it needs a library upgrade or a per-library rule (e.g. `.promise()` on aws-sdk v2).
- **Local functions** could become plain `async`, but only by changing the function and every caller at once. A generic callback-to-async rewrite can't know whether a callback is called once, twice or never, which is the behaviour ff guarantees and this codemod relies on. The `fnAsync` split is the safe part of that: callers switch to `await fnAsync(...)`, and `promisify(fn)` goes with them.

### Not using an existing codemod

Existing callback/promise codemods (e.g. [asyncify](https://github.com/codemodsquad/asyncify), [async-await-codemod](https://github.com/sgilroy/async-await-codemod)) convert `.then` chains, not callbacks or ff. Run on this codemod's output, asyncify only wraps the `.then(s, e)` endings in another async function. Its parser also rejects TypeScript's `import x = require()`.

## Codemod or migrate-ff skill

Use both. The codemod does the mechanical bulk; the [`migrate-ff` skill](https://github.com/andriyor/ff-behavior/blob/master/skills/migrate-ff/SKILL.md) does the rest.

The codemod is better at:

- **Same input, same output.** Every chain it converts follows one mapping, so a reviewer learns the output shape once and skims. A rewrite by hand or by the skill can drift per file, e.g. a parallel call quietly made sequential.
- **Refusing unsafe cases.** It skips any chain whose conversion could change behaviour and says why, instead of relying on someone to remember every gotcha in every file.
- **Reruns.** Free to run again after a rebase, or on another repo.

The skill is better at:

- **The skipped chains.** They need judgement: code after a slot, whether errors ff dropped should stay dropped, `f` inside a nested callback.
- **Idiomatic output.** The codemod is faithful but mechanical (`promisify(x.bind(x))`, `pending` arrays, `callbackify` wrappers). The skill can write a plain async function and export it.
- **Tests.** The skill writes a test against the ff code before converting it. The codemod doesn't, and a project's own tests may barely touch its ff chains: run `node --check` and the type-checker on the result, not just the tests.

Suggested flow:

1. Run the codemod on a branch. Review the diff, fix what tsc reports, and ship it as its own PR; a mechanical diff is easy to review.
2. Migrate the skipped chains one at a time with the skill, writing a test first for each.
3. Later, turn `callbackify` wrappers into async exports once their callers are async.

For a handful of chains in a single repo, the skill alone is cheaper.
