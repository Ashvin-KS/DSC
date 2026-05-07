fn main() {
    // Load build-time credentials from .env.build (gitignored)
    // These will be embedded in the binary during compilation
    if let Ok(content) = std::fs::read_to_string("../.env.build") {
        for line in content.lines() {
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                // Skip comments and empty lines
                if !key.starts_with('#') && !key.is_empty() && !value.is_empty() {
                    println!("cargo:rustc-env={}={}", key, value);
                }
            }
        }
    }
    
    tauri_build::build()
}
