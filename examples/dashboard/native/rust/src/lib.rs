// The Modules page's checksum: a file's SHA-256 in Rust, on a thread of its own, with progress
// events. host.native.files.sha256({ path, requestId }) — typed from these types (src/native.d.ts).
use std::fs::File;
use std::io::Read;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use kitop::{emit, plugin, Error, Plugin, TS};

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
struct HashArgs {
    path: String,
    request_id: String,
}

#[derive(Serialize, TS)]
struct Checksum {
    hex: String,
    bytes: u64,
    millis: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    request_id: &'a str,
    bytes: u64,
    total: u64,
}

fn setup(p: &mut Plugin) {
    p.command("files.sha256", |a: HashArgs| -> Result<Checksum, Error> {
        let started = Instant::now();
        let mut file = File::open(&a.path).map_err(|e| Error::invalid_args(format!("{}: {e}", a.path)))?;
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let (mut bytes, mut reported) = (0u64, 0u64);
        loop {
            let n = file.read(&mut buf).map_err(|e| Error::internal(e.to_string()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            bytes += n as u64;
            // An event every 16 MB: enough for a progress bar, not a flood.
            if bytes - reported >= 16 << 20 {
                reported = bytes;
                emit("files.progress", &Progress { request_id: &a.request_id, bytes, total });
            }
        }
        emit("files.progress", &Progress { request_id: &a.request_id, bytes, total });
        let hex = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        Ok(Checksum { hex, bytes, millis: started.elapsed().as_secs_f64() * 1000.0 })
    });
}

plugin!(setup);
