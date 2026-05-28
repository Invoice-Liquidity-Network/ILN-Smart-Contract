# Contributing to ILN Smart Contract

## Building Optimized WASM

To ensure minimal deployment and execution costs, all Soroban contracts should be built with optimization flags.

### Build Command

Use the following command to build optimized WASM binaries:

```bash
cargo build --release --target wasm32v1-none
```

Note: `wasm32v1-none` is the recommended target for Rust 1.84+ to ensure compatibility and optimal size.

Alternatively, you can use the provided Makefile target:

```bash
make soroban-optimize
```

This will build all contracts and place the optimized binaries in the `out/` directory.

### WASM Size Budget

We enforce a size budget for our contracts. Current sizes are recorded in [docs/wasm-size.md](docs/wasm-size.md). Any pull request that increases the size significantly or exceeds the threshold (currently 100KB) will fail the CI check.
