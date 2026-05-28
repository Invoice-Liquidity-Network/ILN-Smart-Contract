# Build all contracts and optimize WASM output
# Note: Using wasm32v1-none for Rust 1.84+ as recommended for Soroban
soroban-optimize:
	@rustup target add wasm32v1-none
	@cargo build --release --target wasm32v1-none
	@mkdir -p out
	@cp target/wasm32v1-none/release/*.wasm out/
	@ls -lh out/*.wasm

.PHONY: soroban-optimize
