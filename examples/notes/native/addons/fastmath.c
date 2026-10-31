// Node-API addon, compiled to fastmath.node by the Vite plugin and loaded from
// server code with loadAddon('fastmath') (see src/lib/desktop.remote.ts).
#include <node_api.h>

static long long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

static napi_value Fib(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t n = 0;
  napi_get_value_int32(env, argv[0], &n);
  napi_value out;
  napi_create_int64(env, fib(n), &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "fib", NAPI_AUTO_LENGTH, Fib, NULL, &fn);
  napi_set_named_property(env, exports, "fib", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
