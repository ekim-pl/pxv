# Third-party notices

Official Node.js 24.22.0 is distributed with its complete upstream license and notices. Its embedded Rust-derived TypeScript parser is the explicit upstream Node exception; test transpilation uses esbuild instead. Project-managed Rust executables, native addons, WASM and transitive development dependencies are prohibited.

The supervisor uses Koffi 3.3.3 (MIT), its JavaScript loader and the selected Linux glibc x64 Node-API 8 prebuild. Its reviewed license is retained in resources/third-party/KOFFI-LICENSE.txt. No Koffi source build is run. Generated distributions include runtime npm dependency notices and an SPDX SBOM. Retired Rust crate, Rust runtime and musl catalogs are no longer release inputs.

Development tools include TypeScript, ESLint, esbuild, expect/jest-mock, fake-timers, ast-v8-to-istanbul, @babel/parser, java-parser, marked and Playwright. Playwright's libwebp WASM codec is reviewed as a C/C++ development artifact. Android helpers and the Java signature verifier remain repository source. Preserve the bundled font and third-party license files when distributing guides.
