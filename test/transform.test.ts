import { describe, expect, it } from "vitest";
import { transform } from "../src/transform";

// Each case is a module exporting run(cb). It runs once as ff and once
// rewritten, and both must call back the same way. `api` is a fake with
// callback methods, given to the module as a global.

const api = {
  get: (id: unknown, cb: Function) => setTimeout(() => cb(null, "v" + id), 3),
  slow: (id: unknown, cb: Function) => setTimeout(() => cb(null, "s" + id), 8),
  bad: (id: unknown, cb: Function) => setTimeout(() => cb(new Error("bad " + id)), 2),
  put: (_v: unknown, cb: Function) => setTimeout(() => cb(null, "ignored"), 2),
  two: (cb: Function) => setTimeout(() => cb(null, 1, 2), 2),
  plain: (cb: Function) => setTimeout(() => cb(false), 2),
  self: {
    prefix: "p",
    get(this: { prefix: string }, id: unknown, cb: Function) {
      setTimeout(() => cb(null, this.prefix + id), 2);
    },
  },
  late: (cb: Function, id: unknown) => setTimeout(() => cb(null, "late" + id), 2),
};

function load(code: string) {
  const mod = { exports: {} as any };
  new Function("module", "require", "api", code)(mod, require, api);
  return mod.exports.run as (...args: any[]) => void;
}

function call(run: (...args: any[]) => void, ...args: any[]) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ hung: true }), 200);
    run(...args, (err: any, ...values: any[]) => {
      clearTimeout(timer);
      resolve(err ? { err: err.message } : { values: values.length ? values : [undefined] });
    });
  });
}

const header = `const ff = require("ff");\n`;

function check(name: string, body: string, inputs: any[][] = [[]], expectSkip = false) {
  it(name, async () => {
    const before = header + body;
    const out = transform(before);
    if (expectSkip) {
      expect(out.converted, out.text).toBe(0);
      expect(out.skipped.length).toBeGreaterThan(0);
      return;
    }
    expect(out.skipped, out.text).toEqual([]);
    expect(out.converted).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/\bff\b|\bf\.(slot|pass|succeed|fail|wait)/);
    for (const input of inputs) {
      expect(await call(load(out.text), ...input), out.text).toEqual(await call(load(before), ...input));
    }
  });
}

describe("converts", () => {
  check(
    "parallel slots, args in slot order",
    `module.exports.run = function (id, next) {
      const f = ff(
        function () {
          api.slow(id, f.slot());
          api.get(id, f.slot());
        },
        function (a, b) {
          f.pass(a + b);
        }
      ).onComplete(next);
    };`,
    [[1]]
  );

  check(
    "sequential steps, wait, early succeed",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.put(id, f.wait());
        },
        () => {
          if (!id) return f.succeed("none");
          api.get(id, f.slot());
        },
        (v) => {
          f.pass(v.toUpperCase());
        }
      )
        .onSuccess((v) => next(null, v))
        .onError((err) => next(err));
    };`,
    [[1], [0]]
  );

  check(
    "slot error and fail",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id === 2) return f.fail(new Error("two"));
          api.bad(id, f.slot());
          api.get(id, f.slot());
        },
        () => f.pass("unreachable")
      ).onComplete(next);
    };`,
    [[1], [2]]
  );

  check(
    "a throw in a step",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.get(id, f.slot());
        },
        (v) => {
          if (v === "v1") throw new Error("thrown");
          f.pass(v);
        }
      ).onComplete(next);
    };`,
    [[1], [2]]
  );

  check(
    "slotMulti, slotPlain, waitPlain",
    `module.exports.run = function (next) {
      const f = ff(
        () => {
          api.two(f.slotMulti(2));
          api.plain(f.slotPlain());
          api.plain(f.waitPlain());
        },
        (a, b, p) => {
          f.pass([a, b, p]);
        }
      ).onComplete(next);
    };`
  );

  check(
    "method keeps this; slot not last uses new Promise",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.self.get(id, f.slot());
          api.late(f.slot(), id);
        },
        (a, b) => f.pass(a + b)
      ).onComplete(next);
    };`,
    [[1]]
  );

  check(
    "passes and values the next step doesn't name",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          const extra = id * 2;
          f.pass(extra, "x");
          api.get(id, f.slot());
        },
        (extra, _x, v) => {
          f.pass(extra + v);
        }
      ).onComplete(next);
    };`,
    [[1]]
  );

  check(
    "onSuccess only, last step slot",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.get(id, f.slot());
        },
        (v) => {
          api.get(v, f.slot());
        }
      ).onSuccess((v) => next(null, v));
    };`,
    [[1]]
  );

  check(
    "succeed with no value and onComplete",
    `module.exports.run = function (next) {
      const f = ff(() => {
        return f.succeed();
      }).onComplete(next);
    };`
  );

  check(
    "nested chain in a helper inside a step",
    `module.exports.run = function (id, next) {
      function inner(x, cb) {
        const g = ff(() => {
          api.get(x, g.slot());
        }).onComplete(cb);
      }
      const f = ff(
        () => {
          inner(id, f.slot());
        },
        (v) => f.pass(v + "!")
      ).onComplete(next);
    };`,
    [[1]]
  );
});

