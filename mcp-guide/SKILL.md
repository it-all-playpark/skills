# MCP Guide

Reference guide for MCP server selection and usage patterns.

## Usage

```
/mcp-guide [server-name]
```

## Quick Reference

| Server | Purpose | Best For |
|--------|---------|----------|
| Context7 | Documentation lookup | Framework patterns, library APIs |
| Magic | UI generation | Components, design systems |
| Morphllm | Bulk editing | Pattern transforms, style enforcement |
| Playwright | Browser automation | E2E tests, visual validation |
| Sequential | Complex reasoning | Architecture, debugging, analysis |
| Serena | Semantic understanding | Symbol ops, session persistence |

---

## Context7 MCP Server

**Purpose**: Official library documentation lookup and framework pattern guidance

### Triggers
- Import statements: `import`, `require`, `from`, `use`
- Framework keywords: React, Vue, Angular, Next.js, Express, etc.
- Library-specific questions about APIs or best practices
- Need for official documentation patterns vs generic solutions
- Version-specific implementation requirements

### Choose When
- **Over WebSearch**: When you need curated, version-specific documentation
- **Over native knowledge**: When implementation must follow official patterns
- **For frameworks**: React hooks, Vue composition API, Angular services
- **For libraries**: Correct API usage, authentication flows, configuration
- **For compliance**: When adherence to official standards is mandatory

### Works Best With
- **Sequential**: Context7 provides docs -> Sequential analyzes implementation strategy
- **Magic**: Context7 supplies patterns -> Magic generates framework-compliant components

### Examples
```
"implement React useEffect" -> Context7 (official React patterns)
"add authentication with Auth0" -> Context7 (official Auth0 docs)
"migrate to Vue 3" -> Context7 (official migration guide)
"optimize Next.js performance" -> Context7 (official optimization patterns)
"just explain this function" -> Native Claude (no external docs needed)
```

---

## Magic MCP Server

**Purpose**: Modern UI component generation from 21st.dev patterns with design system integration

### Triggers
- UI component requests: button, form, modal, card, table, nav
- Design system implementation needs
- `/ui` or `/21` commands
- Frontend-specific keywords: responsive, accessible, interactive
- Component enhancement or refinement requests

### Choose When
- **For UI components**: Use Magic, not native HTML/CSS generation
- **Over manual coding**: When you need production-ready, accessible components
- **For design systems**: When consistency with existing patterns matters
- **For modern frameworks**: React, Vue, Angular with current best practices
- **Not for backend**: API logic, database queries, server configuration

### Works Best With
- **Context7**: Magic uses 21st.dev patterns -> Context7 provides framework integration
- **Sequential**: Sequential analyzes UI requirements -> Magic implements structured components

### Examples
```
"create a login form" -> Magic (UI component generation)
"build a responsive navbar" -> Magic (UI pattern with accessibility)
"add a data table with sorting" -> Magic (complex UI component)
"make this component accessible" -> Magic (UI enhancement)
"write a REST API" -> Native Claude (backend logic)
"fix database query" -> Native Claude (non-UI task)
```

---

## Morphllm MCP Server

**Purpose**: Pattern-based code editing engine with token optimization for bulk transformations

### Triggers
- Multi-file edit operations requiring consistent patterns
- Framework updates, style guide enforcement, code cleanup
- Bulk text replacements across multiple files
- Natural language edit instructions with specific scope
- Token optimization needed (efficiency gains 30-50%)

### Choose When
- **Over Serena**: For pattern-based edits, not symbol operations
- **For bulk operations**: Style enforcement, framework updates, text replacements
- **When token efficiency matters**: Fast Apply scenarios with compression needs
- **For simple to moderate complexity**: <10 files, straightforward transformations
- **Not for semantic operations**: Symbol renames, dependency tracking, LSP integration

### Works Best With
- **Serena**: Serena analyzes semantic context -> Morphllm executes precise edits
- **Sequential**: Sequential plans edit strategy -> Morphllm applies systematic changes

### Examples
```
"update all React class components to hooks" -> Morphllm (pattern transformation)
"enforce ESLint rules across project" -> Morphllm (style guide application)
"replace all console.log with logger calls" -> Morphllm (bulk text replacement)
"rename getUserData function everywhere" -> Serena (symbol operation)
"analyze code architecture" -> Sequential (complex analysis)
"explain this algorithm" -> Native Claude (simple explanation)
```

