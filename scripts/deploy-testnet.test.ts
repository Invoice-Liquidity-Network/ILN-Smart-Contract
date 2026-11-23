/**
 * Regression harness for scripts/deploy-testnet.sh.
 *
 * Mocks `stellar` and `cargo` on PATH to assert that the script:
 *   - never leaks or exports the deployer secret to child processes,
 *   - initializes every contract in dependency order and verifies it,
 *   - refuses to reuse a deployer key whose secret differs,
 *   - aborts without writing success artefacts when initialization fails.
 *
 * Run with:
 *   npx tsx --test scripts/deploy-testnet.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "deploy-testnet.sh");
const SECRET = `S${"A".repeat(55)}`;
const OTHER_SECRET = `S${"B".repeat(55)}`;
const ADMIN = `G${"A".repeat(55)}`;
const CONTRACT = `C${"A".repeat(55)}`;
const WASM_HASH = "a".repeat(64);

interface RunOptions {
  /** `null` omits ILN_ADMIN_ADDRESS from the environment. */
  admin?: string | null;
  existingSecret?: string;
  failInit?: boolean;
  envFile?: string;
}

function makeProject(opts: RunOptions) {
  const root = mkdtempSync(join(tmpdir(), "iln-deploy-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const log = join(root, "calls.log");

  writeFileSync(
    join(bin, "cargo"),
    `#!/bin/bash
echo "CARGO $* secret=\${STELLAR_TESTNET_DEPLOYER_SECRET:-unset}" >> "${log}"
mkdir -p target/wasm32v1-none/release
for name in invoice_liquidity iln_governance iln_distribution reputation_bonus; do
  printf 'wasm' > "target/wasm32v1-none/release/\${name}.wasm"
done
`,
  );

  writeFileSync(
    join(bin, "stellar"),
    `#!/bin/bash
printf 'STELLAR %s secret=%s\\n' "$*" "\${STELLAR_TESTNET_DEPLOYER_SECRET:-unset}" >> "${log}"
state="${state}"
case "$1 $2" in
  "network ls")
    echo testnet
    ;;
  "keys address")
    [[ -f "\${state}/address" ]] || exit 1
    cat "\${state}/address"
    ;;
  "keys add")
    IFS= read -r value || true
    printf '%s' "\${value}" > "\${state}/secret"
    printf '%s' "${ADMIN}" > "\${state}/address"
    ;;
  "keys secret")
    [[ -f "\${state}/secret" ]] || exit 1
    cat "\${state}/secret"
    ;;
  "contract upload")
    echo "WASM hash: ${WASM_HASH}"
    ;;
  "contract deploy")
    echo "Contract ID: ${CONTRACT}"
    ;;
  "contract invoke")
    if [[ "\${MOCK_FAIL_INIT:-0}" == "1" && "$*" == *" initialize "* ]]; then
      echo "simulated initialization failure" >&2
      exit 1
    fi
    case "$*" in
      *" is_initialized"*) echo true ;;
      *" get_admin"*) cat "\${state}/address" ;;
      *" get_gov_token_total_supply"*) echo 1000000 ;;
      *" get_config"*) echo '{"usdc_sac_address":"${CONTRACT}"}' ;;
      *) echo ok ;;
    esac
    ;;
esac
`,
  );

  for (const name of ["cargo", "stellar"]) chmodSync(join(bin, name), 0o755);

  if (opts.existingSecret) {
    writeFileSync(join(state, "secret"), opts.existingSecret);
    writeFileSync(join(state, "address"), ADMIN);
  }
  if (opts.envFile) writeFileSync(join(root, ".env"), opts.envFile);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    MOCK_FAIL_INIT: opts.failInit ? "1" : "0",
    STELLAR_TESTNET_DEPLOYER_SECRET: SECRET,
    ILN_GOV_TOKEN_ADDRESS: CONTRACT,
    ILN_GOV_TOKEN_TOTAL_SUPPLY: "1000000",
    TESTNET_USDC_SAC: CONTRACT,
    TESTNET_EURC_SAC: CONTRACT,
    TESTNET_XLM_SAC: CONTRACT,
  };
  if (opts.admin !== null) env.ILN_ADMIN_ADDRESS = opts.admin ?? ADMIN;

  const result = spawnSync("bash", [SCRIPT], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });

  return {
    root,
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
    result,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invokedFunctions(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => line.startsWith("STELLAR contract invoke"))
    .map((line) => line.match(/-- (initialize|init|get_config|is_initialized|get_admin|get_gov_token_total_supply)/)?.[1] ?? "?");
}

test("deploy-testnet initializes in dependency order and keeps the secret out of child environments", () => {
  const run = makeProject({});
  try {
    assert.equal(run.result.status, 0, `stdout:\n${run.result.stdout}\nstderr:\n${run.result.stderr}\nlog:\n${run.log}`);
    assert.match(run.result.stdout, /All contracts initialized and verified/);
    assert.equal(run.result.stdout.includes(SECRET), false);
    assert.equal(run.result.stderr.includes(SECRET), false);
    assert.equal(run.log.includes(SECRET), false);
    for (const line of run.log.split("\n").filter(Boolean)) {
      assert.match(line, /secret=unset/);
    }

    assert.deepEqual(invokedFunctions(run.log), [
      "initialize",
      "initialize",
      "init",
      "initialize",
      "get_config",
      "is_initialized",
      "get_admin",
      "get_gov_token_total_supply",
    ]);

    const envFile = readFileSync(join(run.root, ".contracts-testnet.env"), "utf8");
    assert.match(envFile, /INVOICE_LIQUIDITY_ID=C/);
    assert.match(envFile, new RegExp(`ILN_ADMIN_ADDRESS=${ADMIN}`));
    assert.match(envFile, /SOURCE=iln-testnet-deployer/);
    const summary = JSON.parse(readFileSync(join(run.root, "deploy-summary.json"), "utf8"));
    assert.equal(summary.initialized, true);
    assert.equal(summary.admin, ADMIN);
  } finally {
    run.cleanup();
  }
});

test("deploy-testnet fails before uploading when required initialization config is missing", () => {
  const run = makeProject({ admin: null });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /ILN_ADMIN_ADDRESS/);
    assert.equal(run.log.includes("contract upload"), false);
  } finally {
    run.cleanup();
  }
});

test("deploy-testnet refuses to reuse a deployer key with a different secret", () => {
  const run = makeProject({ existingSecret: OTHER_SECRET });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /different secret/);
    assert.equal(run.log.includes("contract upload"), false);
  } finally {
    run.cleanup();
  }
});

test("deploy-testnet aborts without writing a success summary when initialization fails", () => {
  const run = makeProject({ failInit: true });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /Initialization failed/);
    assert.equal(existsSync(join(run.root, "deploy-summary.json")), false);
  } finally {
    run.cleanup();
  }
});

test("deploy-testnet loads only allowlisted values from .env", () => {
  const run = makeProject({
    admin: null,
    envFile: [
      `ILN_ADMIN_ADDRESS=${ADMIN}`,
      "STELLAR_TESTNET_DEPLOYER_SECRET=" + SECRET,
      "UNRELATED_SECRET=do-not-export",
    ].join("\n"),
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.log.includes("do-not-export"), false);
  } finally {
    run.cleanup();
  }
});
