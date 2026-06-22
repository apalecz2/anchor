use std::{env, fs, io, path::Path};

fn copy_dir_contents(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let target_path = destination.join(entry.file_name());

        if path.is_dir() {
            copy_dir_contents(&path, &target_path)?;
        } else if let Err(error) = fs::copy(&path, &target_path) {
            eprintln!(
                "cargo:warning=skipping bundled binary {} -> {}: {}",
                path.display(),
                target_path.display(),
                error
            );
        }
    }

    Ok(())
}

fn platform_binaries_dir() -> Option<&'static str> {
    match env::consts::OS {
        "windows" => Some("windows"),
        "macos" => Some("macos"),
        "linux" => Some("linux"),
        _ => None,
    }
}

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR");
    let manifest_dir = Path::new(&manifest_dir);
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target_binaries_dir = manifest_dir.join("target").join(profile).join("binaries");
    let legacy_binaries_dir = manifest_dir.join("binaries");

    let source_binaries_dir = platform_binaries_dir()
        .map(|platform| legacy_binaries_dir.join(platform))
        .filter(|path| path.exists())
        .unwrap_or_else(|| legacy_binaries_dir.clone());

    if source_binaries_dir.exists() {
        copy_dir_contents(&source_binaries_dir, &target_binaries_dir)
            .expect("failed to copy bundled binaries into the cargo target directory");
    }

    println!("cargo:rerun-if-changed={}", source_binaries_dir.display());
    println!("cargo:rerun-if-changed={}", legacy_binaries_dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("tauri.conf.json").display()
    );

    tauri_build::build()
}
