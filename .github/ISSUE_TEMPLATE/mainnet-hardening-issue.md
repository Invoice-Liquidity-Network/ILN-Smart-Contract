---
name: Mainnet Hardening Issue
about: High-complexity mainnet/SCF-readiness issue (Drips "meaningful issue" format)
labels: mainnet-readiness, 200pts, high-complexity
---

## Description
{{description}}

## Requirements and Context
{{requirements_and_context}}

## Suggested Execution
{{suggested_execution}}

## Guidelines
- **Complexity:** {{complexity}} ({{points}} pts) -- **Category:** {{category}}
- Match the existing code style, error-handling, and test patterns in the affected crate/package.
- Cover the change with unit/integration tests; update any `docs/` file this issue references.
- Open the PR against `dev`, link this issue (`Closes #{{number}}`), and summarize the change plus any residual/accepted risk.
- Suggested commit message style: `{{commit_message}}`

<!-- Format follows https://www.drips.network/blog/posts/creating-meaningful-issues -->
