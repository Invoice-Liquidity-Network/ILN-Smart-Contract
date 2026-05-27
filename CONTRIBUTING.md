# Contributing to ILN Smart Contract

## Development setup

1. Install the [Stellar CLI](https://developers.stellar.org/docs/smart-contracts/getting-started/setup) and Rust toolchain.
2. Clone the repository and run `cargo check` to verify the workspace compiles.

## Running the test suite

```bash
# Run all unit and integration tests
cargo test --workspace
```

## Fuzz testing

The project uses [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html) (libFuzzer)
for property-based fuzz testing of critical input paths.

### Setup

Install cargo-fuzz (requires a nightly toolchain):

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

### Available fuzz targets

| Target | Contract | Property |
|--------|----------|----------|
| `fuzz_submit_invoice` | `invoice_liquidity` | `submit_invoice()` never panics on arbitrary inputs |

### Running a fuzz target

```bash
# Run indefinitely (press Ctrl-C to stop)
cargo +nightly fuzz run fuzz_submit_invoice

# Run for exactly 1 million iterations (recommended before audit)
cargo +nightly fuzz run fuzz_submit_invoice -- -runs=1000000

# Run with a corpus directory to seed known-interesting inputs
cargo +nightly fuzz run fuzz_submit_invoice corpus/fuzz_submit_invoice
```

All fuzz targets live in `contracts/fuzz/src/bin/`. The fuzz entry point
maps raw bytes to the four user-controlled parameters of `submit_invoice()`:
`amount`, `discount_rate`, `due_date`, and `payer`. The property under test
is that the function never panics — it may return an `Err` variant but must
always terminate gracefully.

### Reproducing a crash

cargo-fuzz saves crash inputs to `contracts/fuzz/artifacts/fuzz_submit_invoice/`.
To reproduce a specific crash:

```bash
cargo +nightly fuzz run fuzz_submit_invoice artifacts/fuzz_submit_invoice/crash-<hash>
```

### Adding a new fuzz target

1. Add a new binary in `contracts/fuzz/src/bin/<target_name>.rs`.
2. Register it in `contracts/fuzz/Cargo.toml` under `[[bin]]`.
3. Document it in the table above.

## Submitting a pull request

1. Fork the repository and create a feature branch.
2. Implement your change and add or update tests.
3. Run `cargo test --workspace` and ensure all tests pass.
4. If your change touches input validation, run the relevant fuzz target
   for at least 1 million iterations before opening the PR.
5. Open a pull request against `main` with a clear description of the change.
