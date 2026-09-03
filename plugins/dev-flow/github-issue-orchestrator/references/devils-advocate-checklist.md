# Devil's-Advocate Checklist

Use this checklist to challenge the implementation plan before issue creation.

## Blocking Categories

Treat findings as `blocking` if any item below is true:
- Missing acceptance criteria or untestable acceptance criteria
- No rollback strategy for risky change
- Security/privacy implications are ignored
- Migration/data-change plan is missing where required
- Dependency order is impossible or contradictory
- Ownership is unclear for critical tasks

## Review Dimensions

1. Product/Scope
- Is the problem statement falsifiable?
- Is scope bounded and non-goals explicit?
- Are open questions isolated from committed work?

2. Architecture
- Does the plan define interface boundaries?
- Are contracts backward compatible or migration-safe?
- Are failure modes and graceful degradation covered?

3. Security/Compliance
- Are authn/authz impacts addressed?
- Is sensitive data handling documented?
- Are audit/compliance constraints considered when relevant?

4. Operations/Infra
- Are deployment and rollback paths explicit?
- Is observability (logs/metrics/alerts) included?
- Are cost and reliability trade-offs acknowledged?

5. Delivery
- Are dependencies and phase order realistic?
- Are test levels (unit/integration/e2e) aligned to risk?
- Are owners and exit criteria assigned per phase?

## Loop Protocol

1. Produce a list of findings with severity (`blocking` or `non-blocking`).
2. For each blocking finding, propose a concrete correction.
3. Revise the plan.
4. Re-run review until blocking findings are zero or max rounds reached.

If max rounds reached with blocking findings remaining:
- Do not create issue.
- Return unresolved findings and required user decisions.
