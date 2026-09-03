# Bug Hypothesis Categories

Systematic categorization of bug hypotheses with typical verification approaches.

## Categories

### 1. Logic Bugs

Errors in program logic, control flow, or data transformation.

| Sub-category | Symptoms | Verification Approach |
|-------------|----------|----------------------|
| Conditional branch | Wrong branch taken, missing case | Trace condition values, check edge cases |
| Boundary value | Off-by-one, overflow, underflow | Check loop bounds, array indices, comparisons |
| Type conversion | Unexpected coercion, precision loss | Search for implicit casts, parseInt vs Number |
| Null/undefined | NPE, undefined property access | Trace nullable paths, check optional chaining |
| Regex | Wrong match, catastrophic backtracking | Test regex with edge inputs |

**Grep patterns:**
```
# Off-by-one
< len|<= len|> 0|>= 0|length - 1

# Null checks
\?\.|!= null|!== null|== null|=== null|undefined
```

### 2. State Management

Issues with shared, mutable, or asynchronous state.

| Sub-category | Symptoms | Verification Approach |
|-------------|----------|----------------------|
| Race condition | Intermittent failures, order-dependent | Search for shared mutable state, async operations |
| Stale state | Shows old data, cache inconsistency | Check cache invalidation, TTL, event listeners |
| Memory leak | Growing memory, performance degradation | Search for event listeners not removed, growing arrays |
| Initialization order | Fails on cold start, works after retry | Trace module load order, constructor dependencies |
| Closure capture | Variable has unexpected value | Check loop variables captured by closures |

**Grep patterns:**
```
# Shared state
global|static|singleton|shared|mutex|lock

# Async state
await|Promise|setTimeout|setInterval|EventEmitter
```

### 3. External Dependencies

Issues with APIs, databases, file systems, or network.

| Sub-category | Symptoms | Verification Approach |
|-------------|----------|----------------------|
| API change | Broke after update, field missing | Check API version, diff response schemas |
| DB connection | Timeout, connection pool exhaustion | Check pool config, connection lifecycle |
| File system | Permission denied, path not found | Check permissions, relative vs absolute paths |
| Network | Timeout, DNS, SSL errors | Check timeout config, retry logic, certificates |
| Configuration | Works locally, fails in CI/prod | Diff env configs, check env variable loading |

**Grep patterns:**
```
# API calls
fetch|axios|http\.|request\(|\.get\(|\.post\(

# DB
connect|pool|query|transaction

# Config
process\.env|config\.|\.env|dotenv
```

### 4. Environment Differences

Issues that manifest differently across environments.

| Sub-category | Symptoms | Verification Approach |
|-------------|----------|----------------------|
| OS differences | Works on Mac, fails on Linux | Check path separators, case sensitivity, line endings |
| Timezone | Wrong dates, off-by-N-hours | Search for Date, timezone, UTC handling |
| Locale | Number format, string comparison | Check locale-sensitive operations |
| Version mismatch | Works with Node 18, fails with 20 | Check package.json engines, lockfile diff |
| Docker/container | Works locally, fails in container | Check Dockerfile, volume mounts, user permissions |

**Grep patterns:**
```
# Timezone
timezone|tz|UTC|toLocal|getTimezone|Intl\.DateTimeFormat

# OS-specific
path\.sep|os\.platform|process\.platform|\\\\|\/
```

## Hypothesis Generation Process

### Step 1: Symptom Classification

Map reported symptoms to likely categories:

| Symptom Pattern | Primary Categories | Secondary |
|----------------|-------------------|-----------|
| "Sometimes fails" | State (race), Environment | External |
| "Worked before" | External (API), Logic | Environment |
| "Wrong result" | Logic, State | External |
| "Crash/error" | Logic (null), External | State |
| "Slow/hang" | External (network), State (leak) | Logic |
| "Works locally" | Environment, External (config) | State |

### Step 2: Prioritization

Rank hypotheses by:

1. **Likelihood**: How well symptoms match the category
2. **Verifiability**: How quickly the hypothesis can be confirmed or rejected
3. **Impact**: How much of the codebase is affected

### Step 3: Verification Plan

For each hypothesis, define:

1. **Search targets**: Files, patterns, symbols to examine
2. **Expected evidence**: What to find if hypothesis is correct
3. **Rejection criteria**: What definitively rules out the hypothesis
4. **Time estimate**: Quick check (1-2 steps) vs deep dive (5+ steps)
