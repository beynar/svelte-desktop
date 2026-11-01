// Package desktop: native plugins in Go for svelte-desktop apps.
//
//	package main
//
//	import "svelte-desktop.dev/go/desktop"
//
//	type HashArgs struct{ Text string `json:"text"` }
//	type Digest struct{ Hex string `json:"hex"` }
//
//	func init() {
//		desktop.Command("hasher.sha256", func(a HashArgs) (Digest, error) { return Digest{Hex: sha256(a.Text)}, nil })
//	}
//
//	func main() {}
//
// The app's `native/go/` module is built by svelte-desktop (`go build -buildmode=c-shared`) and loaded
// by the shell. Each command is a platform op: `nativeModule('hasher').sha256({ text })` from pages and
// server code, typed from the Go types (the build reads them with `sd_plugin_describe`). Handlers run on
// their own goroutine, never the UI thread; a panic rejects the call.
package desktop

/*
#cgo CFLAGS: -I${SRCDIR}/../../include
#include <stdlib.h>
#include "host.h"
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unsafe"
)

// Error rejects a call with a code: invalid_args, unsupported, unavailable, denied or internal.
// Any other error rejects with internal.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func InvalidArgs(format string, a ...any) *Error { return &Error{"invalid_args", fmt.Sprintf(format, a...)} }
func Unsupported(format string, a ...any) *Error { return &Error{"unsupported", fmt.Sprintf(format, a...)} }
func Unavailable(format string, a ...any) *Error { return &Error{"unavailable", fmt.Sprintf(format, a...)} }
func Denied(format string, a ...any) *Error      { return &Error{"denied", fmt.Sprintf(format, a...)} }

type command struct {
	service, op  string
	args, result reflect.Type
	call         func(args []byte) (any, error)
}

var commands []*command

// Command registers `service.op` (call it from an init function). A is decoded from the call's
// arguments (struct{} for none), R is the result; both are typed in the generated TypeScript.
func Command[A any, R any](name string, f func(A) (R, error)) {
	service, op, ok := strings.Cut(name, ".")
	if !ok {
		panic("svelte-desktop: command " + name + " must be named service.op")
	}
	commands = append(commands, &command{
		service: service, op: op,
		args: reflect.TypeFor[A](), result: reflect.TypeFor[R](),
		call: func(raw []byte) (any, error) {
			var a A
			if err := json.Unmarshal(raw, &a); err != nil {
				return nil, InvalidArgs("%v", err)
			}
			return f(a)
		},
	})
}

// Emit broadcasts an event to every page and to server code (`onPlatform(event)`). Any goroutine.
func Emit(event string, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	e, d := C.CString(event), C.CString(string(raw))
	defer C.free(unsafe.Pointer(e))
	defer C.free(unsafe.Pointer(d))
	C.sd_go_emit(e, d)
}

// Log writes a line in the app's log.
func Log(message string) {
	m := C.CString(message)
	defer C.free(unsafe.Pointer(m))
	C.sd_go_log(m)
}

//export sd_plugin_init
func sd_plugin_init(host *C.sd_host) C.int {
	if C.sd_go_set_host(host) != 0 {
		return -1
	}
	for i, c := range commands {
		s, o := C.CString(c.service), C.CString(c.op)
		if C.sd_go_register(s, o, C.ulong(i)) != 0 {
			Log("command " + c.service + "." + c.op + " not registered: the name is already taken (the shell or another plugin)")
		}
		C.free(unsafe.Pointer(s))
		C.free(unsafe.Pointer(o))
	}
	return 0
}

//export sdGoDispatch
func sdGoDispatch(call *C.sd_call, args *C.char, user unsafe.Pointer) {
	c := commands[uintptr(user)]
	raw := []byte(C.GoString(args))
	// Off the UI thread: resolve/reject may be called from any thread.
	go func() {
		defer func() {
			if p := recover(); p != nil {
				reject(call, "internal", fmt.Sprintf("%s.%s panicked: %v", c.service, c.op, p))
			}
		}()
		v, err := c.call(raw)
		if err != nil {
			var de *Error
			if errors.As(err, &de) {
				reject(call, de.Code, de.Message)
			} else {
				reject(call, "internal", err.Error())
			}
			return
		}
		out, err := json.Marshal(v)
		if err != nil {
			reject(call, "internal", "result: "+err.Error())
			return
		}
		r := C.CString(string(out))
		defer C.free(unsafe.Pointer(r))
		C.sd_go_resolve(call, r)
	}()
}

func reject(call *C.sd_call, code, message string) {
	c, m := C.CString(code), C.CString(message)
	defer C.free(unsafe.Pointer(c))
	defer C.free(unsafe.Pointer(m))
	C.sd_go_reject(call, c, m)
}

var description *C.char

//export sd_plugin_describe
func sd_plugin_describe() *C.char {
	if description == nil {
		type cmd struct {
			Service string  `json:"service"`
			Op      string  `json:"op"`
			Args    *string `json:"args"`
			Result  string  `json:"result"`
		}
		list := make([]cmd, 0, len(commands))
		for _, c := range commands {
			var args *string
			if !(c.args.Kind() == reflect.Struct && c.args.NumField() == 0) {
				s := tsType(c.args, 0)
				args = &s
			}
			list = append(list, cmd{c.service, c.op, args, tsType(c.result, 0)})
		}
		raw, _ := json.Marshal(map[string]any{"abi": 1, "language": "go", "commands": list})
		description = C.CString(string(raw))
	}
	return description
}

// tsType: the TypeScript of what encoding/json makes of t.
func tsType(t reflect.Type, depth int) string {
	if depth > 8 {
		return "unknown"
	}
	if t.PkgPath() == "time" && t.Name() == "Time" {
		return "string"
	}
	switch t.Kind() {
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return "number"
	case reflect.String:
		return "string"
	case reflect.Pointer:
		return tsType(t.Elem(), depth+1) + " | null"
	case reflect.Slice, reflect.Array:
		if t.Elem().Kind() == reflect.Uint8 {
			return "string" // base64
		}
		elem := tsType(t.Elem(), depth+1)
		if strings.Contains(elem, "|") {
			elem = "(" + elem + ")"
		}
		return elem + "[]"
	case reflect.Map:
		return "Record<string, " + tsType(t.Elem(), depth+1) + ">"
	case reflect.Struct:
		var fields []string
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "-" {
				continue
			}
			if f.Anonymous && name == "" && f.Type.Kind() == reflect.Struct {
				inner := tsType(f.Type, depth+1) // embedded: its fields flatten into this object
				fields = append(fields, strings.TrimSuffix(strings.TrimPrefix(inner, "{ "), " }"))
				continue
			}
			if name == "" {
				name = f.Name
			}
			opt := ""
			if strings.Contains(opts, "omitempty") || strings.Contains(opts, "omitzero") {
				opt = "?"
			}
			fields = append(fields, fmt.Sprintf("%s%s: %s", name, opt, tsType(f.Type, depth+1)))
		}
		if len(fields) == 0 {
			return "Record<string, never>"
		}
		return "{ " + strings.Join(fields, "; ") + " }"
	}
	return "unknown"
}
