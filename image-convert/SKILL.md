---
name: image-convert
description: |
  Convert image files between formats using vips CLI. Supports Web-optimized formats: JPG, PNG, WEBP, AVIF.
  Use when: (1) user wants to convert image to different format, (2) needs to change image extension,
  (3) keywords like "convert", "変換", "to jpg", "to png", "to webp", "to avif",
  (4) file types: JPG, PNG, WEBP, AVIF, TIFF, GIF.
---

# Image Format Conversion

Convert images between formats using vips CLI.

## Supported Formats

| Format | Extension | Use Case |
|--------|-----------|----------|
| JPEG | .jpg, .jpeg | Photos, general web images |
| PNG | .png | Graphics with transparency |
| WEBP | .webp | Modern web format, smaller size |
| AVIF | .avif | Next-gen format, best compression |
| TIFF | .tiff, .tif | High-quality archival |
| GIF | .gif | Simple animations |

## Usage

```bash
scripts/convert.sh <input> -f <format> [-q <quality>]
scripts/convert.sh <input> -o <output> [-q <quality>]
```

## Options

| Flag | Description |
|------|-------------|
| `-f, --format` | Target format (jpg, png, webp, avif, tiff, gif) |
| `-o, --output` | Output file path (format inferred from extension) |
| `-q, --quality` | Output quality 1-100 (higher = better, default: 90) |

## Examples

```bash
# Convert PNG to JPEG
scripts/convert.sh image.png -f jpg

# Convert JPEG to WEBP
scripts/convert.sh photo.jpg -f webp

# Convert to AVIF with high quality
scripts/convert.sh image.png -f avif -q 95

# Specify output path
scripts/convert.sh input.png -o /path/to/output.webp
```

## Output

- Default: Output file created in same directory as input
- Filename: `{original_name}.{new_extension}`
- Example: `photo.png` → `photo.jpg`

## Requirements

- libvips installed (`brew install vips` on macOS)
