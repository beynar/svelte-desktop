// A sidecar executable for Android, compiled with the NDK by the build
// (native/android/sidecars/ → lib/<abi>/libsidecar_hello.so) and started from
// server code with `sidecar('hello', [...])`.
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  printf("hello from an Android sidecar (pid %d)", getpid());
  for (int i = 1; i < argc; i++) printf(" %s", argv[i]);
  printf("\n");
  return 0;
}
