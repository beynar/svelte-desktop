// @bun
import {
  uneval
} from "./index-p8d9cnqj.js";
import {
  __require
} from "./index-ygjk2325.js";

// node_modules/clsx/dist/clsx.mjs
function r(e) {
  var t, f, n = "";
  if (typeof e == "string" || typeof e == "number")
    n += e;
  else if (typeof e == "object")
    if (Array.isArray(e)) {
      var o = e.length;
      for (t = 0;t < o; t++)
        e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
    } else
      for (f in e)
        e[f] && (n && (n += " "), n += f);
  return n;
}
function clsx() {
  for (var e, t, f = 0, n = "", o = arguments.length;f < o; f++)
    (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
  return n;
}

// .svelte-kit/output/server/chunks/server2.js
var async_mode_flag = false;
function enable_async_mode_flag() {
  async_mode_flag = true;
}
enable_async_mode_flag();
var UNINITIALIZED = Symbol("uninitialized");
var ATTR_REGEX = /[&"<]/g;
var CONTENT_REGEX = /[&<]/g;
function escape_html(value, is_attr) {
  const str = String(value ?? "");
  const pattern = is_attr ? ATTR_REGEX : CONTENT_REGEX;
  pattern.lastIndex = 0;
  let escaped = "";
  let last = 0;
  while (pattern.test(str)) {
    const i = pattern.lastIndex - 1;
    const ch = str[i];
    escaped += str.substring(last, i) + (ch === "&" ? "&amp;" : ch === '"' ? "&quot;" : "&lt;");
    last = i + 1;
  }
  return escaped + str.substring(last);
}
var is_array = Array.isArray;
Array.prototype.indexOf;
Array.prototype.includes;
Array.prototype;
var has_own_property = Object.prototype.hasOwnProperty;
var noop = () => {};
function deferred() {
  var resolve;
  var reject;
  return {
    promise: new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve,
    reject
  };
}
var replacements = { translate: /* @__PURE__ */ new Map([[true, "yes"], [false, "no"]]) };
function attr(name, value, is_boolean = false) {
  if (name === "hidden" && value !== "until-found")
    is_boolean = true;
  if (value == null || is_boolean && !value && value !== "")
    return "";
  const normalized = has_own_property.call(replacements, name) && replacements[name].get(value) || value;
  return ` ${name}${is_boolean ? `=""` : `="${escape_html(normalized, true)}"`}`;
}
function clsx$1(value) {
  if (typeof value === "object")
    return clsx(value);
  else
    return value ?? "";
}
var whitespace = [...` 	
\r\f\xA0\v\uFEFF`];
function to_class(value, hash, directives) {
  var classname = value == null ? "" : "" + value;
  if (hash)
    classname = classname ? classname + " " + hash : hash;
  if (directives) {
    for (var key of Object.keys(directives))
      if (directives[key])
        classname = classname ? classname + " " + key : key;
      else if (classname.length) {
        var len = key.length;
        var a = 0;
        while ((a = classname.indexOf(key, a)) >= 0) {
          var b = a + len;
          if ((a === 0 || whitespace.includes(classname[a - 1])) && (b === classname.length || whitespace.includes(classname[b])))
            classname = (a === 0 ? "" : classname.substring(0, a)) + classname.substring(b + 1);
          else
            a = b;
        }
      }
  }
  return classname === "" ? null : classname;
}
function append_styles(styles, important = false) {
  var separator = important ? " !important;" : ";";
  var css = "";
  for (var key of Object.keys(styles)) {
    var value = styles[key];
    if (value != null && value !== "")
      css += " " + key + ": " + value + separator;
  }
  return css;
}
function to_css_name(name) {
  if (name[0] !== "-" || name[1] !== "-")
    return name.toLowerCase();
  return name;
}
function to_style(value, styles) {
  if (styles) {
    var new_style = "";
    var normal_styles;
    var important_styles;
    if (Array.isArray(styles)) {
      normal_styles = styles[0];
      important_styles = styles[1];
    } else
      normal_styles = styles;
    if (value) {
      value = String(value).replaceAll(/\/\*.*?\*\//g, "").trim();
      var in_str = false;
      var in_apo = 0;
      var in_comment = false;
      var reserved_names = [];
      if (normal_styles)
        reserved_names.push(...Object.keys(normal_styles).map(to_css_name));
      if (important_styles)
        reserved_names.push(...Object.keys(important_styles).map(to_css_name));
      var start_index = 0;
      var name_index = -1;
      const len = value.length;
      for (var i = 0;i < len; i++) {
        var c = value[i];
        if (in_comment) {
          if (c === "/" && value[i - 1] === "*")
            in_comment = false;
        } else if (in_str) {
          if (in_str === c)
            in_str = false;
        } else if (c === "/" && value[i + 1] === "*")
          in_comment = true;
        else if (c === '"' || c === "'")
          in_str = c;
        else if (c === "(")
          in_apo++;
        else if (c === ")")
          in_apo--;
        if (!in_comment && in_str === false && in_apo === 0) {
          if (c === ":" && name_index === -1)
            name_index = i;
          else if (c === ";" || i === len - 1) {
            if (name_index !== -1) {
              var name = to_css_name(value.substring(start_index, name_index).trim());
              if (!reserved_names.includes(name)) {
                if (c !== ";")
                  i++;
                var property = value.substring(start_index, i).trim();
                new_style += " " + property + ";";
              }
            }
            start_index = i + 1;
            name_index = -1;
          }
        }
      }
    }
    if (normal_styles)
      new_style += append_styles(normal_styles);
    if (important_styles)
      new_style += append_styles(important_styles, true);
    new_style = new_style.trim();
    return new_style === "" ? null : new_style;
  }
  return value == null ? null : String(value);
}
var CLEAN = 1024;
var DIRTY = 2048;
var MAYBE_DIRTY = 4096;
var STALE_REACTION = new class StaleReactionError extends Error {
  name = "StaleReactionError";
  message = "The reaction that called `getAbortSignal()` was re-run or destroyed";
};
globalThis.document?.contentType;
function lifecycle_outside_component(name) {
  throw new Error(`https://svelte.dev/e/lifecycle_outside_component`);
}
function get_parent_context(context) {
  let parent = context.p;
  while (parent !== null && parent.c === null)
    parent = parent.p;
  return parent?.c ?? null;
}
function get_or_init_context_map(context, name) {
  if (context === null)
    lifecycle_outside_component(name);
  return context.c ??= new Map(get_parent_context(context) || undefined);
}
~(DIRTY | MAYBE_DIRTY | CLEAN);
var BLOCK_OPEN = `<!--[-->`;
var BLOCK_CLOSE = `<!--]-->`;
var EMPTY_COMMENT = `<!---->`;
var DOM_BOOLEAN_ATTRIBUTES = [
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "disabled",
  "formnovalidate",
  "indeterminate",
  "inert",
  "ismap",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "seamless",
  "selected",
  "webkitdirectory",
  "defer",
  "disablepictureinpicture",
  "disableremoteplayback"
];
function is_boolean_attribute(name) {
  return DOM_BOOLEAN_ATTRIBUTES.includes(name);
}
[...DOM_BOOLEAN_ATTRIBUTES];
var ssr_context = null;
function set_ssr_context(v) {
  ssr_context = v;
}
function getContext(key) {
  return get_or_init_context_map(ssr_context, "getContext").get(key);
}
function push(fn) {
  ssr_context = {
    p: ssr_context,
    c: null,
    r: null
  };
}
function pop() {
  ssr_context = ssr_context.p;
}
function async_local_storage_unavailable() {
  const error = /* @__PURE__ */ new Error(`async_local_storage_unavailable
The node API \`AsyncLocalStorage\` is not available, but is required to use async server rendering.
https://svelte.dev/e/async_local_storage_unavailable`);
  error.name = "Svelte error";
  throw error;
}
function await_invalid() {
  const error = /* @__PURE__ */ new Error(`await_invalid
Encountered asynchronous work while rendering synchronously.
https://svelte.dev/e/await_invalid`);
  error.name = "Svelte error";
  throw error;
}
function html_deprecated() {
  const error = /* @__PURE__ */ new Error(`html_deprecated
The \`html\` property of server render results has been deprecated. Use \`body\` instead.
https://svelte.dev/e/html_deprecated`);
  error.name = "Svelte error";
  throw error;
}
function invalid_csp() {
  const error = /* @__PURE__ */ new Error(`invalid_csp
\`csp.nonce\` was set while \`csp.hash\` was \`true\`. These options cannot be used simultaneously.
https://svelte.dev/e/invalid_csp`);
  error.name = "Svelte error";
  throw error;
}
function invalid_id_prefix() {
  const error = /* @__PURE__ */ new Error(`invalid_id_prefix
The \`idPrefix\` option cannot include \`--\`.
https://svelte.dev/e/invalid_id_prefix`);
  error.name = "Svelte error";
  throw error;
}
function server_context_required() {
  const error = /* @__PURE__ */ new Error(`server_context_required
Could not resolve \`render\` context.
https://svelte.dev/e/server_context_required`);
  error.name = "Svelte error";
  throw error;
}
function unresolved_hydratable(key, stack) {
  console.warn(`https://svelte.dev/e/unresolved_hydratable`);
}
var current_render = null;
var context = null;
function get_render_context() {
  const store = context ?? als?.getStore();
  if (!store)
    server_context_required();
  return store;
}
async function with_render_context(fn) {
  context = { hydratable: {
    lookup: /* @__PURE__ */ new Map,
    comparisons: [],
    unresolved_promises: /* @__PURE__ */ new Map
  } };
  if (in_webcontainer()) {
    const { promise, resolve } = deferred();
    const previous_render = current_render;
    current_render = promise;
    await previous_render;
    return fn().finally(resolve);
  }
  try {
    if (als === null)
      async_local_storage_unavailable();
    return als.run(context, fn);
  } finally {
    context = null;
  }
}
var als = null;
var als_import = null;
function init_render_context() {
  als_import ??= import("async_hooks").then((hooks) => {
    als = new hooks.AsyncLocalStorage;
  }).then(noop, noop);
  return als_import;
}
function in_webcontainer() {
  return !!globalThis.process?.versions?.webcontainer;
}
var text_encoder;
var crypto;
var obfuscated_import = (module_name) => import(module_name);
async function sha256(data) {
  text_encoder ??= new TextEncoder;
  crypto ??= globalThis.crypto?.subtle?.digest ? globalThis.crypto : (await obfuscated_import("node:crypto")).webcrypto;
  return base64_encode(await crypto.subtle.digest("SHA-256", text_encoder.encode(data)));
}
function base64_encode(bytes) {
  if (globalThis.Buffer)
    return globalThis.Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0;i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
var Renderer = class Renderer2 {
  #out = [];
  #on_destroy = undefined;
  #is_component_body = false;
  #boundary = null;
  type;
  #parent;
  promise = undefined;
  global;
  local;
  constructor(global, parent) {
    this.#parent = parent;
    this.global = global;
    this.local = parent ? { ...parent.local } : {
      select_value: undefined,
      multiple: false
    };
    this.type = parent ? parent.type : "body";
  }
  head(fn) {
    const head = new Renderer2(this.global, this);
    head.type = "head";
    this.#out.push(head);
    head.child(fn);
  }
  async_block(blockers, fn) {
    this.#out.push(BLOCK_OPEN);
    this.async(blockers, fn);
    this.#out.push(BLOCK_CLOSE);
  }
  async(blockers, fn) {
    let callback = fn;
    if (blockers.length > 0) {
      const context2 = ssr_context;
      callback = (renderer) => {
        return Promise.all(blockers).then(() => {
          const previous_context = ssr_context;
          try {
            set_ssr_context(context2);
            return fn(renderer);
          } finally {
            set_ssr_context(previous_context);
          }
        });
      };
    }
    this.child(callback);
  }
  run(thunks) {
    const context2 = ssr_context;
    let promise = Promise.resolve(thunks[0]());
    const promises = [promise];
    for (const fn of thunks.slice(1)) {
      promise = promise.then(() => {
        const previous_context = ssr_context;
        set_ssr_context(context2);
        try {
          return fn();
        } finally {
          set_ssr_context(previous_context);
        }
      });
      promises.push(promise);
    }
    promise.catch(noop);
    this.promise = this.global.track(promise);
    return promises;
  }
  child_block(fn) {
    this.#out.push(BLOCK_OPEN);
    this.child(fn);
    this.#out.push(BLOCK_CLOSE);
  }
  child(fn) {
    const child = new Renderer2(this.global, this);
    this.#out.push(child);
    const parent = ssr_context;
    set_ssr_context({
      ...ssr_context,
      p: parent,
      c: null,
      r: child
    });
    const result = fn(child);
    set_ssr_context(parent);
    if (result instanceof Promise) {
      result.catch(noop);
      result.finally(() => set_ssr_context(null)).catch(noop);
      if (child.global.mode === "sync")
        await_invalid();
      child.promise = child.global.track(result);
    }
    return child;
  }
  boundary(props, children_fn) {
    const child = new Renderer2(this.global, this);
    this.#out.push(child);
    const parent_context = ssr_context;
    if (props.failed)
      child.#boundary = {
        failed: props.failed,
        transformError: this.global.transformError,
        context: parent_context
      };
    set_ssr_context({
      ...ssr_context,
      p: parent_context,
      c: null,
      r: child
    });
    try {
      const result = children_fn(child);
      set_ssr_context(parent_context);
      if (result instanceof Promise) {
        if (child.global.mode === "sync")
          await_invalid();
        result.catch(noop);
        child.promise = child.global.track(result);
      }
    } catch (error) {
      set_ssr_context(parent_context);
      const failed_snippet = props.failed;
      if (!failed_snippet)
        throw error;
      const result = this.global.transformError(error);
      child.#out.length = 0;
      child.#boundary = null;
      if (result instanceof Promise) {
        if (this.global.mode === "sync")
          await_invalid();
        child.promise = child.global.track(result.then((transformed) => {
          set_ssr_context(parent_context);
          child.#out.push(Renderer2.#serialize_failed_boundary(transformed));
          failed_snippet(child, transformed, noop);
          child.#out.push(BLOCK_CLOSE);
        }));
        child.promise.catch(noop);
      } else {
        child.#out.push(Renderer2.#serialize_failed_boundary(result));
        failed_snippet(child, result, noop);
        child.#out.push(BLOCK_CLOSE);
      }
    }
  }
  component(fn, component_fn) {
    push(component_fn);
    this.child((renderer) => {
      renderer.#is_component_body = true;
      return fn(renderer);
    });
    pop();
  }
  select(attrs, fn, css_hash, classes, styles, flags, is_rich) {
    const { value, defaultValue, ...select_attrs } = attrs;
    if (select_attrs.multiple === "")
      select_attrs.multiple = true;
    this.push(`<select${attributes(select_attrs, css_hash, classes, styles, flags)}>`);
    this.child((renderer) => {
      renderer.local.select_value = value === undefined ? defaultValue : value;
      renderer.local.multiple = !!select_attrs.multiple;
      fn(renderer);
    });
    this.push(`${is_rich ? "<!>" : ""}</select>`);
  }
  option(attrs, body, css_hash, classes, styles, flags, is_rich) {
    this.#out.push(`<option${attributes(attrs, css_hash, classes, styles, flags)}`);
    const close = (renderer, value, { head, body: body2 }) => {
      if (has_own_property.call(attrs, "value"))
        value = attrs.value;
      var select_value = this.local.select_value;
      if (this.local.multiple && is_array(select_value) ? select_value.includes(value) : value === select_value)
        renderer.#out.push(' selected=""');
      renderer.#out.push(`>${body2}${is_rich ? "<!>" : ""}</option>`);
      if (head)
        renderer.head((child) => child.push(head));
    };
    if (typeof body === "function")
      this.child((renderer) => {
        const r2 = new Renderer2(this.global, this);
        body(r2);
        if (this.global.mode === "async")
          return r2.#collect_content_async().then((content) => {
            close(renderer, content.body.replaceAll("<!---->", ""), content);
          });
        else {
          const content = r2.#collect_content();
          close(renderer, content.body.replaceAll("<!---->", ""), content);
        }
      });
    else
      close(this, body, { body: escape_html(body) });
  }
  title(fn) {
    const path = this.get_path();
    const close = (head) => {
      this.global.set_title(head, path);
    };
    this.child((renderer) => {
      const r2 = new Renderer2(renderer.global, renderer);
      fn(r2);
      if (renderer.global.mode === "async")
        return r2.#collect_content_async().then((content) => {
          close(content.head);
        });
      else {
        const content = r2.#collect_content();
        close(content.head);
      }
    });
  }
  push(content) {
    if (typeof content === "function")
      this.child(async (renderer) => renderer.push(await content()));
    else
      this.#out.push(content);
  }
  on_destroy(fn) {
    (this.#on_destroy ??= []).push(fn);
  }
  get_path() {
    return this.#parent ? [...this.#parent.get_path(), this.#parent.#out.indexOf(this)] : [];
  }
  copy() {
    const copy = new Renderer2(this.global, this.#parent);
    copy.type = this.type;
    copy.#out = this.#out.map((item) => item instanceof Renderer2 ? item.copy() : item);
    copy.promise = this.promise;
    return copy;
  }
  subsume(other) {
    if (this.global.mode !== other.global.mode)
      throw new Error("invariant: A renderer cannot switch modes. If you're seeing this, there's a compiler bug. File an issue!");
    this.local = other.local;
    this.#out = other.#out.map((item, i) => {
      const current = this.#out[i];
      if (current instanceof Renderer2 && item instanceof Renderer2) {
        current.subsume(item);
        return current;
      }
      return item;
    });
    this.promise = other.promise;
    this.type = other.type;
  }
  get length() {
    return this.#out.length;
  }
  static #serialize_failed_boundary(error) {
    return `<!--[?${JSON.stringify(error).replace(/>/g, "\\u003e").replace(/</g, "\\u003c")}-->`;
  }
  static render(component, options = {}) {
    let sync;
    let async;
    const result = {};
    Object.defineProperties(result, {
      html: { get: () => {
        return (sync ??= Renderer2.#render(component, options)).body;
      } },
      head: { get: () => {
        return (sync ??= Renderer2.#render(component, options)).head;
      } },
      body: { get: () => {
        return (sync ??= Renderer2.#render(component, options)).body;
      } },
      hashes: { value: { script: "" } },
      then: { value: (onfulfilled, onrejected) => {
        if (!async_mode_flag) {
          const result2 = sync ??= Renderer2.#render(component, options);
          const user_result = onfulfilled({
            head: result2.head,
            body: result2.body,
            html: result2.body,
            hashes: { script: [] }
          });
          return Promise.resolve(user_result);
        }
        async ??= init_render_context().then(() => with_render_context(() => Renderer2.#render_async(component, options)));
        return async.then((result2) => {
          Object.defineProperty(result2, "html", { get: () => {
            html_deprecated();
          } });
          return onfulfilled(result2);
        }, onrejected);
      } }
    });
    return result;
  }
  *#collect_on_destroy() {
    for (const component of this.#traverse_components())
      yield* component.#collect_ondestroy();
  }
  *#traverse_components() {
    for (const child of this.#out)
      if (typeof child !== "string")
        yield* child.#traverse_components();
    if (this.#is_component_body)
      yield this;
  }
  *#collect_ondestroy() {
    if (this.#on_destroy)
      for (const fn of this.#on_destroy)
        yield fn;
    for (const child of this.#out)
      if (child instanceof Renderer2 && !child.#is_component_body)
        yield* child.#collect_ondestroy();
  }
  #run_on_destroy(suppress_errors) {
    let first_error;
    let has_error = false;
    for (const cleanup of this.#collect_on_destroy())
      try {
        cleanup();
      } catch (error) {
        if (!suppress_errors && !has_error) {
          first_error = error;
          has_error = true;
        }
      }
    if (has_error)
      throw first_error;
  }
  static #create(mode, options) {
    if (options.idPrefix?.includes("--"))
      invalid_id_prefix();
    return new Renderer2(new SSRState(mode, options.idPrefix ? options.idPrefix + "-" : "", options.csp, options.transformError));
  }
  static #render(component, options) {
    var previous_context = ssr_context;
    const renderer = Renderer2.#create("sync", options);
    let result;
    let render_error;
    let failed = false;
    try {
      try {
        Renderer2.#open_render(renderer, component, options);
        result = Renderer2.#close_render(renderer.#collect_content(), renderer);
      } catch (error) {
        render_error = error;
        failed = true;
      }
      renderer.#run_on_destroy(failed);
      if (failed)
        throw render_error;
      return result;
    } finally {
      renderer.global.abort();
      set_ssr_context(previous_context);
    }
  }
  static async#render_async(component, options) {
    const previous_context = ssr_context;
    const renderer = Renderer2.#create("async", options);
    let result;
    let render_error;
    let failed = false;
    try {
      try {
        Renderer2.#open_render(renderer, component, options);
        const content = await renderer.#collect_content_async();
        const hydratables = await renderer.#collect_hydratables();
        if (hydratables !== null)
          content.head = hydratables + content.head;
        result = Renderer2.#close_render(content, renderer);
      } catch (error) {
        render_error = error;
        failed = true;
        renderer.global.abort();
        await renderer.global.settle();
      }
      renderer.#run_on_destroy(failed);
      if (failed)
        throw render_error;
      return result;
    } finally {
      set_ssr_context(previous_context);
      renderer.global.abort();
    }
  }
  #collect_content(content = {
    head: "",
    body: ""
  }) {
    for (const item of this.#out)
      if (typeof item === "string")
        content[this.type] += item;
      else if (item instanceof Renderer2)
        item.#collect_content(content);
    return content;
  }
  async#collect_content_async(content = {
    head: "",
    body: ""
  }) {
    await this.promise;
    for (const item of this.#out)
      if (typeof item === "string")
        content[this.type] += item;
      else if (item instanceof Renderer2) {
        if (item.#boundary) {
          const boundary_content = {
            head: "",
            body: ""
          };
          try {
            await item.#collect_content_async(boundary_content);
            content.head += boundary_content.head;
            content.body += boundary_content.body;
          } catch (error) {
            const { context: context2, failed, transformError } = item.#boundary;
            set_ssr_context(context2);
            let promise = transformError(error);
            set_ssr_context(null);
            let transformed = await promise;
            set_ssr_context(context2);
            const failed_renderer = new Renderer2(item.global, item);
            failed_renderer.type = item.type;
            failed_renderer.#out.push(Renderer2.#serialize_failed_boundary(transformed));
            failed(failed_renderer, transformed, noop);
            failed_renderer.#out.push(BLOCK_CLOSE);
            await failed_renderer.#collect_content_async(content);
          }
        } else
          await item.#collect_content_async(content);
      }
    return content;
  }
  async#collect_hydratables() {
    const ctx = get_render_context().hydratable;
    for (const [_, key] of ctx.unresolved_promises)
      unresolved_hydratable(key, ctx.lookup.get(key)?.stack ?? "<missing stack trace>");
    for (const comparison of ctx.comparisons)
      await comparison;
    return await this.#hydratable_block(ctx);
  }
  static #open_render(renderer, component, options) {
    var previous_context = ssr_context;
    try {
      set_ssr_context({
        p: null,
        c: options.context ?? null,
        r: renderer
      });
      renderer.push(BLOCK_OPEN);
      component(renderer, options.props ?? {});
      renderer.push(BLOCK_CLOSE);
    } finally {
      set_ssr_context(previous_context);
    }
  }
  static #close_render(content, renderer) {
    let head = content.head + renderer.global.get_title();
    let body = content.body;
    for (const { hash, code } of renderer.global.css)
      head += `<style id="${hash}">${code}</style>`;
    return {
      head,
      body,
      hashes: { script: renderer.global.csp.script_hashes }
    };
  }
  async#hydratable_block(ctx) {
    if (ctx.lookup.size === 0)
      return null;
    let entries = [];
    let has_promises = false;
    for (const [k, v] of ctx.lookup) {
      if (v.promises) {
        has_promises = true;
        for (const p of v.promises)
          await p;
      }
      entries.push(`[${uneval(k)},${v.serialized}]`);
    }
    let prelude = `const h = (window.__svelte ??= {}).h ??= new Map();`;
    if (has_promises)
      prelude = `const r = (v) => Promise.resolve(v);
				${prelude}`;
    const body = `
			{
				${prelude}

				for (const [k, v] of [
					${entries.join(`,
					`)}
				]) {
					h.set(k, v);
				}
			}
		`;
    let csp_attr = "";
    if (this.global.csp.nonce)
      csp_attr = ` nonce="${this.global.csp.nonce}"`;
    else if (this.global.csp.hash) {
      const hash = await sha256(body);
      this.global.csp.script_hashes.push(`sha256-${hash}`);
    }
    return `
		<script${csp_attr}>${body}</script>`;
  }
};
var SSRState = class {
  csp;
  mode;
  uid;
  css = /* @__PURE__ */ new Set;
  #pending = /* @__PURE__ */ new Set;
  #controller = null;
  #aborted = false;
  transformError;
  #title = {
    path: [],
    value: ""
  };
  constructor(mode, id_prefix = "", csp = { hash: false }, transformError) {
    this.mode = mode;
    this.csp = {
      ...csp,
      script_hashes: []
    };
    this.transformError = transformError ?? ((error) => {
      throw error;
    });
    let uid = 1;
    this.uid = () => `${id_prefix}s${uid++}`;
  }
  track(promise) {
    this.#pending.add(promise);
    promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }
  async settle() {
    while (this.#pending.size > 0)
      await Promise.allSettled([...this.#pending]);
  }
  abort() {
    if (this.#aborted)
      return;
    this.#aborted = true;
    this.#controller?.abort(STALE_REACTION);
  }
  get_abort_signal() {
    const controller = this.#controller ??= new AbortController;
    if (this.#aborted)
      controller.abort(STALE_REACTION);
    return controller.signal;
  }
  get_title() {
    return this.#title.value;
  }
  set_title(value, path) {
    const current = this.#title.path;
    let i = 0;
    let l = Math.min(path.length, current.length);
    while (i < l && path[i] === current[i])
      i += 1;
    if (path[i] === undefined)
      return;
    if (current[i] === undefined || path[i] > current[i]) {
      this.#title.path = path;
      this.#title.value = value;
    }
  }
};
var INVALID_ATTR_NAME_CHAR_REGEX = /[\s'">/=\u{FDD0}-\u{FDEF}\u{FFFE}\u{FFFF}\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;
function render(component, options = {}) {
  if (options.csp?.hash && options.csp.nonce)
    invalid_csp();
  return Renderer.render(component, options);
}
function head(hash, renderer, fn) {
  renderer.head((renderer2) => {
    renderer2.push(`<!--${hash}-->`);
    renderer2.child(fn);
    renderer2.push(EMPTY_COMMENT);
  });
}
function attributes(attrs, css_hash, classes, styles, flags = 0) {
  if (styles)
    attrs.style = to_style(attrs.style, styles);
  if (attrs.class)
    attrs.class = clsx$1(attrs.class);
  if (css_hash || classes)
    attrs.class = to_class(attrs.class, css_hash, classes);
  let attr_str = "";
  let name;
  const is_html = (flags & 1) === 0;
  const lowercase = (flags & 2) === 0;
  const is_input = (flags & 4) !== 0;
  for (name of Object.keys(attrs)) {
    if (typeof attrs[name] === "function")
      continue;
    if (name[0] === "$" && name[1] === "$")
      continue;
    if (name === "" || INVALID_ATTR_NAME_CHAR_REGEX.test(name))
      continue;
    var value = attrs[name];
    var lower = name.toLowerCase();
    if (lowercase)
      name = lower;
    if (lower.length > 2 && lower.startsWith("on"))
      continue;
    if (is_input) {
      if (name === "defaultvalue" || name === "defaultchecked") {
        name = name === "defaultvalue" ? "value" : "checked";
        if (attrs[name])
          continue;
      }
    }
    attr_str += attr(name, value, is_html && is_boolean_attribute(name));
  }
  return attr_str;
}
function once(get_value) {
  let value = UNINITIALIZED;
  return () => {
    if (value === UNINITIALIZED)
      value = get_value();
    return value;
  };
}
function derived(fn) {
  const get_value = ssr_context === null ? fn : once(fn);
  let updated_value;
  return function(new_value) {
    if (arguments.length === 0)
      return updated_value ?? get_value();
    updated_value = new_value;
    return updated_value;
  };
}

export { escape_html, attr, getContext, render, head, derived };

//# debugId=87B9B14D33FC272464756E2164756E21
