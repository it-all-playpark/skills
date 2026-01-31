#!/bin/bash
# Validate generated Marp slides
# Usage: validate.sh <slides.md> [--strict] [--fix-hint]
#
# Checks:
#   - Frontmatter (marp: true, paginate)
#   - Embedded CSS (<style> tag)
#   - Required slides (cover, closing)
#   - 6x6 Rule violations
#   - Table format (HTML vs Markdown)
#   - Logo placeholder status
#   - Speaker notes presence

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

INPUT=""
STRICT=false
FIX_HINT=false

# Colors
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
ERRORS=0
WARNINGS=0

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --strict)
      STRICT=true
      shift
      ;;
    --fix-hint)
      FIX_HINT=true
      shift
      ;;
    -h|--help)
      echo "Usage: validate.sh <slides.md> [--strict] [--fix-hint]"
      echo ""
      echo "Options:"
      echo "  --strict    Treat warnings as errors"
      echo "  --fix-hint  Show hints for fixing issues"
      echo ""
      echo "Exit codes:"
      echo "  0  All checks passed"
      echo "  1  Errors found"
      echo "  2  Warnings found (strict mode)"
      exit 0
      ;;
    *)
      if [[ -z "$INPUT" ]]; then
        INPUT="$1"
      fi
      shift
      ;;
  esac
done

