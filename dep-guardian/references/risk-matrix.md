# Dependency Risk Matrix

## Risk Factors

### Factor 1: Version Bump Type

| Bump | Base Risk | Rationale |
|------|-----------|-----------|
| Patch (x.y.Z) | 1 | Bug fixes only, backward compatible |
| Minor (x.Y.z) | 2 | New features, backward compatible |
| Major (X.y.z) | 4 | Potential breaking changes |

### Factor 2: Dependency Type

| Type | Multiplier | Rationale |
|------|------------|-----------|
| devDependencies | 0.5x | Only affects development, not production |
| dependencies | 1.0x | Affects production runtime |
| peerDependencies | 1.5x | May cascade to consumers |

### Factor 3: Package Category

| Category | Modifier | Examples |
|----------|----------|---------|
| Type definitions (@types/*) | -1 | @types/node, @types/react |
| Linter/formatter | -1 | eslint, prettier, biome |
| Test framework | 0 | vitest, jest, playwright |
| Build tool | +1 | webpack, vite, esbuild, turbopack |
| Framework core | +2 | react, next, express, fastify |
| Database driver | +2 | prisma, drizzle, pg |
| Auth/security | +3 | next-auth, jsonwebtoken |

### Risk Score Calculation

```
risk_score = base_risk * type_multiplier + category_modifier
```

| Score | Risk Level | Auto-Merge? |
|-------|------------|-------------|
| ≤ 1 | Safe | Yes (with --auto-merge) |
| 2-3 | Low | Yes (with --risk-threshold minor) |
| 4-5 | Medium | Only with --risk-threshold major |
| ≥ 6 | High | Never auto-merge |

## Breaking Change Indicators

Scan PR body and changelog for these patterns:

```
/breaking change/i
/BREAKING:/
/migration guide/i
/deprecated.*removed/i
/minimum.*version.*required/i
/dropped support/i
```

If any match: set risk to `breaking` regardless of version bump type.

## Common Safe Updates

These packages are generally safe to auto-merge at patch/minor level:

- `@types/*` — Type definition updates
- `eslint-*` — ESLint plugins and configs
- `prettier` — Code formatter
- `typescript` — Minor/patch releases
- `@testing-library/*` — Test utilities
- `vitest` / `jest` — Test runners (minor/patch)

## Common Risky Updates

Exercise caution with these packages:

- `react` / `next` — Framework core (always test thoroughly)
- `prisma` / `drizzle-orm` — ORM (schema migration risk)
- `tailwindcss` — Major versions may change class names
- `node` — Runtime version (broad impact)
- Any package with `postinstall` scripts
