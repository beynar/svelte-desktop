// Native plugin in Rust: every command is callable from pages and server code,
// typed — nativeModule('hello').rust({ name }) (types in src/native.d.ts, written by the build).
use serde::{Deserialize, Serialize};
use svelte_desktop::{plugin, Error, Plugin, TS};

#[derive(Deserialize, TS)]
struct GreetArgs {
    name: String,
}

#[derive(Serialize, TS)]
struct Greeting {
    message: String,
}

#[derive(Deserialize, TS)]
struct StatsArgs {
    text: String,
}

#[derive(Serialize, TS)]
struct Stats {
    words: u64,
    lines: u64,
    longest: Option<String>,
}

fn setup(p: &mut Plugin) {
    p.command("hello.rust", |a: GreetArgs| -> Result<Greeting, Error> {
        if a.name.is_empty() {
            return Err(Error::invalid_args("name is empty"));
        }
        Ok(Greeting { message: format!("Hello {} from Rust", a.name) })
    });
    // Notes' word count, for the editor.
    p.command("text.stats", |a: StatsArgs| -> Result<Stats, Error> {
        let words: Vec<&str> = a.text.split_whitespace().collect();
        Ok(Stats {
            words: words.len() as u64,
            lines: a.text.lines().count() as u64,
            longest: words.iter().max_by_key(|w| w.chars().count()).map(|w| w.to_string()),
        })
    });
}

plugin!(setup);