---

## Playwright MCP Server

**Purpose**: Browser automation and E2E testing with real browser interaction

### Triggers
- Browser testing and E2E test scenarios
- Visual testing, screenshot, or UI validation requests
- Form submission and user interaction testing
- Cross-browser compatibility validation
- Performance testing requiring real browser rendering
- Accessibility testing with automated WCAG compliance

### Choose When
- **For real browser interaction**: When you need actual rendering, not just code
- **Over unit tests**: For integration testing, user journeys, visual validation
- **For E2E scenarios**: Login flows, form submissions, multi-page workflows
- **For visual testing**: Screenshot comparisons, responsive design validation
- **Not for code analysis**: Static code review, syntax checking, logic validation

### Works Best With
- **Sequential**: Sequential plans test strategy -> Playwright executes browser automation
- **Magic**: Magic creates UI components -> Playwright validates accessibility and behavior

### Examples
```
"test the login flow" -> Playwright (browser automation)
"check if form validation works" -> Playwright (real user interaction)
"take screenshots of responsive design" -> Playwright (visual testing)
"validate accessibility compliance" -> Playwright (automated WCAG testing)
"review this function's logic" -> Native Claude (static analysis)
"explain the authentication code" -> Native Claude (code review)
```

---

## Sequential MCP Server

**Purpose**: Multi-step reasoning engine for complex analysis and systematic problem solving

### Triggers
- Complex debugging scenarios with multiple layers
- Architectural analysis and system design questions
- `--think`, `--think-hard`, `--ultrathink` flags
- Problems requiring hypothesis testing and validation
- Multi-component failure investigation
- Performance bottleneck identification requiring methodical approach

### Choose When
- **Over native reasoning**: When problems have 3+ interconnected components
- **For systematic analysis**: Root cause analysis, architecture review, security assessment
- **When structure matters**: Problems benefit from decomposition and evidence gathering
- **For cross-domain issues**: Problems spanning frontend, backend, database, infrastructure
- **Not for simple tasks**: Basic explanations, single-file changes, straightforward fixes

### Works Best With
- **Context7**: Sequential coordinates analysis -> Context7 provides official patterns
- **Magic**: Sequential analyzes UI logic -> Magic implements structured components
- **Playwright**: Sequential identifies testing strategy -> Playwright executes validation

### Examples
```
"why is this API slow?" -> Sequential (systematic performance analysis)
"design a microservices architecture" -> Sequential (structured system design)
"debug this authentication flow" -> Sequential (multi-component investigation)
"analyze security vulnerabilities" -> Sequential (comprehensive threat modeling)
"explain this function" -> Native Claude (simple explanation)
"fix this typo" -> Native Claude (straightforward change)
```

---

## Serena MCP Server

**Purpose**: Semantic code understanding with project memory and session persistence

### Triggers
- Symbol operations: rename, extract, move functions/classes
- Project-wide code navigation and exploration
- Multi-language projects requiring LSP integration
- Session lifecycle: `/sc:load`, `/sc:save`, project activation
- Memory-driven development workflows
- Large codebase analysis (>50 files, complex architecture)

### Choose When
- **Over Morphllm**: For symbol operations, not pattern-based edits
- **For semantic understanding**: Symbol references, dependency tracking, LSP integration
- **For session persistence**: Project context, memory management, cross-session learning
- **For large projects**: Multi-language codebases requiring architectural understanding
- **Not for simple edits**: Basic text replacements, style enforcement, bulk operations

### Works Best With
- **Morphllm**: Serena analyzes semantic context -> Morphllm executes precise edits
- **Sequential**: Serena provides project context -> Sequential performs architectural analysis

### Examples
```
"rename getUserData function everywhere" -> Serena (symbol operation with dependency tracking)
"find all references to this class" -> Serena (semantic search and navigation)
"load my project context" -> Serena (/sc:load with project activation)
"save my current work session" -> Serena (/sc:save with memory persistence)
"update all console.log to logger" -> Morphllm (pattern-based replacement)
"create a login form" -> Magic (UI component generation)
```
