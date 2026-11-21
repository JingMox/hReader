#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hreader_desktop::run(&argv));
}
