# Cross-Domain Communication Patterns

Query templates for inter-auditor communication via SendMessage.

## Table of Contents

1. [Security to Architecture](#security-to-architecture)
2. [Performance to Security](#performance-to-security)
3. [Architecture to Security](#architecture-to-security)
4. [Architecture to Performance](#architecture-to-performance)
5. [Security to Performance](#security-to-performance)
6. [Performance to Architecture](#performance-to-architecture)

## Security to Architecture

**Pattern**: Vulnerability found, check if the anti-pattern is systemic.

```
Template:
"Found [vulnerability type] at [location].
This [pattern description] may exist elsewhere.
Can you check if this pattern appears in other modules?"

Example:
"Found SQL injection risk at src/db/query.ts:45 using raw string concatenation.
This raw query pattern may exist in other database access files.
Can you check if this pattern appears in other modules?"
```

## Performance to Security

**Pattern**: Optimization candidate requires security assessment.

```
Template:
"Found [performance issue] at [location].
Considering [optimization approach].
Are there security risks with [specific concern]?"

Example:
"Found N+1 query at src/api/users.ts:120 loading user profiles.
Considering adding a Redis cache layer for user data.
Are there security risks with caching personally identifiable information?"
```

## Architecture to Security

**Pattern**: Scattered logic found, check implementation consistency.

```
Template:
"Found [concern] logic scattered across [locations].
Implementations may differ between these locations.
Are there security implications from inconsistent [concern] handling?"

Example:
"Found authentication logic scattered across src/middleware/auth.ts,
src/api/admin.ts, and src/utils/auth.ts.
Implementations may differ between these locations.
Are there security implications from inconsistent auth handling?"
```

## Architecture to Performance

**Pattern**: Structural issue may cause performance bottleneck.

```
Template:
"Found [structural pattern] at [location].
This may cause [performance concern].
Can you assess the performance impact of this pattern?"

Example:
"Found circular dependency between src/services/order.ts and src/services/inventory.ts.
This may cause unnecessary module loading and initialization overhead.
Can you assess the performance impact of this pattern?"
```

## Security to Performance

**Pattern**: Security measure may have performance impact.

```
Template:
"Recommending [security measure] at [location].
This adds [overhead type] to the request path.
Can you assess the performance impact?"

Example:
"Recommending input validation and sanitization at src/api/upload.ts.
This adds regex processing to every upload request.
Can you assess the performance impact for large file uploads?"
```

## Performance to Architecture

**Pattern**: Performance fix may need architectural consideration.

```
Template:
"Found [performance issue] at [location].
The fix may require [architectural change].
Is this aligned with the current architecture patterns?"

Example:
"Found synchronous blocking call at src/services/email.ts:30.
The fix may require introducing an async job queue.
Is this aligned with the current architecture patterns?"
```

## Cross-Domain Finding Format

When an auditor records a finding triggered by cross-domain communication:

```bash
audit-state.sh add-finding \
  --domain <receiving-auditor-domain> \
  --severity <assessed-severity> \
  --location "<location>" \
  --title "<title>" \
  --description "<description from cross-domain investigation>" \
  --evidence "<evidence>" \
  --cross-domain

# Link to the original finding
audit-state.sh add-cross-ref --finding <new-finding-id> --ref <original-finding-id>
```
