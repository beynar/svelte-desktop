// @bun
import {
  MUTATIVE_METHODS,
  ValidationError,
  create_field_proxy,
  create_remote_key,
  deep_set,
  error,
  flatten_issues,
  get_request_store,
  handle_error_and_jsonify,
  init_remote_functions,
  noop,
  normalize_issue,
  parse_form_key,
  prerendering,
  set_nested_value,
  stringify_remote_arg,
  with_request_store
} from "./index-ekdhm16k.js";

// .svelte-kit/output/server/chunks/remote.js
function create_validator(validate_or_fn, maybe_fn) {
  if (!maybe_fn)
    return (arg) => {
      if (arg !== undefined)
        error(400, "Bad Request");
    };
  if (validate_or_fn === "unchecked")
    return (arg) => arg;
  if ("~standard" in validate_or_fn)
    return async (arg) => {
      const result = await validate_or_fn["~standard"].validate(arg);
      if (result.issues)
        throw new ValidationError(result.issues);
      return result.value;
    };
  throw new Error('Invalid validator passed to remote function. Expected "unchecked" or a Standard Schema (https://standardschema.dev)');
}
async function get_response(internals, payload, state, get_result) {
  await 0;
  const cache = get_cache(internals, state);
  if (!state.is_in_remote_query)
    get_implicit_lookup(internals, state)[payload] = get_result;
  return cache[payload] ??= get_result();
}
function derive_remote_function_event(event, state, allow_cookies) {
  const derived = {
    ...event,
    setHeaders: () => {
      throw new Error("setHeaders is not allowed in remote functions");
    },
    cookies: {
      ...event.cookies,
      set: (name, value, opts) => {
        if (!allow_cookies)
          throw new Error("Cannot set cookies in `query` or `prerender` functions");
        if (opts.path && !opts.path.startsWith("/"))
          throw new Error("Cookies set in remote functions must have an absolute path");
        return event.cookies.set(name, value, opts);
      },
      delete: (name, opts) => {
        if (!allow_cookies)
          throw new Error("Cannot delete cookies in `query` or `prerender` functions");
        if (opts.path && !opts.path.startsWith("/"))
          throw new Error("Cookies deleted in remote functions must have an absolute path");
        return event.cookies.delete(name, opts);
      }
    }
  };
  if (state.is_in_remote_query)
    for (const property of [
      "url",
      "params",
      "route"
    ])
      Object.defineProperty(derived, property, {
        enumerable: false,
        get() {
          throw new Error(`Cannot access event.${property} in a query. Pass the value as an argument to the query instead`);
        }
      });
  return {
    event: derived,
    state: {
      ...state,
      is_in_remote_function: true
    }
  };
}
async function run_remote_function(event, state, allow_cookies, get_input, fn) {
  const store = derive_remote_function_event(event, state, allow_cookies);
  const input = await with_request_store(store, get_input);
  return with_request_store(store, () => fn(input));
}
async function* run_remote_generator(event, state, allow_cookies, get_input, fn, name) {
  const store = derive_remote_function_event(event, state, allow_cookies);
  const input = await with_request_store(store, get_input);
  const iterator = to_iterator(await with_request_store(store, () => fn(input)), name);
  let done = false;
  try {
    while (true) {
      const result = await with_request_store(store, () => iterator.next());
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done && typeof iterator.return === "function")
      await with_request_store(store, () => iterator.return?.(undefined));
  }
}
function to_iterator(source, name) {
  if ("next" in source && typeof source.next === "function")
    return source;
  if (Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === "function")
    return source[Symbol.asyncIterator]();
  if (Symbol.iterator in source && typeof source[Symbol.iterator] === "function")
    return source[Symbol.iterator]();
  throw new Error(`query.live '${name}' must return an Iterator, Iterable, AsyncIterator or AsyncIterable`);
}
function get_cache(internals, state) {
  let cache = state.remote.data?.get(internals);
  if (cache === undefined) {
    cache = {};
    (state.remote.data ??= /* @__PURE__ */ new Map).set(internals, cache);
  }
  return cache;
}
function get_implicit_lookup(internals, state) {
  let cache = state.remote.implicit?.get(internals);
  if (cache === undefined) {
    cache = {};
    (state.remote.implicit ??= /* @__PURE__ */ new Map).set(internals, cache);
  }
  return cache;
}
function command(validate_or_fn, maybe_fn) {
  const fn = maybe_fn ?? validate_or_fn;
  const validate = create_validator(validate_or_fn, maybe_fn);
  const __ = {
    type: "command",
    id: "",
    name: ""
  };
  const wrapper = (arg) => {
    const { event, state } = get_request_store();
    if (!MUTATIVE_METHODS.includes(event.request.method) || state.is_in_remote_query || state.is_in_remote_prerender) {
      const violation = state.is_in_remote_query || state.is_in_remote_prerender ? `inside a query or prerender function` : `from a ${event.request.method} handler`;
      throw new Error(`Cannot call a command (${__.name}) ${violation}`);
    }
    if (state.is_in_render)
      throw new Error(`Cannot call a command (${__.name}) during server-side rendering`);
    const promise = Promise.resolve(run_remote_function(event, state, true, () => validate(arg), fn));
    promise.updates = () => {
      throw new Error(`Cannot call '${__.name}(...).updates(...)' on the server`);
    };
    return promise;
  };
  Object.defineProperty(wrapper, "__", { value: __ });
  Object.defineProperty(wrapper, "pending", { get: () => 0 });
  return wrapper;
}
function form(validate_or_fn, maybe_fn) {
  const fn = maybe_fn ?? validate_or_fn;
  const schema = !maybe_fn || validate_or_fn === "unchecked" ? null : validate_or_fn;
  function create_instance(key) {
    const instance = {};
    instance.method = "POST";
    Object.defineProperty(instance, "enhance", { value: () => {
      return {
        action: instance.action,
        method: instance.method
      };
    } });
    const __ = {
      type: "form",
      name: "",
      id: "",
      fn: async (data, meta, form_data) => {
        const output = {};
        output.submission = true;
        const { event, state } = get_request_store();
        const validated = await schema?.["~standard"].validate(data);
        if (meta.validate_only)
          return validated?.issues?.map((issue) => normalize_issue(issue, true)) ?? [];
        if (validated?.issues !== undefined)
          handle_issues(output, validated.issues, form_data, __.id);
        else {
          if (validated !== undefined)
            data = validated.value;
          const issue = create_issues();
          try {
            output.result = await run_remote_function(event, state, true, () => data, (data2) => !maybe_fn ? fn() : fn(data2, issue));
          } catch (e) {
            if (e instanceof ValidationError)
              handle_issues(output, e.issues, form_data, __.id);
            else
              throw e;
          }
        }
        if (!event.isRemoteRequest) {
          const cache = get_cache(__, state);
          cache[""] ??= output;
          get_implicit_lookup(__, state)[__.key ? `${__.id}/${__.key}` : __.id] = () => cache[""];
        }
        return output;
      }
    };
    Object.defineProperty(instance, "__", { value: __ });
    Object.defineProperty(instance, "action", {
      get: () => {
        const search = new URLSearchParams(get_request_store().event.url.search);
        search.delete("/remote");
        const query = search.toString();
        const action_id = __.key ? `${__.id}/${encodeURIComponent(__.key)}` : __.id;
        return `?${query ? `${query}&` : ""}/remote=${action_id}`;
      },
      enumerable: true
    });
    Object.defineProperty(instance, "fields", { get() {
      return create_field_proxy({
        form_id: __.id,
        get: () => get_cache(__, get_request_store().state)?.[""]?.input ?? {},
        set: (path, value) => {
          const cache = get_cache(__, get_request_store().state);
          const entry = cache[""];
          if (entry?.submission)
            return;
          if (path.length === 0) {
            (cache[""] ??= {}).input = value;
            return;
          }
          const input = entry?.input ?? {};
          deep_set(input, path.map(String), value);
          (cache[""] ??= {}).input = input;
        },
        get_issues: () => flatten_issues(get_cache(__, get_request_store().state)?.[""]?.issues ?? []),
        get_touched: () => ({}),
        get_dirty: () => ({})
      });
    } });
    Object.defineProperty(instance, "result", { get() {
      try {
        return get_cache(__, get_request_store().state)?.[""]?.result;
      } catch {
        return;
      }
    } });
    Object.defineProperty(instance, "pending", { get: () => 0 });
    Object.defineProperty(instance, "submitted", { get: () => false });
    Object.defineProperty(instance, "preflight", { value: () => instance });
    Object.defineProperty(instance, "validate", { value: () => {
      throw new Error("Cannot call validate() on the server");
    } });
    Object.defineProperty(instance, "submit", { value: () => {
      throw new Error("Cannot call submit() on the server");
    } });
    Object.defineProperty(instance, "element", { get: () => null });
    if (key == undefined)
      Object.defineProperty(instance, "for", {
        value: (key2) => {
          const { state } = get_request_store();
          const cache_key = __.id + "|" + JSON.stringify(key2);
          let instance2 = (state.remote.forms ??= /* @__PURE__ */ new Map).get(cache_key);
          if (!instance2) {
            instance2 = create_instance(key2);
            instance2.__.id = __.id;
            instance2.__.key = JSON.stringify(key2);
            instance2.__.name = __.name;
            state.remote.forms.set(cache_key, instance2);
          }
          return instance2;
        }
      });
    return instance;
  }
  return create_instance();
}
function handle_issues(output, issues, form_data, form_id) {
  output.issues = issues.map((issue) => normalize_issue(issue, true));
  if (form_data) {
    output.input = {};
    for (const field_name of form_data.keys()) {
      if (/^[.\]]?_/.test(field_name))
        continue;
      const values = form_data.getAll(field_name).filter((value) => typeof value === "string");
      const field = parse_form_key(form_id, field_name);
      set_nested_value(output.input, field, field.is_array ? values : values[0]);
    }
  }
}
function create_issues() {
  return new Proxy((message) => {
    return create_issue(message);
  }, { get(target, prop) {
    if (typeof prop === "symbol")
      return target[prop];
    return create_issue_proxy(prop, []);
  } });
  function create_issue(message, path = []) {
    return {
      message,
      path
    };
  }
  function create_issue_proxy(key, path) {
    const new_path = [...path, key];
    const issue_func = (message) => create_issue(message, new_path);
    return new Proxy(issue_func, { get(target, prop) {
      if (typeof prop === "symbol")
        return target[prop];
      if (/^\d+$/.test(prop))
        return create_issue_proxy(parseInt(prop, 10), new_path);
      return create_issue_proxy(prop, new_path);
    } });
  }
}
var SharedIterator = class {
  #subscribers = /* @__PURE__ */ new Set;
  #start = undefined;
  #stop = undefined;
  #closed = false;
  #terminal_error = undefined;
  get closed() {
    return this.#closed;
  }
  constructor(start) {
    this.#start = start;
  }
  push(value) {
    if (this.#closed)
      return;
    for (const subscriber of this.#subscribers)
      if (subscriber.waiting_resolve) {
        const resolve = subscriber.waiting_resolve;
        subscriber.waiting_resolve = null;
        subscriber.waiting_reject = null;
        resolve({
          value,
          done: false
        });
      } else
        subscriber.pending = { value };
  }
  done() {
    if (this.#closed)
      return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.finished = true;
      if (subscriber.waiting_resolve) {
        const resolve = subscriber.waiting_resolve;
        subscriber.waiting_resolve = null;
        subscriber.waiting_reject = null;
        resolve({
          value: undefined,
          done: true
        });
      }
    }
    this.#subscribers.clear();
  }
  fail(error2) {
    if (this.#closed)
      return;
    this.#closed = true;
    this.#terminal_error = error2;
    for (const subscriber of this.#subscribers) {
      subscriber.finished = true;
      if (subscriber.waiting_reject) {
        const reject = subscriber.waiting_reject;
        subscriber.waiting_resolve = null;
        subscriber.waiting_reject = null;
        reject(error2);
      } else
        subscriber.pending_error = { error: error2 };
    }
    this.#subscribers.clear();
  }
  subscribe(options) {
    const subscriber = {
      pending: options?.initial_value ? { value: options.initial_value.value } : null,
      pending_error: this.#closed && this.#terminal_error !== undefined ? { error: this.#terminal_error } : null,
      finished: this.#closed && this.#terminal_error === undefined,
      waiting_resolve: null,
      waiting_reject: null
    };
    if (!subscriber.finished && subscriber.pending_error === null)
      this.#subscribers.add(subscriber);
    if (!this.#closed)
      this.#stop ??= this.#start?.(this);
    const unsubscribe = () => {
      subscriber.finished = true;
      if (this.#subscribers.delete(subscriber) && this.#subscribers.size === 0)
        this.#stop?.();
    };
    const iterator = {
      next() {
        if (subscriber.pending_error) {
          const { error: error2 } = subscriber.pending_error;
          subscriber.pending_error = null;
          unsubscribe();
          return Promise.reject(error2);
        }
        if (subscriber.pending) {
          const { value } = subscriber.pending;
          subscriber.pending = null;
          return Promise.resolve({
            value,
            done: false
          });
        }
        if (subscriber.finished)
          return Promise.resolve({
            value: undefined,
            done: true
          });
        return new Promise((resolve, reject) => {
          subscriber.waiting_resolve = resolve;
          subscriber.waiting_reject = reject;
        });
      },
      return(value) {
        unsubscribe();
        if (subscriber.waiting_resolve) {
          const resolve = subscriber.waiting_resolve;
          subscriber.waiting_resolve = null;
          subscriber.waiting_reject = null;
          resolve({
            value: undefined,
            done: true
          });
        }
        return Promise.resolve({
          value,
          done: true
        });
      },
      throw(error2) {
        unsubscribe();
        if (subscriber.waiting_reject) {
          const reject = subscriber.waiting_reject;
          subscriber.waiting_resolve = null;
          subscriber.waiting_reject = null;
          reject(error2);
        }
        return Promise.reject(error2);
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async[Symbol.asyncDispose]() {}
    };
    return iterator;
  }
};
function query(validate_or_fn, maybe_fn) {
  const fn = maybe_fn ?? validate_or_fn;
  const validate = create_validator(validate_or_fn, maybe_fn);
  const __ = {
    type: "query",
    id: "",
    name: "",
    validate,
    bind(payload, validated_arg) {
      const { event, state } = get_request_store();
      return create_query_resource(__, payload, event, state, () => run_remote_function(event, {
        ...state,
        is_in_remote_query: true
      }, false, () => validated_arg, fn));
    }
  };
  const wrapper = (arg) => {
    if (prerendering)
      throw new Error(`Cannot call query '${__.name}' while prerendering, as prerendered pages need static data. Use 'prerender' from $app/server instead`);
    const { event, state } = get_request_store();
    const payload = stringify_remote_arg(arg);
    return create_query_resource(__, payload, event, state, () => run_remote_function(event, {
      ...state,
      is_in_remote_query: true
    }, false, () => validate(arg), fn));
  };
  Object.defineProperty(wrapper, "__", { value: __ });
  return wrapper;
}
function live(validate_or_fn, maybe_fn) {
  const fn = maybe_fn ?? validate_or_fn;
  const validate = create_validator(validate_or_fn, maybe_fn);
  const run = (event, state, get_input) => run_remote_generator(event, {
    ...state,
    is_in_remote_query: true
  }, false, get_input, fn, __.name);
  const __ = {
    type: "query_live",
    id: "",
    name: "",
    run: (event, state, arg) => run(event, state, () => validate(arg)),
    validate,
    bind(payload, validated_arg) {
      const { event, state } = get_request_store();
      return create_live_query_resource(__, payload, event, state, () => run(event, state, () => validated_arg));
    }
  };
  const wrapper = (arg) => {
    if (prerendering)
      throw new Error(`Cannot call query.live '${__.name}' while prerendering, as prerendered pages need static data. Use 'prerender' from $app/server instead`);
    const { event, state } = get_request_store();
    const payload = stringify_remote_arg(arg);
    return create_live_query_resource(__, payload, event, state, () => run(event, state, () => validate(arg)));
  };
  Object.defineProperty(wrapper, "__", { value: __ });
  return wrapper;
}
function batch(validate_or_fn, maybe_fn) {
  const fn = maybe_fn ?? validate_or_fn;
  const validate = create_validator(validate_or_fn, maybe_fn);
  const enqueue = (payload, get_validated) => {
    const { event, state } = get_request_store();
    return new Promise((resolve, reject) => {
      const batches = state.remote.batches ??= /* @__PURE__ */ new Map;
      let batched = batches.get(__.id);
      if (!batched) {
        batched = /* @__PURE__ */ new Map;
        batches.set(__.id, batched);
      }
      const entry = batched.get(payload);
      if (entry) {
        entry.resolvers.push({
          resolve,
          reject
        });
        return;
      }
      batched.set(payload, {
        get_validated,
        resolvers: [{
          resolve,
          reject
        }]
      });
      if (batched.size > 1)
        return;
      setTimeout(async () => {
        batches.delete(__.id);
        const entries = Array.from(batched.values());
        try {
          return await run_remote_function(event, {
            ...state,
            is_in_remote_query: true
          }, false, async () => Promise.all(entries.map((entry2) => entry2.get_validated())), async (input) => {
            const get_result = await fn(input);
            for (let i = 0;i < entries.length; i++)
              try {
                const result = get_result(input[i], i);
                for (const resolver of entries[i].resolvers)
                  resolver.resolve(result);
              } catch (error2) {
                for (const resolver of entries[i].resolvers)
                  resolver.reject(error2);
              }
          });
        } catch (error2) {
          for (const entry2 of batched.values())
            for (const resolver of entry2.resolvers)
              resolver.reject(error2);
        }
      }, 0);
    });
  };
  const __ = {
    type: "query_batch",
    id: "",
    name: "",
    validate,
    run: async (args) => {
      const { event, state } = get_request_store();
      return run_remote_function(event, {
        ...state,
        is_in_remote_query: true
      }, false, async () => Promise.all(args.map(validate)), async (input) => {
        const get_result = await fn(input);
        return Promise.all(input.map(async (arg, i) => {
          try {
            return {
              type: "result",
              data: get_result(arg, i)
            };
          } catch (error2) {
            return {
              type: "error",
              error: await handle_error_and_jsonify(event, state, error2)
            };
          }
        }));
      });
    },
    bind(payload, validated_arg) {
      const { event, state } = get_request_store();
      return create_query_resource(__, payload, event, state, () => enqueue(payload, () => validated_arg));
    }
  };
  const wrapper = (arg) => {
    if (prerendering)
      throw new Error(`Cannot call query.batch '${__.name}' while prerendering, as prerendered pages need static data. Use 'prerender' from $app/server instead`);
    const { event, state } = get_request_store();
    const payload = stringify_remote_arg(arg);
    return create_query_resource(__, payload, event, state, () => enqueue(payload, () => validate(arg)));
  };
  Object.defineProperty(wrapper, "__", { value: __ });
  return wrapper;
}
function refresh(event, state, internals, payload, fn) {
  if (!internals.id)
    return;
  if (!event.isRemoteRequest && state.is_in_remote_form_or_command)
    return;
  const key = create_remote_key(internals.id, payload);
  (state.remote.explicit ??= /* @__PURE__ */ new Map).set(key, {
    internals,
    fn
  });
}
function create_query_resource(__, payload, event, state, fn) {
  let promise = null;
  const get_promise = () => {
    return promise ??= get_response(__, payload, state, fn);
  };
  const populate_hydratable = () => {
    if (__.id && state.is_in_render)
      get_promise().catch(noop);
  };
  return {
    catch(onrejected) {
      return get_promise().catch(onrejected);
    },
    get current() {
      populate_hydratable();
    },
    get error() {
      populate_hydratable();
    },
    finally(onfinally) {
      return get_promise().finally(onfinally);
    },
    get loading() {
      populate_hydratable();
      return true;
    },
    get ready() {
      populate_hydratable();
      return false;
    },
    refresh() {
      promise = null;
      delete get_cache(__, state)[payload];
      refresh(event, state, __, payload, get_promise);
      return Promise.resolve();
    },
    set(value) {
      const p = promise = Promise.resolve(value);
      get_cache(__, state)[payload] = p;
      refresh(event, state, __, payload, () => p);
    },
    then(onfulfilled, onrejected) {
      return get_promise().then(onfulfilled, onrejected);
    },
    withOverride() {
      throw new Error(`Cannot call '${__.name}.withOverride()' on the server`);
    },
    get [Symbol.toStringTag]() {
      return "QueryResource";
    }
  };
}
function create_live_query_resource(__, payload, event, state, get_generator) {
  let promise = null;
  const get_first_value = async () => {
    for await (const value of get_generator())
      return value;
    throw new Error(`query.live '${__.name}' did not yield a value`);
  };
  const get_promise = () => {
    return promise ??= get_response(__, payload, state, get_first_value);
  };
  const populate_hydratable = () => {
    if (__.id && state.is_in_render)
      get_promise().catch(noop);
  };
  return {
    catch(onrejected) {
      return get_promise().catch(onrejected);
    },
    get current() {
      populate_hydratable();
    },
    get error() {
      populate_hydratable();
    },
    finally(onfinally) {
      return get_promise().finally(onfinally);
    },
    get done() {
      populate_hydratable();
      return false;
    },
    get loading() {
      populate_hydratable();
      return true;
    },
    get ready() {
      populate_hydratable();
      return false;
    },
    get connected() {
      populate_hydratable();
      return false;
    },
    reconnect() {
      promise = null;
      delete get_cache(__, state)[payload];
      refresh(event, state, __, payload, get_promise);
      return Promise.resolve();
    },
    then(onfulfilled, onrejected) {
      return get_promise().then(onfulfilled, onrejected);
    },
    [Symbol.asyncIterator]() {
      const key = create_remote_key(__.id, payload);
      const cache = state.remote.live_iterators ??= /* @__PURE__ */ new Map;
      let cached = cache.get(key);
      if (!cached) {
        cached = create_shared_live_iterator(event.request.signal, get_generator);
        cache.set(key, cached);
      }
      return cached.subscribe();
    },
    get [Symbol.toStringTag]() {
      return "LiveQueryResource";
    }
  };
}
function create_shared_live_iterator(signal, get_generator) {
  return new SharedIterator((instance) => {
    if (signal.aborted) {
      instance.done();
      return noop;
    }
    const generator = get_generator();
    let aborted = false;
    const close = () => {
      aborted = true;
      generator.return().catch(noop);
    };
    signal.addEventListener("abort", () => (close(), instance.done()), { once: true });
    (async () => {
      try {
        while (true) {
          const result = await generator.next();
          if (result.done) {
            instance.done();
            return;
          }
          instance.push(result.value);
        }
      } catch (error2) {
        if (!aborted)
          instance.fail(error2);
      } finally {
        close();
      }
    })();
    return close;
  });
}
Object.defineProperty(query, "batch", {
  value: batch,
  enumerable: true
});
Object.defineProperty(query, "live", {
  value: live,
  enumerable: true
});

// .svelte-kit/output/server/chunks/data.remote.js
import { Database } from "bun:sqlite";
import { arch, homedir, hostname, platform } from "os";
import { join } from "path";
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
  let target = {};
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true
    });
  if (!no_symbols)
    __defProp(target, Symbol.toStringTag, { value: "Module" });
  return target;
};
var data_remote_exports = /* @__PURE__ */ __exportAll({
  addNote: () => addNote,
  getState: () => getState,
  increment: () => increment,
  openNativeDialog: () => openNativeDialog
});
var native = () => globalThis.__nativeBridge;
var db = new Database(join(homedir(), ".svelte-desktop-demo.sqlite"), { create: true });
db.run("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
db.run("INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)");
db.run("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)");
var getState = /* @__PURE__ */ query(async () => {
  const counter = db.query("SELECT value FROM counter WHERE id = 1").get();
  const notes = db.query("SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 10").all();
  return {
    counter: counter.value,
    notes,
    runtime: `bun ${Bun.version}`,
    pid: process.pid,
    servedAt: (/* @__PURE__ */ new Date()).toISOString(),
    host: `${hostname()} ${platform()}/${arch()}`,
    nativeBridge: !!native()
  };
});
var openNativeDialog = /* @__PURE__ */ command(async () => {
  const bridge = native();
  if (!bridge)
    return { native: false };
  return {
    native: true,
    response: await bridge.showMessageBox({
      type: "info",
      message: "Hello from a SvelteKit remote function",
      detail: "This native dialog was opened by the Electrobun main process via command().",
      buttons: ["Nice", "Dismiss"]
    })
  };
});
var increment = /* @__PURE__ */ command(async () => {
  db.run("UPDATE counter SET value = value + 1 WHERE id = 1");
  await getState().refresh();
});
var addNote = /* @__PURE__ */ form("unchecked", async (data) => {
  const text = String(data.text ?? "").trim();
  if (!text)
    return { error: "empty note" };
  db.run("INSERT INTO notes (text, created_at) VALUES (?, ?)", [text, (/* @__PURE__ */ new Date()).toISOString()]);
  await getState().refresh();
  return { ok: true };
});
init_remote_functions(data_remote_exports, "src/lib/data.remote.ts", "19aeq9f");
for (const [name, fn] of Object.entries(data_remote_exports)) {
  fn.__.id = "19aeq9f/" + name;
  fn.__.name = name;
}

export { data_remote_exports };

//# debugId=E3A4DF59C8B6E25464756E2164756E21
