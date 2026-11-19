# @invoice-liquidity/eslint-config

Shared ESLint configuration for the Invoice Liquidity Network monorepo.

## Usage

Extend this config in your package's `.eslintrc.js`:

```javascript
module.exports = {
  extends: '@invoice-liquidity'
};
```

## Rules

This config enforces:

- **TypeScript strict rules** via `@typescript-eslint/recommended`
- **Import ordering** via `eslint-plugin-import` with alphabetical sorting
- **JSDoc enforcement** via `eslint-plugin-jsdoc` on exported symbols
- **No unused variables** with `_` prefix pattern allowed

## Extending

To add package-specific rules, add them to your local `.eslintrc.js`:

```javascript
module.exports = {
  extends: '@invoice-liquidity',
  rules: {
    'your-custom-rule': 'error'
  }
};
```
