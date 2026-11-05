// @bun
import {
  parse,
  stringify,
  uneval
} from "./index-p8d9cnqj.js";
import {
  __require
} from "./index-ygjk2325.js";

// node_modules/@sveltejs/kit/src/exports/internal/shared.js
class HttpError {
  constructor(error) {
    this.status = error.status;
    this.body = error;
  }
  toString() {
    return JSON.stringify(this.body);
  }
}

class HandledHttpError extends HttpError {
}

class Redirect {
  constructor(status, location) {
    try {
      new Headers({ location });
    } catch {
      throw new Error(`Invalid redirect location ${JSON.stringify(location)}: ` + "this string contains characters that cannot be used in HTTP headers");
    }
    this.status = status;
    this.location = location;
  }
}

class SvelteKitError extends Error {
  constructor(status, text, message) {
    super(message);
    this.status = status;
    this.text = text;
  }
}

class ActionFailure {
  constructor(status, data) {
    this.status = status;
    this.data = data;
  }
}

class ValidationError extends Error {
  constructor(issues) {
    super("Validation failed");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

// node_modules/esm-env/false.js
var false_default = false;
// node_modules/esm-env/true.js
var true_default = true;
// node_modules/@sveltejs/kit/src/constants.js
var MUTATIVE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
var BODY_DEPENDENT_METHODS = [...MUTATIVE_METHODS, "QUERY"];
var IN_WEBCONTAINER = !!globalThis.process?.versions?.webcontainer;

// node_modules/@sveltejs/kit/src/exports/internal/server/event.js
var sync_store = null;
var als;
import("async_hooks").then((hooks) => als = new hooks.AsyncLocalStorage).catch(() => {});
function get_request_store() {
  const result = try_get_request_store();
  if (!result) {
    let message = "Could not get the request store.";
    if (als) {
      message += " This is an internal error.";
    } else {
      message += " In environments without `AsyncLocalStorage`, the request store (used by e.g. remote functions) must be accessed synchronously, not after an `await`. If it was accessed synchronously then this is an internal error.";
    }
    throw new Error(message);
  }
  return result;
}
function try_get_request_store() {
  return sync_store ?? als?.getStore() ?? null;
}
function with_request_store(store, fn) {
  try {
    sync_store = store;
    return als ? als.run(store, fn) : fn();
  } finally {
    if (!IN_WEBCONTAINER) {
      sync_store = null;
    }
  }
}
// node_modules/@sveltejs/kit/src/exports/internal/server/remote-functions.js
var types = ["command", "form", "prerender", "query", "query_batch", "query_live"];
function init_remote_functions(module, file, hash) {
  if (module.default) {
    throw new Error(`Cannot export \`default\` from a remote module (${file}) \u2014 please use named exports instead`);
  }
  for (const [name, fn] of Object.entries(module)) {
    if (!types.includes(fn?.__?.type)) {
      throw new Error(`\`${name}\` exported from ${file} is invalid \u2014 all exports from this file must be remote functions`);
    }
    fn.__.id = `${hash}/${name}`;
    fn.__.name = name;
  }
}
// node_modules/@sveltejs/kit/src/telemetry.js
var noop_span = {
  spanContext() {
    return noop_span_context;
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  setStatus() {
    return this;
  },
  updateName() {
    return this;
  },
  end() {
    return this;
  },
  isRecording() {
    return false;
  },
  recordException() {
    return this;
  },
  addLink() {
    return this;
  },
  addLinks() {
    return this;
  }
};
var noop_span_context = {
  traceId: "",
  spanId: "",
  traceFlags: 0
};

// node_modules/@sveltejs/kit/src/exports/internal/server/telemetry.js
var otel = null;
async function record_span({ name, attributes, fn }) {
  if (otel === null) {
    return fn(noop_span);
  }
  const { SpanStatusCode, tracer } = await otel;
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof HttpError) {
        span.setAttributes({
          [`${name}.result.type`]: "known_error",
          [`${name}.result.status`]: error.status,
          [`${name}.result.message`]: error.body.message
        });
        if (error.status >= 500) {
          span.recordException({
            name: "HttpError",
            message: error.body.message
          });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.body.message
          });
        }
      } else if (error instanceof Redirect) {
        span.setAttributes({
          [`${name}.result.type`]: "redirect",
          [`${name}.result.status`]: error.status,
          [`${name}.result.location`]: error.location
        });
      } else if (error instanceof Error) {
        span.setAttributes({
          [`${name}.result.type`]: "unknown_error"
        });
        span.recordException({
          name: error.name,
          message: error.message,
          ...error.stack !== undefined && { stack: error.stack }
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
        });
      } else {
        span.setAttributes({
          [`${name}.result.type`]: "unknown_error"
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
// node_modules/@sveltejs/kit/src/exports/internal/server/index.js
function merge_tracing(event_like, current) {
  return {
    ...event_like,
    tracing: {
      ...event_like.tracing,
      current
    }
  };
}

// node_modules/@sveltejs/kit/src/utils/url.js
var internal = new URL("a://");

// node_modules/@sveltejs/kit/src/exports/url.js
var javascript_protocols = new Set(["javascript:", "data:"]);

// node_modules/@sveltejs/kit/src/exports/index.js
var text_encoder = new TextEncoder;
function error(status, message, properties) {
  if ((!false_default || true_default) && (isNaN(status) || status < 400 || status > 599)) {
    throw new Error(`HTTP error status codes must be between 400 and 599 \u2014 ${status} is invalid`);
  }
  if (message !== undefined && typeof message !== "string") {
    if (true_default) {
      console.warn("Passing an `App.Error` body as the second argument is deprecated \u2014 pass the `message` as the second argument, and any additional properties as the third");
    }
    ({ message, ...properties } = message);
  }
  throw new HttpError({ ...properties, status, message: message ?? `Error: ${status}` });
}
function isRedirect(e) {
  return e instanceof Redirect;
}
function text(body, init) {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-length")) {
    const encoded = text_encoder.encode(body);
    headers.set("content-length", encoded.byteLength.toString());
    return new Response(encoded, {
      ...init,
      headers
    });
  }
  return new Response(body, {
    ...init,
    headers
  });
}
// .svelte-kit/output/server/chunks/server.js
function noop() {}
function once(fn) {
  let done = false;
  let result;
  return () => {
    if (done)
      return result;
    done = true;
    return result = fn();
  };
}
function disallow_on_server(name, parens = "(...)") {
  return () => {
    throw new Error(`Cannot call \`${name}${parens}\` on the server`);
  };
}
var text_encoder2 = new TextEncoder;
function stream_from_iterable(iterable) {
  if (ReadableStream.from)
    return ReadableStream.from(iterable);
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done)
        controller.close();
      else
        controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    }
  });
}
function stream_text(head, chunks) {
  return stream_from_iterable(async function* () {
    yield text_encoder2.encode(head);
    for await (const chunk of chunks)
      if (chunk)
        yield text_encoder2.encode(chunk);
  }());
}
var text_decoder = new TextDecoder;
function get_relative_path(from, to) {
  const from_parts = from.split(/[/\\]/);
  const to_parts = to.split(/[/\\]/);
  from_parts.pop();
  while (from_parts[0] === to_parts[0]) {
    from_parts.shift();
    to_parts.shift();
  }
  let i = from_parts.length;
  while (i--)
    from_parts[i] = "..";
  return from_parts.concat(to_parts).join("/");
}
function base64_encode(bytes) {
  if (globalThis.Buffer)
    return globalThis.Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0;i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64_decode(encoded) {
  if (globalThis.Buffer) {
    const buffer = globalThis.Buffer.from(encoded, "base64");
    return new Uint8Array(buffer);
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
var ENDPOINT_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "QUERY"
];
var MUTATIVE_METHODS2 = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
];
var BODY_DEPENDENT_METHODS2 = [...MUTATIVE_METHODS2, "QUERY"];
var PAGE_METHODS = [
  "GET",
  "POST",
  "HEAD"
];
var IN_WEBCONTAINER2 = !!globalThis.process?.versions?.webcontainer;
var REROUTED_URL_HEADER = "x-sveltekit-rerouted-url";
var assets = "";
var app_dir = "_app";
var escape_sequence_pattern = /\[([ux])\+([^\]]+)\]/;
function decode_escape_sequence(code) {
  return String.fromCodePoint(...code.split("-").map((codepoint) => parseInt(codepoint, 16)));
}
function encode_pathname_chars(str) {
  return str.replace(/[%/?#]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
function affects_path(segment) {
  return segment !== "" && !/^\([^)]+\)$/.test(segment);
}
function get_route_segments(route) {
  return route.slice(1).split("/").filter(affects_path);
}
function run_matcher(matcher, value) {
  const result = matcher["~standard"].validate(value);
  if (result instanceof Promise)
    throw new Error("Async param matchers are not supported");
  if (result.issues)
    return { success: false };
  const parsed = result.value;
  if (typeof parsed !== "string" && typeof parsed !== "number" && typeof parsed !== "boolean" && typeof parsed !== "bigint")
    throw new Error("Param matcher must return a string, number, boolean, or bigint");
  return {
    success: true,
    value: parsed
  };
}
function exec(match, params, matchers) {
  const result = {};
  const values = match.slice(1);
  const values_needing_match = values.filter((value) => value !== undefined);
  let buffered = 0;
  for (let i = 0;i < params.length; i += 1) {
    const param = params[i];
    let value = values[i - buffered];
    if (param.chained && param.rest && buffered) {
      value = values.slice(i - buffered, i + 1).filter((s) => s).join("/");
      buffered = 0;
    }
    if (value === undefined) {
      if (param.rest)
        value = "";
      else
        continue;
    }
    const decoded = decodeURIComponent(value);
    if (param.matcher) {
      const outcome = run_matcher(matchers[param.matcher], decoded);
      if (!outcome.success) {
        if (param.optional && param.chained) {
          buffered++;
          continue;
        }
        return;
      }
      result[param.name] = outcome.value;
    } else
      result[param.name] = decoded;
    const next_param = params[i + 1];
    const next_value = values[i + 1];
    if (next_param && !next_param.rest && next_param.optional && next_value && param.chained)
      buffered = 0;
    if (!next_param && !next_value && Object.keys(result).length === values_needing_match.length)
      buffered = 0;
  }
  if (buffered)
    return;
  return result;
}
var segment_pattern = new RegExp(`${escape_sequence_pattern.source}|${/\[(\[)?(\.\.\.)?([\w-]+?)(?:=([\w-]+))?\]\]?/g.source}`, "g");
function resolve_route(id, params) {
  const segments = get_route_segments(id);
  const has_id_trailing_slash = id != "/" && id.endsWith("/");
  return "/" + segments.map((segment) => segment.replace(segment_pattern, (_, escape_type, escape_code, optional, rest, name) => {
    if (escape_type)
      return encode_pathname_chars(decode_escape_sequence(escape_code));
    const value = params[name];
    if (value === undefined || value === "") {
      if (optional)
        return "";
      if (rest && value !== undefined)
        return "";
      throw new Error(`Missing parameter '${name}' in route ${id}`);
    }
    if (typeof value === "string") {
      if (value.startsWith("/") || value.endsWith("/"))
        throw new Error(`Parameter '${name}' in route ${id} cannot start or end with a slash -- this would cause an invalid route like foo//bar`);
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
      return String(value);
    throw new Error("Parameter values must be a string, number, boolean, or bigint");
  })).filter(Boolean).join("/") + (has_id_trailing_slash ? "/" : "");
}
function find_route(path, routes, matchers) {
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match)
      continue;
    const matched = exec(match, route.params, matchers);
    if (matched)
      return {
        route,
        params: matched
      };
  }
  return null;
}
var internal2 = new URL("a://");
function resolve$1(base, path) {
  if (path[0] === "/" && path[1] === "/")
    return path;
  let url = new URL(base, internal2);
  url = new URL(path, url);
  return url.protocol === internal2.protocol ? url.pathname + url.search + url.hash : url.href;
}
function relative_pathname(from, to) {
  const segment = to.replace(/\/$/, "").split("/").at(-1);
  return from.endsWith("/") ? `../${segment}` : `${segment}/`;
}
function normalize_path(path, trailing_slash) {
  if (path === "/" || trailing_slash === "ignore")
    return path;
  if (trailing_slash === "never")
    return path.endsWith("/") ? path.slice(0, -1) : path;
  else if (trailing_slash === "always" && !path.endsWith("/"))
    return path + "/";
  return path;
}
function decode_pathname(pathname) {
  return pathname.split("%25").map(decodeURI).join("%25");
}
function make_trackable(url, callback, search_params_callback, allow_hash = false) {
  const tracked = new URL(url);
  Object.defineProperty(tracked, "searchParams", {
    value: new Proxy(tracked.searchParams, { get(obj, key) {
      if (key === "get" || key === "getAll" || key === "has")
        return (param, ...rest) => {
          search_params_callback(param);
          return obj[key](param, ...rest);
        };
      callback();
      const value = Reflect.get(obj, key);
      return typeof value === "function" ? value.bind(obj) : value;
    } }),
    enumerable: true,
    configurable: true
  });
  const tracked_url_properties = [
    "href",
    "pathname",
    "search",
    "toString",
    "toJSON"
  ];
  if (allow_hash)
    tracked_url_properties.push("hash");
  for (const property of tracked_url_properties)
    Object.defineProperty(tracked, property, {
      get() {
        callback();
        return url[property];
      },
      enumerable: true,
      configurable: true
    });
  tracked[Symbol.for("nodejs.util.inspect.custom")] = (_depth, opts, inspect) => {
    return inspect(url, opts);
  };
  tracked.searchParams[Symbol.for("nodejs.util.inspect.custom")] = (_depth, opts, inspect) => {
    return inspect(url.searchParams, opts);
  };
  if (!allow_hash)
    disable_hash(tracked);
  return tracked;
}
function disable_hash(url) {
  allow_nodejs_console_log(url);
  Object.defineProperty(url, "hash", { get() {
    throw new Error("Cannot access event.url.hash. Consider using `page.url.hash` inside a component instead");
  } });
}
function disable_search(url) {
  allow_nodejs_console_log(url);
  for (const property of ["search", "searchParams"])
    Object.defineProperty(url, property, { get() {
      throw new Error(`Cannot access url.${property} on a page with prerendering enabled`);
    } });
}
function allow_nodejs_console_log(url) {
  url[Symbol.for("nodejs.util.inspect.custom")] = (_depth, opts, inspect) => {
    return inspect(new URL(url), opts);
  };
}
var DATA_SUFFIX = "/__data.json";
var HTML_DATA_SUFFIX = ".html__data.json";
function has_data_suffix2(pathname) {
  return pathname.endsWith(DATA_SUFFIX) || pathname.endsWith(HTML_DATA_SUFFIX);
}
function add_data_suffix2(pathname) {
  if (pathname.endsWith(".html"))
    return pathname.replace(/\.html$/, HTML_DATA_SUFFIX);
  return pathname.replace(/\/$/, "") + DATA_SUFFIX;
}
function strip_data_suffix2(pathname) {
  if (pathname.endsWith(HTML_DATA_SUFFIX))
    return pathname.slice(0, -16) + ".html";
  return pathname.slice(0, -12);
}
var ROUTE_SUFFIX = "/__route.js";
var HTML_ROUTE_SUFFIX = ".html__route.js";
function has_resolution_suffix2(pathname) {
  return pathname.endsWith(ROUTE_SUFFIX) || pathname.endsWith(HTML_ROUTE_SUFFIX);
}
function add_resolution_suffix2(pathname) {
  if (pathname.endsWith(".html"))
    return pathname.replace(/\.html$/, HTML_ROUTE_SUFFIX);
  return pathname.replace(/\/$/, "") + ROUTE_SUFFIX;
}
function strip_resolution_suffix2(pathname) {
  if (pathname.endsWith(HTML_ROUTE_SUFFIX))
    return pathname.slice(0, -15) + ".html";
  return pathname.slice(0, -11);
}
var symbol = Symbol.for("sveltekit.global_state");
globalThis[symbol] ??= {};
function set_nested_value(object, field, value) {
  deep_set(object, split_path(field.name), value);
}
function parse_form_key(form_id, key) {
  const suffix = "/" + form_id;
  let name = key;
  let image_coordinate = "";
  if (name.startsWith("i:") && (name.endsWith(suffix + ".x") || name.endsWith(suffix + ".y"))) {
    image_coordinate = name[name.length - 1];
    name = name.slice(0, -2);
  }
  if (!name.endsWith(suffix))
    throw new Error(`Form contained a field that wasn't created with form.fields.as(...): ${name}`);
  name = name.slice(0, -suffix.length);
  let type = null;
  if (name.startsWith("n:")) {
    name = name.slice(2);
    type = "number";
  } else if (name.startsWith("b:")) {
    name = name.slice(2);
    type = "boolean";
  } else if (name.startsWith("i:")) {
    name = name.slice(2);
    type = "number";
  }
  const is_array = name.endsWith("[]");
  if (is_array)
    name = name.slice(0, -2);
  if (image_coordinate)
    name += "." + image_coordinate;
  return {
    name,
    type,
    is_array
  };
}
function coerce_form_value(type, value) {
  if (Array.isArray(value))
    return value.map((value2) => coerce_form_value(type, value2));
  if (type === "number")
    return value === "" ? undefined : parseFloat(value);
  if (type === "boolean")
    return value === "on";
  return value;
}
var DELETE_KEY = {};
function convert_formdata(form_id, data) {
  const result = {};
  for (const field_name of data.keys()) {
    const values = data.getAll(field_name);
    const field = parse_form_key(form_id, field_name);
    const entries = values.filter((entry) => typeof entry === "string" || entry.name !== "" || entry.size > 0);
    if (entries.length === 0 && !field.is_array)
      continue;
    if (entries.length > 1 && !field.is_array)
      throw new Error(`Form cannot contain duplicated keys \u2014 "${field.name}" has ${entries.length} values`);
    set_nested_value(result, field, coerce_form_value(field.type, field.is_array ? entries : entries[0]));
  }
  return result;
}
var BINARY_FORM_CONTENT_TYPE = "application/x-sveltekit-formdata";
var BINARY_FORM_VERSION = 0;
var HEADER_BYTES = 7;
async function deserialize_binary_form(request, form_id) {
  if (request.headers.get("content-type") !== "application/x-sveltekit-formdata") {
    const form_data = await request.formData();
    return {
      data: convert_formdata(form_id, form_data),
      meta: {},
      form_data
    };
  }
  if (!request.body)
    throw deserialize_error("no body");
  const reader = request.body.getReader();
  const chunks = [];
  function get_chunk(index) {
    if (index in chunks)
      return chunks[index];
    let i = chunks.length;
    while (i <= index) {
      const previous = chunks[i - 1] ?? Promise.resolve(undefined);
      chunks[i] = previous.then(() => reader.read()).then((chunk) => chunk.value);
      i++;
    }
    return chunks[index];
  }
  async function get_buffer(offset, length) {
    const parts = [];
    let total = 0;
    for await (const part of read_range(get_chunk, offset, length)) {
      parts.push(part);
      total += part.byteLength;
    }
    if (total < length || parts.length === 0)
      return null;
    if (parts.length === 1)
      return parts[0];
    const buffer = new Uint8Array(length);
    let cursor = 0;
    for (const part of parts) {
      buffer.set(part, cursor);
      cursor += part.byteLength;
    }
    return buffer;
  }
  const header = await get_buffer(0, HEADER_BYTES);
  if (!header)
    throw deserialize_error("too short");
  if (header[0] !== BINARY_FORM_VERSION)
    throw deserialize_error(`got version ${header[0]}, expected version ${BINARY_FORM_VERSION}`);
  const header_view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const data_length = header_view.getUint32(1, true);
  const file_offsets_length = header_view.getUint16(5, true);
  const data_buffer = await get_buffer(HEADER_BYTES, data_length);
  if (!data_buffer)
    throw deserialize_error("data too short");
  let file_offsets;
  let files_start_offset;
  if (file_offsets_length > 0) {
    const file_offsets_buffer = await get_buffer(HEADER_BYTES + data_length, file_offsets_length);
    if (!file_offsets_buffer)
      throw deserialize_error("file offset table too short");
    const parsed_offsets = JSON.parse(text_decoder.decode(file_offsets_buffer));
    if (!Array.isArray(parsed_offsets) || parsed_offsets.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0))
      throw deserialize_error("invalid file offset table");
    file_offsets = parsed_offsets;
    files_start_offset = HEADER_BYTES + data_length + file_offsets_length;
  }
  const file_spans = [];
  const [data, meta] = parse(text_decoder.decode(data_buffer), { File: ([name, type, size, last_modified, index]) => {
    if (typeof name !== "string" || typeof type !== "string" || typeof size !== "number" || typeof last_modified !== "number" || typeof index !== "number")
      throw deserialize_error("invalid file metadata");
    let offset = file_offsets[index];
    if (offset === undefined)
      throw deserialize_error("duplicate file offset table index");
    file_offsets[index] = undefined;
    offset += files_start_offset;
    file_spans.push({
      offset,
      size
    });
    return new Proxy(new LazyFile(name, type, size, last_modified, get_chunk, offset), { getPrototypeOf() {
      return File.prototype;
    } });
  } });
  file_spans.sort((a, b) => a.offset - b.offset || a.size - b.size);
  for (let i = 1;i < file_spans.length; i++) {
    const previous = file_spans[i - 1];
    const current = file_spans[i];
    const previous_end = previous.offset + previous.size;
    if (previous_end < current.offset)
      throw deserialize_error("gaps in file data");
    if (previous_end > current.offset)
      throw deserialize_error("overlapping file data");
  }
  (async () => {
    let has_more = true;
    while (has_more)
      has_more = !!await get_chunk(chunks.length);
  })().catch(noop);
  return {
    data,
    meta,
    form_data: null
  };
}
function deserialize_error(message) {
  return new SvelteKitError(400, "Bad Request", `Could not deserialize binary form: ${message}`);
}
async function* read_range(get_chunk, offset, length) {
  let chunk_start = 0;
  for (let index = 0;; index++) {
    const chunk = await get_chunk(index);
    if (!chunk)
      return;
    const chunk_end = chunk_start + chunk.byteLength;
    if (chunk_end > offset) {
      yield chunk.subarray(Math.max(0, offset - chunk_start), Math.min(chunk.byteLength, offset + length - chunk_start));
      if (offset + length <= chunk_end)
        return;
    }
    chunk_start = chunk_end;
  }
}
var LazyFile = class LazyFile2 {
  #get_chunk;
  #offset;
  constructor(name, type, size, last_modified, get_chunk, offset) {
    this.name = name;
    this.type = type;
    this.size = size;
    this.lastModified = last_modified;
    this.webkitRelativePath = "";
    this.#get_chunk = get_chunk;
    this.#offset = offset;
    this.arrayBuffer = this.arrayBuffer.bind(this);
    this.bytes = this.bytes.bind(this);
    this.slice = this.slice.bind(this);
    this.stream = this.stream.bind(this);
    this.text = this.text.bind(this);
  }
  #buffer;
  async arrayBuffer() {
    this.#buffer ??= await new Response(this.stream()).arrayBuffer();
    return this.#buffer;
  }
  async bytes() {
    return new Uint8Array(await this.arrayBuffer());
  }
  slice(start = 0, end = this.size, contentType = this.type) {
    if (start < 0)
      start = Math.max(this.size + start, 0);
    else
      start = Math.min(start, this.size);
    if (end < 0)
      end = Math.max(this.size + end, 0);
    else
      end = Math.min(end, this.size);
    const size = Math.max(end - start, 0);
    return new LazyFile2(this.name, contentType, size, this.lastModified, this.#get_chunk, this.#offset + start);
  }
  stream() {
    const range = read_range(this.#get_chunk, this.#offset, this.size);
    const size = this.size;
    return stream_from_iterable(async function* () {
      let cursor = 0;
      for await (const chunk of range) {
        cursor += chunk.byteLength;
        yield chunk;
      }
      if (cursor < size)
        throw new Error("incomplete file data");
    }());
  }
  async text() {
    return text_decoder.decode(await this.arrayBuffer());
  }
};
var path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;
function split_path(path) {
  if (!path_regex.test(path))
    throw new Error(`Invalid field name ${path}`);
  return path.split(/\.|\[|\]/).filter(Boolean);
}
function check_prototype_pollution(key) {
  if (key === "__proto__" || key === "constructor" || key === "prototype")
    throw new Error(`Invalid key "${key}"`);
}
function deep_set(object, keys, value) {
  let current = object;
  for (let i = 0;i < keys.length - 1; i += 1) {
    const key = keys[i];
    check_prototype_pollution(key);
    const is_array = /^\d+$/.test(keys[i + 1]);
    const inner = Object.hasOwn(current, key) ? current[key] : undefined;
    const exists = inner != null;
    if (exists && is_array !== Array.isArray(inner))
      throw new Error(`Invalid array key ${keys[i + 1]}`);
    if (!exists) {
      if (value === DELETE_KEY)
        return;
      current[key] = is_array ? [] : {};
    }
    current = current[key];
  }
  const final_key = keys[keys.length - 1];
  check_prototype_pollution(final_key);
  if (value === DELETE_KEY)
    delete current[final_key];
  else
    current[final_key] = value;
}
function normalize_issue(issue, server = false) {
  const normalized = {
    name: "",
    path: [],
    message: issue.message,
    server
  };
  if (issue.path !== undefined) {
    let name = "";
    for (const segment of issue.path) {
      const key = typeof segment === "object" ? segment.key : segment;
      normalized.path.push(key);
      if (typeof key === "number")
        name += `[${key}]`;
      else if (typeof key === "string")
        name += name === "" ? key : "." + key;
    }
    normalized.name = name;
  }
  return normalized;
}
function flatten_issues(issues) {
  const result = {};
  for (const issue of issues) {
    (result.$ ??= []).push(issue);
    let name = "";
    if (issue.path !== undefined)
      for (const key of issue.path) {
        if (typeof key === "number")
          name += `[${key}]`;
        else if (typeof key === "string")
          name += name === "" ? key : "." + key;
        (result[name] ??= []).push(issue);
      }
  }
  return result;
}
function deep_get(object, path) {
  let current = object;
  for (const key of path) {
    if (current === null || typeof current !== "object")
      return;
    current = current[key];
  }
  return current;
}
var type_prefixes = {
  number: "n:",
  boolean: "b:"
};
function add_props(base_props, props) {
  for (const prop in props) {
    const value = props[prop];
    if (typeof value === "function")
      Object.defineProperty(base_props, prop, {
        enumerable: true,
        get: value
      });
    else
      base_props[prop] = value;
  }
  return base_props;
}
function get_type_prefix(type, is_array, input_value) {
  if (type === "number" || type === "range")
    return "n:";
  if (type === "image")
    return "i:";
  if (type === "checkbox" && !is_array)
    return "b:";
  if (type === "hidden" || type === "submit")
    return type_prefixes[typeof input_value] ?? "";
  return "";
}
function deep_clone(value) {
  if (value !== null && typeof value === "object") {
    if (value instanceof Date)
      return new Date(value.getTime());
    if (value instanceof File)
      return value;
    if (Array.isArray(value))
      return value.map(deep_clone);
    const clone = {};
    for (const key of Object.keys(value))
      clone[key] = deep_clone(value[key]);
    return clone;
  }
  return value;
}
var dev_traps = null;
var public_issue = (issue) => ({
  path: issue.path,
  message: issue.message
});
function create_field_method(context, path, prop) {
  switch (prop) {
    case "set":
      return (value) => {
        context.set(path, value);
        return value;
      };
    case "value":
      return () => deep_clone(deep_get(context.get(), path));
    case "issues":
    case "allIssues": {
      const key = build_path_string(path);
      const all = prop === "allIssues";
      return () => {
        const issues = context.get_issues(path, all)[key === "" ? "$" : key];
        if (all)
          return issues?.map(public_issue);
        const own = issues?.filter((issue) => issue.name === key).map(public_issue);
        return own?.length ? own : undefined;
      };
    }
    case "touched":
    case "dirty": {
      const key = build_path_string(path);
      return () => {
        const object = prop === "dirty" ? context.get_dirty() : context.get_touched();
        if (Object.hasOwn(object, key))
          return true;
        for (const candidate in object) {
          if (!Object.hasOwn(object, candidate))
            continue;
          if (key === "")
            return true;
          if (!candidate.startsWith(key))
            continue;
          const next = candidate[key.length];
          if (next === "." || next === "[")
            return true;
        }
        return false;
      };
    }
    case "as": {
      const key = build_path_string(path);
      const read = (fallback) => deep_get(context.get(), path) ?? (fallback !== undefined && Object.hasOwn(context.get_dirty(), key) ? undefined : fallback);
      return (type, input_value, checked) => {
        const is_array = type === "file multiple" || type === "select multiple" || type === "checkbox" && typeof input_value === "string";
        const base_props = {
          name: get_type_prefix(type, is_array, input_value) + key + (is_array ? "[]" : "") + "/" + context.form_id,
          get "aria-invalid"() {
            const issues = context.get_issues();
            return key in issues ? "true" : undefined;
          }
        };
        if (type !== "text" && type !== "select" && type !== "select multiple")
          base_props.type = type === "file multiple" ? "file" : type;
        if (type === "submit" || type === "hidden")
          return add_props(base_props, { value: typeof input_value === "boolean" ? input_value ? "on" : "off" : input_value });
        if (type === "select" || type === "select multiple")
          return add_props(base_props, {
            multiple: is_array,
            value: () => {
              const value = read(input_value);
              return Array.isArray(value) ? [...value] : value;
            }
          });
        if (type === "checkbox" || type === "radio") {
          if (type === "radio" || is_array)
            base_props.value = input_value ?? "on";
          else
            checked = input_value;
          return add_props(base_props, {
            defaultChecked: checked,
            checked: () => {
              const value = read();
              if (value == null)
                return read(checked);
              if (type === "radio")
                return value === input_value;
              if (is_array)
                return value.includes(input_value);
              return value;
            }
          });
        }
        if (type === "file" || type === "file multiple")
          return add_props(base_props, {
            multiple: is_array,
            files: () => {
              const value = read();
              const files = value instanceof File ? [value] : value;
              if (!Array.isArray(files) || !files.every((f) => f instanceof File))
                return null;
              if (typeof DataTransfer === "undefined")
                return Object.assign({ length: files.length }, files);
              const transfer = new DataTransfer;
              for (const file of files)
                transfer.items.add(file);
              return transfer.files;
            }
          });
        if (type === "image")
          return base_props;
        return add_props(base_props, {
          defaultValue: input_value,
          value: () => String(read(input_value) ?? "")
        });
      };
    }
  }
}
function create_field_proxy(context, target = {}, path = []) {
  return new Proxy(target, {
    ...dev_traps,
    get(target2, prop) {
      if (typeof prop === "symbol")
        return target2[prop];
      const next = [...path, /^\d+$/.test(prop) ? parseInt(prop, 10) : prop];
      return create_field_proxy(context, create_field_method(context, path, prop), next);
    }
  });
}
function build_path_string(path) {
  let result = "";
  for (const segment of path)
    if (typeof segment === "number")
      result += `[${segment}]`;
    else
      result += result === "" ? segment : "." + segment;
  return result;
}
function negotiate(accept, types2) {
  const parts = [];
  accept.split(",").forEach((str, i) => {
    const match = /^[ \t]*([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(str);
    if (match) {
      const [, type, subtype, q = "1"] = match;
      parts.push({
        type,
        subtype,
        q: +q,
        i
      });
    }
  });
  parts.sort((a, b) => {
    if (a.q !== b.q)
      return b.q - a.q;
    if (a.subtype === "*" !== (b.subtype === "*"))
      return a.subtype === "*" ? 1 : -1;
    if (a.type === "*" !== (b.type === "*"))
      return a.type === "*" ? 1 : -1;
    return a.i - b.i;
  });
  let accepted;
  let min_priority = Infinity;
  for (const mimetype of types2) {
    const [type, subtype] = mimetype.split("/");
    const priority = parts.findIndex((part) => (part.type === type || part.type === "*") && (part.subtype === subtype || part.subtype === "*"));
    if (priority !== -1 && priority < min_priority) {
      accepted = mimetype;
      min_priority = priority;
    }
  }
  return accepted;
}
function matches_content_type(header, ...types2) {
  const type = header?.split(";", 1)[0].trim() ?? "";
  return types2.includes(type.toLowerCase());
}
function is_form_content_type(request) {
  return matches_content_type(request.headers.get("content-type"), "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", BINARY_FORM_CONTENT_TYPE);
}
var uneval2 = () => {
  throw new Error("");
};
var stringify2 = () => {
  throw new Error("");
};
var parse2 = () => {
  throw new Error("");
};
var encoders = {};
var decoders = {};
var has_custom_transporters = false;
function init_transport(transport) {
  const transporters = Object.entries(transport);
  has_custom_transporters = transporters.length > 0;
  const replacer = (thing) => {
    for (const key of Object.keys(transport)) {
      const encoded = transport[key].encode(thing);
      if (encoded)
        return `app.decode('${key}', ${uneval(encoded, replacer)})`;
    }
  };
  encoders = Object.fromEntries(transporters.map(([k, v]) => [k, v.encode]));
  decoders = Object.fromEntries(transporters.map(([k, v]) => [k, v.decode]));
  uneval2 = (data) => uneval(data, replacer);
  stringify2 = (data) => stringify(data, encoders);
  parse2 = (data) => parse(data, decoders);
}
function fetch_cache_url(url, page) {
  return url.origin === page.origin ? url.href.slice(page.origin.length) : url.href;
}
var INVALIDATED_PARAM = "x-sveltekit-invalidated";
var TRAILING_SLASH_PARAM = "x-sveltekit-trailing-slash";
var object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(Object.prototype).sort().join("\x00");
function is_plain_object(thing) {
  if (typeof thing !== "object" || thing === null)
    return false;
  const proto = Object.getPrototypeOf(thing);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null || Object.getOwnPropertyNames(proto).sort().join("\x00") === object_proto_names;
}
function to_sorted(value, clones) {
  const clone = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  clones.set(value, clone);
  Object.defineProperty(clone, remote_arg_marker, { value: true });
  for (const key of Object.keys(value).sort()) {
    const property = value[key];
    Object.defineProperty(clone, key, {
      value: clones.get(property) ?? property,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return clone;
}
var remote_object = "__skrao";
var remote_map = "__skram";
var remote_set = "__skras";
var remote_file = "__skraf";
var remote_regex_guard = "__skrag";
var remote_arg_marker = Symbol(remote_object);
function create_remote_arg_reducers(sort) {
  const remote_fns_reducers = {
    [remote_regex_guard]: (value) => {
      if (value instanceof RegExp)
        throw new Error("Regular expressions are not valid remote function arguments");
    }
  };
  if (sort) {
    const clones = /* @__PURE__ */ new Map;
    remote_fns_reducers[remote_map] = (value) => {
      if (!(value instanceof Map))
        return;
      const entries = [];
      for (const [key, val] of value)
        entries.push([stringify3(key), stringify3(val)]);
      return entries.sort(([a1, a2], [b1, b2]) => {
        if (a1 < b1)
          return -1;
        if (a1 > b1)
          return 1;
        if (a2 < b2)
          return -1;
        if (a2 > b2)
          return 1;
        return 0;
      });
    };
    remote_fns_reducers[remote_set] = (value) => {
      if (!(value instanceof Set))
        return;
      const items = [];
      for (const item of value)
        items.push(stringify3(item));
      items.sort();
      return items;
    };
    remote_fns_reducers[remote_object] = (value) => {
      if (!is_plain_object(value))
        return;
      if (Object.hasOwn(value, remote_arg_marker))
        return;
      if (clones.has(value))
        return clones.get(value);
      return to_sorted(value, clones);
    };
  }
  const all_reducers = {
    ...encoders,
    ...remote_fns_reducers
  };
  const stringify3 = (value) => stringify(value, all_reducers);
  return all_reducers;
}
function create_remote_arg_revivers() {
  const remote_fns_revivers = {
    [remote_object]: (value) => value,
    [remote_map]: (value) => {
      if (!Array.isArray(value))
        throw new Error("Invalid data for Map reviver");
      const map = /* @__PURE__ */ new Map;
      for (const item of value) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string")
          throw new Error("Invalid data for Map reviver");
        const [key, val] = item;
        map.set(parse3(key), parse3(val));
      }
      return map;
    },
    [remote_set]: (value) => {
      if (!Array.isArray(value))
        throw new Error("Invalid data for Set reviver");
      const set = /* @__PURE__ */ new Set;
      for (const item of value) {
        if (typeof item !== "string")
          throw new Error("Invalid data for Set reviver");
        set.add(parse3(item));
      }
      return set;
    },
    [remote_file]: (value) => {
      if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.type !== "string" || typeof value.size !== "number" || typeof value.lastModified !== "number" || !(value.data instanceof ArrayBuffer))
        throw new Error("Invalid data for File reviver");
      const { data, name, ...meta } = value;
      return new File([data], name, meta);
    }
  };
  const all_revivers = {
    ...decoders,
    ...remote_fns_revivers
  };
  const parse3 = (data) => parse(data, all_revivers);
  return all_revivers;
}
function stringify_remote_arg(value) {
  if (value === undefined)
    return "";
  return url_friendly_base64_encode(stringify(value, create_remote_arg_reducers(true)));
}
function url_friendly_base64_encode(string) {
  return base64_encode(text_encoder2.encode(string)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}
function parse_remote_arg(string) {
  if (!string)
    return;
  const json_string = text_decoder.decode(base64_decode(string.replaceAll("-", "+").replaceAll("_", "/")));
  return parse(json_string, create_remote_arg_revivers());
}
function create_remote_key(id, payload) {
  return id + "/" + payload;
}
function split_remote_key(key) {
  const i = key.lastIndexOf("/");
  if (i === -1)
    throw new Error(`Invalid remote key: ${key}`);
  return {
    id: key.slice(0, i),
    payload: key.slice(i + 1)
  };
}
function coalesce_to_error(err) {
  return err instanceof Error || err && err.name && err.message ? err : new Error(JSON.stringify(err));
}
function normalize_error(error2) {
  return error2;
}
function get_status(error2) {
  return error2 instanceof HttpError || error2 instanceof SvelteKitError ? error2.status : 500;
}
var escape_html_attr_dict = {
  "&": "&amp;",
  '"': "&quot;"
};
var escape_html_dict = {
  "&": "&amp;",
  "<": "&lt;"
};
var escape_regex = (dict) => new RegExp(`[${Object.keys(dict).join("")}]|\\p{Surrogate}`, "gu");
var escape_html_attr_regex = escape_regex(escape_html_attr_dict);
var escape_html_regex = escape_regex(escape_html_dict);
function escape_html(str, is_attr) {
  const dict = is_attr ? escape_html_attr_dict : escape_html_dict;
  return str.replace(is_attr ? escape_html_attr_regex : escape_html_regex, (match) => dict[match] ?? `&#${match.charCodeAt(0)};`);
}
async function handle_fatal_error(event, state, error2) {
  const body = await handle_error_and_jsonify(event, state, error2);
  const status = body.status;
  const type = negotiate(event.request.headers.get("accept") || "text/html", ["application/json", "text/html"]);
  if (event.isDataRequest || type === "application/json")
    return Response.json(body, { status });
  return static_error_page(status, body.message);
}
function handle_error_and_jsonify(event, state, error2) {
  if (error2 instanceof HandledHttpError)
    return error2.body;
  let caught;
  if (error2 instanceof HttpError)
    caught = {
      kind: "app",
      error: error2.body
    };
  else if (error2 instanceof SvelteKitError)
    caught = {
      kind: "framework",
      error: {
        status: error2.status,
        message: error2.text
      }
    };
  else if (error2 instanceof ValidationError)
    caught = {
      kind: "validation",
      error: {
        status: 400,
        message: "Bad Request"
      },
      issues: error2.issues
    };
  else {
    caught = {
      kind: "unknown",
      error: error2
    };
    let e = error2;
    while (e instanceof Error) {
      fix_stack_trace(e);
      e = e.cause;
    }
  }
  const fallback = caught.kind === "unknown" ? {
    status: 500,
    message: "Internal Error"
  } : caught.error;
  function merge(body) {
    return {
      ...fallback,
      ...body
    };
  }
  let result;
  try {
    const input = {
      ...caught,
      event
    };
    result = with_request_store({
      event,
      state
    }, () => hooks.handleError(input));
  } catch (hook_error) {
    log_handle_error_hook_failure(error2, hook_error);
    return {
      status: fallback.status,
      message: "Internal Error"
    };
  }
  if (result instanceof Promise)
    return result.then(merge, (hook_error) => {
      log_handle_error_hook_failure(error2, hook_error);
      return {
        status: fallback.status,
        message: "Internal Error"
      };
    });
  return merge(result);
}
function log_handle_error_hook_failure(error2, hook_error) {
  const failure = new Error("The `handleError` hook failed", { cause: coalesce_to_error(hook_error) });
  failure.stack = failure.message;
  console.error(failure);
  if (error2 instanceof SvelteKitError)
    console.error(`Original error: ${error2.status} ${error2.text}: ${error2.message}`);
  else
    console.error("Original error:", error2);
}
function static_error_page(status, message) {
  let page = options$1.templates.error({
    status,
    message: escape_html(message)
  });
  return text(page, {
    headers: { "content-type": "text/html; charset=utf-8" },
    status
  });
}
function method_not_allowed(mod, method) {
  return text(`${method} method not allowed`, {
    status: 405,
    headers: { allow: allowed_methods(mod).join(", ") }
  });
}
function allowed_methods(mod) {
  const allowed = ENDPOINT_METHODS.filter((method) => (method in mod));
  if ("GET" in mod && !("HEAD" in mod))
    allowed.push("HEAD");
  return allowed;
}
function redirect_response(status, location) {
  return new Response(undefined, {
    status,
    headers: { location }
  });
}
function with_version_header(response) {
  response.headers.set("x-sveltekit-version", "1789244386078");
  return response;
}
function clarify_devalue_error(event, error2) {
  if (error2.path)
    return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error2.message} (${error2.path}). If you need to serialize/deserialize custom types, use transport hooks: https://svelte.dev/docs/kit/hooks#transport.`;
  if (error2.path === "")
    return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
  return error2.message;
}
function serialize_uses(node) {
  const uses = {};
  if (node.uses && node.uses.dependencies.size > 0)
    uses.dependencies = Array.from(node.uses.dependencies);
  if (node.uses && node.uses.search_params.size > 0)
    uses.search_params = Array.from(node.uses.search_params);
  if (node.uses && node.uses.params.size > 0)
    uses.params = Array.from(node.uses.params);
  if (node.uses?.parent)
    uses.parent = 1;
  if (node.uses?.route)
    uses.route = 1;
  if (node.uses?.url)
    uses.url = 1;
  return uses;
}
function has_prerendered_path(pathname) {
  return manifest.prerendered_routes.has(pathname) || pathname.at(-1) === "/" && manifest.prerendered_routes.has(pathname.slice(0, -1));
}
function get_node_type(node_id) {
  const filename = node_id?.split("/")?.at(-1);
  if (!filename)
    return "unknown";
  return filename.split(".").slice(0, -1).join(".");
}
function is_action_json_request(event) {
  return negotiate(event.request.headers.get("accept") ?? "*/*", ["application/json", "text/html"]) === "application/json" && event.request.method === "POST";
}
async function handle_action_json_request(event, state, server) {
  return action_result_json(event, state, await handle_action_request(event, state, server));
}
async function action_result_json(event, state, result) {
  if (result.type === "redirect")
    return action_json(result);
  if (result.type === "error") {
    const error2 = await handle_error_and_jsonify(event, state, result.error);
    return action_json({
      ...result,
      error: error2
    }, { status: error2.status });
  }
  if (result.type === "success" && !result.data)
    return action_json({
      ...result,
      status: 204,
      data: undefined
    });
  try {
    return action_json({
      ...result,
      data: try_serialize(result.data, stringify2, event.route.id)
    }, { status: result.status });
  } catch (e) {
    return action_result_json(event, state, action_error_result(e, result.location));
  }
}
function get_action_location(url) {
  const location = new URL(url);
  for (const key of location.searchParams.keys())
    if (key.startsWith("/")) {
      location.searchParams.delete(key);
      break;
    }
  return location.pathname + location.search;
}
function method_not_allowed_result(event, location) {
  event.setHeaders({ allow: "GET" });
  return {
    type: "error",
    location,
    error: new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for this page`)
  };
}
function action_error_result(e, location) {
  const err = normalize_error(e);
  if (err instanceof Redirect)
    return {
      type: "redirect",
      status: err.status,
      location: err.location
    };
  return {
    type: "error",
    location,
    error: err
  };
}
function action_json_redirect(redirect) {
  return action_json({
    type: "redirect",
    status: redirect.status,
    location: redirect.location
  });
}
function action_json(data, init) {
  return with_version_header(Response.json(data, init));
}
function is_action_request(event) {
  return event.request.method === "POST";
}
async function handle_action_request(event, state, server) {
  const actions = server?.actions;
  const location = get_action_location(event.url);
  if (!actions)
    return method_not_allowed_result(event, location);
  check_named_default_separate(actions);
  try {
    const data = await call_action(event, state, actions);
    if (data instanceof ActionFailure)
      return {
        type: "failure",
        status: data.status,
        location,
        data: data.data
      };
    else
      return {
        type: "success",
        status: 200,
        location,
        data
      };
  } catch (e) {
    return action_error_result(e instanceof ActionFailure ? /* @__PURE__ */ new Error('Cannot "throw fail()". Use "return fail()"') : e, location);
  }
}
function check_named_default_separate(actions) {
  if (actions.default && Object.keys(actions).length > 1)
    throw new Error("When using named actions, the default action cannot be used. See the docs for more info: https://svelte.dev/docs/kit/form-actions#named-actions");
}
async function call_action(event, state, actions) {
  const url = new URL(event.request.url);
  let name = "default";
  for (const param of url.searchParams)
    if (param[0].startsWith("/")) {
      name = param[0].slice(1);
      if (name === "default")
        throw new Error('Cannot use reserved action name "default"');
      break;
    }
  if (!Object.hasOwn(actions, name))
    throw new SvelteKitError(404, "Not Found", `No action with name '${name}' found`);
  const action = actions[name];
  if (!is_form_content_type(event.request))
    throw new SvelteKitError(415, "Unsupported Media Type", `Form actions expect form-encoded data \u2014 received ${event.request.headers.get("content-type")}`);
  return record_span({
    name: "sveltekit.form_action",
    attributes: {
      "sveltekit.form_action.name": name,
      "http.route": event.route.id || "unknown"
    },
    fn: async (current) => {
      const traced_event = merge_tracing(event, current);
      const result = await with_request_store({
        event: traced_event,
        state
      }, () => action(traced_event));
      if (result instanceof ActionFailure)
        current.setAttributes({
          "sveltekit.form_action.result.type": "failure",
          "sveltekit.form_action.result.status": result.status
        });
      return result;
    }
  });
}
function uneval_action_response(data, route_id) {
  return try_serialize(data, uneval2, route_id);
}
function try_serialize(data, fn, route_id) {
  try {
    return fn(data);
  } catch (e) {
    const error2 = e;
    if (data instanceof Response)
      throw new Error(`Data returned from action inside ${route_id} is not serializable. Form actions need to return plain objects or fail(). E.g. return { success: true } or return fail(400, { message: "invalid" });`, { cause: e });
    if ("path" in error2) {
      let message = `Data returned from action inside ${route_id} is not serializable: ${error2.message}`;
      if (error2.path !== "")
        message += ` (data.${error2.path})`;
      throw new Error(message, { cause: e });
    }
    throw error2;
  }
}
var KEEP_ALIVE_INTERVAL = 30000;
function create_live_query_response(event, state, internals, arg) {
  const cancellation = new AbortController;
  const live_event = {
    ...event,
    request: new Request(event.request, { signal: AbortSignal.any([event.request.signal, cancellation.signal]) })
  };
  const generator = internals.run(live_event, state, arg);
  let open = true;
  let pulling = false;
  let stream_controller;
  let keep_alive;
  let result;
  function schedule_keep_alive() {
    clearTimeout(keep_alive);
    keep_alive = setTimeout(() => {
      if (!open)
        return;
      if ((stream_controller.desiredSize ?? 0) > 0)
        stream_controller.enqueue(text_encoder2.encode(`: keep-alive

`));
      schedule_keep_alive();
    }, KEEP_ALIVE_INTERVAL);
  }
  function send(data) {
    if (!open)
      return;
    stream_controller.enqueue(text_encoder2.encode("data: " + JSON.stringify(data) + `

`));
    schedule_keep_alive();
  }
  function teardown(cancelled) {
    if (!open)
      return;
    open = false;
    clearTimeout(keep_alive);
    cancellation.abort();
    if (!cancelled)
      stream_controller.close();
    generator.return(undefined).catch(() => {});
  }
  event.request.signal.addEventListener("abort", () => teardown(true), { once: true });
  return new Response(new ReadableStream({
    start(controller) {
      stream_controller = controller;
      schedule_keep_alive();
    },
    async pull() {
      if (!open || pulling)
        return;
      pulling = true;
      try {
        while (open) {
          const { value, done } = await generator.next();
          if (!open)
            return;
          if (done) {
            teardown(false);
            return;
          }
          if (result !== (result = stringify2(value))) {
            send({
              type: "result",
              result
            });
            return;
          }
        }
      } catch (error2) {
        if (!open)
          return;
        if (error2 instanceof Redirect)
          send({
            type: "redirect",
            location: error2.location
          });
        else
          send({
            type: "error",
            error: await handle_error_and_jsonify(event, state, error2)
          });
        teardown(false);
      } finally {
        pulling = false;
      }
    },
    cancel() {
      teardown(true);
    }
  }), { headers: {
    "cache-control": "private, no-store",
    "content-type": "text/event-stream"
  } });
}
async function handle_remote_call(event, state, id) {
  return record_span({
    name: "sveltekit.remote.call",
    attributes: { "sveltekit.remote.call.id": id },
    fn: async (current) => {
      const traced_event = merge_tracing(event, current);
      return with_version_header(await with_request_store({
        event: traced_event,
        state
      }, () => handle_remote_call_internal(traced_event, state, id)));
    }
  });
}
async function handle_remote_call_internal(event, state, id) {
  const [hash, name, additional_args] = id.split("/");
  const remotes = manifest.remotes;
  if (!Object.hasOwn(remotes, hash))
    error(404);
  const module = await remotes[hash]();
  const fn = Object.hasOwn(module.default, name) ? module.default[name] : undefined;
  if (!fn)
    error(404);
  const internals = fn.__;
  event.tracing.current.setAttributes({
    "sveltekit.remote.call.type": internals.type,
    "sveltekit.remote.call.name": internals.name
  });
  const headers = state.prerendering ? undefined : { "cache-control": "private, no-store" };
  try {
    const data = {};
    switch (internals.type) {
      case "query_live":
        if (event.request.method !== "GET")
          throw new SvelteKitError(405, "Method Not Allowed", `\`query.live\` functions must be invoked via GET request, not ${event.request.method}`);
        return create_live_query_response(event, state, internals, parse_remote_arg(new URL(event.request.url).searchParams.get("payload")));
      case "query_batch": {
        if (event.request.method !== "POST")
          throw new SvelteKitError(405, "Method Not Allowed", `\`query.batch\` functions must be invoked via POST request, not ${event.request.method}`);
        const { payloads } = await event.request.json();
        const args = await Promise.all(payloads.map((payload) => parse_remote_arg(payload)));
        data._ = await with_request_store({
          event,
          state
        }, () => internals.run(args));
        break;
      }
      case "form": {
        if (event.request.method !== "POST")
          throw new SvelteKitError(405, "Method Not Allowed", `\`form\` functions must be invoked via POST request, not ${event.request.method}`);
        if (!is_form_content_type(event.request))
          throw new SvelteKitError(415, "Unsupported Media Type", `\`form\` functions expect form-encoded data \u2014 received ${event.request.headers.get("content-type")}`);
        const { data: input, meta, form_data } = await deserialize_binary_form(event.request, internals.id);
        state.remote.requested = create_requested_map(meta.remote_refreshes);
        if (additional_args && !("id" in input))
          input.id = JSON.parse(decodeURIComponent(additional_args));
        const fn2 = internals.fn;
        data._ = await with_request_store({
          event,
          state: {
            ...state,
            is_in_remote_form_or_command: true
          }
        }, () => fn2(input, meta, form_data));
        if (data._.issues)
          return Response.json({
            type: "result",
            data: stringify2(data)
          }, { headers });
        break;
      }
      case "command": {
        const { payload, refreshes } = await event.request.json();
        state.remote.requested = create_requested_map(refreshes);
        const arg = parse_remote_arg(payload);
        data._ = await with_request_store({
          event,
          state: {
            ...state,
            is_in_remote_form_or_command: true
          }
        }, () => fn(arg));
        break;
      }
      case "prerender":
        data._ = await with_request_store({
          event,
          state
        }, () => fn(parse_remote_arg(additional_args)));
        break;
      case "query": {
        const payload = new URL(event.request.url).searchParams.get("payload");
        data._ = await with_request_store({
          event,
          state
        }, () => fn(parse_remote_arg(payload)));
        break;
      }
    }
    await collect_remote_data(data, event, state);
    if (state.remote.ignored?.size)
      data.i = Array.from(state.remote.ignored);
    return Response.json({
      type: "result",
      data: stringify2(data)
    }, { headers });
  } catch (error2) {
    if (error2 instanceof Redirect) {
      const data = await collect_remote_data({ redirect: error2.location }, event, state);
      return Response.json({
        type: "result",
        data: stringify2(data)
      }, { headers });
    }
    const transformed = await handle_error_and_jsonify(event, state, error2);
    return Response.json({
      type: "error",
      error: transformed
    }, {
      status: state.prerendering ? transformed.status : undefined,
      headers: { "cache-control": "private, no-store" }
    });
  }
}
async function collect_remote_data(data, event, state) {
  function convert_error(error2) {
    return Promise.resolve(handle_error_and_jsonify(event, state, error2));
  }
  const promises = [];
  const processed = /* @__PURE__ */ new Set;
  if (state.remote.explicit) {
    const { explicit } = state.remote;
    const inflight = [];
    const drain = () => {
      for (const [remote_key, { internals, fn }] of explicit) {
        explicit.delete(remote_key);
        if (processed.has(remote_key))
          continue;
        processed.add(remote_key);
        data.r = true;
        const type = internals.type === "query_live" ? "l" : internals.type[0];
        inflight.push(fn().then((v) => {
          (data[type] ??= {})[remote_key] = { v };
          drain();
        }, async (e) => {
          if (!(e instanceof Redirect))
            (data[type] ??= {})[remote_key] = { e: await convert_error(e) };
          drain();
        }));
      }
    };
    drain();
    for (const promise of inflight)
      await promise;
  }
  if (state.remote.implicit)
    for (const [internals, record] of state.remote.implicit) {
      if (!internals.id)
        continue;
      for (const key in record) {
        const remote_key = internals.type === "form" ? key : create_remote_key(internals.id, key);
        if (processed.has(remote_key))
          continue;
        const type = internals.type === "query_live" ? "l" : internals.type[0];
        const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
        let resolved = true;
        await Promise.race([Promise.resolve(promise).then((v) => {
          if (resolved)
            ((data[type] ??= {})[remote_key] ??= {}).v = v;
        }, (e) => {
          if (e instanceof Redirect)
            return;
          if (resolved)
            promises.push(convert_error(e).then((e2) => {
              ((data[type] ??= {})[remote_key] ??= {}).e = e2;
            }));
        }), Promise.resolve().then(() => resolved = false)]);
      }
    }
  await Promise.all(promises);
  return data;
}
function create_requested_map(refreshes) {
  const requested = /* @__PURE__ */ new Map;
  for (const key of refreshes ?? []) {
    const parts = split_remote_key(key);
    const existing = requested.get(parts.id);
    if (existing)
      existing.add(parts.payload);
    else
      requested.set(parts.id, /* @__PURE__ */ new Set([parts.payload]));
  }
  return requested;
}
async function handle_remote_form_post(event, state, id) {
  return record_span({
    name: "sveltekit.remote.form.post",
    attributes: { "sveltekit.remote.form.post.id": id },
    fn: (current) => {
      const traced_event = merge_tracing(event, current);
      return with_request_store({
        event: traced_event,
        state
      }, () => handle_remote_form_post_internal(traced_event, state, id));
    }
  });
}
async function handle_remote_form_post_internal(event, state, id) {
  const location = get_action_location(event.url);
  const [hash, name, ...rest] = id.split("/");
  const action_id = rest.join("/");
  const remotes = manifest.remotes;
  const module = Object.hasOwn(remotes, hash) ? await remotes[hash]() : undefined;
  let form = module && Object.hasOwn(module.default, name) ? module.default[name] : undefined;
  if (!form)
    return method_not_allowed_result(event, location);
  if (action_id)
    form = with_request_store({
      event,
      state
    }, () => form.for(JSON.parse(action_id)));
  try {
    const __ = form.__;
    const { data, meta, form_data } = await deserialize_binary_form(event.request, __.id);
    if (action_id && !("id" in data))
      data.id = JSON.parse(decodeURIComponent(action_id));
    await with_request_store({
      event,
      state: {
        ...state,
        is_in_remote_form_or_command: true
      }
    }, () => __.fn(data, meta, form_data));
    return {
      type: "success",
      status: 200,
      location
    };
  } catch (e) {
    return action_error_result(e, location);
  }
}
function has_remote_prefix(url) {
  return url.pathname.startsWith(`/${app_dir}/remote/`);
}
function strip_remote_prefix(url) {
  return url.pathname.replace(`/${app_dir}/remote/`, "");
}
function get_remote_id(url) {
  return has_remote_prefix(url) && strip_remote_prefix(url);
}
function get_remote_action(url) {
  return url.searchParams.get("/remote");
}
var fs = globalThis.process?.getBuiltinModule?.("node:fs");
var url = globalThis.process?.getBuiltinModule?.("node:url");
var path = globalThis.process?.getBuiltinModule?.("node:path");
var module = globalThis.process?.getBuiltinModule?.("node:module");
var cwd = globalThis.process?.cwd?.();
var relative = cwd ? (file) => path.relative(cwd, file) : (file) => file;
var fix_stack_trace = (error2) => {
  if (!error2.stack || !fs)
    return;
  let end = 0;
  error2.stack = error2.stack.split(`
`).map((line, i) => {
    const match = line.match(/^ {4}at.+(file:\/\/\/.*):(\d+):(\d+)(\)?)$/);
    if (!match) {
      if (!line.includes("node:internal/"))
        end = i + 1;
      return line;
    }
    const file = url.fileURLToPath(match[1]);
    const traced = trace(file, Number(match[2]) - 1, Number(match[3]) - 1);
    if (!/[\\/]node_modules[\\/]/.test(traced?.file ?? file))
      end = i + 1;
    if (traced?.line) {
      const location = `${match[1]}:${match[2]}:${match[3]}`;
      const original = `${relative(traced.file)}:${traced.line}:${traced.column}`;
      return line.replace(location, original);
    }
    if (traced)
      return `${line.replace(match[1], relative(file))} [${traced.file}]`;
    return line;
  }).slice(0, end).join(`
`);
};
var source_maps = /* @__PURE__ */ new Map;
var source_regions = /* @__PURE__ */ new Map;
function get_source_map(file) {
  if (source_maps.has(file))
    return source_maps.get(file);
  try {
    let source;
    let directory = path.dirname(file);
    const code = fs.readFileSync(file, "utf8");
    const url2 = Array.from(code.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)).at(-1)?.[1];
    if (url2?.startsWith("data:")) {
      const comma = url2.indexOf(",");
      const metadata = url2.slice(5, comma);
      const data = url2.slice(comma + 1);
      source = metadata.endsWith(";base64") ? Buffer.from(data, "base64").toString() : decodeURIComponent(data);
    } else {
      const map_file = url2 ? path.resolve(path.dirname(file), decodeURIComponent(url2)) : `${file}.map`;
      if (fs.existsSync(map_file)) {
        directory = path.dirname(map_file);
        source = fs.readFileSync(map_file, "utf8");
      }
    }
    if (source) {
      const source_map = {
        map: new module.SourceMap(JSON.parse(source)),
        directory
      };
      source_maps.set(file, source_map);
      return source_map;
    }
  } catch {}
  source_maps.set(file, null);
  return null;
}
function trace(file, line, column) {
  const source_map = get_source_map(file);
  if (!source_map)
    return null;
  const entry = source_map.map.findEntry(line, column);
  if (entry && "originalSource" in entry && entry.originalSource && typeof entry.originalLine === "number" && typeof entry.originalColumn === "number") {
    const traced = {
      file: entry.originalSource.startsWith("file:") ? url.fileURLToPath(entry.originalSource) : path.resolve(source_map.directory, entry.originalSource),
      line: entry.originalLine + 1,
      column: entry.originalColumn + 1
    };
    return trace(traced.file, traced.line - 1, traced.column - 1) ?? traced;
  }
  let regions = source_regions.get(file);
  if (!regions) {
    let source2;
    regions = fs.readFileSync(file, "utf8").split(`
`).map((line2) => {
      const start = line2.match(/^\/\/#region (.+)$/);
      if (start)
        source2 = start[1];
      if (line2 === "//#endregion")
        source2 = undefined;
      return source2;
    });
    source_regions.set(file, regions);
  }
  const source = regions[line];
  if (source)
    return { file: source };
  return null;
}
var styleText = globalThis.process?.getBuiltinModule?.("node:util")?.styleText ?? ((_format, text2) => text2);
var read_implementation = false;
var manifest = false;
var options$1 = false;
var hooks = false;
function set_read_implementation(fn) {
  read_implementation = fn;
}
function set_manifest(value) {
  manifest = value;
}
function set_options(value) {
  options$1 = value;
}
function set_hooks(value) {
  hooks = value;
}
var prerendering = false;
var error_template_default = ({ status, message }) => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>` + message + `</title>

		<style>
			body {
				--bg: white;
				--fg: #222;
				--divider: #ccc;
				background: var(--bg);
				color: var(--fg);
				font-family:
					system-ui,
					-apple-system,
					BlinkMacSystemFont,
					'Segoe UI',
					Roboto,
					Oxygen,
					Ubuntu,
					Cantarell,
					'Open Sans',
					'Helvetica Neue',
					sans-serif;
				display: flex;
				align-items: center;
				justify-content: center;
				height: 100vh;
				margin: 0;
			}

			.error {
				display: flex;
				align-items: center;
				max-width: 32rem;
				margin: 0 1rem;
			}

			.status {
				font-weight: 200;
				font-size: 3rem;
				line-height: 1;
				position: relative;
				top: -0.05rem;
			}

			.message {
				border-left: 1px solid var(--divider);
				padding: 0 0 0 1rem;
				margin: 0 0 0 1rem;
				min-height: 2.5rem;
				display: flex;
				align-items: center;
			}

			.message h1 {
				font-weight: 400;
				font-size: 1em;
				margin: 0;
			}

			@media (prefers-color-scheme: dark) {
				body {
					--bg: #222;
					--fg: #ddd;
					--divider: #666;
				}
			}
		</style>
	</head>
	<body>
		<div class="error">
			<span class="status">` + status + `</span>
			<div class="message">
				<h1>` + message + `</h1>
			</div>
		</div>
	</body>
</html>
`;
var options = {
  app_template_contains_nonce: false,
  csp: {
    mode: "auto",
    directives: {
      "upgrade-insecure-requests": false,
      "block-all-mixed-content": false
    },
    reportOnly: {
      "upgrade-insecure-requests": false,
      "block-all-mixed-content": false
    }
  },
  csrf_trusted_origins: [],
  service_worker_options: undefined,
  templates: {
    app: ({ head, body, assets: assets2, nonce, env }) => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="text-scale" content="scale" />
		` + head + `
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">` + body + `</div>
	</body>
</html>
`,
    error: error_template_default
  }
};
async function get_hooks() {
  let handle;
  let handleFetch;
  let handleError;
  let init;
  let reroute;
  let transport;
  return {
    handle,
    handleFetch,
    handleError,
    init,
    reroute,
    transport
  };
}
function resolve(id, params) {
  let resolved;
  if (id[0] === "/") {
    if (id.includes("[") && !params)
      throw new Error(`Missing params for dynamic route ID ${id}`);
    resolved = resolve_route(id, params ?? {});
  } else
    resolved = "/" + id;
  {
    const store = try_get_request_store();
    if (store && !store.state.prerendering?.fallback)
      return ((store.event.isDataRequest ? add_data_suffix2(store.event.url.pathname) : store.event.url.pathname).slice(0).split("/").slice(2).map(() => "..").join("/") || ".") + resolved;
  }
  return "" + resolved;
}

