// The svelte-desktop plugin host on Android (native/include/svelte_desktop.h).
// libsdhost.so loads the app's libapp-native.so (native/*.c|cc|cpp built with the
// NDK), calls sd_plugin_init with this host, and bridges ops to the Java host
// (dev.sveltedesktop.NativePlugins): registration and calls come down through
// JNI on the main thread; resolve / reject / emit go up from any thread.
#include <android/log.h>
#include <dlfcn.h>
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "svelte_desktop.h"

#define TAG "SvelteDesktop"

struct sd_call {
  jlong id;
};

typedef struct {
  char *name; // "service.op"
  sd_op_fn fn;
  void *user;
} op_entry;

static JavaVM *g_vm;
static jclass g_cls; // global ref to NativePlugins
static jmethodID g_registered, g_resolve, g_reject, g_emit;
static op_entry *g_ops;
static int g_nops, g_cap;

static JNIEnv *env_for_thread(void) {
  JNIEnv *env = NULL;
  if ((*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6) == JNI_OK) return env;
  // Plugin threads: attach once; the JVM detaches them when they exit (AttachCurrentThreadAsDaemon).
  if ((*g_vm)->AttachCurrentThreadAsDaemon(g_vm, &env, NULL) != JNI_OK) return NULL;
  return env;
}

static jstring jstr(JNIEnv *env, const char *s) { return (*env)->NewStringUTF(env, s ? s : ""); }

static int host_register(const char *service, const char *op, sd_op_fn fn, void *user) {
  if (!service || !op || !fn) return -1;
  if (g_nops == g_cap) {
    g_cap = g_cap ? g_cap * 2 : 16;
    g_ops = realloc(g_ops, sizeof(op_entry) * g_cap);
  }
  size_t n = strlen(service) + strlen(op) + 2;
  char *name = malloc(n);
  snprintf(name, n, "%s.%s", service, op);
  g_ops[g_nops++] = (op_entry){name, fn, user};
  JNIEnv *env = env_for_thread();
  jstring s = jstr(env, service), o = jstr(env, op);
  jboolean ok = (*env)->CallStaticBooleanMethod(env, g_cls, g_registered, s, o);
  (*env)->DeleteLocalRef(env, s);
  (*env)->DeleteLocalRef(env, o);
  return ok ? 0 : -1;
}

static void host_resolve(sd_call *call, const char *value_json) {
  JNIEnv *env = env_for_thread();
  if (!env || !call) return;
  jstring v = jstr(env, value_json ? value_json : "null");
  (*env)->CallStaticVoidMethod(env, g_cls, g_resolve, call->id, v);
  (*env)->DeleteLocalRef(env, v);
  free(call);
}

static void host_reject(sd_call *call, const char *code, const char *message) {
  JNIEnv *env = env_for_thread();
  if (!env || !call) return;
  jstring c = jstr(env, code ? code : "internal"), m = jstr(env, message);
  (*env)->CallStaticVoidMethod(env, g_cls, g_reject, call->id, c, m);
  (*env)->DeleteLocalRef(env, c);
  (*env)->DeleteLocalRef(env, m);
  free(call);
}

static void host_emit(const char *event, const char *data_json) {
  JNIEnv *env = env_for_thread();
  if (!env) return;
  jstring e = jstr(env, event), d = jstr(env, data_json ? data_json : "null");
  (*env)->CallStaticVoidMethod(env, g_cls, g_emit, e, d);
  (*env)->DeleteLocalRef(env, e);
  (*env)->DeleteLocalRef(env, d);
}

static void *host_none(int window_id) {
  (void)window_id;
  return NULL; // no NSWindow / WKWebView on Android
}

static int host_caller_window(sd_call *call) {
  (void)call;
  return 0;
}

static void host_log(const char *message) { __android_log_print(ANDROID_LOG_INFO, TAG, "[plugin] %s", message ? message : ""); }

static const sd_host g_host = {
    .abi = SD_ABI_VERSION,
    .register_op = host_register,
    .resolve = host_resolve,
    .reject = host_reject,
    .emit = host_emit,
    .window = host_none,
    .webview = host_none,
    .caller_window = host_caller_window,
    .log = host_log,
};

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  (void)reserved;
  g_vm = vm;
  return JNI_VERSION_1_6;
}

JNIEXPORT jstring JNICALL Java_dev_sveltedesktop_NativePlugins_load(JNIEnv *env, jclass cls, jstring path) {
  if (!g_cls) {
    g_cls = (*env)->NewGlobalRef(env, cls);
    g_registered = (*env)->GetStaticMethodID(env, cls, "registered", "(Ljava/lang/String;Ljava/lang/String;)Z");
    g_resolve = (*env)->GetStaticMethodID(env, cls, "resolve", "(JLjava/lang/String;)V");
    g_reject = (*env)->GetStaticMethodID(env, cls, "reject", "(JLjava/lang/String;Ljava/lang/String;)V");
    g_emit = (*env)->GetStaticMethodID(env, cls, "emit", "(Ljava/lang/String;Ljava/lang/String;)V");
  }
  const char *p = (*env)->GetStringUTFChars(env, path, NULL);
  void *lib = dlopen(p, RTLD_NOW | RTLD_LOCAL);
  (*env)->ReleaseStringUTFChars(env, path, p);
  if (!lib) return jstr(env, dlerror());
  sd_plugin_init_fn init = (sd_plugin_init_fn)dlsym(lib, "sd_plugin_init");
  if (!init) return jstr(env, "libapp-native.so has no sd_plugin_init");
  int rc = init(&g_host);
  if (rc != 0) {
    char msg[64];
    snprintf(msg, sizeof msg, "sd_plugin_init returned %d", rc);
    return jstr(env, msg);
  }
  return NULL;
}

JNIEXPORT jboolean JNICALL Java_dev_sveltedesktop_NativePlugins_call(JNIEnv *env, jclass cls, jstring name, jstring args, jlong id) {
  (void)cls;
  const char *n = (*env)->GetStringUTFChars(env, name, NULL);
  op_entry *op = NULL;
  for (int i = 0; i < g_nops; i++)
    if (strcmp(g_ops[i].name, n) == 0) op = &g_ops[i];
  (*env)->ReleaseStringUTFChars(env, name, n);
  if (!op) return JNI_FALSE;
  sd_call *call = malloc(sizeof *call);
  call->id = id;
  const char *a = (*env)->GetStringUTFChars(env, args, NULL);
  op->fn(call, a, op->user);
  (*env)->ReleaseStringUTFChars(env, args, a);
  return JNI_TRUE;
}