describe("converts slots in if/else", () => {
  check(
    "optional slot, value is undefined when skipped",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id) api.get(id, f.slot());
        },
        (v) => f.pass(v === undefined ? "none" : v)
      ).onComplete(next);
    };`,
    [[1], [0]]
  );

  check(
    "slot in both branches, fail in a third",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id === 1) {
            api.get(id, f.slot());
          } else if (id === 2) {
            api.slow(id, f.slot());
          } else {
            return f.fail(new Error("bad id"));
          }
        },
        (v) => {
          if (!v) return f.fail(new Error("empty"));
          f.pass(v + "!");
        }
      ).onComplete(next);
    };`,
    [[1], [2], [3]]
  );

  check(
    "unconditional slot then optional one; parallel, args in order",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.slow(id, f.slot());
          if (id > 1) {
            api.get(id, f.slot());
          }
        },
        (a, b) => f.pass([a, b])
      ).onComplete(next);
    };`,
    [[1], [2]]
  );

  check(
    "slot in one branch, pass in the other",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id) {
            api.get(id, f.slot());
          } else {
            f.pass(null);
          }
          if (id !== 2) {
            api.slow(id, f.slot());
          } else {
            f.pass("two");
          }
        },
        (a, b) => f.pass([a, b])
      ).onComplete(next);
    };`,
    [[1], [0], [2]]
  );

  check(
    "early succeed before a branch, slot error in a branch",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id === 0) {
            return f.succeed("zero");
          }
          if (id === 1) {
            api.bad(id, f.slot());
          } else {
            api.get(id, f.slot());
          }
        },
        (v) => f.pass(v)
      ).onComplete(next);
    };`,
    [[0], [1], [2]]
  );

  check(
    "waits in branches, wait-only last step",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.get(id, f.slot());
        },
        (v) => {
          if (id) {
            api.put(v, f.wait());
          }
        }
      ).onComplete(next);
    };`,
    [[1], [0]]
  );

  check(
    "succeed as the last statement of a branch",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.get(id, f.slot());
        },
        (v) => {
          if (id === 1) {
            f.succeed("one");
          } else {
            api.get(v, f.slot());
          }
        }
      ).onSuccess((v) => next(null, v)).onError(next);
    };`,
    [[1], [2]]
  );
});

describe("skips", () => {
  check(
    "f inside a nested callback",
    `module.exports.run = function (next) {
      const f = ff(() => {
        setTimeout(() => api.get(1, f.slot()), 1);
      }).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "slot in a branch that never registers can't pick a position",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id) api.get(id, f.slot());
          api.get(2, f.slot());
        },
        (a, b) => f.pass([a, b])
      ).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "branches giving different values",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id) api.get(id, f.slot());
          else api.two(f.slotMulti(2));
        },
        (a, b) => f.pass([a, b])
      ).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "a slot that is never called back",
    `module.exports.run = function (next) {
      const f = ff(
        () => {
          f.wait();
        },
        () => f.pass(1)
      ).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "code after a slot in a branch",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          if (id) {
            api.get(id, f.slot());
            api.put(1, () => {});
          }
        },
        (v) => f.pass(v)
      ).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "succeed without return, with code after",
    `module.exports.run = function (next) {
      const f = ff(() => {
        f.succeed(1);
        api.put(1, () => {});
      }).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "code after the chain",
    `module.exports.run = function (next) {
      let x = 0;
      const f = ff(() => f.pass(x)).onComplete(next);
      x = 1;
    };`,
    [[]],
    true
  );

  check(
    "step uses this",
    `module.exports.run = function (next) {
      const f = ff(function () {
        f.pass(this);
      }).onComplete(next);
    };`,
    [[]],
    true
  );

  check(
    "same name in two steps",
    `module.exports.run = function (next) {
      const f = ff(
        () => {
          const x = 1;
          api.get(x, f.slot());
        },
        (v) => {
          const x = v;
          f.pass(x);
        }
      ).onComplete(next);
    };`,
    [[]],
    true
  );
});

it("output for a TypeScript file keeps types and fixes imports", () => {
  const src = `// @ts-ignore // not typescript-ified yet
import ff = require("ff");

export function load(id: string, next: (err: Error | null, v?: string) => void) {
  const f = ff(
    () => {
      api.get(id, f.slotMulti(2));
    },
    (a: string, b: number) => {
      f.pass(a + b);
    }
  ).onComplete(next);
}
`;
  expect(transform(src, "x.ts").text).toMatchInlineSnapshot(`
    "import { callbackify } from "util";

    export function load(id: string, next: (err: Error | null, v?: string) => void) {
      callbackify(async () => {
        const [a, b]: [string, number] = await new Promise<any>((resolve, reject) => api.get(id, (err: any, ...values: any[]) => (err ? reject(err) : resolve(values))));
        return a + b;
      })(next);
    }
    "
  `);
});

it("two branched steps get different array names", () => {
  const out = transform(`${header}module.exports.run = function (id, next) {
  const f = ff(
    () => {
      if (id) api.get(id, f.slot());
    },
    (v) => {
      if (v) api.get(v, f.slot());
    },
    (w) => f.pass(w)
  ).onComplete(next);
};`);
  expect(out.text).toContain("const pending = []");
  expect(out.text).toContain("const pending2 = []");
});

describe("pass of a same-named value after a slot", () => {
  check(
    "is not declared twice",
    `module.exports.run = function (id, next) {
      const f = ff(
        () => {
          api.get(id, f.slot());
        },
        (attributes) => {
          api.slow(id, f.slot());
          f.pass(attributes);
        },
        (s, attributes) => f.pass(s + attributes)
      ).onComplete(next);
    };`,
    [[1]]
  );
});