export { Redirect, SvelteKitError, ValidationError, get_request_store, with_request_store, init_remote_functions, otel, record_span, merge_tracing, error, isRedirect, text, noop, once, disallow_on_server, text_encoder2 as text_encoder, stream_from_iterable, stream_text, get_relative_path, base64_encode, ENDPOINT_METHODS, MUTATIVE_METHODS2 as MUTATIVE_METHODS, BODY_DEPENDENT_METHODS2 as BODY_DEPENDENT_METHODS, PAGE_METHODS, IN_WEBCONTAINER2 as IN_WEBCONTAINER, REROUTED_URL_HEADER, assets, app_dir, find_route, resolve$1, relative_pathname, normalize_path, decode_pathname, make_trackable, disable_search, has_data_suffix2 as has_data_suffix, add_data_suffix2 as add_data_suffix, strip_data_suffix2 as strip_data_suffix, has_resolution_suffix2 as has_resolution_suffix, add_resolution_suffix2 as add_resolution_suffix, strip_resolution_suffix2 as strip_resolution_suffix, set_nested_value, parse_form_key, deep_set, normalize_issue, flatten_issues, create_field_proxy, negotiate, is_form_content_type, uneval2 as uneval, encoders, has_custom_transporters, init_transport, fetch_cache_url, INVALIDATED_PARAM, TRAILING_SLASH_PARAM, stringify_remote_arg, create_remote_key, normalize_error, get_status, escape_html, handle_fatal_error, handle_error_and_jsonify, static_error_page, method_not_allowed, redirect_response, with_version_header, clarify_devalue_error, serialize_uses, has_prerendered_path, get_node_type, is_action_json_request, handle_action_json_request, action_json_redirect, is_action_request, handle_action_request, uneval_action_response, handle_remote_call, collect_remote_data, handle_remote_form_post, get_remote_id, get_remote_action, read_implementation, manifest, options$1, hooks, set_read_implementation, set_manifest, set_options, set_hooks, prerendering, options, get_hooks, resolve };

//# debugId=F25CCDD6B625D32564756E2164756E21
