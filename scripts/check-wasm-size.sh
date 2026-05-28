#!/bin/bash
# scripts/check-wasm-size.sh

MAX_SIZE_KB=100
EXIT_CODE=0

for wasm in out/*.wasm; do
    size=$(du -k "$wasm" | cut -f1)
    name=$(basename "$wasm")
    if [ "$size" -gt "$MAX_SIZE_KB" ]; then
        echo "Error: $name is too large ($size KB). Maximum allowed size is $MAX_SIZE_KB KB."
        EXIT_CODE=1
    else
        echo "$name size check passed: $size KB."
    fi
done

exit $EXIT_CODE
