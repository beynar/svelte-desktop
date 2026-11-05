// @bun
import {
  BODY_DEPENDENT_METHODS,
  ENDPOINT_METHODS,
  INVALIDATED_PARAM,
  IN_WEBCONTAINER,
  PAGE_METHODS,
  REROUTED_URL_HEADER,
  Redirect,
  SvelteKitError,
  TRAILING_SLASH_PARAM,
  action_json_redirect,
  add_data_suffix,
  add_resolution_suffix,
  app_dir,
  assets,
  base64_encode,
  clarify_devalue_error,
  collect_remote_data,
  decode_pathname,
  disable_search,
  disallow_on_server,
  encoders,
  escape_html,
  fetch_cache_url,
  find_route,
  get_hooks,
  get_node_type,
  get_relative_path,
  get_remote_action,
  get_remote_id,
  get_status,
  handle_action_json_request,
  handle_action_request,
  handle_error_and_jsonify,
  handle_fatal_error,
  handle_remote_call,
  handle_remote_form_post,
  has_custom_transporters,
  has_data_suffix,
  has_prerendered_path,
  has_resolution_suffix,
  hooks,
  init_transport,
  isRedirect,
  is_action_json_request,
  is_action_request,
  is_form_content_type,
  make_trackable,
  manifest,
  merge_tracing,
  method_not_allowed,
  negotiate,
  noop,
  normalize_error,
  normalize_path,
  once,
  options,
  options$1,
  otel,
  read_implementation,
  record_span,
  redirect_response,
  relative_pathname,
  resolve$1,
  serialize_uses,
  set_hooks,
  set_manifest,
  set_options,
  set_read_implementation,
  static_error_page,
  stream_from_iterable,
  stream_text,
  strip_data_suffix,
  strip_resolution_suffix,
  text,
  text_encoder,
  uneval as uneval2,
  uneval_action_response,
  with_request_store,
  with_version_header
} from "./server/chunks/index-ekdhm16k.js";
import {
  derived,
  escape_html as escape_html2,
  render
} from "./server/chunks/index-g45m2085.js";
import {
  stringify,
  uneval
} from "./server/chunks/index-p8d9cnqj.js";
import {
  __require
} from "./server/chunks/index-ygjk2325.js";

// node_modules/@sveltejs/adapter-bun/src/index.js
import fs from "fs";
import process2 from "process";

// node_modules/@sveltejs/adapter-bun/src/options.js
var options_default = {};

// .svelte-kit/output/server/manifest.js
var app_dir2 = "_app";
var base = "/";
var embed = false;
var env_prefix = "";
var origin = undefined;

