// Native plugin in Go: every command is callable from pages and server code,
// typed — nativeModule('hello').go({ name }) (types in src/native.d.ts, written by the build).
package main

import (
	"time"

	"svelte-desktop.dev/go/desktop"
)

type GreetArgs struct {
	Name string `json:"name"`
}

type Greeting struct {
	Message string `json:"message"`
}

type CountdownArgs struct {
	From int `json:"from"`
}

func init() {
	desktop.Command("hello.go", func(a GreetArgs) (Greeting, error) {
		if a.Name == "" {
			return Greeting{}, desktop.InvalidArgs("name is empty")
		}
		return Greeting{Message: "Hello " + a.Name + " from Go"}, nil
	})
	// Emits clock.tick events (onPlatform('clock.tick') in pages and server code), then resolves.
	desktop.Command("clock.countdown", func(a CountdownArgs) (int, error) {
		for n := a.From; n > 0; n-- {
			desktop.Emit("clock.tick", map[string]int{"n": n})
			time.Sleep(10 * time.Millisecond)
		}
		return a.From, nil
	})
}

func main() {}