# Validate input
if [[ -z "$INPUT" ]]; then
  echo -e "${RED}Error: Input file required${NC}"
  echo "Usage: validate.sh <slides.md> [--strict] [--fix-hint]"
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo -e "${RED}Error: File not found: $INPUT${NC}"
  exit 1
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}Marp Slide Validator${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "File: $INPUT"
echo ""

error() {
  echo -e "${RED}✗ ERROR: $1${NC}"
  ((ERRORS++))
  if [[ "$FIX_HINT" == true && -n "$2" ]]; then
    echo -e "  ${CYAN}→ Fix: $2${NC}"
  fi
}

warn() {
  echo -e "${YELLOW}⚠ WARN:  $1${NC}"
  ((WARNINGS++))
  if [[ "$FIX_HINT" == true && -n "$2" ]]; then
    echo -e "  ${CYAN}→ Fix: $2${NC}"
  fi
}

pass() {
  echo -e "${GREEN}✓ PASS:  $1${NC}"
}

info() {
  echo -e "  INFO:  $1"
}

# ==========================================
# 1. Frontmatter Checks
# ==========================================
echo -e "\n${CYAN}[1/7] Frontmatter${NC}"

if grep -q "^marp: true" "$INPUT" || grep -q "^marp:true" "$INPUT"; then
  pass "marp: true found"
else
  error "marp: true missing in frontmatter" "Add 'marp: true' at the top of the file"
fi

if grep -q "^paginate:" "$INPUT"; then
  pass "paginate setting found"
else
  warn "paginate setting missing" "Add 'paginate: true' for page numbers"
fi

# ==========================================
# 2. Embedded CSS Check
# ==========================================
echo -e "\n${CYAN}[2/7] Embedded CSS${NC}"

if grep -q "<style>" "$INPUT"; then
  pass "<style> tag found"

  # Check for layout classes in CSS
  LAYOUT_CLASSES=("cover" "lead" "agenda" "two-col" "comparison" "closing")
  FOUND_CLASSES=0
  for class in "${LAYOUT_CLASSES[@]}"; do
    if grep -q "section\.$class\|\.${class}[[:space:]{]" "$INPUT"; then
      ((FOUND_CLASSES++))
    fi
  done

  if [[ $FOUND_CLASSES -ge 3 ]]; then
    pass "Layout classes embedded ($FOUND_CLASSES found)"
  else
    warn "Few layout classes in CSS ($FOUND_CLASSES found)" "Embed theme CSS with layout classes (cover, lead, agenda, etc.)"
  fi
else
  error "No embedded <style> tag" "Embed theme CSS from references/themes/*.css"
fi

# ==========================================
# 3. Required Slides Check
# ==========================================
echo -e "\n${CYAN}[3/7] Required Slides${NC}"

if grep -q "<!-- _class: cover -->" "$INPUT" || grep -q "<!-- _class:cover -->" "$INPUT"; then
  pass "Cover slide found"
else
  error "No cover slide" "Add '<!-- _class: cover -->' to first content slide"
fi

if grep -q "<!-- _class: closing -->" "$INPUT" || grep -q "<!-- _class:closing -->" "$INPUT"; then
  pass "Closing slide found"
else
  warn "No closing slide" "Add '<!-- _class: closing -->' to final slide"
fi

# Count slides
SLIDE_COUNT=$(grep -c "^---$" "$INPUT" || echo "0")
info "Total slides: $SLIDE_COUNT"

# ==========================================
# 4. 6x6 Rule Check
# ==========================================
echo -e "\n${CYAN}[4/7] 6x6 Rule (Information Density)${NC}"

# Split into slides and check bullet points
DENSE_SLIDES=0
SLIDE_NUM=0
while IFS= read -r -d '---' slide; do
  ((SLIDE_NUM++))
  # Count bullet points (lines starting with - or *)
  BULLETS=$(echo "$slide" | grep -c "^[[:space:]]*[-*] " || echo "0")
  if [[ $BULLETS -gt 6 ]]; then
    ((DENSE_SLIDES++))
    if [[ $DENSE_SLIDES -le 3 ]]; then
      info "Slide $SLIDE_NUM has $BULLETS bullet points (max 6 recommended)"
    fi
  fi
done < "$INPUT"

if [[ $DENSE_SLIDES -eq 0 ]]; then
  pass "All slides follow 6x6 rule"
elif [[ $DENSE_SLIDES -le 2 ]]; then
  warn "$DENSE_SLIDES slide(s) exceed 6 bullet points" "Split dense slides into multiple slides"
else
  warn "$DENSE_SLIDES slides exceed 6 bullet points" "Consider splitting content across more slides"
fi

# ==========================================
# 5. Table Format Check
# ==========================================
echo -e "\n${CYAN}[5/7] Table Format${NC}"

# Check for Markdown tables (| at start of line, followed by content and |)
MD_TABLES=$(grep -c "^|.*|.*|$" "$INPUT" || echo "0")
HTML_TABLES=$(grep -c "<table" "$INPUT" || echo "0")

if [[ $MD_TABLES -gt 0 ]]; then
  warn "$MD_TABLES Markdown table row(s) found" "Convert to HTML tables for column width control (see snippets/table.html)"
elif [[ $HTML_TABLES -gt 0 ]]; then
  pass "Tables are HTML format ($HTML_TABLES found)"
else
  pass "No tables (or all HTML)"
fi

# ==========================================
# 6. Logo Placeholder Check
# ==========================================
echo -e "\n${CYAN}[6/7] Logo Placeholder${NC}"

if grep -q "{{LOGO_BASE64}}" "$INPUT"; then
  warn "{{LOGO_BASE64}} placeholder not replaced" "Run: scripts/inject-logo.sh $INPUT"
else
  # Check if logo data URI exists (already injected)
  if grep -q "data:image/png;base64," "$INPUT"; then
    pass "Logo already injected"
  else
    info "No logo placeholder or injection (may be intentional)"
  fi
fi

# ==========================================
# 7. Speaker Notes Check
# ==========================================
echo -e "\n${CYAN}[7/7] Speaker Notes${NC}"

NOTES_COUNT=$(grep -c "^<!--$" "$INPUT" || echo "0")
# More accurate: count multi-line HTML comments that aren't class directives
NOTES_APPROX=$(grep -c "^<!--[^_]" "$INPUT" || echo "0")

if [[ $NOTES_APPROX -ge 3 ]]; then
  pass "Speaker notes present (~$NOTES_APPROX sections)"
else
  warn "Few or no speaker notes detected" "Add speaker notes: <!-- Notes here -->"
fi

# ==========================================
# Summary
# ==========================================
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}Summary${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
  echo -e "${GREEN}✓ All checks passed!${NC}"
  exit 0
elif [[ $ERRORS -eq 0 ]]; then
  echo -e "${YELLOW}⚠ $WARNINGS warning(s)${NC}"
  if [[ "$STRICT" == true ]]; then
    exit 2
  fi
  exit 0
else
  echo -e "${RED}✗ $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
fi