// node_modules/@sveltejs/adapter-bun/src/routes-util.js
import path from "path";
import { fileURLToPath } from "url";
var dir = path.dirname(fileURLToPath(import.meta.url));
function resolve_file(subdir, filename) {
  return embed ? filename : path.resolve(dir, subdir, filename);
}
var CONTENT_ENCODING = { br: "br", gz: "gzip" };
var ESCAPED_PATH_CHAR = /[\u0000-\u001f\u007f-\u{10ffff} "#<>?`{}%\\]/gu;
function encode_pathname(pathname) {
  return pathname.replace(ESCAPED_PATH_CHAR, (char) => encodeURIComponent(char));
}
function route_paths(pathname) {
  const minimal = encode_pathname(pathname);
  const full = pathname.split("/").map(encodeURIComponent).join("/");
  return minimal === full ? [minimal] : [minimal, full];
}
function to_paths(url) {
  return route_paths(path.posix.join(base, url));
}
function to_directory_paths(url) {
  const directory = `${path.posix.join(base, url).replace(/\/$/, "")}/`;
  const paths = route_paths(directory);
  if (directory !== "/") {
    paths.push(...route_paths(directory.slice(0, -1)));
  }
  return paths;
}
function is_fresh(request, etag, mtime) {
  const header = request.headers.get("if-none-match");
  if (header !== null) {
    return header.split(",").some((value) => ["*", etag].includes(value.trim().replace(/^W\//, "")));
  }
  const since = Date.parse(request.headers.get("if-modified-since") ?? "");
  return Number.isFinite(since) && Math.trunc(mtime / 1000) <= Math.trunc(since / 1000);
}
function negotiate2(accept, meta) {
  if (accept === null || !meta.br && !meta.gz)
    return null;
  const accepted = new Set;
  for (const part of accept.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (params.some((param) => /^q=0(\.0*)?$/.test(param.trim())))
      continue;
    accepted.add(name.trim());
  }
  if (meta.br && (accepted.has("br") || accepted.has("*")))
    return "br";
  if (meta.gz && (accepted.has("gzip") || accepted.has("*")))
    return "gz";
  return null;
}
function route_entries(paths, route) {
  return paths.map((route_path) => [route_path, route]);
}
function file_route(file, meta, extra_headers = {}) {
  const content_type = Bun.file(file).type;
  const last_modified = new Date(meta.mtime).toUTCString();
  const handler = (request) => {
    const encoding = request.headers.get("range") === null ? negotiate2(request.headers.get("accept-encoding"), meta) : null;
    const etag = encoding === null ? `"${meta.hash}"` : `"${meta.hash}-${encoding}"`;
    const response_headers = {
      "content-type": content_type,
      ...extra_headers,
      etag,
      "last-modified": last_modified
    };
    if (meta.br || meta.gz)
      response_headers["vary"] = "accept-encoding";
    if (is_fresh(request, etag, meta.mtime)) {
      return new Response(null, { status: 304, headers: response_headers });
    }
    let body_file = file;
    if (encoding !== null) {
      response_headers["content-encoding"] = CONTENT_ENCODING[encoding];
      body_file = `${file}.${encoding}`;
    }
    return new Response(Bun.file(body_file), { headers: response_headers });
  };
  return { GET: handler };
}
function client_asset(url, filename = url, meta) {
  const immutable = url.startsWith(`${app_dir2}/immutable/`);
  const route = file_route(resolve_file("client", filename), meta, immutable ? { "cache-control": "public,max-age=31536000,immutable" } : {});
  const paths = to_paths(url);
  if (url.endsWith("/index.html") || url === "index.html") {
    paths.push(...to_directory_paths(url.slice(0, -"index.html".length)));
  } else if (url.endsWith(".html")) {
    paths.push(...to_paths(url.slice(0, -".html".length)));
  }
  return route_entries(paths, route);
}

// node_modules/@sveltejs/adapter-bun/src/routes.js
var routes = Object.fromEntries([
  ...client_asset("robots.txt", undefined, { hash: "1c7d763ae7035203", mtime: 1789244386757 }),
  ...client_asset("_app/version.json", undefined, { hash: "ea856d87cfdd6794", mtime: 1789244386757 }),
  ...client_asset("_app/immutable/nodes/2.DcnjIMyu.js", undefined, { hash: "5894c0236a7744b2", mtime: 1789244386758 }),
  ...client_asset("_app/immutable/nodes/3.B_nc_2wI.js", undefined, { hash: "581d4d6e3ea0d4b6", mtime: 1789244386758 }),
  ...client_asset("_app/immutable/nodes/1.BkNXo6Uq.js", undefined, { hash: "d53e6b43c8731d7a", mtime: 1789244386758 }),
  ...client_asset("_app/immutable/nodes/0.D7vHRuuD.js", undefined, { hash: "2a8581bb9a766572", mtime: 1789244386758 }),
  ...client_asset("_app/immutable/entry/payload.DSmR2FwN.js", undefined, { hash: "63f597fe584aedcd", mtime: 1789244386758 }),
  ...client_asset("_app/immutable/entry/app.-S7c7anB.js", undefined, { hash: "67b539408ad1aaa8", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/entry/start.ClB3ytoR.js", undefined, { hash: "a6126aec63438d38", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/CsWHYyEQ.js", undefined, { hash: "77f8025dad5c6e26", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/Bjy-W4x2.js", undefined, { hash: "566098d43927cea6", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/Bq9QSwnx.js", undefined, { hash: "5666d394f2e09ccf", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/B9YORNkk.js", undefined, { hash: "1913da80ae49bb24", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/BBF8RMid.js", undefined, { hash: "b876164e34a3cca4", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/DYPZcoGe.js", undefined, { hash: "bd178856fe22a26b", mtime: 1789244386759 }),
  ...client_asset("_app/immutable/chunks/CpSOaVEa.js", undefined, { hash: "b35580191454bd53", mtime: 1789244386760 }),
  ...client_asset("_app/immutable/chunks/OhUZcmHJ.js", undefined, { hash: "291f8c272567d4d6", mtime: 1789244386760 })
].reverse());
var server_assets = new Map([]);

// .svelte-kit/output/server/env.js
var explicit_public_env = {};
var rendered_env = {};

// node_modules/cookie/dist/index.js
var cookieNameRegExp = /^[\u0021-\u003A\u003C\u003E-\u007E]+$/;
var cookieValueRegExp = /^[\u0021-\u003A\u003C-\u007E]*$/;
var domainValueRegExp = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
var pathValueRegExp = /^[\u0020-\u003A\u003D-\u007E]*$/;
var maxAgeRegExp = /^-?\d+$/;
var cookieOctetRegExp = /^[!#$&'()*+\-.\/0-9:<=>?@A-Z[\]\^_`a-z{|}~]*$/;
var NullObject = /* @__PURE__ */ (() => {
  const C = function() {};
  C.prototype = Object.create(null);
  return C;
})();
function parseCookie(str, options2) {
  const obj = new NullObject;
  const len = str.length;
  if (len < 2)
    return obj;
  const dec = options2?.decode || decode;
  let index = 0;
  do {
    const eqIdx = eqIndex(str, index, len);
    if (eqIdx === len)
      break;
    const endIdx = endIndex(str, index, len);
    if (eqIdx > endIdx) {
      index = str.lastIndexOf(";", eqIdx - 1) + 1;
      continue;
    }
    const key = valueSlice(str, index, eqIdx);
    if (obj[key] === undefined) {
      obj[key] = dec(valueSlice(str, eqIdx + 1, endIdx));
    }
    index = endIdx + 1;
  } while (index < len);
  return obj;
}
function stringifySetCookie(cookie, options2) {
  const enc = options2?.encode || defaultEncode;
  if (!cookieNameRegExp.test(cookie.name)) {
    throw new TypeError(`argument name is invalid: ${cookie.name}`);
  }
  const value = cookie.value == null ? "" : enc(cookie.value);
  if (!cookieValueRegExp.test(value)) {
    throw new TypeError(`argument val is invalid: ${cookie.value}`);
  }
  let str = cookie.name + "=" + value;
  if (cookie.maxAge !== undefined) {
    if (!Number.isInteger(cookie.maxAge)) {
      throw new TypeError(`option maxAge is invalid: ${cookie.maxAge}`);
    }
    str += "; Max-Age=" + cookie.maxAge;
  }
  if (cookie.domain) {
    if (!domainValueRegExp.test(cookie.domain)) {
      throw new TypeError(`option domain is invalid: ${cookie.domain}`);
    }
    str += "; Domain=" + cookie.domain;
  }
  if (cookie.path) {
    if (!pathValueRegExp.test(cookie.path)) {
      throw new TypeError(`option path is invalid: ${cookie.path}`);
    }
    str += "; Path=" + cookie.path;
  }
  if (cookie.expires) {
    if (!Number.isFinite(cookie.expires.valueOf())) {
      throw new TypeError(`option expires is invalid: ${cookie.expires}`);
    }
    str += "; Expires=" + cookie.expires.toUTCString();
  }
  if (cookie.httpOnly) {
    str += "; HttpOnly";
  }
  if (cookie.secure) {
    str += "; Secure";
  }
  if (cookie.partitioned) {
    str += "; Partitioned";
  }
  if (cookie.priority) {
    const priority = typeof cookie.priority === "string" ? cookie.priority.toLowerCase() : undefined;
    switch (priority) {
      case "low":
        str += "; Priority=Low";
        break;
      case "medium":
        str += "; Priority=Medium";
        break;
      case "high":
        str += "; Priority=High";
        break;
      default:
        throw new TypeError(`option priority is invalid: ${cookie.priority}`);
    }
  }
  if (cookie.sameSite) {
    const sameSite = typeof cookie.sameSite === "string" ? cookie.sameSite.toLowerCase() : cookie.sameSite;
    switch (sameSite) {
      case true:
      case "strict":
        str += "; SameSite=Strict";
        break;
      case "lax":
        str += "; SameSite=Lax";
        break;
      case "none":
        str += "; SameSite=None";
        break;
      default:
        throw new TypeError(`option sameSite is invalid: ${cookie.sameSite}`);
    }
  }
  return str;
}
function parseSetCookie(str, options2) {
  const dec = options2?.decode || decode;
  const len = str.length;
  const endIdx = endIndex(str, 0, len);
  let eqIdx = eqIndex(str, 0, len);
  const setCookie = eqIdx < endIdx ? {
    name: valueSlice(str, 0, eqIdx),
    value: dec(valueSlice(str, eqIdx + 1, endIdx))
  } : { name: "", value: dec(valueSlice(str, 0, endIdx)) };
  let index = endIdx + 1;
  while (index < len) {
    const endIdx2 = endIndex(str, index, len);
    if (eqIdx < index)
      eqIdx = eqIndex(str, index, len);
    const attr = eqIdx < endIdx2 ? valueSlice(str, index, eqIdx) : valueSlice(str, index, endIdx2);
    const val = eqIdx < endIdx2 ? valueSlice(str, eqIdx + 1, endIdx2) : undefined;
    switch (attr.toLowerCase()) {
      case "httponly":
        setCookie.httpOnly = true;
        break;
      case "secure":
        setCookie.secure = true;
        break;
      case "partitioned":
        setCookie.partitioned = true;
        break;
      case "domain":
        setCookie.domain = val;
        break;
      case "path":
        setCookie.path = val;
        break;
      case "max-age":
        if (val && maxAgeRegExp.test(val))
          setCookie.maxAge = Number(val);
        break;
      case "expires":
        if (!val)
          break;
        const date = new Date(val);
        if (Number.isFinite(date.valueOf()))
          setCookie.expires = date;
        break;
      case "priority":
        if (!val)
          break;
        const priority = val.toLowerCase();
        if (priority === "low" || priority === "medium" || priority === "high") {
          setCookie.priority = priority;
        }
        break;
      case "samesite":
        if (!val)
          break;
        const sameSite = val.toLowerCase();
        if (sameSite === "lax" || sameSite === "strict" || sameSite === "none") {
          setCookie.sameSite = sameSite;
        }
        break;
    }
    index = endIdx2 + 1;
  }
  return setCookie;
}
function endIndex(str, min, len) {
  const index = str.indexOf(";", min);
  return index === -1 ? len : index;
}
function eqIndex(str, min, len) {
  const index = str.indexOf("=", min);
  return index === -1 ? len : index;
}
function valueSlice(str, min, max) {
  if (min === max)
    return "";
  let start = min;
  let end = max;
  do {
    const code = str.charCodeAt(start);
    if (code !== 32 && code !== 9)
      break;
  } while (++start < end);
  while (end > start) {
    const code = str.charCodeAt(end - 1);
    if (code !== 32 && code !== 9)
      break;
    end--;
  }
  return str.slice(start, end);
}
function decode(str) {
  if (str.indexOf("%") === -1)
    return str;
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}
function defaultEncode(str) {
  return cookieOctetRegExp.test(str) ? str : encodeURIComponent(str);
}

// .svelte-kit/output/server/index.js
var s = JSON.stringify;
async function render_endpoint(event, state, mod) {
  const method = event.request.method;
  let handler = mod[method] || mod.fallback;
  if (method === "HEAD" && !mod.HEAD && mod.GET)
    handler = mod.GET;
  if (!handler)
    return method_not_allowed(mod, method);
  const prerender = mod.prerender ?? state.prerender_default;
  if (prerender && BODY_DEPENDENT_METHODS.some((method2) => mod[method2]))
    throw new Error("Cannot prerender endpoints with body-dependent methods");
  if (state.prerendering && !state.prerendering.inside_reroute && !prerender) {
    if (state.depth > 0)
      throw new Error(`${event.route.id} is not prerenderable`);
    else
      return new Response(undefined, { status: 204 });
  }
  try {
    const response = await with_request_store({
      event,
      state
    }, () => handler(event));
    if (!(response instanceof Response))
      throw new Error(`Invalid response from route ${event.url.pathname}: handler should return a Response object`);
    if (state.prerendering && (!state.prerendering.inside_reroute || prerender)) {
      const cloned = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
      cloned.headers.set("x-sveltekit-prerender", String(prerender));
      if (state.prerendering.inside_reroute && prerender) {
        cloned.headers.set("x-sveltekit-routeid", encodeURI(event.route.id));
        state.prerendering.dependencies.set(event.url.pathname, {
          response: cloned,
          body: null
        });
      } else
        return cloned;
    }
    return response;
  } catch (e) {
    if (e instanceof Redirect)
      return new Response(undefined, {
        status: e.status,
        headers: { location: e.location }
      });
    throw e;
  }
}
function is_endpoint_request(event) {
  const { method, headers } = event.request;
  if (ENDPOINT_METHODS.includes(method) && !PAGE_METHODS.includes(method))
    return true;
  if (method === "POST" && headers.get("x-sveltekit-action") === "true")
    return false;
  const accept = event.request.headers.get("accept") ?? "*/*";
  return negotiate(accept, ["*", "text/html"]) !== "text/html";
}
function compact(arr) {
  return arr.filter((val) => val != null);
}
var ROUTES_PREFIX = "/routes";
function route_id_resolution_pathname(route_id) {
  return add_resolution_suffix(`/${app_dir}${ROUTES_PREFIX}${route_id === "/" ? "" : route_id}`);
}
function is_route_id_resolution_path(pathname) {
  const prefix = `/${app_dir}${ROUTES_PREFIX}`;
  return pathname === prefix || pathname.startsWith(prefix + "/");
}
function extract_route_id(pathname) {
  return pathname.slice(`/_app${ROUTES_PREFIX}`.length) || "/";
}
function build_error_chain(branch, errors, load) {
  const chain = [undefined];
  let last_idx = -1;
  for (let i = 1;i < branch.length; i += 1) {
    if (!branch[i])
      continue;
    let j = i - 1;
    while (j > last_idx + 1 && errors[j] == null)
      j -= 1;
    last_idx = j;
    const error = errors[j];
    chain.push(error == null ? undefined : load(error)?.catch(() => {
      return;
    }));
  }
  return Promise.all(chain);
}
function* nearest_error_pages(i, branch, errors) {
  while (i--) {
    const error = errors[i];
    if (error != null) {
      let j = i;
      while (!branch[j])
        j -= 1;
      yield {
        error,
        idx: j + 1
      };
    }
  }
}
function create_async_iterator() {
  let resolved = -1;
  const deferred = [];
  return {
    async* iterate(transform = (x) => x) {
      for (let i = 0;i < deferred.length; i += 1)
        yield transform(await deferred[i].promise);
    },
    add: (promise) => {
      const next = Promise.withResolvers();
      next.promise.catch(noop);
      deferred.push(next);
      promise.then((value) => {
        deferred[++resolved].resolve(value);
      }, (error) => {
        deferred[++resolved].reject(error);
      });
    }
  };
}
function server_data_serializer(event, state) {
  let promise_id = 1;
  let max_nodes = -1;
  const iterator = create_async_iterator();
  const global = "__sveltekit_1ffbhg2";
  function get_replacer(index) {
    return function replacer(thing) {
      if (typeof thing?.then === "function") {
        const id = promise_id++;
        const promise = thing.then((data) => ({ data })).catch(async (error) => ({ error: await handle_error_and_jsonify(event, state, error) })).then(async ({ data, error }) => {
          let str;
          try {
            str = uneval(error ? [, error] : [data], replacer);
          } catch (e) {
            error = await handle_error_and_jsonify(event, state, new Error(`Failed to serialize promise while rendering ${event.route.id}`, { cause: e }));
            str = uneval([, error], replacer);
          }
          return {
            index,
            str: `${global}.resolve(${id}, ${str.includes("app.decode") ? `(app) => ${str}` : `() => ${str}`})`
          };
        });
        iterator.add(promise);
        return `${global}.defer(${id})`;
      } else
        for (const key in encoders) {
          const encoded = encoders[key](thing);
          if (encoded)
            return `app.decode('${key}', ${uneval(encoded, replacer)})`;
        }
    };
  }
  const strings = [];
  return {
    set_max_nodes(i) {
      max_nodes = i;
    },
    add_node(i, node) {
      try {
        if (!node) {
          strings[i] = "null";
          return;
        }
        const payload = {
          type: "data",
          data: node.data,
          uses: serialize_uses(node)
        };
        if (node.slash)
          payload.slash = node.slash;
        strings[i] = uneval(payload, get_replacer(i));
      } catch (e) {
        e.path = e.path.slice(1);
        throw new Error(clarify_devalue_error(event, e), { cause: e });
      }
    },
    get_data(csp) {
      const open = `<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>`;
      const close = `</script>
`;
      return {
        data: `[${compact(max_nodes > -1 ? strings.slice(0, max_nodes) : strings).join(",")}]`,
        chunks: promise_id > 1 ? iterator.iterate(({ index, str }) => {
          if (max_nodes > -1 && index >= max_nodes)
            return "";
          return open + str + close;
        }) : null
      };
    }
  };
}
function server_data_serializer_json(event, state) {
  let promise_id = 1;
  const iterator = create_async_iterator();
  const reducers = {
    ...encoders,
    Promise: (thing) => {
      if (typeof thing?.then !== "function")
        return;
      const id = promise_id++;
      let key = "data";
      const promise = thing.catch(async (e) => {
        key = "error";
        return handle_error_and_jsonify(event, state, e);
      }).then(async (value) => {
        let str;
        try {
          str = stringify(value, reducers);
        } catch (e) {
          const error = await handle_error_and_jsonify(event, state, new Error(`Failed to serialize promise while rendering ${event.route.id}`, { cause: e }));
          key = "error";
          str = stringify(error, reducers);
        }
        return `{"type":"chunk","id":${id},"${key}":${str}}
`;
      });
      iterator.add(promise);
      return id;
    }
  };
  const strings = [];
  return {
    add_node(i, node) {
      try {
        if (!node) {
          strings[i] = "null";
          return;
        }
        if (node.type === "error" || node.type === "skip") {
          strings[i] = JSON.stringify(node);
          return;
        }
        strings[i] = `{"type":"data","data":${stringify(node.data, reducers)},"uses":${JSON.stringify(serialize_uses(node))}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ""}}`;
      } catch (e) {
        e.path = "data" + e.path;
        throw new Error(clarify_devalue_error(event, e), { cause: e });
      }
    },
    get_data() {
      return {
        data: `{"type":"data","nodes":[${strings.join(",")}]}
`,
        chunks: promise_id > 1 ? iterator.iterate() : null
      };
    }
  };
}
var NULL_BODY_STATUS = [
  101,
  103,
  204,
  205,
  304
];
async function load_server_data({ event, state, node, parent }) {
  if (!node?.server)
    return null;
  let is_tracking = true;
  const uses = {
    dependencies: /* @__PURE__ */ new Set,
    params: /* @__PURE__ */ new Set,
    parent: false,
    route: false,
    url: false,
    search_params: /* @__PURE__ */ new Set
  };
  const load = node.server.load;
  const slash = node.server.trailingSlash;
  if (!load)
    return {
      type: "data",
      data: null,
      uses,
      slash
    };
  const url = make_trackable(event.url, () => {
    if (is_tracking)
      uses.url = true;
  }, (param) => {
    if (is_tracking)
      uses.search_params.add(param);
  });
  if (state.prerendering || state.prerender_default === true)
    disable_search(url);
  return {
    type: "data",
    data: await record_span({
      name: "sveltekit.load",
      attributes: {
        "sveltekit.load.node_id": node.server_id || "unknown",
        "sveltekit.load.node_type": get_node_type(node.server_id),
        "sveltekit.load.environment": "server",
        "http.route": event.route.id || "unknown"
      },
      fn: async (current) => {
        const traced_event = merge_tracing(event, current);
        return await with_request_store({
          event: traced_event,
          state
        }, () => load.call(null, {
          ...traced_event,
          fetch: (info, init) => {
            new URL(info instanceof Request ? info.url : info, event.url);
            return event.fetch(info, init);
          },
          depends: (...deps) => {
            for (const dep of deps) {
              const { href } = new URL(dep, event.url);
              uses.dependencies.add(href);
            }
          },
          params: new Proxy(event.params, { get: (target, key) => {
            if (is_tracking)
              uses.params.add(key);
            return target[key];
          } }),
          parent: async () => {
            if (is_tracking)
              uses.parent = true;
            return parent();
          },
          route: new Proxy(event.route, { get: (target, key) => {
            if (is_tracking)
              uses.route = true;
            return target[key];
          } }),
          url,
          untrack(fn) {
            is_tracking = false;
            try {
              return fn();
            } finally {
              is_tracking = true;
            }
          }
        }));
      }
    }) ?? null,
    uses,
    slash
  };
}
async function load_data({ event, state, fetched, node, parent, server_data_promise, resolve_opts, csr }) {
  const server_data_node = await server_data_promise;
  const load = node?.universal?.load;
  if (!load)
    return server_data_node?.data ?? null;
  return await record_span({
    name: "sveltekit.load",
    attributes: {
      "sveltekit.load.node_id": node.universal_id || "unknown",
      "sveltekit.load.node_type": get_node_type(node.universal_id),
      "sveltekit.load.environment": "server",
      "http.route": event.route.id || "unknown"
    },
    fn: async (current) => {
      const traced_event = merge_tracing(event, current);
      return await with_request_store({
        event: traced_event,
        state
      }, () => load.call(null, {
        url: event.url,
        params: event.params,
        data: server_data_node?.data ?? null,
        route: event.route,
        fetch: create_universal_fetch(event, state.prerendering, fetched, csr, resolve_opts),
        setHeaders: event.setHeaders,
        depends: noop,
        parent,
        untrack: (fn) => fn(),
        tracing: traced_event.tracing
      }));
    }
  }) ?? null;
}
function create_universal_fetch(event, prerendering, fetched, csr, resolve_opts) {
  const universal_fetch = async (input, init) => {
    const cloned_body = input instanceof Request && input.body ? input.clone().body : null;
    const cloned_headers = input instanceof Request && [...input.headers].length ? new Headers(input.headers) : init?.headers;
    let response = await event.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input, event.url);
    const same_origin = url.origin === event.url.origin;
    let dependency;
    if (same_origin) {
      if (prerendering) {
        dependency = {
          response,
          body: null
        };
        prerendering.dependencies.set(url.pathname, dependency);
      }
    } else if (url.protocol === "https:" || url.protocol === "http:") {
      if ((input instanceof Request ? input.mode : init?.mode ?? "cors") === "no-cors")
        response = new Response("", {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      else {
        const acao = response.headers.get("access-control-allow-origin");
        if (!acao || acao !== event.url.origin && acao !== "*")
          throw new Error(`CORS error: ${acao ? "Incorrect" : "No"} 'Access-Control-Allow-Origin' header is present on the requested resource`);
      }
    }
    let teed_body;
    const proxy = new Proxy(response, { get(response2, key, receiver) {
      async function push_fetched(body, is_b64) {
        const status_number = Number(response2.status);
        if (isNaN(status_number))
          throw new Error(`response.status is not a number. value: "${response2.status}" type: ${typeof response2.status}`);
        const request_body = input instanceof Request && cloned_body ? await new Response(cloned_body).text() : init?.body;
        if (request_body && typeof request_body !== "string" && !ArrayBuffer.isView(request_body))
          return;
        fetched.push({
          url: fetch_cache_url(url, event.url),
          method: event.request.method,
          request_body,
          request_headers: cloned_headers,
          response_body: body,
          response: response2,
          is_b64
        });
      }
      if (key === "body") {
        if (response2.body === null)
          return null;
        if (teed_body)
          return teed_body;
        const [a, b] = response2.body.tee();
        (async () => {
          const result = new Uint8Array(await new Response(a).arrayBuffer());
          if (dependency)
            dependency.body = new Uint8Array(result);
          push_fetched(base64_encode(result), true);
        })().catch(noop);
        return teed_body = b;
      }
      if (key === "arrayBuffer")
        return async () => {
          const buffer = await response2.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          if (dependency)
            dependency.body = bytes;
          if (buffer instanceof ArrayBuffer)
            await push_fetched(base64_encode(bytes), true);
          return buffer;
        };
      async function text2() {
        const body = await response2.text();
        if (body === "" && NULL_BODY_STATUS.includes(response2.status)) {
          await push_fetched(undefined, false);
          return;
        }
        if (!body || typeof body === "string")
          await push_fetched(body, false);
        if (dependency)
          dependency.body = body;
        return body;
      }
      if (key === "text")
        return text2;
      if (key === "json")
        return async () => {
          const body = await text2();
          return body ? JSON.parse(body) : undefined;
        };
      const value = Reflect.get(response2, key, response2);
      if (value instanceof Function)
        return Object.defineProperties(function() {
          return Reflect.apply(value, this === receiver ? response2 : this, arguments);
        }, {
          name: { value: value.name },
          length: { value: value.length }
        });
      return value;
    } });
    if (csr) {
      const get = response.headers.get;
      response.headers.get = (key) => {
        const lower = key.toLowerCase();
        const value = get.call(response.headers, lower);
        if (value && !lower.startsWith("x-sveltekit-")) {
          if (!resolve_opts.filterSerializedResponseHeaders(lower, value))
            throw new Error(`Failed to get response header "${lower}" \u2014 it must be included by the \`filterSerializedResponseHeaders\` option: https://svelte.dev/docs/kit/hooks#handle (at ${event.route.id})`);
        }
        return value;
      };
      const get_set_cookie = response.headers.getSetCookie;
      response.headers.getSetCookie = () => {
        const values = get_set_cookie.call(response.headers);
        for (const value of values)
          if (!resolve_opts.filterSerializedResponseHeaders("set-cookie", value))
            throw new Error(`Failed to get response header "set-cookie" \u2014 it must be included by the \`filterSerializedResponseHeaders\` option: https://svelte.dev/docs/kit/hooks#handle (at ${event.route.id})`);
        return values;
      };
    }
    return proxy;
  };
  return (input, init) => {
    const response = universal_fetch(input, init);
    response.catch(noop);
    return response;
  };
}
function hash(...values) {
  let hash2 = 5381;
  for (const value of values)
    if (typeof value === "string") {
      let i = value.length;
      while (i)
        hash2 = hash2 * 33 ^ value.charCodeAt(--i);
    } else if (ArrayBuffer.isView(value)) {
      const buffer = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let i = buffer.length;
      while (i)
        hash2 = hash2 * 33 ^ buffer[--i];
    } else
      throw new TypeError("value must be a string or TypedArray");
  return (hash2 >>> 0).toString(36);
}
function hash_request(headers, body) {
  const values = [];
  if (headers)
    values.push([...new Headers(headers)].join(","));
  if (body)
    values.push(body);
  return hash(...values);
}
var replacements = {
  "<": "\\u003C",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029"
};
var pattern = new RegExp(`[${Object.keys(replacements).join("")}]`, "g");
function serialize_data(fetched, filter, prerendering = false) {
  const headers = {};
  let cache_control = null;
  let age = null;
  let varyAny = false;
  for (const [key, value] of fetched.response.headers) {
    if (filter(key, value))
      headers[key] = value;
    if (key === "cache-control")
      cache_control = value;
    else if (key === "age")
      age = value;
    else if (key === "vary" && value.trim() === "*")
      varyAny = true;
  }
  const payload = {
    status: fetched.response.status,
    statusText: fetched.response.statusText,
    headers,
    body: fetched.response_body
  };
  const safe_payload = JSON.stringify(payload).replace(pattern, (match) => replacements[match]);
  const attrs = [
    'type="application/json"',
    "data-sveltekit-fetched",
    `data-url="${escape_html(fetched.url, true)}"`
  ];
  if (fetched.is_b64)
    attrs.push("data-b64");
  if (fetched.request_headers || fetched.request_body)
    attrs.push(`data-hash="${hash_request(fetched.request_headers, fetched.request_body)}"`);
  if (!prerendering && fetched.method === "GET" && cache_control && !varyAny) {
    const match = /s-maxage=(\d+)/g.exec(cache_control) ?? /max-age=(\d+)/g.exec(cache_control);
    if (match) {
      const ttl = +match[1] - +(age ?? "0");
      attrs.push(`data-ttl="${ttl}"`);
    }
  }
  return `<script ${attrs.join(" ")}>${safe_payload}</script>`;
}
function sha256(data) {
  if (!key[0])
    precompute();
  const out = init.slice(0);
  const array = encode(data);
  for (let i = 0;i < array.length; i += 16) {
    const w = array.subarray(i, i + 16);
    let tmp;
    let a;
    let b;
    let out0 = out[0];
    let out1 = out[1];
    let out2 = out[2];
    let out3 = out[3];
    let out4 = out[4];
    let out5 = out[5];
    let out6 = out[6];
    let out7 = out[7];
    for (let i2 = 0;i2 < 64; i2++) {
      if (i2 < 16)
        tmp = w[i2];
      else {
        a = w[i2 + 1 & 15];
        b = w[i2 + 14 & 15];
        tmp = w[i2 & 15] = (a >>> 7 ^ a >>> 18 ^ a >>> 3 ^ a << 25 ^ a << 14) + (b >>> 17 ^ b >>> 19 ^ b >>> 10 ^ b << 15 ^ b << 13) + w[i2 & 15] + w[i2 + 9 & 15] | 0;
      }
      tmp = tmp + out7 + (out4 >>> 6 ^ out4 >>> 11 ^ out4 >>> 25 ^ out4 << 26 ^ out4 << 21 ^ out4 << 7) + (out6 ^ out4 & (out5 ^ out6)) + key[i2];
      out7 = out6;
      out6 = out5;
      out5 = out4;
      out4 = out3 + tmp | 0;
      out3 = out2;
      out2 = out1;
      out1 = out0;
      out0 = tmp + (out1 & out2 ^ out3 & (out1 ^ out2)) + (out1 >>> 2 ^ out1 >>> 13 ^ out1 >>> 22 ^ out1 << 30 ^ out1 << 19 ^ out1 << 10) | 0;
    }
    out[0] = out[0] + out0 | 0;
    out[1] = out[1] + out1 | 0;
    out[2] = out[2] + out2 | 0;
    out[3] = out[3] + out3 | 0;
    out[4] = out[4] + out4 | 0;
    out[5] = out[5] + out5 | 0;
    out[6] = out[6] + out6 | 0;
    out[7] = out[7] + out7 | 0;
  }
  const bytes = new Uint8Array(out.buffer);
  reverse_endianness(bytes);
  return base64_encode(bytes);
}
var init = /* @__PURE__ */ new Uint32Array(8);
var key = /* @__PURE__ */ new Uint32Array(64);
function precompute() {
  function frac(x) {
    return (x - Math.floor(x)) * 4294967296;
  }
  let prime = 2;
  for (let i = 0;i < 64; prime++) {
    let is_prime = true;
    for (let factor = 2;factor * factor <= prime; factor++)
      if (prime % factor === 0) {
        is_prime = false;
        break;
      }
    if (is_prime) {
      if (i < 8)
        init[i] = frac(prime ** (1 / 2));
      key[i] = frac(prime ** (1 / 3));
      i++;
    }
  }
}
function reverse_endianness(bytes) {
  for (let i = 0;i < bytes.length; i += 4) {
    const a = bytes[i + 0];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const d = bytes[i + 3];
    bytes[i + 0] = d;
    bytes[i + 1] = c;
    bytes[i + 2] = b;
    bytes[i + 3] = a;
  }
}
function encode(str) {
  const encoded = text_encoder.encode(str);
  const length = encoded.length * 8;
  const size = 512 * Math.ceil((length + 65) / 512);
  const bytes = new Uint8Array(size / 8);
  bytes.set(encoded);
  bytes[encoded.length] = 128;
  reverse_endianness(bytes);
  const words = new Uint32Array(bytes.buffer);
  words[words.length - 2] = Math.floor(length / 4294967296);
  words[words.length - 1] = length;
  return words;
}
var array = /* @__PURE__ */ new Uint8Array(16);
function generate_nonce() {
  crypto.getRandomValues(array);
  return base64_encode(array);
}
var quoted = /* @__PURE__ */ new Set([
  "self",
  "unsafe-eval",
  "unsafe-hashes",
  "unsafe-inline",
  "none",
  "strict-dynamic",
  "report-sample",
  "wasm-unsafe-eval",
  "script"
]);
var crypto_pattern = /^(nonce|sha\d\d\d)-/;
var BaseProvider = class {
  #use_hashes;
  #script_needs_csp;
  #script_src_needs_csp;
  #script_src_elem_needs_csp;
  #style_needs_csp;
  #style_src_needs_csp;
  #style_src_attr_needs_csp;
  #style_src_elem_needs_csp;
  #directives;
  #script_src = /* @__PURE__ */ new Set;
  #script_src_elem = /* @__PURE__ */ new Set;
  #style_src = /* @__PURE__ */ new Set;
  #style_src_attr = /* @__PURE__ */ new Set;
  #style_src_elem = /* @__PURE__ */ new Set;
  script_needs_nonce;
  style_needs_nonce;
  script_needs_hash;
  #nonce;
  constructor(use_hashes, directives, nonce) {
    this.#use_hashes = use_hashes;
    this.#directives = directives;
    const d = this.#directives;
    const effective_script_src = d["script-src"] || d["default-src"];
    const script_src_elem = d["script-src-elem"];
    const effective_style_src = d["style-src"] || d["default-src"];
    const style_src_attr = d["style-src-attr"];
    const style_src_elem = d["style-src-elem"];
    const style_needs_csp = (directive) => !!directive && !directive.some((value) => value === "unsafe-inline");
    const script_needs_csp = (directive) => !!directive && (!directive.some((value) => value === "unsafe-inline") || directive.some((value) => value === "strict-dynamic"));
    this.#script_src_needs_csp = script_needs_csp(effective_script_src);
    this.#script_src_elem_needs_csp = script_needs_csp(script_src_elem);
    this.#style_src_needs_csp = style_needs_csp(effective_style_src);
    this.#style_src_attr_needs_csp = style_needs_csp(style_src_attr);
    this.#style_src_elem_needs_csp = style_needs_csp(style_src_elem);
    this.#script_needs_csp = this.#script_src_needs_csp || this.#script_src_elem_needs_csp;
    this.#style_needs_csp = this.#style_src_needs_csp || this.#style_src_attr_needs_csp || this.#style_src_elem_needs_csp;
    this.script_needs_nonce = this.#script_needs_csp && !this.#use_hashes;
    this.style_needs_nonce = this.#style_needs_csp && !this.#use_hashes;
    this.script_needs_hash = this.#script_needs_csp && this.#use_hashes;
    this.#nonce = nonce;
  }
  #get_source(content) {
    return this.#use_hashes ? `sha256-${sha256(content)}` : `nonce-${this.#nonce}`;
  }
  #add_script_source(source) {
    if (this.#script_src_needs_csp)
      this.#script_src.add(source);
    if (this.#script_src_elem_needs_csp)
      this.#script_src_elem.add(source);
  }
  add_script(content) {
    if (!this.#script_needs_csp)
      return;
    this.#add_script_source(this.#get_source(content));
  }
  add_script_hashes(hashes) {
    for (const hash2 of hashes)
      this.#add_script_source(hash2);
  }
  add_style(content) {
    if (!this.#style_needs_csp)
      return;
    const source = this.#get_source(content);
    if (this.#style_src_needs_csp)
      this.#style_src.add(source);
    if (this.#style_src_attr_needs_csp)
      this.#style_src_attr.add(source);
    if (this.#style_src_elem_needs_csp) {
      const sha256_empty_comment_hash = "sha256-9OlNO0DNEeaVzHL4RZwCLsBHA8WBQ8toBp/4F5XV2nc=";
      const d = this.#directives;
      if (d["style-src-elem"] && !d["style-src-elem"].includes(sha256_empty_comment_hash) && !this.#style_src_elem.has(sha256_empty_comment_hash))
        this.#style_src_elem.add(sha256_empty_comment_hash);
      if (source !== sha256_empty_comment_hash)
        this.#style_src_elem.add(source);
    }
  }
  get_header(is_meta = false) {
    const header = [];
    const directives = { ...this.#directives };
    const merge_sources = (key2, sources, base2) => {
      if (sources.size > 0)
        directives[key2] = [...base2 || [], ...sources];
    };
    merge_sources("style-src", this.#style_src, directives["style-src"] || directives["default-src"]);
    merge_sources("style-src-attr", this.#style_src_attr, directives["style-src-attr"]);
    merge_sources("style-src-elem", this.#style_src_elem, directives["style-src-elem"]);
    merge_sources("script-src", this.#script_src, directives["script-src"] || directives["default-src"]);
    merge_sources("script-src-elem", this.#script_src_elem, directives["script-src-elem"]);
    for (const key2 in directives) {
      if (is_meta && (key2 === "frame-ancestors" || key2 === "report-uri" || key2 === "sandbox"))
        continue;
      const value = directives[key2];
      if (!value)
        continue;
      const directive = [key2];
      if (Array.isArray(value))
        for (const source of value)
          directive.push(quoted.has(source) || crypto_pattern.test(source) ? `'${source}'` : source);
      header.push(directive.join(" "));
    }
    return header.join("; ");
  }
};
var CspProvider = class extends BaseProvider {
  get_meta() {
    const content = this.get_header(true);
    if (!content)
      return;
    return `<meta http-equiv="content-security-policy" content="${escape_html(content, true)}">`;
  }
};
var CspReportOnlyProvider = class extends BaseProvider {
  constructor(use_hashes, directives, nonce) {
    super(use_hashes, directives, nonce);
    if (Object.values(directives).some((v) => !!v) && !directives["report-to"]?.length && !directives["report-uri"]?.length)
      throw Error("`content-security-policy-report-only` must be specified with either the `report-to` or `report-uri` directives, or both");
  }
};
var Csp = class {
  nonce = generate_nonce();
  csp_provider;
  report_only_provider;
  constructor({ mode, directives, reportOnly }, { prerender }) {
    const use_hashes = mode === "hash" || mode === "auto" && prerender;
    this.csp_provider = new CspProvider(use_hashes, directives, this.nonce);
    this.report_only_provider = new CspReportOnlyProvider(use_hashes, reportOnly, this.nonce);
  }
  get script_needs_hash() {
    return this.csp_provider.script_needs_hash || this.report_only_provider.script_needs_hash;
  }
  get script_needs_nonce() {
    return this.csp_provider.script_needs_nonce || this.report_only_provider.script_needs_nonce;
  }
  get style_needs_nonce() {
    return this.csp_provider.style_needs_nonce || this.report_only_provider.style_needs_nonce;
  }
  add_script(content) {
    this.csp_provider.add_script(content);
    this.report_only_provider.add_script(content);
  }
  add_script_hashes(hashes) {
    this.csp_provider.add_script_hashes(hashes);
    this.report_only_provider.add_script_hashes(hashes);
  }
  add_style(content) {
    this.csp_provider.add_style(content);
    this.report_only_provider.add_style(content);
  }
};
function generate_route_object(route, url, client) {
  const { errors, layouts, leaf } = route;
  const nodes = [
    ...errors,
    ...layouts.map((l) => l?.[1]),
    leaf[1]
  ].filter((n) => typeof n === "number").map((n) => `'${n}': () => ${create_client_import(client.nodes?.[n], url)}`).join(`,
		`);
  return [
    `{
	id: ${s(route.id)}`,
    `errors: ${s(route.errors)}`,
    `layouts: ${s(route.layouts)}`,
    `leaf: ${s(route.leaf)}`,
    `nodes: {
		${nodes}
	}
}`
  ].join(`,
	`);
}
function create_client_import(import_path, url) {
  if (!import_path)
    return "Promise.resolve({})";
  if (assets !== "" && import_path[0] !== "/")
    return `import('${assets}/${import_path}')`;
  const absolute = import_path[0] === "/" ? import_path : `/${import_path}`;
  let path2 = get_relative_path(url.pathname, absolute);
  if (path2[0] !== ".")
    path2 = `./${path2}`;
  return `import('${path2}')`;
}
async function resolve_route(resolved_path, url) {
  if (!manifest.client?.routes)
    return text("Server-side route resolution disabled", { status: 400 });
  try {
    const matchers = await manifest.matchers();
    const result = find_route(resolved_path, manifest.client.routes, matchers);
    return create_server_routing_response(result?.route ?? null, result?.params ?? {}, url, manifest.client).response;
  } catch {
    return text("Error resolving route", { status: 500 });
  }
}
function resolve_route_by_id(route_id, url) {
  if (!manifest.client?.routes)
    return text("Server-side route resolution disabled", { status: 400 });
  try {
    const route = manifest.client.routes.find((r) => r.id === route_id);
    if (route)
      return create_server_routing_response(route, null, url, manifest.client).response;
    if (manifest.routes.some((r) => r.id === route_id && !r.page))
      return text("export const endpoint_only = true;", { headers: js_headers() });
    return create_server_routing_response(null, null, url, manifest.client).response;
  } catch {
    return text("Error resolving route", { status: 500 });
  }
}
function js_headers() {
  return new Headers({ "content-type": "application/javascript; charset=utf-8" });
}
function create_server_routing_response(route, params, url, client) {
  const headers = js_headers();
  let body = "";
  if (route) {
    const csr_route = generate_route_object(route, url, client);
    body = `${create_css_import(route, url, client)}export const route = ${csr_route};`;
    if (params !== null)
      body += `
export const params = ${JSON.stringify(params)}`;
  }
  return {
    response: text(body, { headers }),
    body
  };
}
function create_css_import(route, url, client) {
  const { errors, layouts, leaf } = route;
  let css = "";
  for (const node of [
    ...errors,
    ...layouts.map((l) => l?.[1]),
    leaf[1]
  ]) {
    if (typeof node !== "number")
      continue;
    const node_css = client.css?.[node];
    for (const css_path of node_css ?? [])
      css += `'${assets || ""}/${css_path}',`;
  }
  if (!css)
    return "";
  return `${create_client_import(client.start, url)}.then(x => x.load_css([${css}]));
`;
}
var afterNavigate = noop;
disallow_on_server("disableScrollHandling", "()");
disallow_on_server("goto");
disallow_on_server("invalidate");
disallow_on_server("invalidateAll", "()");
disallow_on_server("refreshAll", "()");
disallow_on_server("preloadCode");
disallow_on_server("preloadData");
disallow_on_server("pushState");
disallow_on_server("replaceState");
function Root($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const { page, components, onerror, tree, form, error } = $$props;
    let mounted = false;
    let navigated = false;
    let title = "";
    afterNavigate(() => {
      if (mounted) {
        navigated = true;
        title = document.title || "untitled page";
      } else
        mounted = true;
    });
    function node($$renderer3, n, depth) {
      const Component = derived(() => n.component);
      const Error2 = derived(() => n.error);
      const data = derived(() => n.data);
      function failed($$renderer4, error2) {
        if (Error2()) {
          $$renderer4.push("<!--[-->");
          Error2()($$renderer4, { error: error2 });
          $$renderer4.push("<!--]-->");
        } else {
          $$renderer4.push("<!--[!-->");
          $$renderer4.push("<!--]-->");
        }
      }
      $$renderer3.boundary({ failed: Error2() ? failed : undefined }, ($$renderer4) => {
        $$renderer4.push(`<!--[-->`);
        if (n.child) {
          $$renderer4.push("<!--[0-->");
          if (Component()) {
            $$renderer4.push("<!--[-->");
            Component()($$renderer4, {
              data: data(),
              form,
              params: page.params,
              children: ($$renderer5) => {
                node($$renderer5, n.child, depth + 1);
              },
              $$slots: { default: true }
            });
            $$renderer4.push("<!--]-->");
          } else {
            $$renderer4.push("<!--[!-->");
            $$renderer4.push("<!--]-->");
          }
        } else {
          $$renderer4.push("<!--[-1-->");
          if (Component()) {
            $$renderer4.push("<!--[-->");
            Component()($$renderer4, {
              data: data(),
              form,
              params: page.params,
              error
            });
            $$renderer4.push("<!--]-->");
          } else {
            $$renderer4.push("<!--[!-->");
            $$renderer4.push("<!--]-->");
          }
        }
        $$renderer4.push(`<!--]-->`);
        $$renderer4.push(`<!--]-->`);
      });
    }
    node($$renderer2, tree, 0);
    $$renderer2.push(`<!----> `);
    if (mounted) {
      $$renderer2.push(`<!--[0--><div id="svelte-announcer" aria-live="assertive" aria-atomic="true" style="position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px">`);
      if (navigated)
        $$renderer2.push(`<!--[0-->${escape_html2(title)}`);
      else
        $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<!--]--></div>`);
    } else
      $$renderer2.push("<!--[-1-->");
    $$renderer2.push(`<!--]-->`);
  });
}
var Props = class {
  page;
  components = [];
  form;
  error;
  tree;
  onerror;
  constructor({ page, tree, form, error, onerror = noop }) {
    this.page = page;
    this.tree = tree;
    this.onerror = onerror;
    this.form = form;
    this.error = error;
  }
};
var RenderNode = class {
  component;
  error;
  data = {};
  child;
  constructor(component, error) {
    this.component = component;
    this.error = error;
  }
};
async function render_response({ branch, fetched, page_config, status, error = null, event, state, resolve_opts, action_result, data_serializer, error_components }) {
  if (state.prerendering || state.prerender_default === true) {
    if (options$1.csp.mode === "nonce")
      throw new Error('Cannot use prerendering if config.csp.mode === "nonce"');
    if (options$1.app_template_contains_nonce)
      throw new Error("Cannot use prerendering if page template contains %sveltekit.nonce%");
  }
  const client = manifest.client;
  const modulepreloads = new Set(client?.imports);
  const stylesheets = new Set(client?.stylesheets);
  const fonts = new Map(client?.fonts.map((font) => [font.file, font]));
  const inline_styles = /* @__PURE__ */ new Map;
  let rendered;
  const form_value = action_result?.type === "success" || action_result?.type === "failure" ? action_result.data ?? null : null;
  let base2 = "";
  let assets$1 = assets;
  let base_expression = s("");
  const csp = new Csp(options$1.csp, { prerender: !!(state.prerendering || state.prerender_default === true) });
  if (!state.prerendering?.fallback) {
    base2 = (event.isDataRequest ? add_data_suffix(event.url.pathname) : event.url.pathname).slice(0).split("/").slice(2).map(() => "..").join("/") || ".";
    base_expression = `new URL(${s(base2)}, location).pathname.slice(0, -1)`;
    if (!assets || assets[0] === "/" && assets !== "/_svelte_kit_assets")
      assets$1 = base2;
  }
  if (page_config.ssr) {
    const props = new Props({
      page: {
        error,
        params: event.params,
        route: event.route,
        status,
        url: event.url,
        data: {},
        form: form_value,
        shallow: null,
        state: {}
      },
      tree: new RenderNode(await branch[0].node.component?.(), undefined),
      form: form_value,
      error: error ?? undefined
    });
    let current_node = props.tree;
    let data2 = props.page.data;
    for (let i = 0;i < branch.length; i += 1) {
      const node = branch[i];
      data2 = {
        ...data2,
        ...node.data
      };
      current_node.data = data2;
      if (i < branch.length - 1)
        current_node = current_node.child = new RenderNode(await branch[i + 1].node.component?.(), error_components?.[i + 1]);
    }
    props.page.data = data2;
    const render_state = {
      ...state,
      is_in_render: true
    };
    const render_opts = {
      context: /* @__PURE__ */ new Map([["__request__", { page: props.page }]]),
      csp: csp.script_needs_nonce ? { nonce: csp.nonce } : { hash: csp.script_needs_hash },
      transformError: error_components ? (e) => {
        if (isRedirect(e))
          throw e;
        const handled = handle_error_and_jsonify(event, render_state, e);
        if (handled instanceof Promise)
          return handled.then((e2) => {
            error = e2;
            props.page.error = error;
            props.page.status = status = error.status;
            return error;
          });
        error = handled;
        props.page.error = error;
        props.page.status = status = error.status;
        return error;
      } : undefined
    };
    globalThis.fetch;
    try {
      rendered = await with_request_store({
        event,
        state: render_state
      }, async () => {
        return render(Root, {
          ...render_opts,
          props
        });
      });
      if (rendered.hashes)
        csp.add_script_hashes(rendered.hashes.script);
    } finally {}
  } else
    rendered = {
      head: "",
      body: "",
      hashes: { script: [] }
    };
  for (const { node } of branch) {
    for (const url of node.imports)
      modulepreloads.add(url);
    for (const url of node.stylesheets)
      stylesheets.add(url);
    for (const font of node.fonts)
      fonts.set(font.file, font);
    if (node.inline_styles && !client?.inline)
      Object.entries(await node.inline_styles()).forEach(([filename, css]) => {
        if (typeof css === "string") {
          inline_styles.set(filename, css);
          return;
        }
        inline_styles.set(filename, css(`${assets$1}/${app_dir}/immutable/assets`, assets$1));
      });
  }
  const head = new Head(rendered.head);
  let body = rendered.body;
  const prefixed = (path2) => {
    if (path2.startsWith("/"))
      return `${base2}/${path2.slice(1)}`;
    return `${assets$1}/${path2}`;
  };
  const style = client?.inline ? client.inline?.style : Array.from(inline_styles.values()).join(`
`);
  if (style) {
    const attributes = [];
    if (csp.style_needs_nonce)
      attributes.push(`nonce="${csp.nonce}"`);
    csp.add_style(style);
    head.add_style(style, attributes);
  }
  const add_preload = (path2, attributes) => {
    head.add_link_tag(path2, attributes);
  };
  for (const dep of stylesheets) {
    const path2 = prefixed(dep);
    const attributes = ['rel="stylesheet"'];
    if (inline_styles.has(dep))
      attributes.push("disabled", 'media="(max-width: 0)"');
    head.add_stylesheet(path2, attributes);
  }
  for (const { file, filename } of fonts.values()) {
    const path2 = prefixed(file);
    if (resolve_opts.preload({
      type: "font",
      path: path2,
      filename
    }))
      add_preload(path2, [
        'rel="preload"',
        'as="font"',
        `type="font/${file.slice(file.lastIndexOf(".") + 1)}"`,
        "crossorigin"
      ]);
  }
  const global = "__sveltekit_1ffbhg2";
  const { data, chunks } = data_serializer.get_data(csp);
  if (page_config.ssr && page_config.csr)
    body += `
			${fetched.map((item) => serialize_data(item, resolve_opts.filterSerializedResponseHeaders, !!(state.prerendering || state.prerender_default === true))).join(`
			`)}`;
  if (page_config.csr && client) {
    const route = client.routes?.find((r) => r.id === event.route.id) ?? null;
    const load_env_eagerly = client.uses_env_dynamic_public && (state.prerendering || state.prerender_default === true);
    if (load_env_eagerly)
      modulepreloads.add(`${app_dir}/env.js`);
    if (!client.inline)
      for (const dep of modulepreloads) {
        const path2 = prefixed(dep);
        if (resolve_opts.preload({
          type: "js",
          path: path2
        }))
          add_preload(path2, ['rel="modulepreload"']);
      }
    if (client.routes && state.prerendering && !state.prerendering.fallback) {
      const pathname = add_resolution_suffix(event.url.pathname);
      state.prerendering.dependencies.set(pathname, create_server_routing_response(route, event.params, new URL(pathname, event.url), client));
      if (route && !state.prerendering.resolved_route_ids.has(route.id)) {
        state.prerendering.resolved_route_ids.add(route.id);
        const id_pathname = "" + route_id_resolution_pathname(route.id);
        state.prerendering.dependencies.set(id_pathname, create_server_routing_response(route, null, new URL(id_pathname, event.url), client));
      }
    }
    const blocks = [];
    const properties = [`base: ${base_expression}`, `version: ${s("1789244386078")}`];
    if (assets)
      properties.push(`assets: ${s(assets)}`);
    if (client.uses_env_dynamic_public)
      properties.push(`env: ${load_env_eagerly ? "null" : uneval(rendered_env)}`);
    if (chunks) {
      blocks.push("const deferred = new Map();");
      properties.push(`defer: (id) => new Promise((fulfil, reject) => {
							deferred.set(id, { fulfil, reject });
						})`);
      let app_declaration = "";
      if (has_custom_transporters) {
        if (client.inline)
          app_declaration = `const app = ${global}.app.app;`;
        else if (client.app)
          app_declaration = `const kit = await import(${s(prefixed(client.start))});
							kit.init(${global});
							const app = await import(${s(prefixed(client.app))});`;
        else
          app_declaration = `const { app } = await import(${s(prefixed(client.start))});`;
      }
      const prelude = app_declaration ? `${app_declaration}
							const [data, error] = fn(app);` : `const [data, error] = fn();`;
      properties.push(`resolve: async (id, fn) => {
							${prelude}

							const try_to_resolve = () => {
								if (!deferred.has(id)) {
									setTimeout(try_to_resolve, 0);
									return;
								}
								const { fulfil, reject } = deferred.get(id);
								deferred.delete(id);
								if (error) reject(error);
								else fulfil(data);
							}
							try_to_resolve();
						}`);
    }
    blocks.push(`${global} = {
						${properties.join(`,
						`)}
					};`);
    const args = ["element"];
    blocks.push("const element = document.currentScript.parentElement;");
    if (page_config.ssr) {
      const serialized = {
        form: "null",
        error: "null"
      };
      if (form_value)
        serialized.form = uneval_action_response(form_value, event.route.id);
      if (error)
        serialized.error = uneval(error);
      const hydrate = [
        `node_ids: [${branch.map(({ node }) => node.index).join(", ")}]`,
        `data: ${data}`,
        `form: ${serialized.form}`,
        `error: ${serialized.error}`
      ];
      if (status !== 200 && !error)
        hydrate.push(`status: ${status}`);
      if (client.routes) {
        if (route) {
          const stringified = generate_route_object(route, event.url, client).replaceAll(`
`, `
							`);
          hydrate.push(`params: ${uneval(event.params)}`, `server_route: ${stringified}`);
        }
      }
      const indent = "\t".repeat(load_env_eagerly ? 7 : 6);
      args.push(`{
${indent}	${hydrate.join(`,
${indent}	`)}
${indent}}`);
    }
    const remote_data = await collect_remote_data({}, event, state);
    const serialized_data = Object.keys(remote_data).length > 0 ? `${global}.data = ${uneval2(remote_data)};

						` : "";
    const boot = client.inline ? `${client.inline.script}

					${serialized_data}${global}.app.start(${args.join(", ")});` : client.app ? `import(${s(prefixed(client.start))}).then(async (kit) => {
						kit.init(${global});
						const app = await import(${s(prefixed(client.app))});
						${serialized_data}kit.start(app, ${args.join(", ")});
					});` : `import(${s(prefixed(client.start))}).then((app) => {
						${serialized_data}app.start(${args.join(", ")})
					});`;
    if (load_env_eagerly)
      blocks.push(`import(${s(`${base2}/${app_dir}/env.js`)}).then(({ env }) => {
						${global}.env = env;

						${boot.replace(/\n/g, `
	`)}
					});`);
    else
      blocks.push(boot);
    const init_app = `
				{
					${blocks.join(`

					`)}
				}
			`;
    csp.add_script(init_app);
    body += `
			<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>${init_app}</script>
		`;
  }
  const headers = new Headers({
    "x-sveltekit-page": "true",
    "content-type": "text/html"
  });
  if (state.prerendering || state.prerender_default === true) {
    const csp_headers = csp.csp_provider.get_meta();
    if (csp_headers)
      head.add_http_equiv(csp_headers);
    if (state.prerendering?.cache)
      head.add_http_equiv(`<meta http-equiv="cache-control" content="${state.prerendering.cache}">`);
  } else {
    const csp_header = csp.csp_provider.get_header();
    if (csp_header)
      headers.set("content-security-policy", csp_header);
    const report_only_header = csp.report_only_provider.get_header();
    if (report_only_header)
      headers.set("content-security-policy-report-only", report_only_header);
  }
  const html = options$1.templates.app({
    head: head.build(),
    body,
    assets: assets$1,
    nonce: csp.nonce,
    env: explicit_public_env
  });
  const transformed = await resolve_opts.transformPageChunk({
    html,
    done: true
  }) || "";
  if (!chunks)
    headers.set("etag", `"${hash(transformed)}"`);
  return chunks ? new Response(stream_text(transformed + `
`, chunks), {
    status,
    headers
  }) : text(transformed, {
    status,
    headers
  });
}
var Head = class {
  #rendered;
  #http_equiv = [];
  #link_tags = [];
  #style_tags = [];
  #stylesheet_links = [];
  constructor(rendered) {
    this.#rendered = rendered;
  }
  build() {
    return [
      ...this.#http_equiv,
      ...this.#link_tags,
      this.#rendered,
      ...this.#style_tags,
      ...this.#stylesheet_links
    ].join(`
		`);
  }
  add_style(style, attributes) {
    this.#style_tags.push(`<style${attributes.length ? " " + attributes.join(" ") : ""}>${style}</style>`);
  }
  add_stylesheet(href, attributes) {
    this.#stylesheet_links.push(`<link href="${href}" ${attributes.join(" ")}>`);
  }
  add_link_tag(href, attributes) {
    this.#link_tags.push(`<link href="${href}" ${attributes.join(" ")}>`);
  }
  add_http_equiv(tag) {
    this.#http_equiv.push(tag);
  }
};
function validator(expected) {
  function validate(module, file) {
    if (!module)
      return;
    for (const key2 in module) {
      if (key2[0] === "_" || expected.has(key2))
        continue;
      const values = [...expected.values()];
      const hint = hint_for_supported_files(key2, file?.slice(file.lastIndexOf("."))) ?? `valid exports are ${values.join(", ")}, or anything with a '_' prefix`;
      throw new Error(`Invalid export '${key2}'${file ? ` in ${file}` : ""} (${hint})`);
    }
  }
  return validate;
}
function hint_for_supported_files(key2, ext = ".js") {
  const supported_files = [];
  if (valid_layout_exports.has(key2))
    supported_files.push(`+layout${ext}`);
  if (valid_page_exports.has(key2))
    supported_files.push(`+page${ext}`);
  if (valid_layout_server_exports.has(key2))
    supported_files.push(`+layout.server${ext}`);
  if (valid_page_server_exports.has(key2))
    supported_files.push(`+page.server${ext}`);
  if (valid_server_exports.has(key2))
    supported_files.push(`+server${ext}`);
  if (supported_files.length > 0)
    return `'${key2}' is a valid export in ${supported_files.slice(0, -1).join(", ")}${supported_files.length > 1 ? " or " : ""}${supported_files.at(-1)}`;
}
var valid_layout_exports = /* @__PURE__ */ new Set([
  "load",
  "prerender",
  "csr",
  "ssr",
  "trailingSlash",
  "config"
]);
var valid_page_exports = /* @__PURE__ */ new Set([...valid_layout_exports, "entries"]);
var valid_layout_server_exports = /* @__PURE__ */ new Set([...valid_layout_exports]);
var valid_page_server_exports = /* @__PURE__ */ new Set([
  ...valid_layout_server_exports,
  "actions",
  "entries"
]);
var valid_server_exports = /* @__PURE__ */ new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "QUERY",
  "fallback",
  "prerender",
  "trailingSlash",
  "config",
  "entries"
]);
var validate_layout_exports = validator(valid_layout_exports);
var validate_page_exports = validator(valid_page_exports);
var validate_layout_server_exports = validator(valid_layout_server_exports);
var validate_page_server_exports = validator(valid_page_server_exports);
var PageNodes = class {
  data;
  constructor(nodes) {
    this.data = nodes;
  }
  layouts() {
    return this.data.slice(0, -1);
  }
  page() {
    return this.data.at(-1);
  }
  validate() {
    for (const layout of this.layouts())
      if (layout) {
        validate_layout_server_exports(layout.server, layout.server_id);
        validate_layout_exports(layout.universal, layout.universal_id);
      }
    const page = this.page();
    if (page) {
      validate_page_server_exports(page.server, page.server_id);
      validate_page_exports(page.universal, page.universal_id);
    }
  }
  #get_option(option) {
    return this.data.reduce((value, node) => {
      return node?.universal?.[option] ?? node?.server?.[option] ?? value;
    }, undefined);
  }
  csr() {
    return this.#get_option("csr") ?? true;
  }
  ssr() {
    return this.#get_option("ssr") ?? true;
  }
  prerender() {
    return this.#get_option("prerender") ?? false;
  }
  trailing_slash() {
    return this.#get_option("trailingSlash") ?? "never";
  }
  get_config() {
    let current = {};
    for (const node of this.data) {
      if (!node?.universal?.config && !node?.server?.config)
        continue;
      current = {
        ...current,
        ...node?.server?.config,
        ...node?.universal?.config
      };
    }
    return Object.keys(current).length ? current : undefined;
  }
  should_prerender_data() {
    return this.data.some((node) => node?.server?.load || node?.server?.trailingSlash !== undefined);
  }
};
async function respond_with_error({ event, state, error, resolve_opts }) {
  if (event.request.headers.get("x-sveltekit-error")) {
    const transformed = await handle_error_and_jsonify(event, state, error);
    return static_error_page(transformed.status, transformed.message);
  }
  const fetched = [];
  try {
    const branch = [];
    const default_layout = await manifest.nodes[0]();
    const nodes = new PageNodes([default_layout]);
    const ssr = nodes.ssr();
    const csr = nodes.csr();
    const data_serializer = server_data_serializer(event, state);
    const transformed = await handle_error_and_jsonify(event, state, error);
    if (ssr) {
      state.error = true;
      const server_data_promise = load_server_data({
        event,
        state,
        node: default_layout,
        parent: async () => ({})
      });
      const server_data = await server_data_promise;
      data_serializer.add_node(0, server_data);
      const data = await load_data({
        event,
        state,
        fetched,
        node: default_layout,
        parent: async () => ({}),
        resolve_opts,
        server_data_promise,
        csr
      });
      branch.push({
        node: default_layout,
        server_data,
        data
      }, {
        node: await manifest.nodes[1](),
        data: null,
        server_data: null
      });
    }
    return await render_response({
      page_config: {
        ssr,
        csr
      },
      status: transformed.status,
      error: transformed,
      branch,
      error_components: [],
      fetched,
      event,
      state,
      resolve_opts,
      data_serializer
    });
  } catch (e) {
    if (e instanceof Redirect)
      return redirect_response(e.status, e.location);
    const transformed = await handle_error_and_jsonify(event, state, e);
    return static_error_page(transformed.status, transformed.message);
  }
}
var MAX_DEPTH = 10;
async function render_page(event, state, page, nodes, resolve_opts) {
  if (state.depth > MAX_DEPTH)
    return text(`Not found: ${event.url.pathname}`, { status: 404 });
  if (is_action_json_request(event)) {
    const node = await manifest.nodes[page.leaf]();
    return handle_action_json_request(event, state, node?.server);
  }
  try {
    const leaf_node = nodes.page();
    let status = 200;
    let action_result = undefined;
    if (is_action_request(event)) {
      const remote_id = get_remote_action(event.url);
      if (remote_id)
        action_result = await handle_remote_form_post(event, state, remote_id);
      else
        action_result = await handle_action_request(event, state, leaf_node.server);
      if (action_result?.type === "redirect")
        return redirect_response(action_result.status, action_result.location);
      if (action_result?.type === "error")
        status = get_status(action_result.error);
      if (action_result?.type === "failure")
        status = action_result.status;
    }
    const should_prerender = nodes.prerender();
    if (should_prerender) {
      if (leaf_node.server?.actions)
        throw new Error("Cannot prerender pages with actions");
    } else if (state.prerendering)
      return new Response(undefined, { status: 204 });
    state.prerender_default = should_prerender;
    const should_prerender_data = nodes.should_prerender_data();
    const data_pathname = add_data_suffix(event.url.pathname);
    const fetched = [];
    const ssr = nodes.ssr();
    const csr = nodes.csr();
    if (ssr === false && !((state.prerendering || state.prerender_default === true) && should_prerender_data))
      return await render_response({
        branch: compact(nodes.data).map((node) => {
          return {
            node,
            data: null,
            server_data: null
          };
        }),
        fetched,
        page_config: {
          ssr: false,
          csr
        },
        status,
        error: null,
        event,
        state,
        resolve_opts,
        data_serializer: server_data_serializer(event, state)
      });
    const branch = [];
    let load_error = null;
    const data_serializer = server_data_serializer(event, state);
    const data_serializer_json = (state.prerendering || state.prerender_default === true) && should_prerender_data ? server_data_serializer_json(event, state) : null;
    const server_promises = nodes.data.map((node, i) => {
      if (load_error)
        throw load_error;
      return Promise.resolve().then(async () => {
        try {
          if (node === leaf_node && action_result?.type === "error")
            throw action_result.error;
          const server_data = await load_server_data({
            event,
            state,
            node,
            parent: async () => {
              const data = {};
              for (let j = 0;j < i; j += 1) {
                const parent = await server_promises[j];
                if (parent)
                  Object.assign(data, parent.data);
              }
              return data;
            }
          });
          if (node)
            data_serializer.add_node(i, server_data);
          data_serializer_json?.add_node(i, server_data);
          return server_data;
        } catch (e) {
          load_error = e;
          throw load_error;
        }
      });
    });
    const load_promises = nodes.data.map((node, i) => {
      if (load_error)
        throw load_error;
      return Promise.resolve().then(async () => {
        try {
          return await load_data({
            event,
            state,
            fetched,
            node,
            parent: async () => {
              const data = {};
              for (let j = 0;j < i; j += 1)
                Object.assign(data, await load_promises[j]);
              return data;
            },
            resolve_opts,
            server_data_promise: server_promises[i],
            csr
          });
        } catch (e) {
          load_error = e;
          throw load_error;
        }
      });
    });
    for (const p of server_promises)
      p.catch(noop);
    for (const p of load_promises)
      p.catch(noop);
    for (let i = 0;i < nodes.data.length; i += 1) {
      const node = nodes.data[i];
      if (node)
        try {
          const server_data = await server_promises[i];
          const data = await load_promises[i];
          branch.push({
            node,
            server_data,
            data
          });
        } catch (e) {
          const err = normalize_error(e);
          if (err instanceof Redirect) {
            if (state.prerendering && should_prerender_data) {
              const body = JSON.stringify({
                type: "redirect",
                status: err.status,
                location: err.location
              });
              state.prerendering.dependencies.set(data_pathname, {
                response: text(body),
                body
              });
            }
            return redirect_response(err.status, err.location);
          }
          const error = await handle_error_and_jsonify(event, state, err);
          const status2 = error.status;
          for (const { error: index, idx } of nearest_error_pages(i, branch, page.errors)) {
            const node2 = await manifest.nodes[index]();
            data_serializer.set_max_nodes(idx);
            const layouts = compact(branch.slice(0, idx));
            const nodes2 = new PageNodes(layouts.map((layout) => layout.node));
            const error_branch = layouts.concat({
              node: node2,
              data: null,
              server_data: null
            });
            return await render_response({
              event,
              state,
              resolve_opts,
              page_config: {
                ssr: nodes2.ssr(),
                csr: nodes2.csr()
              },
              status: status2,
              error,
              error_components: await load_error_components(ssr, error_branch, page),
              branch: error_branch,
              fetched,
              data_serializer
            });
          }
          return static_error_page(status2, error.message);
        }
      else
        branch.push(null);
    }
    if (state.prerendering && data_serializer_json) {
      let { data, chunks } = data_serializer_json.get_data();
      if (chunks)
        for await (const chunk of chunks)
          data += chunk;
      state.prerendering.dependencies.set(data_pathname, {
        response: text(data),
        body: data
      });
    }
    return await render_response({
      event,
      state,
      resolve_opts,
      page_config: {
        csr,
        ssr
      },
      status,
      error: null,
      branch: compact(branch),
      action_result,
      fetched,
      data_serializer: !ssr ? server_data_serializer(event, state) : data_serializer,
      error_components: await load_error_components(ssr, branch, page)
    });
  } catch (e) {
    if (e instanceof Redirect)
      return redirect_response(e.status, e.location);
    return await respond_with_error({
      event,
      state,
      error: e,
      resolve_opts
    });
  }
}
function load_error_components(ssr, branch, page) {
  if (!ssr)
    return;
  return build_error_chain(branch, page.errors, (idx) => manifest.nodes[idx]?.().then((e) => e.component?.()));
}
var mutating_form_methods = /* @__PURE__ */ new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]);
function get_self_origin(paths_origin, url_origin) {
  return paths_origin || url_origin;
}
function is_csrf_forbidden({ request, request_origin, self_origin, trusted_origins }) {
  return (!request.headers.get("content-type") || is_form_content_type(request)) && mutating_form_methods.has(request.method) && request_origin !== self_origin && (!request_origin || !trusted_origins.includes(request_origin));
}
function is_remote_forbidden({ request, request_origin, self_origin }) {
  return request.method !== "GET" && request_origin !== self_origin;
}
async function render_data(event, state, route, invalidated_data_nodes, trailing_slash) {
  if (!route.page)
    return with_version_header(new Response(undefined, { status: 404 }));
  try {
    const node_ids = [...route.page.layouts, route.page.leaf];
    const invalidated = invalidated_data_nodes ?? node_ids.map(() => true);
    let aborted = false;
    const url = new URL(event.url);
    url.pathname = normalize_path(url.pathname, trailing_slash);
    const new_event = {
      ...event,
      url
    };
    const functions = node_ids.map((n, i) => {
      return once(async () => {
        try {
          if (aborted)
            return { type: "skip" };
          const node = n == undefined ? n : await manifest.nodes[n]();
          return load_server_data({
            event: new_event,
            state,
            node,
            parent: async () => {
              const data2 = {};
              for (let j = 0;j < i; j += 1) {
                const parent = await functions[j]();
                if (parent)
                  Object.assign(data2, parent.data);
              }
              return data2;
            }
          });
        } catch (e) {
          aborted = true;
          throw e;
        }
      });
    });
    const promises = functions.map(async (fn, i) => {
      if (!invalidated[i])
        return { type: "skip" };
      return fn();
    });
    const data_serializer = server_data_serializer_json(event, state);
    await Promise.all(promises.map(async (p, i) => {
      const node = await p.catch(async (error) => {
        if (error instanceof Redirect)
          throw error;
        return {
          type: "error",
          error: await handle_error_and_jsonify(event, state, error)
        };
      });
      data_serializer.add_node(i, node);
    }));
    const { data, chunks } = data_serializer.get_data();
    if (!chunks)
      return json_response(data);
    return with_version_header(new Response(stream_text(data, chunks), { headers: {
      "content-type": "text/sveltekit-data",
      "cache-control": "private, no-store"
    } }));
  } catch (e) {
    const error = normalize_error(e);
    if (error instanceof Redirect)
      return redirect_json_response(error);
    else {
      const transformed = await handle_error_and_jsonify(event, state, error);
      return json_response(transformed, transformed.status);
    }
  }
}
function json_response(json, status = 200) {
  return with_version_header(text(typeof json === "string" ? json : JSON.stringify(json), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store"
    }
  }));
}
function redirect_json_response(redirect) {
  return json_response({
    type: "redirect",
    status: redirect.status,
    location: redirect.location
  });
}
function generate_cookie_key(domain, path2, name) {
  return `${domain || ""}${path2}?${encodeURIComponent(name)}`;
}
function get_cookies(request, url) {
  const header = request.headers.get("cookie") ?? "";
  const initial_cookies = parseCookie(header, { decode: (value) => value });
  let default_cookies;
  function parse_header(opts) {
    return opts?.decode ? parseCookie(header, opts) : default_cookies ??= parseCookie(header);
  }
  function matches_url(cookie) {
    return domain_matches(url.hostname, cookie.options.domain) && path_matches(url.pathname, cookie.options.path);
  }
  let normalized_url;
  const new_cookies = /* @__PURE__ */ new Map;
  const defaults = {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: !(url.hostname === "localhost" && url.protocol === "http:")
  };
  const cookies = {
    get(name, opts) {
      let best_match;
      for (const c of new_cookies.values())
        if (c.name === name && matches_url(c) && (!best_match || c.options.path.length > best_match.options.path.length))
          best_match = c;
      if (best_match)
        return best_match.options.maxAge === 0 ? undefined : best_match.value;
      return parse_header(opts)[name];
    },
    getAll(opts) {
      const cookies2 = { ...parse_header(opts) };
      const lookup = /* @__PURE__ */ new Map;
      for (const c of new_cookies.values())
        if (matches_url(c)) {
          const existing = lookup.get(c.name);
          if (!existing || c.options.path.length > existing.options.path.length)
            lookup.set(c.name, c);
        }
      for (const c of lookup.values())
        if (c.options.maxAge === 0)
          delete cookies2[c.name];
        else
          cookies2[c.name] = c.value;
      return Object.entries(cookies2).filter(([, value]) => value != null).map(([name, value]) => ({
        name,
        value
      }));
    },
    set(name, value, options2) {
      set_internal(name, value, {
        ...defaults,
        ...options2
      });
    },
    delete(name, options2) {
      cookies.set(name, "", {
        ...options2,
        maxAge: 0
      });
    },
    parse: parseSetCookie,
    serialize(name, value, { encode: encode2, ...options2 }) {
      let path2 = options2.path ?? "/";
      if (!options2.domain || options2.domain === url.hostname) {
        if (!normalized_url)
          throw new Error("Cannot serialize cookies until after the route is determined");
        path2 = resolve$1(normalized_url, path2);
      }
      return stringifySetCookie({
        name,
        value,
        ...defaults,
        ...options2,
        path: path2
      }, { encode: encode2 });
    }
  };
  function get_cookie_header(destination, header2) {
    const combined_cookies = { ...initial_cookies };
    for (const cookie of new_cookies.values()) {
      if (!domain_matches(destination.hostname, cookie.options.domain))
        continue;
      if (!path_matches(destination.pathname, cookie.options.path))
        continue;
      const encoder = cookie.options.encode || encodeURIComponent;
      combined_cookies[cookie.name] = encoder(cookie.value);
    }
    if (header2) {
      const parsed = parseCookie(header2, { decode: (value) => value });
      for (const name in parsed)
        combined_cookies[name] = parsed[name];
    }
    return Object.entries(combined_cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  }
  const internal_queue = [];
  function set_internal(name, value, options2) {
    if (!normalized_url) {
      internal_queue.push(() => set_internal(name, value, options2));
      return;
    }
    let path2 = options2.path ?? "/";
    if (!options2.domain || options2.domain === url.hostname)
      path2 = resolve$1(normalized_url, path2);
    const cookie_key = generate_cookie_key(options2.domain, path2, name);
    const cookie = {
      name,
      value,
      options: {
        ...options2,
        path: path2
      }
    };
    new_cookies.set(cookie_key, cookie);
  }
  function set_trailing_slash(trailing_slash) {
    normalized_url = normalize_path(url.pathname, trailing_slash);
    internal_queue.forEach((fn) => fn());
  }
  return {
    cookies,
    new_cookies,
    get_cookie_header,
    set_internal,
    set_trailing_slash
  };
}
function domain_matches(hostname, constraint) {
  if (!constraint)
    return true;
  const normalized = constraint[0] === "." ? constraint.slice(1) : constraint;
  if (hostname === normalized)
    return true;
  return hostname.endsWith("." + normalized);
}
function path_matches(path2, constraint) {
  if (!constraint)
    return true;
  const normalized = constraint.endsWith("/") ? constraint.slice(0, -1) : constraint;
  if (path2 === normalized)
    return true;
  return path2.startsWith(normalized + "/");
}
function add_cookies_to_headers(headers, cookies) {
  for (const new_cookie of cookies) {
    const { name, value, options: { encode: encode2, ...options2 } } = new_cookie;
    headers.append("set-cookie", stringifySetCookie({
      name,
      value,
      ...options2
    }, { encode: encode2 }));
    if (options2.path.endsWith(".html")) {
      const path2 = add_data_suffix(options2.path);
      headers.append("set-cookie", stringifySetCookie({
        name,
        value,
        ...options2,
        path: path2
      }, { encode: encode2 }));
    }
  }
}
function transient_fields() {
  return {
    remote: {
      data: null,
      explicit: null,
      implicit: null,
      forms: null,
      requested: null,
      ignored: null,
      batches: null,
      live_iterators: null
    },
    is_in_remote_function: false,
    is_in_remote_form_or_command: false,
    is_in_remote_query: false,
    is_in_remote_prerender: false,
    is_in_render: false
  };
}
function create_request_state(options2) {
  return {
    getClientAddress: options2.getClientAddress,
    platform: options2.platform,
    read: options2.read,
    before_handle: options2.before_handle,
    emulator: options2.emulator,
    prerendering: options2.prerendering,
    prerender_default: undefined,
    error: false,
    depth: 0,
    rerouted_url: null,
    ...transient_fields()
  };
}
function fork_state_for_subrequest(state) {
  return {
    ...state,
    ...transient_fields(),
    depth: state.depth + 1
  };
}
function create_fetch({ event, state, get_cookie_header, set_internal }) {
  const server_fetch = async (info, init2) => {
    const original_request = normalize_fetch_input(info, init2, event.url);
    let mode = (info instanceof Request ? info.mode : init2?.mode) ?? "cors";
    let credentials = (info instanceof Request ? info.credentials : init2?.credentials) ?? "same-origin";
    return hooks.handleFetch({
      event,
      request: original_request,
      fetch: async (info2, init3) => {
        const request = normalize_fetch_input(info2, init3, event.url);
        const url = new URL(request.url);
        if (!request.headers.has("origin"))
          request.headers.set("origin", event.url.origin);
        if (info2 !== original_request) {
          mode = (info2 instanceof Request ? info2.mode : init3?.mode) ?? "cors";
          credentials = (info2 instanceof Request ? info2.credentials : init3?.credentials) ?? "same-origin";
        }
        if ((request.method === "GET" || request.method === "HEAD") && (mode === "no-cors" && url.origin !== event.url.origin || url.origin === event.url.origin))
          request.headers.delete("origin");
        const decoded = decodeURIComponent(url.pathname);
        if (url.origin !== event.url.origin || "") {
          if (`.${url.hostname}`.endsWith(`.${event.url.hostname}`) && credentials !== "omit") {
            const cookie = get_cookie_header(url, request.headers.get("cookie"));
            if (cookie)
              request.headers.set("cookie", cookie);
          }
          return fetch(request);
        }
        const filename = (decoded.startsWith(assets) ? decoded.slice(assets.length) : decoded).slice(1);
        const filename_html = `${filename}/index.html`;
        const is_asset = manifest.assets.has(filename) || filename in manifest.server_assets;
        const is_asset_html = manifest.assets.has(filename_html) || filename_html in manifest.server_assets;
        if (is_asset || is_asset_html) {
          const file = is_asset ? filename : filename_html;
          if (state.read) {
            const type = is_asset ? manifest.mime_types[filename.slice(filename.lastIndexOf("."))] : "text/html";
            return new Response(state.read(file), { headers: type ? { "content-type": type } : {} });
          } else if (read_implementation && file in manifest.server_assets) {
            const length = manifest.server_assets[file];
            const type = manifest.mime_types[file.slice(file.lastIndexOf("."))];
            return new Response(read_implementation(file), { headers: {
              "Content-Length": "" + length,
              "Content-Type": type
            } });
          }
          return await fetch(request);
        }
        if (has_prerendered_path(decoded))
          return await fetch(request);
        if (credentials !== "omit") {
          const cookie = get_cookie_header(url, request.headers.get("cookie"));
          if (cookie)
            request.headers.set("cookie", cookie);
          const authorization = event.request.headers.get("authorization");
          if (authorization && !request.headers.has("authorization"))
            request.headers.set("authorization", authorization);
        }
        if (!request.headers.has("accept"))
          request.headers.set("accept", "*/*");
        const accept_language = event.request.headers.get("accept-language");
        if (accept_language && !request.headers.has("accept-language"))
          request.headers.set("accept-language", accept_language);
        const response = await internal_fetch(request, state);
        for (const str of response.headers.getSetCookie()) {
          const { name, value, ...cookie_options } = parseSetCookie(str, { decode: (v) => v });
          set_internal(name, value, {
            path: cookie_options.path ?? (url.pathname.split("/").slice(0, -1).join("/") || "/"),
            encode: (value2) => value2,
            ...cookie_options
          });
        }
        return response;
      }
    });
  };
  return (input, init2) => {
    const response = server_fetch(input, init2);
    response.catch(noop);
    return response;
  };
}
function normalize_fetch_input(info, init2, url) {
  if (info instanceof Request)
    return info;
  return new Request(typeof info === "string" ? new URL(info, url) : info, init2);
}
async function internal_fetch(request, state) {
  if (request.signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const subrequest_state = fork_state_for_subrequest(state);
  if (!request.signal)
    return await respond(request, subrequest_state);
  let remove_abort_listener = noop;
  const abort_promise = new Promise((_, reject) => {
    const on_abort = () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    request.signal.addEventListener("abort", on_abort, { once: true });
    remove_abort_listener = () => request.signal.removeEventListener("abort", on_abort);
  });
  return Promise.race([respond(request, subrequest_state), abort_promise]).finally(remove_abort_listener);
}
var payload;
var etag;
var headers;
function get_public_env(request) {
  const env = rendered_env;
  payload ??= uneval(env);
  etag ??= `W/${Date.now()}`;
  headers ??= new Headers({
    "content-type": "application/javascript; charset=utf-8",
    etag
  });
  if (request.headers.get("if-none-match") === etag)
    return new Response(undefined, {
      status: 304,
      headers
    });
  return new Response(`export const env=${payload}`, { headers });
}
var default_transform = ({ html }) => html;
var default_filter = () => false;
var default_preload = ({ type }) => type === "js" || type === "css";
var non_html_fetch_destinations = /* @__PURE__ */ new Set([
  "audio",
  "audioworklet",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt"
]);
var page_methods = /* @__PURE__ */ new Set([
  "GET",
  "HEAD",
  "POST"
]);
var allowed_page_methods = /* @__PURE__ */ new Set([
  "GET",
  "HEAD",
  "OPTIONS"
]);
var respond = propagate_context(internal_respond);
async function internal_respond(request, state) {
  const url = new URL(request.url);
  const is_route_resolution_request = has_resolution_suffix(url.pathname);
  const is_data_request = has_data_suffix(url.pathname);
  const remote_id = get_remote_id(url);
  {
    const request_origin = request.headers.get("origin");
    const self_origin = get_self_origin(undefined, url.origin);
    if (remote_id) {
      if (is_remote_forbidden({
        request,
        request_origin,
        self_origin
      }))
        return Response.json({ message: "Cross-site remote requests are forbidden" }, { status: 403 });
    } else if (is_csrf_forbidden({
      request,
      request_origin,
      self_origin,
      trusted_origins: options$1.csrf_trusted_origins
    })) {
      const message = `Cross-site ${request.method} form submissions are forbidden`;
      const opts = { status: 403 };
      if (request.headers.get("accept") === "application/json")
        return Response.json({ message }, opts);
      return text(message, opts);
    }
  }
  let invalidated_data_nodes;
  let skip_route_resolution = false;
  let is_route_id_resolution_request = false;
  if (is_route_resolution_request) {
    url.pathname = strip_resolution_suffix(url.pathname);
    is_route_id_resolution_request = is_route_id_resolution_path(url.pathname);
  } else if (is_data_request) {
    url.pathname = strip_data_suffix(url.pathname) + (url.searchParams.get("x-sveltekit-trailing-slash") === "1" ? "/" : "") || "/";
    url.searchParams.delete(TRAILING_SLASH_PARAM);
    invalidated_data_nodes = url.searchParams.get(INVALIDATED_PARAM)?.split("").map((node) => node === "1");
    url.searchParams.delete(INVALIDATED_PARAM);
  } else if (remote_id) {
    const pathname = request.headers.get("x-sveltekit-pathname");
    if (pathname === null)
      skip_route_resolution = true;
    else {
      url.pathname = pathname;
      url.search = request.headers.get("x-sveltekit-search") ?? "";
    }
  }
  const headers2 = {};
  const { cookies, new_cookies, get_cookie_header, set_internal, set_trailing_slash } = get_cookies(request, url);
  const event = {
    cookies,
    fetch: null,
    getClientAddress: state.getClientAddress || (() => {
      throw new Error(`@sveltejs/adapter-bun does not specify getClientAddress. Please raise an issue`);
    }),
    locals: {},
    params: {},
    platform: state.emulator?.platform ? await state.emulator.platform({
      config: {},
      prerender: !!state.prerendering?.fallback
    }) : state.platform,
    request,
    route: { id: null },
    setHeaders: (new_headers) => {
      for (const key2 in new_headers) {
        const lower = key2.toLowerCase();
        const value = new_headers[key2];
        if (lower === "set-cookie")
          throw new Error("Use `event.cookies.set(name, value, options)` instead of `event.setHeaders` to set cookies");
        else if (lower in headers2) {
          if (lower === "server-timing")
            headers2[lower] += ", " + value;
          else
            throw new Error(`"${key2}" header is already set`);
        } else {
          headers2[lower] = value;
          if (state.prerendering && lower === "cache-control")
            state.prerendering.cache = value;
        }
      }
    },
    url,
    isDataRequest: is_data_request,
    isSubRequest: state.depth > 0,
    isRemoteRequest: !!remote_id
  };
  event.fetch = create_fetch({
    event,
    state,
    get_cookie_header,
    set_internal
  });
  let resolved_path = url.pathname;
  if (!remote_id && !is_route_id_resolution_request) {
    const prerendering_reroute_state = state.prerendering?.inside_reroute;
    try {
      if (state.prerendering)
        state.prerendering.inside_reroute = true;
      resolved_path = await hooks.reroute({
        url: new URL(url),
        fetch: event.fetch
      }) ?? url.pathname;
      if (!manifest.routes.length && resolved_path !== url.pathname)
        state.rerouted_url = denormalise_url({
          request_url: request.url,
          resolved_path,
          is_data_request,
          is_route_resolution_request
        }).toString();
    } catch {
      return text("Internal Server Error", { status: 500 });
    } finally {
      if (state.prerendering)
        state.prerendering.inside_reroute = prerendering_reroute_state;
    }
  }
  let resolve_opts = {
    transformPageChunk: default_transform,
    filterSerializedResponseHeaders: default_filter,
    preload: default_preload
  };
  let trailing_slash = "never";
  let page_nodes;
  try {
    resolved_path = decode_pathname(resolved_path);
  } catch {
    resolved_path = null;
    return await handle();
  }
  if (resolved_path !== decode_pathname(url.pathname) && !state.prerendering?.fallback && has_prerendered_path(resolved_path)) {
    const url2 = denormalise_url({
      request_url: request.url,
      resolved_path,
      is_data_request,
      is_route_resolution_request
    });
    try {
      const response = await fetch(url2, request);
      const headers3 = new Headers(response.headers);
      if (headers3.has("content-encoding")) {
        headers3.delete("content-encoding");
        headers3.delete("content-length");
      }
      return new Response(response.body, {
        headers: headers3,
        status: response.status,
        statusText: response.statusText
      });
    } catch (error) {
      return await handle_fatal_error(event, state, error);
    }
  }
  let route = null;
  if (is_route_resolution_request) {
    if (is_route_id_resolution_request)
      return resolve_route_by_id(extract_route_id(resolved_path), new URL(request.url));
    return resolve_route(resolved_path, new URL(request.url));
  }
  if (resolved_path === `/_app/env.js`)
    return get_public_env(request);
  if (!remote_id && resolved_path.startsWith(`/_app`)) {
    const headers3 = new Headers;
    headers3.set("cache-control", "public, max-age=0, must-revalidate");
    return text("Not found", {
      status: 404,
      headers: headers3
    });
  }
  if (!state.prerendering?.fallback && !skip_route_resolution)
    try {
      const matchers = await manifest.matchers();
      const result = find_route(resolved_path, manifest.routes, matchers);
      if (result) {
        route = result.route;
        event.route = { id: route.id };
        event.params = result.params;
      }
    } catch (e) {
      return await handle_fatal_error(event, state, e);
    }
  try {
    page_nodes = route?.page ? new PageNodes(await load_page_nodes(route.page)) : undefined;
    if (route && !remote_id) {
      if (url.pathname === "" || url.pathname === "/")
        trailing_slash = "always";
      else if (page_nodes)
        trailing_slash = page_nodes.trailing_slash();
      else if (route.endpoint)
        trailing_slash = (await route.endpoint()).trailingSlash ?? "never";
      if (!is_data_request) {
        const normalized = normalize_path(url.pathname, trailing_slash);
        if (normalized !== url.pathname && !state.prerendering?.fallback)
          return new Response(undefined, {
            status: 308,
            headers: {
              "x-sveltekit-normalize": "1",
              location: relative_pathname(url.pathname, normalized) + (url.search === "?" ? "" : url.search)
            }
          });
      }
      if (state.before_handle || state.emulator?.platform) {
        let config = {};
        let prerender = false;
        if (route.endpoint) {
          const node = await route.endpoint();
          config = node.config ?? config;
          prerender = node.prerender ?? prerender;
        } else if (page_nodes) {
          config = page_nodes.get_config() ?? config;
          prerender = state.prerender_default = page_nodes.prerender();
        }
        if (state.emulator?.platform)
          event.platform = await state.emulator.platform({
            config,
            prerender
          });
        if (state.before_handle)
          return await state.before_handle(event, config, prerender, handle);
      }
    }
    return await handle();
  } catch (e) {
    if (e instanceof Redirect)
      try {
        const response = is_data_request || remote_id ? redirect_json_response(e) : route?.page && is_action_json_request(event) ? action_json_redirect(e) : redirect_response(e.status, e.location);
        add_cookies_to_headers(response.headers, new_cookies.values());
        return response;
      } catch (err) {
        return await handle_fatal_error(event, state, err);
      }
    return await handle_fatal_error(event, state, e);
  }
  async function handle() {
    set_trailing_slash(trailing_slash);
    if (state.prerendering && !state.prerendering.fallback && !state.prerendering.inside_reroute)
      disable_search(url);
    const response = await record_span({
      name: "sveltekit.handle.root",
      attributes: {
        "http.route": event.route.id || "unknown",
        "http.method": event.request.method,
        "http.url": event.url.href,
        "sveltekit.is_data_request": is_data_request,
        "sveltekit.is_sub_request": event.isSubRequest
      },
      fn: async (root_span) => {
        const traced_event = {
          ...event,
          tracing: {
            enabled: false,
            root: root_span,
            current: root_span
          }
        };
        return await with_request_store({
          event: traced_event,
          state
        }, () => hooks.handle({
          event: traced_event,
          resolve: (event2, opts) => {
            return record_span({
              name: "sveltekit.resolve",
              attributes: { "http.route": event2.route.id || "unknown" },
              fn: (resolve_span) => {
                return with_request_store(null, () => resolve(merge_tracing(event2, resolve_span), page_nodes, opts).then((response2) => {
                  for (const key2 in headers2) {
                    const value = headers2[key2];
                    response2.headers.set(key2, value);
                  }
                  add_cookies_to_headers(response2.headers, new_cookies.values());
                  if (state.prerendering && event2.route.id !== null)
                    response2.headers.set("x-sveltekit-routeid", encodeURI(event2.route.id));
                  resolve_span.setAttributes({
                    "http.response.status_code": response2.status,
                    "http.response.body.size": response2.headers.get("content-length") || "unknown"
                  });
                  return response2;
                }));
              }
            });
          }
        }));
      }
    });
    if (response.status === 200 && response.headers.has("etag")) {
      let if_none_match_value = request.headers.get("if-none-match");
      if (if_none_match_value?.startsWith('W/"'))
        if_none_match_value = if_none_match_value.substring(2);
      const etag2 = response.headers.get("etag");
      if (if_none_match_value === etag2) {
        const headers3 = new Headers({ etag: etag2 });
        for (const key2 of [
          "cache-control",
          "content-location",
          "date",
          "expires",
          "vary"
        ]) {
          const value = response.headers.get(key2);
          if (value)
            headers3.set(key2, value);
        }
        for (const cookie of response.headers.getSetCookie())
          headers3.append("set-cookie", cookie);
        return new Response(undefined, {
          status: 304,
          headers: headers3
        });
      }
    }
    if (is_data_request && response.status >= 300 && response.status <= 308) {
      const location = response.headers.get("location");
      if (location)
        return redirect_json_response(new Redirect(response.status, location));
    }
    return response;
  }
  async function resolve(event2, page_nodes2, opts) {
    try {
      if (opts)
        resolve_opts = {
          transformPageChunk: opts.transformPageChunk || default_transform,
          filterSerializedResponseHeaders: opts.filterSerializedResponseHeaders || default_filter,
          preload: opts.preload || default_preload
        };
      if (resolved_path === null)
        return await respond_with_error({
          event: event2,
          state,
          error: new SvelteKitError(400, "Malformed URI", `Failed to decode URI: ${event2.url.pathname}`),
          resolve_opts
        });
      if (state.prerendering?.fallback)
        return await render_response({
          event: event2,
          state,
          page_config: {
            ssr: false,
            csr: true
          },
          status: 200,
          error: null,
          branch: [{
            node: await manifest.nodes[0](),
            data: null,
            server_data: null
          }],
          fetched: [],
          resolve_opts,
          data_serializer: server_data_serializer(event2, state)
        });
      if (remote_id)
        return await handle_remote_call(event2, state, remote_id);
      if (route) {
        const method = event2.request.method;
        let response2;
        if (is_data_request)
          response2 = await render_data(event2, state, route, invalidated_data_nodes, trailing_slash);
        else {
          let endpoint;
          if (route.endpoint && (!route.page || !state.prerendering && is_endpoint_request(event2))) {
            endpoint = await route.endpoint();
            if (route.page && (method === "GET" || method === "HEAD" || method === "POST")) {
              if (!(method === "POST" ? !!(endpoint.POST || endpoint.fallback) : !!(endpoint.GET || endpoint.fallback || method === "HEAD" && endpoint.HEAD)))
                endpoint = undefined;
            }
          }
          if (endpoint)
            response2 = await render_endpoint(event2, state, endpoint);
          else if (route.page) {
            if (!page_nodes2)
              throw new Error("page_nodes not found. This should never happen");
            else if (page_methods.has(method))
              response2 = await render_page(event2, state, route.page, page_nodes2, resolve_opts);
            else {
              const allowed_methods = new Set(allowed_page_methods);
              if ((await manifest.nodes[route.page.leaf]())?.server?.actions)
                allowed_methods.add("POST");
              if (method === "OPTIONS")
                response2 = new Response(null, {
                  status: 204,
                  headers: { allow: Array.from(allowed_methods.values()).join(", ") }
                });
              else {
                const mod = [...allowed_methods].reduce((acc, curr) => {
                  acc[curr] = true;
                  return acc;
                }, {});
                response2 = method_not_allowed(mod, method);
              }
            }
          } else
            throw new Error("Route is neither page nor endpoint. This should never happen");
        }
        if ((request.method === "GET" || request.method === "HEAD") && route.page && route.endpoint) {
          const vary = response2.headers.get("vary")?.split(",")?.map((v) => v.trim().toLowerCase());
          if (!(vary?.includes("accept") || vary?.includes("*"))) {
            response2 = new Response(response2.body, {
              status: response2.status,
              statusText: response2.statusText,
              headers: new Headers(response2.headers)
            });
            response2.headers.append("Vary", "Accept");
          }
        }
        return response2;
      }
      if (state.error && event2.isSubRequest) {
        const headers3 = new Headers(request.headers);
        headers3.set("x-sveltekit-error", "true");
        return await fetch(request, { headers: headers3 });
      }
      if (state.error)
        return text("Internal Server Error", { status: 500 });
      if (state.depth === 0) {
        if (!state.prerendering && is_data_request && invalidated_data_nodes?.length === 1 && invalidated_data_nodes[0])
          return await render_data(event2, state, { page: {
            layouts: [],
            leaf: 0
          } }, invalidated_data_nodes, "ignore");
        if (non_html_fetch_destinations.has(event2.request.headers.get("sec-fetch-dest") ?? ""))
          return text("Not Found", {
            status: 404,
            headers: { vary: "Sec-Fetch-Dest" }
          });
        return await respond_with_error({
          event: event2,
          state,
          error: new SvelteKitError(404, "Not Found", `Not found: ${event2.url.pathname}`),
          resolve_opts
        });
      }
      if (state.prerendering)
        return text("not found", { status: 404 });
      const response = await fetch(request);
      return new Response(response.body, response);
    } catch (e) {
      return await handle_fatal_error(event2, state, e);
    } finally {
      event2.cookies.set = () => {
        throw new Error("Cannot use `cookies.set(...)` after the response has been generated");
      };
      event2.setHeaders = () => {
        throw new Error("Cannot use `setHeaders(...)` after the response has been generated");
      };
    }
  }
}
function load_page_nodes(page) {
  return Promise.all([...page.layouts.map((n) => n == undefined ? n : manifest.nodes[n]()), manifest.nodes[page.leaf]()]);
}
function propagate_context(fn) {
  return async (req, ...rest) => {
    if (otel === null)
      return fn(req, ...rest);
    const { propagation, context } = await otel;
    const c = propagation.extract(context.active(), Object.fromEntries(req.headers));
    return context.with(c, async () => {
      return await fn(req, ...rest);
    });
  };
}
function denormalise_url({ request_url, resolved_path, is_data_request, is_route_resolution_request }) {
  const url = new URL(request_url);
  url.pathname = is_data_request ? add_data_suffix(resolved_path) : is_route_resolution_request ? add_resolution_suffix(resolved_path) : resolved_path;
  return url;
}
set_options(options);
var init_promise;
var current = null;
var Server = class {
  constructor(manifest2) {
    if (IN_WEBCONTAINER) {
      const respond2 = this.respond.bind(this);
      this.respond = async (...args) => {
        const { promise, resolve } = Promise.withResolvers();
        const previous = current;
        current = promise;
        await previous;
        return respond2(...args).finally(resolve);
      };
    }
    set_manifest(manifest2);
  }
  async init({ env, read }) {
    if (read) {
      const wrapped_read = (file) => {
        const result = read(file);
        if (result instanceof ReadableStream)
          return result;
        return stream_from_iterable(async function* () {
          const stream = await result;
          if (stream)
            yield* stream;
        }());
      };
      set_read_implementation(wrapped_read);
    }
    await (init_promise ??= (async () => {
      try {
        const module = await get_hooks();
        set_hooks({
          handle: module.handle || (({ event, resolve }) => resolve(event)),
          handleError: module.handleError || (({ kind, error, issues }) => {
            if (kind === "validation") {
              console.error("Remote function schema validation failed:", issues);
              return;
            }
            if (kind !== "unknown")
              return;
            let e = error;
            while (e instanceof Error) {
              if (e.stack)
                console.error(e.stack);
              e = e.cause;
            }
            if (e)
              console.error(String(e));
          }),
          handleFetch: module.handleFetch || (({ request, fetch: fetch2 }) => fetch2(request)),
          reroute: module.reroute || noop
        });
        init_transport(module.transport ?? {});
        if (module.init)
          await module.init();
      } catch (e) {
        throw e;
      }
    })());
  }
  async respond(request, options2) {
    const request_state = create_request_state(options2);
    const response = await respond(request, request_state);
    if (request_state.rerouted_url)
      response.headers.set(REROUTED_URL_HEADER, request_state.rerouted_url);
    if (request.method === "HEAD" && response.body !== null) {
      response.body.cancel().catch(noop);
      return new Response(null, response);
    }
    return response;
  }
};

// .svelte-kit/bun-tmp/server.js
var manifest2 = (() => {
  function __memo(fn) {
    let value;
    return () => value ??= value = fn();
  }
  return {
    app_dir: "_app",
    app_path: "_app",
    assets: new Set(["robots.txt"]),
    mime_types: { ".txt": "text/plain" },
    client: { start: "_app/immutable/entry/start.ClB3ytoR.js", app: "_app/immutable/entry/app.-S7c7anB.js", imports: ["_app/immutable/entry/start.ClB3ytoR.js", "_app/immutable/entry/payload.DSmR2FwN.js", "_app/immutable/chunks/Bq9QSwnx.js", "_app/immutable/chunks/DYPZcoGe.js", "_app/immutable/chunks/CpSOaVEa.js", "_app/immutable/chunks/OhUZcmHJ.js", "_app/immutable/chunks/BBF8RMid.js", "_app/immutable/chunks/B9YORNkk.js", "_app/immutable/entry/app.-S7c7anB.js"], stylesheets: [], fonts: [], uses_env_dynamic_public: false },
    nodes: [
      __memo(() => import("./server/chunks/0-czkhkppt.js")),
      __memo(() => import("./server/chunks/1-1ype8agd.js")),
      __memo(() => import("./server/chunks/2-aw3kk5n0.js")),
      __memo(() => import("./server/chunks/3-9a57d8re.js"))
    ],
    remotes: {
      "19aeq9f": __memo(() => import("./server/chunks/remote-19aeq9f-zzgknk8v.js"))
    },
    routes: [
      {
        id: "/",
        pattern: /^\/$/,
        params: [],
        page: { layouts: [0], errors: [1], leaf: 2 },
        endpoint: null
      },
      {
        id: "/about",
        pattern: /^\/about\/?$/,
        params: [],
        page: { layouts: [0], errors: [1], leaf: 3 },
        endpoint: null
      }
    ],
    prerendered_routes: new Set([]),
    matchers: async () => {
      return {};
    },
    server_assets: {}
  };
})();
var server = new Server(manifest2);

// node_modules/@sveltejs/adapter-bun/src/env.js
import process from "process";
var expected = new Set([
  "SOCKET_PATH",
  "HOST",
  "PORT",
  "REUSE_PORT",
  "IPV6_ONLY",
  "CONNECTION_IDLE_TIMEOUT",
  "BODY_SIZE_LIMIT",
  "SHUTDOWN_TIMEOUT",
  "DEVELOPMENT",
  "XFF_DEPTH",
  "ADDRESS_HEADER",
  "PROTOCOL_HEADER",
  "HOST_HEADER",
  "PORT_HEADER"
]);
if (env_prefix) {
  for (const name in process.env) {
    if (name.startsWith(env_prefix) && !expected.has(name.slice(env_prefix.length))) {
      throw new Error(`You should change envPrefix (${env_prefix}) to avoid conflicts with existing environment variables \u2014 unexpectedly saw ${name}`);
    }
  }
}
function parsing_error(name, value, expected2) {
  throw new Error(`Invalid value for environment variable ${env_prefix + name}: ${JSON.stringify(value)} (expected ${expected2})`);
}
function env(name, fallback) {
  const prefixed = env_prefix + name;
  return prefixed in process.env ? process.env[prefixed] : fallback;
}
var BOOLEANS = {
  1: true,
  true: true,
  yes: true,
  on: true,
  0: false,
  false: false,
  no: false,
  off: false
};
function boolean_env(name, fallback) {
  const value = env(name);
  if (value === undefined)
    return fallback;
  return BOOLEANS[value.toLowerCase()] ?? parsing_error(name, value, "a boolean");
}
function number_env(name, fallback, limits = {}) {
  const value = env(name);
  if (value === undefined)
    return fallback;
  if (!/^\d+$/.test(value)) {
    parsing_error(name, value, "a non-negative integer");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (limits.min ?? 0) || number > (limits.max ?? Infinity)) {
    const range = limits.max === undefined ? `at least ${limits.min ?? 0}` : `between ${limits.min ?? 0} and ${limits.max}`;
    parsing_error(name, value, `an integer ${range}`);
  }
  return number;
}
function bytes_env(name, fallback) {
  const value = env(name);
  if (value === undefined)
    return fallback;
  if (value === "Infinity")
    return Infinity;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[KMG])?$/i.test(value)) {
    parsing_error(name, value, "a non-negative number with an optional K, M, or G suffix, or Infinity");
  }
  const suffix = value.at(-1)?.toUpperCase();
  const multiplier = {
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024
  }[suffix] ?? 1;
  const number = Number(multiplier === 1 ? value : value.slice(0, -1)) * multiplier;
  if (!Number.isSafeInteger(number)) {
    parsing_error(name, value, "a non-negative number of whole bytes");
  }
  return number;
}

// node_modules/@sveltejs/adapter-bun/src/handler.js
var address_header = env("ADDRESS_HEADER", "").toLowerCase();
var protocol_header = env("PROTOCOL_HEADER", "").toLowerCase();
var host_header = env("HOST_HEADER", "").toLowerCase();
var port_header = env("PORT_HEADER", "").toLowerCase();
var xff_depth = number_env("XFF_DEPTH", 1, { min: 1 });
await server.init({
  env: Bun.env,
  read: (file) => server_assets.get(file)?.stream() ?? null
});
async function handler(request, bun_server) {
  const normalized_request = normalize_request(request);
  if (normalized_request instanceof Response)
    return normalized_request;
  const response = await server.respond(normalized_request, {
    platform: { server: bun_server },
    getClientAddress: () => get_client_address(request, bun_server)
  });
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    bun_server.timeout(request, 0);
    response.headers.set("x-accel-buffering", "no");
  }
  return response;
}
function normalize_request(request) {
  try {
    const url = new URL(request.url);
    const request_origin = origin || get_origin(request, url);
    return request_origin === url.origin ? request : new Request(request_origin + url.pathname + url.search, request);
  } catch (error) {
    console.error(`Could not determine request origin: ${error instanceof Error ? error.message : String(error)}`);
    return new Response("Bad Request", { status: 400 });
  }
}
function get_origin(request, url) {
  const protocol = decodeURIComponent(protocol_header && request.headers.get(protocol_header) || "https");
  if (!/^https?$/i.test(protocol)) {
    throw new Error(`The ${protocol_header} header specified ${protocol} which is an invalid protocol scheme. It should only contain the protocol scheme (e.g. \`https\`)`);
  }
  const host = host_header && request.headers.get(host_header) || (request.headers.get("host") ?? url.host);
  if (!host) {
    throw new Error(`Could not determine host from the ${host_header ? `${host_header} or ` : ""}host header`);
  }
  const port = port_header ? request.headers.get(port_header) : null;
  if (port && isNaN(+port)) {
    throw new Error(`The ${port_header} header specified ${port} which is an invalid port because it is not a number. The value should only contain the port number (e.g. 443)`);
  }
  return new URL(`${protocol}://${host}${port ? `:${port}` : ""}`).origin;
}
function get_client_address(request, bun_server) {
  if (!address_header) {
    return bun_server.requestIP(request)?.address;
  }
  const value = request.headers.get(address_header);
  if (value === null) {
    throw new Error(`Address header was specified with ${env_prefix}ADDRESS_HEADER=${address_header} but is absent from request`);
  }
  if (address_header !== "x-forwarded-for")
    return value;
  const addresses = value.split(",");
  if (xff_depth > addresses.length) {
    throw new Error(`${env_prefix}XFF_DEPTH is ${xff_depth}, but only found ${addresses.length} addresses`);
  }
  return addresses[addresses.length - xff_depth].trim();
}

// node_modules/@sveltejs/adapter-bun/src/index.js
if (Bun.semver.order(Bun.version, "1.4.0") < 0) {
  throw new Error(`@sveltejs/adapter-bun requires Bun 1.4 or newer, but this is Bun ${Bun.version}`);
}
var options2 = { ...options_default };
var unix = env("SOCKET_PATH", options2.unix);
if (unix) {
  options2.unix = unix;
  delete options2.hostname;
  delete options2.port;
  delete options2.reusePort;
  delete options2.ipv6Only;
  try {
    if (fs.statSync(unix).size === 0)
      fs.rmSync(unix);
  } catch {}
} else {
  delete options2.unix;
  options2.hostname = env("HOST", options2.hostname);
  options2.port = env("PORT", options2.port?.toString()) ?? 3000;
  options2.reusePort = boolean_env("REUSE_PORT", options2.reusePort);
  options2.ipv6Only = boolean_env("IPV6_ONLY", options2.ipv6Only);
}
options2.idleTimeout = number_env("CONNECTION_IDLE_TIMEOUT", options2.idleTimeout, { max: 255 });
options2.development = boolean_env("DEVELOPMENT") ?? options2.development ?? false;
options2.maxRequestBodySize = bytes_env("BODY_SIZE_LIMIT", options2.maxRequestBodySize ?? 512 * 1024);
var shutdown_timeout = number_env("SHUTDOWN_TIMEOUT", 30);
options2.fetch = handler;
options2.routes = routes;
var server2 = Bun.serve(options2);
console.log(unix ? `Listening on ${unix}` : `Listening on ${server2.url}`);
var shutting_down = false;
async function graceful_shutdown(reason) {
  if (shutting_down)
    return process2.exit(1);
  shutting_down = true;
  if (server2.pendingRequests !== 0) {
    console.log(`Waiting for ${server2.pendingRequests} requests to finish before shutting down...
` + "Press Ctrl+C again to force shutdown.");
  }
  let deadline;
  const drained = await Promise.race([
    server2.stop().then(() => true),
    new Promise((resolve) => {
      deadline = setTimeout(() => resolve(false), shutdown_timeout * 1000);
    })
  ]);
  clearTimeout(deadline);
  if (!drained)
    await server2.stop(true);
  process2.emit("sveltekit:shutdown", reason);
}
process2.on("SIGTERM", () => graceful_shutdown("SIGTERM"));
process2.on("SIGINT", () => graceful_shutdown("SIGINT"));

//# debugId=CECB7628536DFAD664756E2164756E21
